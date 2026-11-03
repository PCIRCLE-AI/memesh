import fs from 'node:fs';
import type { MemeshDatabase } from '../storage/sqlite.js';
import { agentMessageExpiryCutoff } from './agent-message-ttl.js';

export interface AgentMessageStorageReportOptions {
  /** Optional known database path. Stat failures are reported as null, never thrown. */
  databasePath?: string;
  /** The clock for what counts as past its one-day lifetime. Tests only. */
  nowMs?: number;
}

export interface AgentMessageStorageReport {
  message_count: number;
  delivery_count: number;
  event_count: number;
  receipt_count: number;
  cursor_count: number;
  principal_count: number;
  session_instance_count: number;
  session_connection_count: number;
  presence_fact_count: number;
  dispatch_attempt_count: number;
  host_accept_count: number;
  ack_fact_count: number;
  workflow_fact_count: number;
  retention_fact_count: number;
  payload_bytes: number;
  original_payload_bytes: number;
  tombstoned_message_count: number;
  protected_unresolved_message_count: number;
  terminal_retained_message_count: number;
  /** Past their one-day lifetime and not yet deleted by the expiry pass (readers already treat them as gone). */
  expired_pending_message_count: number;
  reconciled_message_count: number;
  page_count: number;
  page_size: number;
  freelist_count: number;
  allocated_database_bytes: number;
  reusable_freelist_bytes: number;
  database_file_bytes: number | null;
  wal_file_bytes: number | null;
}

export interface AgentMessageStorageQuotaInput {
  /** The deterministic logical message-payload budget, in UTF-8 bytes. */
  quotaBytes: number;
  /** Exact UTF-8 byte length of the canonical payload about to be inserted. */
  additionalPayloadBytes: number;
}

/** Stable error base for callers that need to distinguish storage failures. */
export class AgentMessageStorageError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AgentMessageStorageError';
    this.code = code;
  }
}

/** Throw this from the canonical send transaction before writing any message rows. */
export class AgentMessageStorageQuotaExceededError extends AgentMessageStorageError {
  readonly quotaBytes: number;
  readonly usedBytes: number;
  readonly requestedBytes: number;

  constructor(quotaBytes: number, usedBytes: number, requestedBytes: number) {
    super('storage_quota_exceeded', 'Agent message storage quota exceeded. Review stored messages and the owner-configured quota before retrying.');
    this.name = 'AgentMessageStorageQuotaExceededError';
    this.quotaBytes = quotaBytes;
    this.usedBytes = usedBytes;
    this.requestedBytes = requestedBytes;
  }
}

/**
 * Read-only reconciliation for durable message storage. `page_count` is the
 * SQLite logical allocation high-watermark, not a promise that the main file
 * will shrink after messages are deleted; `freelist_count` is immediately reusable.
 */
export function getAgentMessageStorageReport(
  db: MemeshDatabase,
  options: AgentMessageStorageReportOptions,
): AgentMessageStorageReport {
  const states = readMessageStates(db, agentMessageExpiryCutoff(options.nowMs));
  const lifecycle = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM agent_message_deliveries) AS delivery_count,
      (SELECT COUNT(*) FROM agent_message_events) AS event_count,
      (SELECT COUNT(*) FROM agent_message_receipts) AS receipt_count,
      (SELECT COUNT(*) FROM agent_message_cursors) AS cursor_count,
      (SELECT COUNT(*) FROM agent_principals) AS principal_count,
      (SELECT COUNT(*) FROM agent_session_instances) AS session_instance_count,
      (SELECT COUNT(*) FROM agent_session_connections) AS session_connection_count,
      (SELECT COUNT(*) FROM agent_presence_facts) AS presence_fact_count,
      (SELECT COUNT(*) FROM agent_dispatch_attempts) AS dispatch_attempt_count,
      (SELECT COUNT(*) FROM agent_host_accepts) AS host_accept_count,
      (SELECT COUNT(*) FROM agent_ack_facts) AS ack_fact_count,
      (SELECT COUNT(*) FROM agent_workflow_facts) AS workflow_fact_count,
      (SELECT COUNT(*) FROM agent_retention_facts) AS retention_fact_count
  `).get() as LifecycleCounts;
  const pageCount = pragmaInteger(db, 'page_count');
  const pageSize = pragmaInteger(db, 'page_size');
  const freelistCount = pragmaInteger(db, 'freelist_count');

  return {
    message_count: states.message_count,
    delivery_count: lifecycle.delivery_count,
    event_count: lifecycle.event_count,
    receipt_count: lifecycle.receipt_count,
    cursor_count: lifecycle.cursor_count,
    principal_count: lifecycle.principal_count,
    session_instance_count: lifecycle.session_instance_count,
    session_connection_count: lifecycle.session_connection_count,
    presence_fact_count: lifecycle.presence_fact_count,
    dispatch_attempt_count: lifecycle.dispatch_attempt_count,
    host_accept_count: lifecycle.host_accept_count,
    ack_fact_count: lifecycle.ack_fact_count,
    workflow_fact_count: lifecycle.workflow_fact_count,
    retention_fact_count: lifecycle.retention_fact_count,
    payload_bytes: states.payload_bytes,
    original_payload_bytes: states.original_payload_bytes,
    tombstoned_message_count: states.tombstoned_message_count,
    protected_unresolved_message_count: states.protected_unresolved_message_count,
    terminal_retained_message_count: states.terminal_retained_message_count,
    expired_pending_message_count: states.expired_pending_message_count,
    reconciled_message_count: states.reconciled_message_count,
    page_count: pageCount,
    page_size: pageSize,
    freelist_count: freelistCount,
    allocated_database_bytes: pageCount * pageSize,
    reusable_freelist_bytes: freelistCount * pageSize,
    database_file_bytes: safeFileSize(options.databasePath),
    wal_file_bytes: options.databasePath ? safeFileSize(`${options.databasePath}-wal`) : null,
  };
}

/**
 * The quota check is intentionally transaction-local: call it from the same
 * immediate transaction as the canonical message insert. It neither prunes
 * rows nor mutates protected deliveries, so an exception rolls back a send
 * before message, delivery, event, idempotency, dispatch, or receipt effects.
 */
export function enforceAgentMessageStorageQuota(
  db: MemeshDatabase,
  input: AgentMessageStorageQuotaInput,
): void {
  const quotaBytes = normalizeNonNegativeInteger('quotaBytes', input.quotaBytes);
  const additionalPayloadBytes = normalizeNonNegativeInteger('additionalPayloadBytes', input.additionalPayloadBytes);
  const row = db.prepare(`
    SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) AS payload_bytes
    FROM agent_messages
  `).get() as { payload_bytes: number };
  const usedBytes = row.payload_bytes;
  if (usedBytes + additionalPayloadBytes > quotaBytes) {
    throw new AgentMessageStorageQuotaExceededError(quotaBytes, usedBytes, additionalPayloadBytes);
  }
}

/** Convenience for callers that hold canonical JSON rather than a byte count. */
export function agentMessagePayloadStorageBytes(payloadJson: string): number {
  if (typeof payloadJson !== 'string') {
    throw new AgentMessageStorageError('invalid_payload_storage_input', 'Agent message payload JSON must be a string.');
  }
  return Buffer.byteLength(payloadJson, 'utf8');
}

type LifecycleCounts = {
  delivery_count: number;
  event_count: number;
  receipt_count: number;
  cursor_count: number;
  principal_count: number;
  session_instance_count: number;
  session_connection_count: number;
  presence_fact_count: number;
  dispatch_attempt_count: number;
  host_accept_count: number;
  ack_fact_count: number;
  workflow_fact_count: number;
  retention_fact_count: number;
};

type MessageStateCounts = {
  message_count: number;
  payload_bytes: number;
  original_payload_bytes: number;
  tombstoned_message_count: number;
  protected_unresolved_message_count: number;
  terminal_retained_message_count: number;
  expired_pending_message_count: number;
  reconciled_message_count: number;
};

function readMessageStates(db: MemeshDatabase, expiryCutoff: string): MessageStateCounts {
  return db.prepare(`
    WITH workflow_candidates AS (
      SELECT delivery_id, workflow_state, created_at
      FROM agent_workflow_facts
      UNION ALL
      SELECT d.delivery_id, json_extract(r.detail_json, '$.disposition') AS workflow_state,
        r.created_at
      FROM agent_message_receipts r
      JOIN agent_message_deliveries d
        ON d.message_id = r.message_id AND d.project = r.project AND d.recipient = r.recipient
      WHERE r.receipt_kind = 'disposition'
    ), ranked_workflow AS (
      SELECT delivery_id, workflow_state, created_at,
        DENSE_RANK() OVER (
          PARTITION BY delivery_id
          ORDER BY julianday(created_at) DESC
        ) AS time_rank
      FROM workflow_candidates
    ), latest_workflow AS (
      SELECT delivery_id,
        CASE WHEN SUM(CASE
          WHEN workflow_state IN ('completed', 'cancelled', 'rejected') THEN 0 ELSE 1
        END) = 0 THEN 1 ELSE 0 END AS is_terminal
      FROM ranked_workflow
      WHERE time_rank = 1
      GROUP BY delivery_id
    ), acknowledged_deliveries AS (
      SELECT delivery_id
      FROM agent_ack_facts
      UNION
      SELECT d.delivery_id
      FROM agent_message_receipts r
      JOIN agent_message_deliveries d
        ON d.message_id = r.message_id AND d.project = r.project AND d.recipient = r.recipient
      WHERE r.receipt_kind = 'ack'
    ), delivery_states AS (
      SELECT d.message_id,
        COUNT(*) AS delivery_count,
        SUM(CASE WHEN acknowledged_deliveries.delivery_id IS NOT NULL THEN 1 ELSE 0 END) AS acknowledged_count,
        SUM(CASE WHEN lw.is_terminal = 1 THEN 1 ELSE 0 END) AS terminal_count
      FROM agent_message_deliveries d
      LEFT JOIN acknowledged_deliveries ON acknowledged_deliveries.delivery_id = d.delivery_id
      LEFT JOIN latest_workflow lw ON lw.delivery_id = d.delivery_id
      GROUP BY d.message_id
    ), message_states AS (
      SELECT m.message_id, length(CAST(m.payload_json AS BLOB)) AS payload_bytes,
        COALESCE(m.payload_original_bytes, length(CAST(m.payload_json AS BLOB))) AS original_payload_bytes,
        CASE
          WHEN m.payload_tombstoned_at IS NOT NULL THEN 'tombstoned'
          WHEN m.created_at < ? THEN 'expired'
          WHEN COALESCE(ds.delivery_count, 0) > 0
               AND ds.acknowledged_count = ds.delivery_count
               AND ds.terminal_count = ds.delivery_count THEN 'terminal_retained'
          ELSE 'protected'
        END AS storage_state
      FROM agent_messages m
      LEFT JOIN delivery_states ds ON ds.message_id = m.message_id
    )
    SELECT
      COUNT(*) AS message_count,
      COALESCE(SUM(payload_bytes), 0) AS payload_bytes,
      COALESCE(SUM(original_payload_bytes), 0) AS original_payload_bytes,
      COALESCE(SUM(storage_state = 'tombstoned'), 0) AS tombstoned_message_count,
      COALESCE(SUM(storage_state = 'protected'), 0) AS protected_unresolved_message_count,
      COALESCE(SUM(storage_state = 'terminal_retained'), 0) AS terminal_retained_message_count,
      COALESCE(SUM(storage_state = 'expired'), 0) AS expired_pending_message_count,
      COALESCE(SUM(storage_state IN ('tombstoned', 'expired', 'protected', 'terminal_retained')), 0) AS reconciled_message_count
    FROM message_states
  `).get(expiryCutoff) as MessageStateCounts;
}

function normalizeNonNegativeInteger(label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AgentMessageStorageError('invalid_storage_quota', `${label} must be a non-negative safe integer.`);
  }
  return value;
}

function pragmaInteger(db: MemeshDatabase, pragma: string): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, number>;
  const value = row[pragma];
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AgentMessageStorageError('invalid_storage_pragma', `SQLite PRAGMA ${pragma} returned an invalid value.`);
  }
  return value;
}

function safeFileSize(filePath: string | undefined): number | null {
  if (!filePath) return null;
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}
