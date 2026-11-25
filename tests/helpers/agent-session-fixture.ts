import { createHash, randomUUID } from 'crypto';
import fs from 'node:fs';
import { getDatabase } from '../../src/db.js';
import type { MemeshDatabase } from '../../src/storage/sqlite.js';

const legacySchema = fs.readFileSync(new URL('../fixtures/legacy-message-schema.sql', import.meta.url), 'utf8');

/** Historical rows only: this fixture never dispatches or validates a send. */
export function installLegacyMessageSchema(db: Pick<MemeshDatabase, 'exec'>): void { db.exec(legacySchema); }

export function seedLegacyMessage(db: MemeshDatabase, input: {
  project: string; sender: string; recipient: string; payload: unknown;
  content_type?: string; idempotency_key?: string; target_kind?: string; intended_session?: string | null;
  sender_host?: string | null; correlation_id?: string | null; reply_to?: string | null; privacy?: string; provenance?: unknown;
  [field: string]: unknown;
}) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_messages'").get()) installLegacyMessageSchema(db);
  const message_id: string = randomUUID(), delivery_id: string = randomUUID(), event_id: string = randomUUID();
  const created_at = new Date().toISOString(), payload = JSON.stringify(input.payload);
  const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  db.prepare('INSERT INTO agent_messages(message_id,project,sender,sender_host,recipient,content_type,correlation_id,reply_to_message_id,privacy,payload_json,provenance_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(message_id, input.project, input.sender, input.sender_host ?? null, input.recipient,
      input.content_type ?? 'application/json', input.correlation_id ?? null, input.reply_to ?? null,
      input.privacy ?? 'private', payload, JSON.stringify(input.provenance ?? {}), created_at);
  db.prepare('INSERT INTO agent_message_deliveries(delivery_id,message_id,project,recipient,target_kind,intended_session,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(delivery_id, message_id, input.project, input.recipient, input.target_kind ?? 'principal', input.intended_session ?? null, created_at);
  const event = db.prepare('INSERT INTO agent_message_events(event_id,message_id,delivery_id,project,recipient,event_kind,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(event_id, message_id, delivery_id, input.project, input.recipient, 'notification', created_at);
  db.prepare('INSERT INTO agent_message_idempotency(project,sender,idempotency_key,request_hash,message_id,created_at) VALUES (?,?,?,?,?,?)')
    .run(input.project, input.sender, input.idempotency_key ?? randomUUID(), requestHash, message_id, created_at);
  return { ...input, message_id, delivery_id, event_id, event_sequence: Number(event.lastInsertRowid), created_at, reused: false };
}

export function seedLegacyReceipt(db: MemeshDatabase, input: {
  project: string; recipient: string; message_id: string; receipt_kind: string; actor: string;
  idempotency_key: string; detail?: unknown; [field: string]: unknown;
}) {
  const receipt_id = randomUUID(), created_at = new Date().toISOString();
  db.prepare('INSERT INTO agent_message_receipts(receipt_id,message_id,project,recipient,receipt_kind,actor,idempotency_key,request_hash,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(receipt_id, input.message_id, input.project, input.recipient, input.receipt_kind, input.actor,
      input.idempotency_key, createHash('sha256').update(JSON.stringify(input)).digest('hex'), JSON.stringify(input.detail ?? {}), created_at);
  return { ...input, receipt_id, created_at };
}

/**
 * Registers a session instance and its connection row — the same shape
 * agent-router.ts writes — so a `target_kind: "session"` delivery can be
 * matched against real "is this session live" state (#490). Live by default;
 * `disconnected` or a past `leaseExpiresAtMs` makes it dead. `sessionId`
 * pins the id, so a test can name the same session A in the router, the
 * core query and the hook payload (#497); `adapterKind` says which host
 * registered it (only a `claude-channel` session can be an intended_session).
 */
export function registerAgentSession(
  project: string,
  principalId: string,
  overrides: { disconnected?: boolean; leaseExpiresAtMs?: number; sessionId?: string; adapterKind?: string } = {},
): string {
  const sessionId = overrides.sessionId ?? `session-${randomUUID()}`;
  const db = getDatabase();
  installLegacyMessageSchema(db);
  db.prepare(`
    INSERT OR IGNORE INTO agent_principals (project, principal_id, activation_event_sequence)
    VALUES (?, ?, 0)
  `).run(project, principalId);
  db.prepare(`
    INSERT INTO agent_session_instances (project, session_instance_id, principal_id, adapter_kind)
    VALUES (?, ?, ?, ?)
  `).run(project, sessionId, principalId, overrides.adapterKind ?? 'test-adapter');
  db.prepare(`
    INSERT INTO agent_session_connections (
      connection_id, project, principal_id, session_instance_id, generation,
      adapter_kind, router_instance_id, lease_expires_at_ms, disconnected_at
    ) VALUES (?, ?, ?, ?, 1, ?, 'test-router', ?, ?)
  `).run(
    `connection-${randomUUID()}`, project, principalId, sessionId, overrides.adapterKind ?? 'test-adapter',
    overrides.leaseExpiresAtMs ?? Date.now() + 60_000,
    overrides.disconnected ? new Date().toISOString() : null,
  );
  return sessionId;
}

/** Sends a `target_kind: "session"` delivery addressed to `sessionId`. */
export function sendSessionTargetedMessage(project: string, sessionId: string, idempotencyKey: string) {
  return seedLegacyMessage(getDatabase(), {
    project,
    sender: 'codex-reviewer',
    recipient: sessionId,
    target_kind: 'session',
    idempotency_key: idempotencyKey,
    payload: { text: 'review is done' },
    content_type: 'application/json',
  });
}

/**
 * #497: a principal-targeted delivery that names the one session it is meant
 * for — what a refused `target_kind: "session"` send falls back to.
 */
export function sendIntendedPrincipalMessage(
  project: string,
  principalId: string,
  intendedSession: string,
  idempotencyKey: string,
) {
  return seedLegacyMessage(getDatabase(), {
    project,
    sender: 'codex-lead',
    recipient: principalId,
    target_kind: 'principal',
    intended_session: intendedSession,
    idempotency_key: idempotencyKey,
    payload: { text: 'work instruction for one session' },
    content_type: 'application/json',
  });
}
