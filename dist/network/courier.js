import { createHash } from 'node:crypto';
import { AgentConversationLoopError, AgentIdempotencyConflictError, AgentMessagingError, agentHostKind, agentSessionHandle, resolveAgentSessionHandle, sendAgentMessage, } from '../core/agent-messaging.js';
import { AGENT_MESSAGE_TTL_MS } from '../core/agent-message-ttl.js';
import { parseSqliteUtcMs, sqliteUtcToIso } from '../core/time-utils.js';
import { formatNetworkAddress, isLocalSenderName, parseNetworkAddress, projectHash } from './address.js';
import { FRAME_VERSION, } from './frames.js';
import { PRESENCE_TTL_MS } from './outbound.js';
export const DELIVERY_WINDOW_MS = AGENT_MESSAGE_TTL_MS;
const BACKOFF_FIRST_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
export const NOTICE_SENDER = 'memesh-network';
function hasTable(db, name) {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}
export function messagingAvailable(db) {
    return hasTable(db, 'agent_messages') && hasTable(db, 'agent_message_deliveries');
}
export function enqueueOutgoing(db, joined, now) {
    const rows = db.prepare(`
    SELECT d.delivery_id, d.message_id, d.recipient, m.created_at
    FROM agent_message_deliveries d
    JOIN agent_messages m ON m.message_id = d.message_id
    LEFT JOIN agent_network_outbox o ON o.delivery_id = d.delivery_id
    WHERE o.delivery_id IS NULL AND d.target_kind = 'principal' AND d.recipient LIKE '%/%@%'
  `).all();
    const insert = db.prepare(`
    INSERT OR IGNORE INTO agent_network_outbox (delivery_id, message_id, machine_id, state, next_attempt_at_ms, expires_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
    let taken = 0;
    for (const row of rows) {
        const address = parseNetworkAddress(row.recipient);
        const member = address && joined.roster.members.find((candidate) => candidate.name === address.machine);
        const createdAt = parseSqliteUtcMs(row.created_at) ?? now;
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
export function dueMachines(db, now) {
    return db.prepare(`
    SELECT DISTINCT machine_id FROM agent_network_outbox
    WHERE state = 'pending' AND next_attempt_at_ms <= ? AND expires_at_ms > ? AND machine_id IS NOT NULL
  `).all(now, now).map((row) => row.machine_id);
}
export function dueOutgoingFor(db, machineId, now, limit = 20) {
    return db.prepare(`
    SELECT delivery_id, message_id, machine_id, attempts, expires_at_ms FROM agent_network_outbox
    WHERE state = 'pending' AND machine_id = ? AND next_attempt_at_ms <= ? AND expires_at_ms > ?
    ORDER BY next_attempt_at_ms, rowid LIMIT ?
  `).all(machineId, now, now, limit);
}
export function retryNowFor(db, machineId, now) {
    db.prepare(`UPDATE agent_network_outbox SET next_attempt_at_ms = ? WHERE state = 'pending' AND machine_id = ?`).run(now, machineId);
}
export function buildMessageFrame(db, joined, entry) {
    const row = db.prepare(`
    SELECT m.message_id, m.project, m.sender, d.recipient, m.content_type, m.correlation_id, m.reply_to_message_id,
           m.payload_json, m.payload_tombstoned_at, m.created_at,
           (SELECT i.idempotency_key FROM agent_message_idempotency i WHERE i.message_id = m.message_id LIMIT 1) AS idempotency_key
    FROM agent_message_deliveries d JOIN agent_messages m ON m.message_id = d.message_id
    WHERE d.delivery_id = ?
  `).get(entry.delivery_id);
    if (!row)
        return 'message_gone';
    if (row.payload_tombstoned_at !== null)
        return 'payload_removed';
    if (!isLocalSenderName(row.sender))
        return 'sender_not_local';
    const address = parseNetworkAddress(row.recipient);
    if (!address || row.idempotency_key === null)
        return 'message_invalid';
    return {
        version: FRAME_VERSION,
        kind: 'message',
        project_hash: projectHash(joined.config.network_id, row.project),
        sender: row.sender,
        target: address.target,
        target_kind: 'principal',
        idempotency_key: row.idempotency_key,
        content_type: row.content_type,
        payload: JSON.parse(row.payload_json),
        correlation_id: row.correlation_id,
        reply_to_origin: replyToOrigin(db, row.reply_to_message_id),
        origin_message_id: row.message_id,
        created_at: sqliteUtcToIso(row.created_at),
    };
}
function replyToOrigin(db, replyTo) {
    if (replyTo === null)
        return null;
    const row = db.prepare('SELECT provenance_json FROM agent_messages WHERE message_id = ?').get(replyTo);
    if (!row)
        return null;
    try {
        const provenance = JSON.parse(row.provenance_json);
        return provenance.via === 'network' && typeof provenance.origin_message_id === 'string' ? provenance.origin_message_id : null;
    }
    catch {
        return null;
    }
}
function backoffMs(attempts) {
    return Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
}
export function recordAttempt(db, entry, result, now, notifier) {
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
export function recordUnsendable(db, entry, code, notifier) {
    db.prepare(`UPDATE agent_network_outbox SET state = 'rejected', last_error_code = ? WHERE delivery_id = ?`).run(code, entry.delivery_id);
    notifySender(db, entry.delivery_id, 'rejected', code, notifier);
}
export function expireOverdue(db, now, notifier) {
    const overdue = db.prepare(`SELECT delivery_id, last_error_code FROM agent_network_outbox WHERE state = 'pending' AND expires_at_ms <= ?`)
        .all(now);
    for (const row of overdue) {
        db.prepare(`UPDATE agent_network_outbox SET state = 'expired' WHERE delivery_id = ?`).run(row.delivery_id);
        notifySender(db, row.delivery_id, 'expired', row.last_error_code ?? 'unreachable', notifier);
    }
    return overdue.length;
}
function notifySender(db, deliveryId, state, code, notifier) {
    const row = db.prepare(`
    SELECT m.message_id, m.project, m.sender, d.recipient FROM agent_message_deliveries d
    JOIN agent_messages m ON m.message_id = d.message_id WHERE d.delivery_id = ?
  `).get(deliveryId);
    if (!row)
        return;
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
function localProjects(db) {
    const projects = new Set();
    const add = (rows) => { for (const row of rows)
        projects.add(row.project); };
    if (hasTable(db, 'agent_session_instances'))
        add(db.prepare('SELECT DISTINCT project FROM agent_session_instances').all());
    if (hasTable(db, 'agent_session_connections'))
        add(db.prepare('SELECT DISTINCT project FROM agent_session_connections').all());
    if (hasTable(db, 'agent_principals'))
        add(db.prepare('SELECT DISTINCT project FROM agent_principals').all());
    if (hasTable(db, 'agent_messages'))
        add(db.prepare('SELECT DISTINCT project FROM agent_messages').all());
    return [...projects];
}
export function receiveMessage(db, joined, member, frame, notifier) {
    if (!messagingAvailable(db))
        return { result: 'retry', code: 'messaging_unavailable' };
    const project = localProjects(db).find((candidate) => projectHash(joined.config.network_id, candidate) === frame.project_hash);
    if (project === undefined)
        return { result: 'rejected', code: 'project_unknown' };
    let target;
    try {
        target = resolveAgentSessionHandle(db, project, frame.target);
    }
    catch {
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
    }
    catch (err) {
        if (err instanceof AgentIdempotencyConflictError)
            return { result: 'rejected', code: 'idempotency_conflict' };
        if (err instanceof AgentConversationLoopError)
            return { result: 'rejected', code: 'loop_limit' };
        if (err instanceof AgentMessagingError)
            return { result: 'rejected', code: 'message_invalid' };
        throw err;
    }
}
export function localPresence(db, joined, now) {
    if (!hasTable(db, 'agent_session_connections'))
        return [];
    const rows = db.prepare(`
    SELECT project, principal_id, session_instance_id, adapter_kind FROM agent_session_connections
    WHERE disconnected_at IS NULL AND lease_expires_at_ms > ?
  `).all(now);
    const entries = new Map();
    for (const row of rows) {
        const handle = agentSessionHandle(row.project, row.adapter_kind, row.session_instance_id);
        const entry = {
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
export function receivePresence(db, member, frame, now) {
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
export function rememberPeer(db, machineId, relay, addrs, now) {
    db.prepare(`
    INSERT INTO agent_network_peers (machine_id, relay_url, addrs_json, seen_at_ms) VALUES (?, ?, ?, ?)
    ON CONFLICT(machine_id) DO UPDATE SET relay_url = excluded.relay_url, addrs_json = excluded.addrs_json, seen_at_ms = excluded.seen_at_ms
  `).run(machineId, relay, JSON.stringify(addrs), now);
}
export function peerRoute(db, machineId) {
    const row = db.prepare('SELECT relay_url, addrs_json FROM agent_network_peers WHERE machine_id = ?').get(machineId);
    if (!row)
        return null;
    try {
        return { relay: row.relay_url, addrs: JSON.parse(row.addrs_json) };
    }
    catch {
        return { relay: row.relay_url, addrs: [] };
    }
}
export function frameLabel(frame) {
    return frame.kind === 'message' ? `message ${createHash('sha256').update(String(frame.origin_message_id)).digest('hex').slice(0, 12)}` : frame.kind;
}
//# sourceMappingURL=courier.js.map