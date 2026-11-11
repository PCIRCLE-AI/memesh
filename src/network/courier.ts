// The bridge's message work, without any transport: which local deliveries go to
// another machine, the frame each one becomes, what an answer does to it, and what
// a frame from a member becomes here. Messages are stored and read only through
// the existing message store, so retries, loop limits and notification are its own.
//
// What crosses is the message an agent sent and the least routing data. Nothing
// here reads a memory table, a work summary or a title.

import { createHash } from 'node:crypto';
import type { MemeshDatabase } from '../storage/sqlite.js';
import {
  AgentConversationLoopError,
  AgentIdempotencyConflictError,
  AgentMessagingError,
  agentHostKind,
  agentSessionHandle,
  resolveAgentSessionHandle,
  sendAgentMessage,
  type AgentContentType,
  type AgentJsonValue,
  type AgentMessagePostCommitNotifier,
} from '../core/agent-messaging.js';
import { parseSqliteUtcMs, sqliteUtcToIso } from '../core/time-utils.js';
import { formatNetworkAddress, isLocalSenderName, parseNetworkAddress, projectHash } from './address.js';
import {
  FRAME_VERSION, type Ack, type MessageFrame, type PresenceEntry, type PresenceFrame,
} from './frames.js';
import { PRESENCE_TTL_MS } from './outbound.js';
import type { NetworkConfig } from './store.js';
import type { Roster, RosterMember } from './types.js';

export const DELIVERY_WINDOW_MS = 24 * 60 * 60_000;
const BACKOFF_FIRST_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
export const NOTICE_SENDER = 'memesh-network';

export interface Joined { config: NetworkConfig; roster: Roster }

export interface OutboxEntry {
  delivery_id: string;
  message_id: string;
  machine_id: string;
  attempts: number;
  expires_at_ms: number;
}

function hasTable(db: MemeshDatabase, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/** The message tables come from MeMesh's own database open; the bridge never creates them. */
export function messagingAvailable(db: MemeshDatabase): boolean {
  return hasTable(db, 'agent_messages') && hasTable(db, 'agent_message_deliveries');
}

/**
 * Take in every principal delivery addressed `person/target@machine` that has no
 * outbox row yet. One whose machine is not a member stays an ordinary local
 * delivery and is marked `local` so it is not looked at again.
 */
export function enqueueOutgoing(db: MemeshDatabase, joined: Joined, now: number): number {
  const rows = db.prepare(`
    SELECT d.delivery_id, d.message_id, d.recipient, m.created_at
    FROM agent_message_deliveries d
    JOIN agent_messages m ON m.message_id = d.message_id
    LEFT JOIN agent_network_outbox o ON o.delivery_id = d.delivery_id
    WHERE o.delivery_id IS NULL AND d.target_kind = 'principal' AND d.recipient LIKE '%/%@%'
  `).all() as Array<{ delivery_id: string; message_id: string; recipient: string; created_at: string }>;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO agent_network_outbox (delivery_id, message_id, machine_id, state, next_attempt_at_ms, expires_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  let taken = 0;
  for (const row of rows) {
    const address = parseNetworkAddress(row.recipient);
    const member = address && joined.roster.members.find((candidate) => candidate.name === address.machine);
    const createdAt = parseSqliteUtcMs(row.created_at) ?? now;
    // A message older than the membership was sent before this address could mean
    // another machine: it was meant for a local recipient of that name, and stays one.
    // (created_at has whole seconds, so the comparison allows the second it started in.)
    const self = joined.roster.members.find((candidate) => candidate.machine_id === joined.config.machine_id);
    const since = Math.max(Date.parse(self?.joined_at ?? ''), Date.parse(member?.joined_at ?? '')) || 0;
    const olderThanMembership = createdAt + 1_000 <= since;
    if (!member || member.machine_id === joined.config.machine_id || member.person !== address?.person || olderThanMembership) {
      insert.run(row.delivery_id, row.message_id, null, 'local', 0, createdAt + DELIVERY_WINDOW_MS);
      continue;
    }
    insert.run(row.delivery_id, row.message_id, member.machine_id, 'pending', now, createdAt + DELIVERY_WINDOW_MS);
    taken++;
  }
  return taken;
}

/** The machines that have a message due now, each handled on its own so one cannot hold up another. */
export function dueMachines(db: MemeshDatabase, now: number): string[] {
  return (db.prepare(`
    SELECT DISTINCT machine_id FROM agent_network_outbox
    WHERE state = 'pending' AND next_attempt_at_ms <= ? AND expires_at_ms > ? AND machine_id IS NOT NULL
  `).all(now, now) as Array<{ machine_id: string }>).map((row) => row.machine_id);
}

/** One machine's due messages, oldest due first, so its order is kept. */
export function dueOutgoingFor(db: MemeshDatabase, machineId: string, now: number, limit = 20): OutboxEntry[] {
  return db.prepare(`
    SELECT delivery_id, message_id, machine_id, attempts, expires_at_ms FROM agent_network_outbox
    WHERE state = 'pending' AND machine_id = ? AND next_attempt_at_ms <= ? AND expires_at_ms > ?
    ORDER BY next_attempt_at_ms, rowid LIMIT ?
  `).all(machineId, now, now, limit) as unknown as OutboxEntry[];
}

/** A member just showed up: try what is waiting for it now, not at its next backoff. */
export function retryNowFor(db: MemeshDatabase, machineId: string, now: number): void {
  db.prepare(`UPDATE agent_network_outbox SET next_attempt_at_ms = ? WHERE state = 'pending' AND machine_id = ?`).run(now, machineId);
}

interface MessageRow {
  message_id: string;
  project: string;
  sender: string;
  recipient: string;
  content_type: string;
  correlation_id: string | null;
  reply_to_message_id: string | null;
  payload_json: string;
  payload_tombstoned_at: string | null;
  created_at: string;
  idempotency_key: string | null;
}

/**
 * The frame for one delivery: the message's own row and nothing else.
 * A string means it can never be sent, with that code.
 */
export function buildMessageFrame(db: MemeshDatabase, joined: Joined, entry: OutboxEntry): MessageFrame | string {
  const row = db.prepare(`
    SELECT m.message_id, m.project, m.sender, d.recipient, m.content_type, m.correlation_id, m.reply_to_message_id,
           m.payload_json, m.payload_tombstoned_at, m.created_at,
           (SELECT i.idempotency_key FROM agent_message_idempotency i WHERE i.message_id = m.message_id LIMIT 1) AS idempotency_key
    FROM agent_message_deliveries d JOIN agent_messages m ON m.message_id = d.message_id
    WHERE d.delivery_id = ?
  `).get(entry.delivery_id) as MessageRow | undefined;
  if (!row) return 'message_gone';
  if (row.payload_tombstoned_at !== null) return 'payload_removed';
  if (!isLocalSenderName(row.sender)) return 'sender_not_local';
  const address = parseNetworkAddress(row.recipient);
  if (!address || row.idempotency_key === null) return 'message_invalid';
  return {
    version: FRAME_VERSION,
    kind: 'message',
    project_hash: projectHash(joined.config.network_id, row.project),
    sender: row.sender,
    target: address.target,
    target_kind: 'principal',
    idempotency_key: row.idempotency_key,
    content_type: row.content_type as AgentContentType,
    payload: JSON.parse(row.payload_json) as AgentJsonValue,
    correlation_id: row.correlation_id,
    reply_to_origin: replyToOrigin(db, row.reply_to_message_id),
    origin_message_id: row.message_id,
    created_at: sqliteUtcToIso(row.created_at),
  };
}

/** A local reply to a message that came over the network carries that message's id on the sending machine back. */
function replyToOrigin(db: MemeshDatabase, replyTo: string | null): string | null {
  if (replyTo === null) return null;
  const row = db.prepare('SELECT provenance_json FROM agent_messages WHERE message_id = ?').get(replyTo) as { provenance_json: string } | undefined;
  if (!row) return null;
  try {
    const provenance = JSON.parse(row.provenance_json) as { via?: unknown; origin_message_id?: unknown };
    return provenance.via === 'network' && typeof provenance.origin_message_id === 'string' ? provenance.origin_message_id : null;
  } catch {
    return null;
  }
}

function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
}

export type Outcome = 'delivered' | 'rejected' | 'pending' | 'expired';

/** What one attempt did. Rejected and expired tell the original sender. */
export function recordAttempt(
  db: MemeshDatabase,
  entry: OutboxEntry,
  result: { ack?: Ack; failure?: string; path?: string | null },
  now: number,
  notifier?: AgentMessagePostCommitNotifier,
): Outcome {
  const attempts = entry.attempts + 1;
  const ack = result.ack;
  if (ack && (ack.result === 'accepted' || ack.result === 'duplicate')) {
    db.prepare(`
      UPDATE agent_network_outbox SET state = 'delivered', attempts = ?, delivered_at_ms = ?, path = ?, last_error_code = NULL
      WHERE delivery_id = ?
    `).run(attempts, now, result.path ?? null, entry.delivery_id);
    return 'delivered';
  }
  if (ack?.result === 'rejected') {
    db.prepare(`UPDATE agent_network_outbox SET state = 'rejected', attempts = ?, last_error_code = ? WHERE delivery_id = ?`)
      .run(attempts, ack.code ?? 'rejected', entry.delivery_id);
    notifySender(db, entry.delivery_id, 'rejected', ack.code ?? 'rejected', notifier);
    return 'rejected';
  }
  const code = ack?.code ?? result.failure ?? 'unreachable';
  if (now + backoffMs(attempts) >= entry.expires_at_ms) {
    db.prepare(`UPDATE agent_network_outbox SET state = 'expired', attempts = ?, last_error_code = ? WHERE delivery_id = ?`)
      .run(attempts, code, entry.delivery_id);
    notifySender(db, entry.delivery_id, 'expired', code, notifier);
    return 'expired';
  }
  db.prepare(`UPDATE agent_network_outbox SET attempts = ?, last_error_code = ?, next_attempt_at_ms = ? WHERE delivery_id = ?`)
    .run(attempts, code, now + backoffMs(attempts), entry.delivery_id);
  return 'pending';
}

/** Never sendable, from the start: told to the sender like a rejection. */
export function recordUnsendable(db: MemeshDatabase, entry: OutboxEntry, code: string, notifier?: AgentMessagePostCommitNotifier): void {
  db.prepare(`UPDATE agent_network_outbox SET state = 'rejected', last_error_code = ? WHERE delivery_id = ?`).run(code, entry.delivery_id);
  notifySender(db, entry.delivery_id, 'rejected', code, notifier);
}

/** Pending past its day, without an attempt to notice it (the other machine never came back). */
export function expireOverdue(db: MemeshDatabase, now: number, notifier?: AgentMessagePostCommitNotifier): number {
  const overdue = db.prepare(`SELECT delivery_id, last_error_code FROM agent_network_outbox WHERE state = 'pending' AND expires_at_ms <= ?`)
    .all(now) as Array<{ delivery_id: string; last_error_code: string | null }>;
  for (const row of overdue) {
    db.prepare(`UPDATE agent_network_outbox SET state = 'expired' WHERE delivery_id = ?`).run(row.delivery_id);
    notifySender(db, row.delivery_id, 'expired', row.last_error_code ?? 'unreachable', notifier);
  }
  return overdue.length;
}

function notifySender(db: MemeshDatabase, deliveryId: string, state: 'rejected' | 'expired', code: string, notifier?: AgentMessagePostCommitNotifier): void {
  const row = db.prepare(`
    SELECT m.message_id, m.project, m.sender, d.recipient FROM agent_message_deliveries d
    JOIN agent_messages m ON m.message_id = d.message_id WHERE d.delivery_id = ?
  `).get(deliveryId) as { message_id: string; project: string; sender: string; recipient: string } | undefined;
  if (!row) return;
  const what = state === 'expired'
    ? `was not delivered: ${row.recipient.split('@').pop()} did not take it within one day`
    : `was refused by ${row.recipient.split('@').pop()}`;
  sendAgentMessage(db, {
    project: row.project,
    sender: NOTICE_SENDER,
    recipient: row.sender,
    target_kind: 'principal',
    idempotency_key: `memesh-network:${state}:${deliveryId}`,
    content_type: 'text/plain',
    payload: `Your message ${row.message_id} to ${row.recipient} ${what}. Codes: state=${state}, code=${code}.`,
    reply_to: row.message_id,
    provenance: { via: 'network-notice', delivery_id: deliveryId, state, code },
  }, { ...(notifier ? { notifier } : {}) });
}

function localProjects(db: MemeshDatabase): string[] {
  // Each statement is written out, so every table read here can be seen in the code.
  const projects = new Set<string>();
  const add = (rows: unknown[]): void => { for (const row of rows as Array<{ project: string }>) projects.add(row.project); };
  if (hasTable(db, 'agent_session_instances')) add(db.prepare('SELECT DISTINCT project FROM agent_session_instances').all());
  if (hasTable(db, 'agent_session_connections')) add(db.prepare('SELECT DISTINCT project FROM agent_session_connections').all());
  if (hasTable(db, 'agent_principals')) add(db.prepare('SELECT DISTINCT project FROM agent_principals').all());
  if (hasTable(db, 'agent_messages')) add(db.prepare('SELECT DISTINCT project FROM agent_messages').all());
  return [...projects];
}

/**
 * A message frame from a verified member becomes a local message. Its sender is
 * written from the roster, never from the frame. Inbound rules come in a later
 * slice: this is where a message from a member could be held or refused; for now
 * every verified member is accepted.
 */
export function receiveMessage(
  db: MemeshDatabase,
  joined: Joined,
  member: RosterMember,
  frame: MessageFrame,
  notifier?: AgentMessagePostCommitNotifier,
): Ack {
  if (!messagingAvailable(db)) return { result: 'retry', code: 'messaging_unavailable' };
  const project = localProjects(db).find((candidate) => projectHash(joined.config.network_id, candidate) === frame.project_hash);
  if (project === undefined) return { result: 'rejected', code: 'project_unknown' };
  let target: { recipient: string; target_kind: 'principal' | 'session'; intended_session?: string };
  try {
    target = resolveAgentSessionHandle(db, project, frame.target);
  } catch {
    target = { recipient: frame.target, target_kind: 'principal' };
  }
  const replyTo = frame.reply_to_origin !== null
    && db.prepare('SELECT 1 FROM agent_messages WHERE message_id = ?').get(frame.reply_to_origin) !== undefined
    ? frame.reply_to_origin : null;
  try {
    const sent = sendAgentMessage(db, {
      project,
      sender: formatNetworkAddress(member.person, frame.sender, member.name),
      ...target,
      idempotency_key: frame.idempotency_key,
      payload: frame.payload,
      content_type: frame.content_type,
      correlation_id: frame.correlation_id,
      reply_to: replyTo,
      provenance: { via: 'network', from_machine: member.name, origin_message_id: frame.origin_message_id },
    }, { ...(notifier ? { notifier } : {}) });
    return { result: sent.reused ? 'duplicate' : 'accepted' };
  } catch (err) {
    if (err instanceof AgentIdempotencyConflictError) return { result: 'rejected', code: 'idempotency_conflict' };
    if (err instanceof AgentConversationLoopError) return { result: 'rejected', code: 'loop_limit' };
    if (err instanceof AgentMessagingError) return { result: 'rejected', code: 'message_invalid' };
    throw err;
  }
}

/** Live sessions here, as presence: project hash, principal, handle, host kind, connected. Nothing else. */
export function localPresence(db: MemeshDatabase, joined: Joined, now: number): PresenceEntry[] {
  if (!hasTable(db, 'agent_session_connections')) return [];
  const rows = db.prepare(`
    SELECT project, principal_id, session_instance_id, adapter_kind FROM agent_session_connections
    WHERE disconnected_at IS NULL AND lease_expires_at_ms > ?
  `).all(now) as Array<{ project: string; principal_id: string; session_instance_id: string; adapter_kind: string }>;
  const entries = new Map<string, PresenceEntry>();
  for (const row of rows) {
    const handle = agentSessionHandle(row.project, row.adapter_kind, row.session_instance_id);
    const entry: PresenceEntry = {
      project_hash: projectHash(joined.config.network_id, row.project),
      principal: row.principal_id,
      handle,
      host_kind: agentHostKind(row.adapter_kind),
      connected: true,
    };
    entries.set(`${entry.project_hash}:${handle}`, entry);
  }
  return [...entries.values()].slice(0, 256);
}

/** What a member says is live there replaces what it said before, and lapses on its own. */
export function receivePresence(db: MemeshDatabase, member: RosterMember, frame: PresenceFrame, now: number): void {
  db.transaction(() => {
    db.prepare('DELETE FROM agent_network_presence WHERE machine_id = ?').run(member.machine_id);
    const insert = db.prepare(`
      INSERT OR REPLACE INTO agent_network_presence (machine_id, project_hash, principal, handle, host_kind, connected, expires_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const entry of frame.entries) {
      insert.run(member.machine_id, entry.project_hash, entry.principal, entry.handle, entry.host_kind, entry.connected ? 1 : 0, now + PRESENCE_TTL_MS);
    }
    rememberPeer(db, member.machine_id, frame.relay, frame.addrs, now);
  }).immediate();
}

export function rememberPeer(db: MemeshDatabase, machineId: string, relay: string | null, addrs: string[], now: number): void {
  db.prepare(`
    INSERT INTO agent_network_peers (machine_id, relay_url, addrs_json, seen_at_ms) VALUES (?, ?, ?, ?)
    ON CONFLICT(machine_id) DO UPDATE SET relay_url = excluded.relay_url, addrs_json = excluded.addrs_json, seen_at_ms = excluded.seen_at_ms
  `).run(machineId, relay, JSON.stringify(addrs), now);
}

export function peerRoute(db: MemeshDatabase, machineId: string): { relay: string | null; addrs: string[] } | null {
  const row = db.prepare('SELECT relay_url, addrs_json FROM agent_network_peers WHERE machine_id = ?').get(machineId) as
    { relay_url: string | null; addrs_json: string } | undefined;
  if (!row) return null;
  try {
    return { relay: row.relay_url, addrs: JSON.parse(row.addrs_json) as string[] };
  } catch {
    return { relay: row.relay_url, addrs: [] };
  }
}

/** A short, stable label for a frame in logs: never its content. */
export function frameLabel(frame: { kind: string; origin_message_id?: string }): string {
  return frame.kind === 'message' ? `message ${createHash('sha256').update(String(frame.origin_message_id)).digest('hex').slice(0, 12)}` : frame.kind;
}
