import { canonicalAgentScopeId } from '../core/agent-scope-id.js';
import { createHash, randomUUID } from 'node:crypto';
import { AgentIntendedSessionUnsupportedError, AgentMessageAccessError, AgentMessagingError, AgentNativeMessageTooLargeError, fetchAgentMessage, pollAgentEvents, assertCallerMayUseDelivery, principalsOfSession, readAgentMessageReceipts, recordAgentReceipt, resolveAgentSessionHandle, sendAgentMessage, waitForAgentEvents, HANDLED_RECEIPT_KINDS_SQL, } from '../core/agent-messaging.js';
import { MessageSchema } from './schemas.js';
import { AGENT_ROUTER_PROTOCOL_VERSION, AgentRouterError, createAgentRouterNotifier, sendAgentRouterRequest, } from '../core/agent-router.js';
import { getAgentRouterSocketPath } from '../core/paths.js';
import { sessionAliasChain } from '../core/agent-message-inbox.js';
import { jsonStringLiteral } from '../core/work-topology.js';
import { sqliteUtcToIso } from '../core/time-utils.js';
import { networkReceiptFact, remoteDiscoverCards, resolveNetworkRecipient } from '../network/outbound.js';
export class AgentRecipientUnavailableError extends AgentMessagingError {
    code = 'recipient_unavailable';
    constructor(detail) {
        super(`recipient_unavailable: Could not confirm the session accepted the notification. It may have already arrived, or the session stopped, disconnected, refused it, or its queue is full. The durable message is preserved in the inbox. Try fallback_to_principal to store it in the shared inbox.${detail ? ` ${detail}` : ''}`);
    }
}
export class AgentRouterUnavailableError extends AgentMessagingError {
    code = 'router_unreachable';
    constructor(options = {}) {
        super((options.startFailure === undefined
            ? 'router_unreachable: the MeMesh message router is not running. Start it with `memesh-router` (leave it running), then retry.'
            : `router_unreachable: the MeMesh message router is not running and could not be started (${options.startFailure}). Run \`memesh-router\` in a terminal to see why, then retry.`)
            + (options.messageSaved ? ' The durable message is preserved.' : ''));
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
        accepted_at: sqliteUtcToIso(row.created_at),
    };
}
function intendedSessionNote(session, principal) {
    return `Session ${session} is not connected now. Only it can take this message in, the next time it runs; `
        + `no other session of ${principal} will. If it has ended for good, send to ${principal} `
        + 'without intended_session instead.';
}
function principalAvailability(db, sent) {
    const recipient = canonicalAgentScopeId(sent.recipient);
    const meant = sent.intended_session ? sessionAliasChain(db, sent.intended_session) : undefined;
    const wanted = meant === undefined ? [] : [...meant].map((id) => id.toLowerCase());
    const inWanted = meant === undefined ? '' : ` AND lower(session_instance_id) IN (${wanted.map(() => '?').join(', ')})`;
    const live = db.prepare(`
    SELECT principal_id FROM agent_session_connections
    WHERE project = ? AND disconnected_at IS NULL AND lease_expires_at_ms > ?${inWanted}
  `).all(sent.project, Date.now(), ...wanted)
        .some((row) => canonicalAgentScopeId(row.principal_id) === recipient);
    if (sent.intended_session) {
        if (live)
            return ` Session ${sent.intended_session} is connected now; use status to see whether its notice reached the conversation.`;
        const registered = db.prepare(`
      SELECT principal_id FROM agent_session_instances WHERE project = ?${inWanted}
    `).all(sent.project, ...wanted)
            .map((row) => canonicalAgentScopeId(row.principal_id));
        if (registered.length === 0) {
            return ` Session ${sent.intended_session} has not registered in this project, so MeMesh cannot tell whether it exists. `
                + `Only a session with that id can take this message in; no other session of ${sent.recipient} will. `
                + `Check the id; if it is wrong or the session has ended, send to ${sent.recipient} without intended_session instead.`;
        }
        if (!registered.includes(recipient)) {
            const other = [...new Set(registered)].join(', ');
            return ` Session ${sent.intended_session} is a session of ${other}; ${sent.recipient}'s notices do not reach it. `
                + `Send to ${other}, or send to ${sent.recipient} without intended_session.`;
        }
        return ` ${intendedSessionNote(sent.intended_session, sent.recipient)}`;
    }
    return live
        ? ` A session of ${sent.recipient} is connected now; use status to see whether its notice reached the conversation.`
        : ` No session of ${sent.recipient} is connected now; the message waits in the inbox.`;
}
function publicSentMessage(sent, adapter, availability = '') {
    const { reused, ...message } = sent;
    const delivery_note = reused
        ? 'Reused the previous message_id; no new message was created. An unconfirmed notification may be sent again.'
        : adapter
            ? `${adapter} accepted the notification. This does not mean the model has read or accepted it.`
            : `Stored in ${sent.recipient}'s inbox. This does not mean the recipient has read or accepted it.${availability}`;
    return { ...message, delivery_note };
}
async function requestRouter(request, dependencies, timeoutMs, messageSaved = false) {
    const send = dependencies.sendRouterRequest ?? sendAgentRouterRequest;
    const socketPath = routerSocketPath();
    try {
        return await send(socketPath, request, timeoutMs);
    }
    catch (error) {
        let started;
        try {
            started = await dependencies.startRouterIfDown?.(socketPath, error) ?? false;
        }
        catch (startError) {
            throw new AgentRouterUnavailableError({
                startFailure: startError instanceof Error ? startError.message : String(startError),
                messageSaved,
            });
        }
        if (!started)
            throw error;
        return send(socketPath, request, timeoutMs);
    }
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
        const result = await requestRouter(request, dependencies, EXACT_SESSION_NATIVE_TIMEOUT_MS, true);
        if (result.delivered !== true) {
            const accepted = readHostAccept(db, sent.delivery_id);
            if (accepted)
                return nativeAcceptance(accepted);
            if (readLatestDispatchFailure(db, sent.delivery_id)?.failure_code === 'native_message_too_large') {
                throw new AgentNativeMessageTooLargeError();
            }
            throw new AgentRecipientUnavailableError();
        }
    }
    catch (error) {
        if (error instanceof AgentRecipientUnavailableError
            || error instanceof AgentNativeMessageTooLargeError
            || error instanceof AgentRouterUnavailableError)
            throw error;
        if (error instanceof AgentRouterError) {
            if (!['timeout', 'connection_closed'].includes(error.code))
                throw error;
        }
        throw new AgentRouterUnavailableError({ messageSaved: true });
    }
    const accepted = readHostAccept(db, sent.delivery_id);
    if (!accepted)
        throw new AgentRecipientUnavailableError();
    return nativeAcceptance(accepted);
}
function readLatestDispatchFailure(db, deliveryId) {
    return db.prepare(`
    SELECT a.failure_code AS failure_code, c.adapter_kind AS adapter_kind
    FROM agent_dispatch_attempts a
    LEFT JOIN agent_session_connections c ON c.connection_id = a.connection_id
    WHERE a.delivery_id = ? AND a.result = 'adapter_rejected' AND a.failure_code IS NOT NULL
    ORDER BY a.attempt_number DESC
    LIMIT 1
  `).get(deliveryId);
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
    SELECT delivery_id, message_id, project, recipient, target_kind, intended_session
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
        caller_session: context.hostSession,
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
function acceptedNote(adapterKind) {
    if (adapterKind === 'claude-inbox') {
        return 'A notice is in the recipient\'s conversation; the agent has not recorded intake, an ack or a disposition yet.';
    }
    if (adapterKind === 'claude-channel') {
        return 'The notice was handed to the recipient\'s Claude Code Channel and queued; MeMesh does not see it shown there, and the agent has not recorded intake, an ack or a disposition yet.';
    }
    if (adapterKind === 'codex-cli-queue' || adapterKind === 'codex-app-server') {
        return 'The notice was queued for the recipient\'s Codex thread; MeMesh does not see it shown there, and the agent has not recorded intake, an ack or a disposition yet.';
    }
    return 'The host accepted the notice; whether the agent has seen it is not recorded here.';
}
function queuedNote(failure, adapterKind) {
    const claude = adapterKind === undefined || adapterKind.startsWith('claude-');
    const later = claude ? 'the message appears at the session\'s next prompt or turn end' : 'the message waits in the inbox until the recipient reads it';
    switch (failure) {
        case undefined:
            return 'Stored in the inbox; no notice has been confirmed in the recipient\'s conversation.';
        case 'notice_held':
            return `Stored in the inbox. Claude Code is holding the notice for its user to approve or deny, and MeMesh cannot see which; either way ${later}.`;
        case 'notice_not_confirmed':
            return `Stored in the inbox. The notice reached the session but was not shown in its conversation (Claude Code may be holding it); ${later}.`;
        case 'transcript_unavailable':
        case 'transcript_not_found':
            return `Stored in the inbox. MeMesh could not read the session's conversation record, so it cannot tell whether the notice arrived; ${later}.`;
        case 'frame_too_large':
            return `Stored in the inbox. The notice was too large to be sent and was not delivered; ${later}.`;
        default:
            return `Stored in the inbox. A delivery attempt ended without a result, so the notice may or may not have reached the session and nothing confirms it; ${later}.`;
    }
}
function hasReplyFromRecipient(db, delivery) {
    const original = db.prepare('SELECT sender FROM agent_messages WHERE message_id = ? AND project = ?').get(delivery.message_id, delivery.project);
    if (!original)
        return false;
    const originalSender = canonicalAgentScopeId(original.sender);
    const recipients = new Set(delivery.target_kind === 'principal'
        ? [canonicalAgentScopeId(delivery.recipient)]
        : [canonicalAgentScopeId(delivery.recipient), ...principalsOfSession(db, delivery.project, delivery.recipient)]);
    const replies = db.prepare(`
    SELECT m.sender AS sender, d.recipient AS recipient, d.target_kind AS target_kind
    FROM agent_messages m JOIN agent_message_deliveries d ON d.message_id = m.message_id
    WHERE m.project = ? AND m.reply_to_message_id = ?
  `).all(delivery.project, delivery.message_id);
    return replies.some((reply) => recipients.has(canonicalAgentScopeId(reply.sender))
        && (canonicalAgentScopeId(reply.recipient) === originalSender
            || (reply.target_kind === 'session' && principalsOfSession(db, delivery.project, reply.recipient).includes(originalSender))));
}
function readMessageStatus(db, input, callerSession) {
    return db.transaction(() => {
        const delivery = resolveCanonicalDelivery(db, input.project, input.recipient, input.message_id);
        assertCallerMayUseDelivery(db, delivery, callerSession, { allowSender: true });
        const state = readDeliveryState(db, delivery);
        const replied = hasReplyFromRecipient(db, delivery);
        const handled = db.prepare(`
      SELECT 1 FROM agent_message_receipts
      WHERE project = ? AND recipient = ? AND message_id = ? AND receipt_kind IN ${HANDLED_RECEIPT_KINDS_SQL}
      LIMIT 1
    `).get(delivery.project, delivery.recipient, delivery.message_id) !== undefined;
        const hostAccept = readHostAccept(db, delivery.delivery_id);
        const status = replied ? 'replied' : handled ? 'handed_to_agent' : hostAccept ? 'accepted' : 'queued';
        const latestFailure = status === 'queued' ? readLatestDispatchFailure(db, delivery.delivery_id) : undefined;
        const failure = latestFailure?.failure_code;
        const lastHost = latestFailure?.adapter_kind ?? undefined;
        let note;
        if (status === 'replied')
            note = 'A reply addressed back to the sender and linked to this message exists.';
        else if (status === 'handed_to_agent')
            note = 'The agent recorded intake, an ack or a disposition for this message; no reply is linked to it yet.';
        else if (status === 'accepted')
            note = acceptedNote(hostAccept?.adapter_kind);
        else {
            note = queuedNote(failure, lastHost);
            if (failure === undefined && delivery.target_kind === 'principal') {
                const availability = principalAvailability(db, delivery);
                if (!availability.includes('is connected now; use status'))
                    note += availability;
            }
            else if (failure === undefined && state.target_session === 'not_live') {
                note = 'Stored in the inbox. The target session is not connected now; the message is delivered when it next connects.';
            }
        }
        return {
            message_id: delivery.message_id,
            status,
            note,
            ...(failure ? { last_failure: failure } : {}),
            delivery_state: state,
        };
    })();
}
function readPublicReceipts(db, input, callerSession) {
    return db.transaction(() => readPublicReceiptsSnapshot(db, { ...input, caller_session: callerSession }))();
}
function readPublicReceiptsSnapshot(db, input) {
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
        projected.push({
            fact: { ...projectHostAccept(delivery, hostAccept), delivery_state: readDeliveryState(db, delivery) },
            rank: 0,
            order: hostAccept.fact_order,
        });
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
                created_at: sqliteUtcToIso(row.created_at),
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
                created_at: sqliteUtcToIso(row.created_at),
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
function readDeliveryState(db, delivery) {
    const observedAtMs = Date.now();
    const intake = db.prepare(`
    SELECT 1 FROM agent_message_receipts
    WHERE project = ? AND recipient = ? AND message_id = ? AND receipt_kind = 'intake'
    LIMIT 1
  `).get(delivery.project, delivery.recipient, delivery.message_id) === undefined ? 'pending' : 'recorded';
    const observed_at = new Date(observedAtMs).toISOString();
    const session = delivery.target_kind === 'session' ? delivery.recipient : delivery.intended_session;
    if (session === null)
        return { observed_at, intake, target_session: 'not_applicable' };
    return { observed_at, intake, target_session: sessionLiveness(db, delivery.project, session, observedAtMs), session };
}
function sessionLiveness(db, project, session, observedAtMs) {
    const ids = [...sessionAliasChain(db, session)].map((id) => id.toLowerCase());
    const marks = ids.map(() => '?').join(', ');
    try {
        const registered = db.prepare(`
      SELECT 1 FROM agent_session_instances WHERE project = ? AND lower(session_instance_id) IN (${marks}) LIMIT 1
    `).get(project, ...ids) !== undefined;
        if (!registered)
            return 'unknown';
        const live = db.prepare(`
      SELECT 1 FROM agent_session_connections
      WHERE project = ? AND lower(session_instance_id) IN (${marks})
        AND disconnected_at IS NULL AND lease_expires_at_ms > ?
      LIMIT 1
    `).get(project, ...ids, observedAtMs) !== undefined;
        return live ? 'live' : 'not_live';
    }
    catch (error) {
        if (/no such table: agent_session_(instances|connections)\b/.test(error instanceof Error ? error.message : ''))
            return 'unknown';
        throw error;
    }
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
        created_at: sqliteUtcToIso(fact.created_at),
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
function principalFallbackKey(idempotencyKey) {
    return `principal-fallback:${createHash('sha256').update(idempotencyKey).digest('hex')}`;
}
function hasPrincipalFallback(db, sent, idempotencyKey) {
    return db.prepare(`
    SELECT 1 FROM agent_message_idempotency WHERE project = ? AND sender = ? AND idempotency_key = ?
  `).get(sent.project, sent.sender, principalFallbackKey(idempotencyKey)) !== undefined;
}
function sendPrincipalFallback(db, message, refused) {
    const ids = [...sessionAliasChain(db, refused.recipient)];
    const marks = ids.map(() => '?').join(', ');
    const registrations = db.prepare(`
    SELECT session_instance_id, principal_id FROM agent_session_instances
    WHERE project = ? AND session_instance_id IN (${marks})
  `).all(refused.project, ...ids);
    const session = registrations.find((row) => row.session_instance_id === refused.recipient)
        ?? (new Set(registrations.map((row) => row.principal_id)).size === 1 ? registrations[0] : undefined);
    if (!session) {
        if (registrations.length > 0) {
            throw new AgentRecipientUnavailableError('There is no principal fallback: the session aliases name different principals in this project.');
        }
        throw new AgentRecipientUnavailableError(`There is no principal fallback: session ${JSON.stringify(refused.recipient)} has never registered in project `
            + `${jsonStringLiteral(refused.project)}, so its principal is unknown. Send to the principal yourself with `
            + `intended_session ${JSON.stringify(refused.recipient)}.`);
    }
    let fallback;
    try {
        fallback = sendAgentMessage(db, {
            ...message,
            recipient: session.principal_id,
            target_kind: 'principal',
            intended_session: refused.recipient,
            idempotency_key: principalFallbackKey(message.idempotency_key),
        }, {
            notifier: optionalRouterNotifier(),
            storage_quota_bytes: configuredAgentMessageStorageQuotaBytes(),
            fallback_of_message_id: refused.message_id,
        });
    }
    catch (error) {
        if (error instanceof AgentIntendedSessionUnsupportedError) {
            throw new AgentRecipientUnavailableError(`There is no principal fallback: ${error.message}`);
        }
        throw error;
    }
    const connected = db.prepare(`
    SELECT 1 FROM agent_session_connections
    WHERE project = ? AND principal_id = ? AND session_instance_id IN (${marks})
      AND disconnected_at IS NULL AND lease_expires_at_ms > ?
    LIMIT 1
  `).get(refused.project, session.principal_id, ...ids, Date.now()) !== undefined;
    return {
        ...publicSentMessage(fallback),
        fallback: {
            reason: 'recipient_unavailable',
            intended_session_connected: connected,
            ...(connected ? {} : {
                note: intendedSessionNote(refused.recipient, session.principal_id),
            }),
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
            const resolved = input.recipient_handle === undefined
                ? { recipient: input.recipient, target_kind: input.target_kind ?? 'principal', intended_session: input.intended_session }
                : resolveAgentSessionHandle(db, input.project, input.recipient_handle);
            if (input.recipient_handle !== undefined && input.target_kind !== undefined && input.target_kind !== resolved.target_kind) {
                throw new AgentMessagingError('target_kind does not match the recipient handle. Omit it or use the resolved target kind.');
            }
            if (input.recipient_handle !== undefined && input.intended_session !== undefined && input.intended_session !== resolved.intended_session) {
                throw new AgentMessagingError('intended_session does not match the recipient handle. Omit it or use the resolved session.');
            }
            if (input.fallback_to_principal !== undefined && resolved.target_kind !== 'session') {
                throw new AgentMessagingError('fallback_to_principal is only valid with target_kind "session".');
            }
            const network = input.recipient_handle === undefined ? resolveNetworkRecipient(db, resolved.recipient) : null;
            if (network && (resolved.target_kind !== 'principal' || resolved.intended_session !== undefined || input.fallback_to_principal !== undefined)) {
                throw new AgentMessagingError('A message to another machine goes to a principal or a handle there: target_kind session, intended_session and fallback_to_principal do not apply.');
            }
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
                    ...(context.hostSession ? { sender_session: context.hostSession } : {}),
                },
            };
            const sent = sendAgentMessage(db, {
                ...message,
                ...resolved,
            }, {
                notifier: resolved.target_kind === 'session' || network ? undefined : optionalRouterNotifier(),
                storage_quota_bytes: configuredAgentMessageStorageQuotaBytes(),
            });
            if (network)
                return { ...publicSentMessage(sent), delivery_note: network.note };
            if (sent.target_kind !== 'session')
                return publicSentMessage(sent, undefined, principalAvailability(db, sent));
            if (hasPrincipalFallback(db, sent, input.idempotency_key)) {
                return sendPrincipalFallback(db, message, sent);
            }
            try {
                const native_delivery = await requireExactSessionNativeAcceptance(db, sent, dependencies);
                return { ...publicSentMessage(sent, String(native_delivery.adapter_kind)), native_delivery };
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
                caller_session: context.hostSession,
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
            let local;
            try {
                local = await requestRouter(request, dependencies);
            }
            catch (error) {
                if (error instanceof AgentRouterUnavailableError
                    || (error instanceof AgentRouterError && !['timeout', 'connection_closed'].includes(error.code))) {
                    throw error;
                }
                throw new AgentRouterUnavailableError();
            }
            try {
                const remote = remoteDiscoverCards(db, input.project);
                if (remote.length === 0)
                    return local;
                const cards = Array.isArray(local.cards) ? local.cards : [];
                return { ...local, cards: [...cards, ...remote] };
            }
            catch (error) {
                return { ...local, network_note: `Agents on other machines could not be listed: ${error instanceof Error ? error.message : String(error)}` };
            }
        }
        case 'fetch':
            return fetchAgentMessage(db, { ...input, caller_session: context.hostSession });
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
                caller_session: context.hostSession,
            });
        case 'receipts': {
            const facts = readPublicReceipts(db, input, context.hostSession);
            const delivery = resolveCanonicalDelivery(db, input.project, input.recipient, input.message_id);
            const network = networkReceiptFact(db, delivery.delivery_id);
            return network ? [...facts, network] : facts;
        }
        case 'status':
            return readMessageStatus(db, input, context.hostSession);
    }
}
//# sourceMappingURL=agent-messaging.js.map