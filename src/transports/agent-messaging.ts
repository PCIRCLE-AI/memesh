import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import type { MemeshDatabase } from '../storage/sqlite.js';
import {
  AgentIntendedSessionUnsupportedError,
  AgentMessageAccessError,
  AgentMessagingError,
  AgentNativeMessageTooLargeError,
  fetchAgentMessage,
  pollAgentEvents,
  readAgentMessageReceipts,
  recordAgentReceipt,
  sendAgentMessage,
  waitForAgentEvents,
  type AgentAckFact,
  type AgentJsonObject,
  type AgentMessagePostCommitNotifier,
  type SendAgentMessageInput,
  type SentAgentMessage,
  type AgentWorkflowFact,
} from '../core/agent-messaging.js';
import { MessageSchema } from './schemas.js';
import {
  AGENT_ROUTER_PROTOCOL_VERSION,
  AgentRouterError,
  createAgentRouterNotifier,
  sendAgentRouterRequest,
  type AgentRouterNotifyRequest,
  type AgentRouterDiscoverRequest,
} from '../core/agent-router.js';
import { getAgentRouterSocketPath } from '../core/paths.js';
import { sessionAliasChain } from '../core/agent-message-inbox.js';
import { jsonStringLiteral } from '../core/work-topology.js';
import { sqliteUtcToIso } from '../core/time-utils.js';

export type AgentMessageActionInput = z.infer<typeof MessageSchema>;

export interface AgentMessageTransportContext {
  transport: 'cli' | 'http' | 'mcp';
  sourceHost: string;
  signal?: AbortSignal;
  /**
   * #497: the host session this call runs in, as the transport knows it
   * (MCP and CLI: `CLAUDE_CODE_SESSION_ID`; HTTP: none). Decides whether
   * intake or a disposition may be recorded for a delivery meant for one
   * session. Never taken from the call's own arguments.
   */
  hostSession?: string;
}

export interface AgentMessageTransportDependencies {
  sendRouterRequest?: typeof sendAgentRouterRequest;
}

export class AgentRecipientUnavailableError extends AgentMessagingError {
  readonly code = 'recipient_unavailable';

  constructor(detail?: string) {
    super(`recipient_unavailable: the exact active session did not accept the native message.${detail ? ` ${detail}` : ''}`);
  }
}

export class AgentRouterUnavailableError extends AgentMessagingError {
  readonly code = 'router_unreachable';

  constructor() {
    super('router_unreachable: the sender could not reach the local agent router; the durable message is preserved.');
  }
}

export class AgentDiscoveryUnavailableError extends AgentMessagingError {
  readonly code = 'router_unreachable';

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

type CanonicalDeliveryScope = {
  delivery_id: string;
  message_id: string;
  project: string;
  recipient: string;
  target_kind: string;
  intended_session: string | null;
};

/**
 * G-dead: what a sender can see about an accepted message, observed when the
 * receipts are read. `not_live` is only that observation, not a lost message:
 * MeMesh never resends or reroutes it, and the sender may send to the principal.
 */
type DeliveryState = {
  observed_at: string;
  intake: 'recorded' | 'pending';
  target_session: 'live' | 'not_live' | 'unknown' | 'not_applicable';
  session?: string;
};

type HostAcceptRow = {
  fact_order: number;
  host_accept_id: string;
  attempt_id: string;
  delivery_id: string;
  adapter_kind: string;
  receipt_json: string;
  created_at: string;
};

type AckFactRow = {
  fact_order: number;
  ack_fact_id: string;
  delivery_id: string;
  host_accept_id: string;
  actor: string;
  idempotency_key: string;
  detail_json: string;
  created_at: string;
};

type WorkflowFactRow = {
  fact_order: number;
  workflow_fact_id: string;
  delivery_id: string;
  actor: string;
  workflow_state: string;
  idempotency_key: string;
  detail_json: string;
  created_at: string;
};

type ProjectedFact = Record<string, unknown> & { created_at: string };

function configuredAgentMessageStorageQuotaBytes(): number | undefined {
  const raw = process.env[AGENT_MESSAGE_STORAGE_QUOTA_ENV];
  if (raw === undefined || raw === '') return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`${AGENT_MESSAGE_STORAGE_QUOTA_ENV} must be a non-negative integer byte count.`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${AGENT_MESSAGE_STORAGE_QUOTA_ENV} exceeds the safe integer range.`);
  }
  return parsed;
}

function routerSocketPath(): string {
  return process.env.MEMESH_ROUTER_SOCKET ?? getAgentRouterSocketPath();
}

function optionalRouterNotifier(): AgentMessagePostCommitNotifier | undefined {
  try {
    return createAgentRouterNotifier(routerSocketPath());
  } catch {
    // The message transaction is the source of truth. An unusable optional
    // hint path (including an overlong Unix-domain socket path in a nested
    // temporary HOME) must not prevent durable send; a running router also
    // drains committed deliveries when a host registers or reconnects.
    return undefined;
  }
}

function nativeAcceptance(row: HostAcceptRow): AgentJsonObject {
  return {
    status: 'native_accepted',
    delivery_id: row.delivery_id,
    adapter_kind: row.adapter_kind,
    receipt: parseStoredObject(row.receipt_json, 'agent_host_accepts.receipt_json'),
    accepted_at: sqliteUtcToIso(row.created_at),
  };
}

async function requireExactSessionNativeAcceptance(
  db: MemeshDatabase,
  sent: { delivery_id: string; project: string },
  dependencies: AgentMessageTransportDependencies,
): Promise<AgentJsonObject> {
  const existing = readHostAccept(db, sent.delivery_id);
  if (existing) return nativeAcceptance(existing);

  const request: AgentRouterNotifyRequest = {
    version: AGENT_ROUTER_PROTOCOL_VERSION,
    type: 'notify',
    request_id: randomUUID(),
    project: sent.project,
    delivery_id: sent.delivery_id,
    hops: 0,
  };
  try {
    const result = await (dependencies.sendRouterRequest ?? sendAgentRouterRequest)(
      routerSocketPath(),
      request,
      EXACT_SESSION_NATIVE_TIMEOUT_MS,
    );
    if (result.delivered !== true) {
      const accepted = readHostAccept(db, sent.delivery_id);
      if (accepted) return nativeAcceptance(accepted);
      if (readLatestDispatchFailureCode(db, sent.delivery_id) === 'native_message_too_large') {
        throw new AgentNativeMessageTooLargeError();
      }
      throw new AgentRecipientUnavailableError();
    }
  } catch (error) {
    if (
      error instanceof AgentRecipientUnavailableError
      || error instanceof AgentNativeMessageTooLargeError
    ) throw error;
    if (error instanceof AgentRouterError) {
      // Preserve protocol/identity errors: they indicate a broken or skewed
      // router, not an unreachable socket. Connection-level failures are the
      // only router errors that should use the sender-side reachability code.
      if (!['timeout', 'connection_closed'].includes(error.code)) throw error;
    }
    throw new AgentRouterUnavailableError();
  }

  const accepted = readHostAccept(db, sent.delivery_id);
  if (!accepted) throw new AgentRecipientUnavailableError();
  return nativeAcceptance(accepted);
}

function readLatestDispatchFailureCode(
  db: MemeshDatabase,
  deliveryId: string,
): string | undefined {
  const row = db.prepare(`
    SELECT failure_code
    FROM agent_dispatch_attempts
    WHERE delivery_id = ? AND result = 'adapter_rejected' AND failure_code IS NOT NULL
    ORDER BY attempt_number DESC
    LIMIT 1
  `).get(deliveryId) as { failure_code: string } | undefined;
  return row?.failure_code;
}

function receiptDetail(
  note: string | undefined,
  context: AgentMessageTransportContext,
): AgentJsonObject {
  return {
    transport: context.transport,
    source_host: context.sourceHost,
    ...(note ? { note } : {}),
  };
}

function resolveCanonicalDelivery(
  db: MemeshDatabase,
  project: string,
  recipient: string,
  messageId: string,
): CanonicalDeliveryScope {
  const delivery = db.prepare(`
    SELECT delivery_id, message_id, project, recipient, target_kind, intended_session
    FROM agent_message_deliveries
    WHERE project = ? AND recipient = ? AND message_id = ?
  `).get(project, recipient, messageId) as CanonicalDeliveryScope | undefined;
  if (!delivery) {
    throw new AgentMessageAccessError(
      `Agent message ${messageId} is not available to recipient ${recipient} in project ${project}.`,
    );
  }
  return delivery;
}

function readHostAccept(db: MemeshDatabase, deliveryId: string): HostAcceptRow | undefined {
  return db.prepare(`
    SELECT rowid AS fact_order, host_accept_id, attempt_id, delivery_id, adapter_kind, receipt_json, created_at
    FROM agent_host_accepts
    WHERE delivery_id = ?
  `).get(deliveryId) as HostAcceptRow | undefined;
}

function recordPublicAck(
  db: MemeshDatabase,
  input: Extract<AgentMessageActionInput, { action: 'ack' }>,
  context: AgentMessageTransportContext,
) {
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

function recordPublicWorkflow(
  db: MemeshDatabase,
  input: Extract<AgentMessageActionInput, { action: 'disposition' }>,
  context: AgentMessageTransportContext,
) {
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

// One read transaction, so the facts and the observed delivery state are one snapshot.
function readPublicReceipts(
  db: MemeshDatabase,
  input: Extract<AgentMessageActionInput, { action: 'receipts' }>,
): ProjectedFact[] {
  return db.transaction(() => readPublicReceiptsSnapshot(db, input))();
}

function readPublicReceiptsSnapshot(
  db: MemeshDatabase,
  input: Extract<AgentMessageActionInput, { action: 'receipts' }>,
): ProjectedFact[] {
  const delivery = resolveCanonicalDelivery(db, input.project, input.recipient, input.message_id);
  const projected: Array<{ fact: ProjectedFact; rank: number; order: number }> = [];

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
  `).all(delivery.delivery_id) as AckFactRow[];
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
  `).all(delivery.delivery_id) as WorkflowFactRow[];
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

function readDeliveryState(db: MemeshDatabase, delivery: CanonicalDeliveryScope): DeliveryState {
  const observedAtMs = Date.now();
  const intake = db.prepare(`
    SELECT 1 FROM agent_message_receipts
    WHERE project = ? AND recipient = ? AND message_id = ? AND receipt_kind = 'intake'
    LIMIT 1
  `).get(delivery.project, delivery.recipient, delivery.message_id) === undefined ? 'pending' : 'recorded';
  const observed_at = new Date(observedAtMs).toISOString();
  const session = delivery.target_kind === 'session' ? delivery.recipient : delivery.intended_session;
  if (session === null) return { observed_at, intake, target_session: 'not_applicable' };
  return { observed_at, intake, target_session: sessionLiveness(db, delivery.project, session, observedAtMs), session };
}

/** Live through any id in the session's alias chain; a session no registry row names is `unknown`, never `not_live`. */
function sessionLiveness(
  db: MemeshDatabase,
  project: string,
  session: string,
  observedAtMs: number,
): DeliveryState['target_session'] {
  const ids = [...sessionAliasChain(db, session)];
  const marks = ids.map(() => '?').join(', ');
  try {
    const registered = db.prepare(`
      SELECT 1 FROM agent_session_instances WHERE project = ? AND session_instance_id IN (${marks}) LIMIT 1
    `).get(project, ...ids) !== undefined;
    if (!registered) return 'unknown';
    const live = db.prepare(`
      SELECT 1 FROM agent_session_connections
      WHERE project = ? AND session_instance_id IN (${marks})
        AND disconnected_at IS NULL AND lease_expires_at_ms > ?
      LIMIT 1
    `).get(project, ...ids, observedAtMs) !== undefined;
    return live ? 'live' : 'not_live';
  } catch (error) {
    if (/no such table: agent_session_(instances|connections)\b/.test(error instanceof Error ? error.message : '')) return 'unknown';
    throw error;
  }
}

function projectHostAccept(delivery: CanonicalDeliveryScope, fact: HostAcceptRow): ProjectedFact {
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

function projectAckFact(delivery: CanonicalDeliveryScope, fact: AgentAckFact): ProjectedFact {
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

function projectWorkflowFact(delivery: CanonicalDeliveryScope, fact: AgentWorkflowFact): ProjectedFact {
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

function parseStoredObject(raw: string, label: string): AgentJsonObject {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as AgentJsonObject;
    }
  } catch {
    // Fall through to one stable storage-corruption error below.
  }
  throw new AgentMessagingError(`Invalid stored JSON object in ${label}.`);
}

/**
 * #497 `fallback_to_principal`: the exact session refused a session send, so
 * send the same message to that session's principal, meant for that session
 * (`intended_session`). Only that session is then reminded of it, and only it
 * can record intake. The refused session delivery stays durable, as it does
 * without the flag.
 *
 * The principal is the one the session registered under in this project. A
 * session the router has never registered has no known principal, so there
 * is nothing to fall back to: the refusal is raised, saying so.
 *
 * The fallback's idempotency key is derived from the caller's, so a retry of
 * the same call returns the same principal message instead of a second one.
 *
 * Only the intended session can take the fallback in. When it is not
 * connected now, the sender is told so (#518): if that session has ended for
 * good, no session will ever take the message, and the sender should know.
 */
function sendPrincipalFallback(
  db: MemeshDatabase,
  message: Omit<SendAgentMessageInput, 'recipient' | 'target_kind' | 'intended_session'>,
  refused: { message_id: string; delivery_id: string; project: string; recipient: string },
) {
  const session = db.prepare(`
    SELECT principal_id FROM agent_session_instances WHERE project = ? AND session_instance_id = ?
  `).get(refused.project, refused.recipient) as { principal_id: string } | undefined;
  if (!session) {
    throw new AgentRecipientUnavailableError(
      `There is no principal fallback: session ${JSON.stringify(refused.recipient)} has never registered in project `
      + `${jsonStringLiteral(refused.project)}, so its principal is unknown. Send to the principal yourself with `
      + `intended_session ${JSON.stringify(refused.recipient)}.`,
    );
  }
  let fallback: SentAgentMessage;
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
  } catch (error) {
    // A Codex session: keep the sender's answer the refusal it got, and say why
    // there is no fallback, rather than a bare validation error.
    if (error instanceof AgentIntendedSessionUnsupportedError) {
      throw new AgentRecipientUnavailableError(`There is no principal fallback: ${error.message}`);
    }
    throw error;
  }
  const connected = db.prepare(`
    SELECT 1 FROM agent_session_connections
    WHERE project = ? AND session_instance_id = ? AND disconnected_at IS NULL AND lease_expires_at_ms > ?
    LIMIT 1
  `).get(refused.project, refused.recipient, Date.now()) !== undefined;
  return {
    ...fallback,
    fallback: {
      reason: 'recipient_unavailable',
      intended_session_connected: connected,
      ...(connected ? {} : {
        note: `Session ${refused.recipient} is not connected now. Only it can take this message in, the next time it runs; `
          + `no other session of ${session.principal_id} will. If it has ended for good, send to ${session.principal_id} `
          + 'without intended_session instead.',
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

/**
 * One transport-neutral dispatcher for the public message lifecycle.
 *
 * The Zod union owns conditional fields for MCP, HTTP, and CLI alike.  Host
 * Cooperative provenance context and receipt actors are supplied by the
 * calling adapter rather than copied from message payload data. They describe
 * the local transport path; they do not authenticate a human or model identity.
 * Read actions deliberately do not write intake or acknowledgement receipts.
 */
export async function executeAgentMessageAction(
  db: MemeshDatabase,
  rawInput: unknown,
  context: AgentMessageTransportContext,
  dependencies: AgentMessageTransportDependencies = {},
): Promise<unknown> {
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
      if (sent.target_kind !== 'session') return sent;
      try {
        return {
          ...sent,
          native_delivery: await requireExactSessionNativeAcceptance(db, sent, dependencies),
        };
      } catch (error) {
        if (input.fallback_to_principal !== true || !(error instanceof AgentRecipientUnavailableError)) throw error;
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
      const request: AgentRouterDiscoverRequest = {
        version: AGENT_ROUTER_PROTOCOL_VERSION,
        type: 'discover',
        request_id: randomUUID(),
        project: input.project,
        limit: input.limit,
        hops: 0,
      };
      // Discovery is deliberately router-only: it neither reads nor writes
      // durable message state, and router failures remain explicit errors —
      // never a silently empty directory. Connection-level failures are
      // translated into an actionable error the same way requireExactSessionNativeAcceptance
      // translates them for `send`; a protocol/identity error (a broken or
      // skewed router, not an unreachable one) still passes through unchanged.
      try {
        return await (dependencies.sendRouterRequest ?? sendAgentRouterRequest)(
          routerSocketPath(),
          request,
        );
      } catch (error) {
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
