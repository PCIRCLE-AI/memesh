import { createHash, randomUUID } from 'node:crypto';
import { AgentIntendedSessionUnsupportedError, AgentMessageAccessError, AgentMessagingError, AgentNativeMessageTooLargeError, fetchAgentMessage, pollAgentEvents, readAgentMessageReceipts, recordAgentReceipt, sendAgentMessage, waitForAgentEvents, } from '../core/agent-messaging.js';
import { MessageSchema } from './schemas.js';
import { AGENT_ROUTER_PROTOCOL_VERSION, AgentRouterError, createAgentRouterNotifier, sendAgentRouterRequest, } from '../core/agent-router.js';
import { getAgentRouterSocketPath } from '../core/paths.js';
export class AgentRecipientUnavailableError extends AgentMessagingError {
    code = 'recipient_unavailable';
    constructor(detail) {
        super(`recipient_unavailable: the exact active session did not accept the native message.${detail ? ` ${detail}` : ''}`);
    }
}
export class AgentRouterUnavailableError extends AgentMessagingError {
    code = 'router_unreachable';
    constructor() {
        super('router_unreachable: the sender could not reach the local agent router; the durable message is preserved.');
    }
}
export class AgentDiscoveryUnavailableError extends AgentMessagingError {
    code = 'router_unreachable';
    constructor() {
        super('router_unreachable: could not reach the local agent router to discover live hosts. '
            + 'Start it with `memesh-router` (or your host\'s managed launch step, e.g. `memesh-host-codex`), '
            + 'or skip discovery — `send`/`fetch` to a principal (a stable recipient, not an exact session) work without the router; '
            + 'an exact `target_kind: "session"` send still needs it.');
    }
}
const AGENT_MESSAGE_STORAGE_QUOTA_ENV = 'MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES';
const EXACT_SESSION_NATIVE_TIMEOUT_MS = 12_000;
const PUBLIC_DISPOSITIONS = new Set(['accepted', 'rejected', 'completed', 'cancelled', 'deferred']);
function configuredAgentMessageStorageQuotaBytes() {
    const raw = process.env[AGENT_MESSAGE_STORAGE_QUOTA_ENV];
    if (raw === undefined || raw === '')
        return undefined;
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
        throw new Error(`${AGENT_MESSAGE_STORAGE_QUOTA_ENV} must be a non-negative integer byte count.`);
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) {
        throw new Error(`${AGENT_MESSAGE_STORAGE_QUOTA_ENV} exceeds the safe integer range.`);
    }
    return parsed;
}
function routerSocketPath() {
    return process.env.MEMESH_ROUTER_SOCKET ?? getAgentRouterSocketPath();
}
function optionalRouterNotifier() {
    try {
        return createAgentRouterNotifier(routerSocketPath());
    }
    catch {
        return undefined;
    }
}
function nativeAcceptance(row) {
    return {
        status: 'native_accepted',
        delivery_id: row.delivery_id,
        adapter_kind: row.adapter_kind,
        receipt: parseStoredObject(row.receipt_json, 'agent_host_accepts.receipt_json'),
        accepted_at: row.created_at,
    };
}
async function requireExactSessionNativeAcceptance(db, sent, dependencies) {
    const existing = readHostAccept(db, sent.delivery_id);
    if (existing)
        return nativeAcceptance(existing);
    const request = {
        version: AGENT_ROUTER_PROTOCOL_VERSION,
        type: 'notify',
        request_id: randomUUID(),
        project: sent.project,
        delivery_id: sent.delivery_id,
        hops: 0,
    };
    try {
        const result = await (dependencies.sendRouterRequest ?? sendAgentRouterRequest)(routerSocketPath(), request, EXACT_SESSION_NATIVE_TIMEOUT_MS);
        if (result.delivered !== true) {
            const accepted = readHostAccept(db, sent.delivery_id);
            if (accepted)
                return nativeAcceptance(accepted);
            if (readLatestDispatchFailureCode(db, sent.delivery_id) === 'native_message_too_large') {
                throw new AgentNativeMessageTooLargeError();
            }
            throw new AgentRecipientUnavailableError();
        }
    }
    catch (error) {
        if (error instanceof AgentRecipientUnavailableError
            || error instanceof AgentNativeMessageTooLargeError)
            throw error;
        if (error instanceof AgentRouterError) {
            if (!['timeout', 'connection_closed'].includes(error.code))
                throw error;
        }
        throw new AgentRouterUnavailableError();
    }
    const accepted = readHostAccept(db, sent.delivery_id);
    if (!accepted)
        throw new AgentRecipientUnavailableError();
    return nativeAcceptance(accepted);
}
function readLatestDispatchFailureCode(db, deliveryId) {
    const row = db.prepare(`
    SELECT failure_code
    FROM agent_dispatch_attempts
    WHERE delivery_id = ? AND result = 'adapter_rejected' AND failure_code IS NOT NULL
    ORDER BY attempt_number DESC
    LIMIT 1
  `).get(deliveryId);
    return row?.failure_code;
}
function receiptDetail(note, context) {
    return {
        transport: context.transport,
        source_host: context.sourceHost,
        ...(note ? { note } : {}),
    };
}
function resolveCanonicalDelivery(db, project, recipient, messageId) {
    const delivery = db.prepare(`
    SELECT delivery_id, message_id, project, recipient
    FROM agent_message_deliveries
    WHERE project = ? AND recipient = ? AND message_id = ?
  `).get(project, recipient, messageId);
    if (!delivery) {
        throw new AgentMessageAccessError(`Agent message ${messageId} is not available to recipient ${recipient} in project ${project}.`);
    }
    return delivery;
}
function readHostAccept(db, deliveryId) {
    return db.prepare(`
    SELECT rowid AS fact_order, host_accept_id, attempt_id, delivery_id, adapter_kind, receipt_json, created_at
    FROM agent_host_accepts
    WHERE delivery_id = ?
  `).get(deliveryId);
}
function recordPublicAck(db, input, context) {
    return recordAgentReceipt(db, {
        project: input.project,
        recipient: input.recipient,
        message_id: input.message_id,
        actor: input.recipient,
        idempotency_key: input.idempotency_key,
        receipt_kind: 'ack',
        detail: receiptDetail(undefined, context),
    });
}
function recordPublicWorkflow(db, input, context) {
    return recordAgentReceipt(db, {
        project: input.project,
        recipient: input.recipient,
        message_id: input.message_id,
        actor: input.recipient,
        idempotency_key: input.idempotency_key,
        receipt_kind: 'disposition',
        disposition: input.disposition,
        detail: receiptDetail(input.detail, context),
        caller_session: context.hostSession,
    });
}
function readPublicReceipts(db, input) {
    const delivery = resolveCanonicalDelivery(db, input.project, input.recipient, input.message_id);
    const projected = [];
    const legacy = readAgentMessageReceipts(db, input);
    legacy.forEach((receipt, order) => projected.push({
        fact: { ...receipt, fact_source: 'agent_message_receipt' },
        rank: 1,
        order,
    }));
    const hostAccept = readHostAccept(db, delivery.delivery_id);
    if (hostAccept) {
        projected.push({ fact: projectHostAccept(delivery, hostAccept), rank: 0, order: hostAccept.fact_order });
    }
    const ackFacts = db.prepare(`
    SELECT rowid AS fact_order, ack_fact_id, delivery_id, host_accept_id, actor,
           idempotency_key, detail_json, created_at
    FROM agent_ack_facts
    WHERE delivery_id = ?
    ORDER BY rowid ASC
  `).all(delivery.delivery_id);
    for (const row of ackFacts) {
        projected.push({
            fact: projectAckFact(delivery, {
                ack_fact_id: row.ack_fact_id,
                delivery_id: row.delivery_id,
                host_accept_id: row.host_accept_id,
                actor: row.actor,
                idempotency_key: row.idempotency_key,
                detail: parseStoredObject(row.detail_json, 'agent_ack_facts.detail_json'),
                created_at: row.created_at,
            }),
            rank: 2,
            order: row.fact_order,
        });
    }
    const workflowFacts = db.prepare(`
    SELECT rowid AS fact_order, workflow_fact_id, delivery_id, actor,
           workflow_state, idempotency_key, detail_json, created_at
    FROM agent_workflow_facts
    WHERE delivery_id = ?
    ORDER BY rowid ASC
  `).all(delivery.delivery_id);
    for (const row of workflowFacts) {
        projected.push({
            fact: projectWorkflowFact(delivery, {
                workflow_fact_id: row.workflow_fact_id,
                delivery_id: row.delivery_id,
                actor: row.actor,
                workflow_state: row.workflow_state,
                idempotency_key: row.idempotency_key,
                detail: parseStoredObject(row.detail_json, 'agent_workflow_facts.detail_json'),
                created_at: row.created_at,
            }),
            rank: 3,
            order: row.fact_order,
        });
    }
    return projected
        .sort((left, right) => left.fact.created_at.localeCompare(right.fact.created_at)
        || left.rank - right.rank
        || left.order - right.order)
        .map(({ fact }) => fact);
}
function projectHostAccept(delivery, fact) {
    return {
        receipt_id: fact.host_accept_id,
        receipt_kind: 'host_accept',
        fact_source: 'agent_host_accept',
        message_id: delivery.message_id,
        project: delivery.project,
        recipient: delivery.recipient,
        delivery_id: fact.delivery_id,
        host_accept_id: fact.host_accept_id,
        attempt_id: fact.attempt_id,
        adapter_kind: fact.adapter_kind,
        receipt: parseStoredObject(fact.receipt_json, 'agent_host_accepts.receipt_json'),
        created_at: fact.created_at,
    };
}
function projectAckFact(delivery, fact) {
    return {
        receipt_id: fact.ack_fact_id,
        receipt_kind: 'ack',
        fact_source: 'agent_ack_fact',
        ack_fact_id: fact.ack_fact_id,
        message_id: delivery.message_id,
        project: delivery.project,
        recipient: delivery.recipient,
        delivery_id: fact.delivery_id,
        host_accept_id: fact.host_accept_id,
        actor: fact.actor,
        idempotency_key: fact.idempotency_key,
        detail: { acknowledged: true, detail: fact.detail },
        created_at: fact.created_at,
    };
}
function projectWorkflowFact(delivery, fact) {
    const disposition = PUBLIC_DISPOSITIONS.has(fact.workflow_state) ? fact.workflow_state : undefined;
    return {
        receipt_id: fact.workflow_fact_id,
        receipt_kind: disposition ? 'disposition' : 'workflow',
        fact_source: 'agent_workflow_fact',
        workflow_fact_id: fact.workflow_fact_id,
        message_id: delivery.message_id,
        project: delivery.project,
        recipient: delivery.recipient,
        delivery_id: fact.delivery_id,
        actor: fact.actor,
        idempotency_key: fact.idempotency_key,
        workflow_state: fact.workflow_state,
        ...(disposition ? { disposition } : {}),
        detail: disposition
            ? { disposition, detail: fact.detail }
            : { workflow_state: fact.workflow_state, detail: fact.detail },
        created_at: fact.created_at,
    };
}
function parseStoredObject(raw, label) {
    try {
        const parsed = JSON.parse(raw);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
    }
    catch {
    }
    throw new AgentMessagingError(`Invalid stored JSON object in ${label}.`);
}
function sendPrincipalFallback(db, message, refused) {
    const session = db.prepare(`
    SELECT principal_id FROM agent_session_instances WHERE project = ? AND session_instance_id = ?
  `).get(refused.project, refused.recipient);
    if (!session) {
        throw new AgentRecipientUnavailableError(`There is no principal fallback: session ${JSON.stringify(refused.recipient)} has never registered in project `
            + `${JSON.stringify(refused.project)}, so its principal is unknown. Send to the principal yourself with `
            + `intended_session ${JSON.stringify(refused.recipient)}.`);
    }
    let fallback;
    try {
        fallback = sendAgentMessage(db, {
            ...message,
            recipient: session.principal_id,
            target_kind: 'principal',
            intended_session: refused.recipient,
            idempotency_key: `principal-fallback:${createHash('sha256').update(message.idempotency_key).digest('hex')}`,
        }, {
            notifier: optionalRouterNotifier(),
            storage_quota_bytes: configuredAgentMessageStorageQuotaBytes(),
        });
    }
    catch (error) {
        if (error instanceof AgentIntendedSessionUnsupportedError) {
            throw new AgentRecipientUnavailableError(`There is no principal fallback: ${error.message}`);
        }
        throw error;
    }
    return {
        ...fallback,
        fallback: {
            reason: 'recipient_unavailable',
            from: {
                message_id: refused.message_id,
                delivery_id: refused.delivery_id,
                recipient: refused.recipient,
                target_kind: 'session',
            },
        },
    };
}
export async function executeAgentMessageAction(db, rawInput, context, dependencies = {}) {
    const input = MessageSchema.parse(rawInput);
    switch (input.action) {
        case 'send': {
            const message = {
                project: input.project,
                sender: input.sender,
                sender_host: context.sourceHost,
                idempotency_key: input.idempotency_key,
                payload: input.payload,
                content_type: input.content_type,
                privacy: input.privacy,
                correlation_id: input.correlation_id,
                reply_to: input.reply_to,
                provenance: {
                    transport: context.transport,
                    source_host: context.sourceHost,
                },
            };
            const sent = sendAgentMessage(db, {
                ...message,
                recipient: input.recipient,
                target_kind: input.target_kind,
                intended_session: input.intended_session,
            }, {
                notifier: input.target_kind === 'session' ? undefined : optionalRouterNotifier(),
                storage_quota_bytes: configuredAgentMessageStorageQuotaBytes(),
            });
            if (sent.target_kind !== 'session')
                return sent;
            try {
                return {
                    ...sent,
                    native_delivery: await requireExactSessionNativeAcceptance(db, sent, dependencies),
                };
            }
            catch (error) {
                if (input.fallback_to_principal !== true || !(error instanceof AgentRecipientUnavailableError))
                    throw error;
                return sendPrincipalFallback(db, message, sent);
            }
        }
        case 'poll': {
            const query = {
                project: input.project,
                recipient: input.recipient,
                cursor: input.cursor,
                limit: input.limit,
            };
            return input.wait_ms > 0
                ? waitForAgentEvents(db, { ...query, wait_ms: input.wait_ms }, context.signal)
                : pollAgentEvents(db, query);
        }
        case 'discover': {
            const request = {
                version: AGENT_ROUTER_PROTOCOL_VERSION,
                type: 'discover',
                request_id: randomUUID(),
                project: input.project,
                limit: input.limit,
                hops: 0,
            };
            try {
                return await (dependencies.sendRouterRequest ?? sendAgentRouterRequest)(routerSocketPath(), request);
            }
            catch (error) {
                if (error instanceof AgentRouterError && !['timeout', 'connection_closed'].includes(error.code)) {
                    throw error;
                }
                throw new AgentDiscoveryUnavailableError();
            }
        }
        case 'fetch':
            return fetchAgentMessage(db, input);
        case 'intake':
            return recordAgentReceipt(db, {
                project: input.project,
                recipient: input.recipient,
                message_id: input.message_id,
                actor: input.recipient,
                idempotency_key: input.idempotency_key,
                receipt_kind: 'intake',
                intake_state: input.intake_state,
                detail: receiptDetail(undefined, context),
                caller_session: context.hostSession,
            });
        case 'ack':
            return recordPublicAck(db, input, context);
        case 'disposition':
            return recordPublicWorkflow(db, input, context);
        case 'activation':
            return recordAgentReceipt(db, {
                project: input.project,
                recipient: input.recipient,
                message_id: input.message_id,
                actor: input.recipient,
                idempotency_key: input.idempotency_key,
                receipt_kind: 'host_activation',
                host_activation: input.activation,
                detail: receiptDetail(input.detail, context),
            });
        case 'receipts':
            return readPublicReceipts(db, input);
    }
}
//# sourceMappingURL=agent-messaging.js.map