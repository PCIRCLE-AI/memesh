// What happens when a message sent to another machine runs out its one day:
// what status, receipts and fetch answer, what the sender is told, and what
// becomes of the bridge's outbox row and its retries.
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../../src/db.js';
import type { MemeshDatabase } from '../../src/storage/sqlite.js';
import { executeAgentMessageAction } from '../../src/transports/agent-messaging.js';
import { runAgentMessageExpiry } from '../../src/core/agent-message-expiry.js';
import { AGENT_MESSAGE_TTL_MS } from '../../src/core/agent-message-ttl.js';
import {
  DELIVERY_WINDOW_MS, buildMessageFrame, dueMachines, dueOutgoingFor, enqueueOutgoing, recordAttempt, recordUnsendable, type Joined,
} from '../../src/network/courier.js';
import { ensureIdentity, type Identity } from '../../src/network/identity.js';
import { addMember, createRoster, signRoster, verifyRoster } from '../../src/network/roster.js';
import { insertConfig, readConfig, signedRosterOf } from '../../src/network/store.js';
import { makeHome, removeTree } from './helpers.js';

const NETWORK_ID = '0123456789abcdef0123456789abcdef';
const PROJECT = 'shared~0123456789abcdef0123456789abcdef';
const context = { transport: 'cli' as const, sourceHost: 'test-host' };
const REMOTE = 'ben/bob@beta';

let home: string;
let db: MemeshDatabase;
let self: Identity;
let peer: Identity;

/** This machine joined as ann@alpha with ben@beta, three days ago, so a message sent now is newer than the membership. */
function join(): Joined {
  const joinedAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
  let roster = createRoster(NETWORK_ID, { machine_id: self.machineId, name: 'alpha', person: 'ann', joined_at: joinedAt });
  roster = addMember(roster, { machine_id: peer.machineId, name: 'beta', person: 'ben', joined_at: joinedAt });
  const signed = signRoster(self, roster);
  insertConfig(db, {
    network_id: NETWORK_ID, owner_id: self.machineId, machine_id: self.machineId, machine_name: 'alpha', person: 'ann',
    relay_url: 'off', roster_json: signed.roster_json, roster_signature: signed.signature,
  }, Date.now());
  const config = readConfig(db);
  if (!config) throw new Error('no config');
  return { config, roster: verifyRoster(signedRosterOf(config), config.owner_id, config.network_id) };
}

async function sendRemote(key: string): Promise<string> {
  const sent = await executeAgentMessageAction(db, {
    action: 'send', project: PROJECT, sender: 'alice', recipient: REMOTE, idempotency_key: key, payload: `to-beta-${key}`,
  }, context) as { message_id: string };
  return sent.message_id;
}

function age(messageId: string, modifier = '-25 hours'): void {
  for (const table of ['agent_messages', 'agent_message_deliveries', 'agent_message_events']) {
    db.prepare(`UPDATE ${table} SET created_at = datetime('now', '${modifier}') WHERE message_id = ?`).run(messageId);
  }
}

const act = (action: string, messageId: string, recipient = REMOTE) => executeAgentMessageAction(db, {
  action, project: PROJECT, recipient, message_id: messageId,
} as never, context);

/** Hands the message to the bridge and records one attempt: a failure code, or an accepted delivery. */
function queueAndAttempt(joined: Joined, outcome: { failure: string } | { delivered: true }): void {
  enqueueOutgoing(db, joined, Date.now());
  const entry = db.prepare('SELECT delivery_id, message_id, machine_id, attempts, expires_at_ms FROM agent_network_outbox').get() as never;
  recordAttempt(db, entry, 'failure' in outcome ? { failure: outcome.failure } : { ack: { result: 'accepted' }, path: 'direct' }, Date.now());
}

function noticeSummary(): string {
  const rows = db.prepare("SELECT payload_json FROM agent_messages WHERE sender = 'memesh' AND recipient = 'alice'").all() as Array<{ payload_json: string }>;
  expect(rows).toHaveLength(1);
  return (JSON.parse(rows[0].payload_json) as { summary: string }).summary;
}

beforeEach(() => {
  home = makeHome();
  db = openDatabase(path.join(home, '.memesh', 'knowledge-graph.db'));
  self = ensureIdentity(path.join(home, 'self'));
  peer = ensureIdentity(path.join(home, 'peer'));
});
afterEach(() => {
  closeDatabase();
  removeTree(home);
});

describe('a message to another machine that ran out its day', () => {
  it('status, receipts and fetch all say message_expired, before the pass deletes it and after', async () => {
    const joined = join();
    const id = await sendRemote('k-answers');
    queueAndAttempt(joined, { failure: 'unreachable' });
    age(id);
    for (const phase of ['past its day, not yet deleted', 'deleted']) {
      for (const action of ['status', 'receipts', 'fetch']) {
        await expect(act(action, id), `${action}, ${phase}`).rejects.toThrow(/^message_expired: /);
      }
      if (phase !== 'deleted') await runAgentMessageExpiry(db, { trigger: 'test' });
    }
  });

  it('tells the sender it was not delivered to the other machine, with the last error code', async () => {
    const joined = join();
    const id = await sendRemote('k-undelivered');
    queueAndAttempt(joined, { failure: 'unreachable' });
    age(id);
    await runAgentMessageExpiry(db, { trigger: 'test' });
    const summary = noticeSummary();
    expect(summary).toMatch(/not delivered/);
    expect(summary).toContain('unreachable');
    expect(summary).not.toMatch(/recorded no intake/);
  });

  it('tells the sender it reached the other machine but no reply was seen here', async () => {
    const joined = join();
    const id = await sendRemote('k-delivered');
    queueAndAttempt(joined, { delivered: true });
    age(id);
    await runAgentMessageExpiry(db, { trigger: 'test' });
    const summary = noticeSummary();
    expect(summary).toMatch(/delivered to machine beta/);
    expect(summary).toMatch(/no reply/);
    expect(summary).not.toMatch(/recorded no intake/);
  });

  it('does not repeat a not-delivered notice the bridge already sent for the same message', async () => {
    const joined = join();
    const id = await sendRemote('k-told');
    enqueueOutgoing(db, joined, Date.now());
    const [entry] = dueOutgoingFor(db, peer.machineId, Date.now());
    recordAttempt(db, entry, { ack: { result: 'rejected', code: 'project_unknown' } }, Date.now());
    age(id);
    const result = await runAgentMessageExpiry(db, { trigger: 'test' });
    expect(result).toMatchObject({ outcome: 'deleted', expired_message_count: 1, notice_count: 0 });
    const toAlice = db.prepare('SELECT sender FROM agent_messages WHERE recipient = ?').all('alice') as Array<{ sender: string }>;
    expect(toAlice).toEqual([{ sender: 'memesh-network' }]);
  });

  it('keeps the outbox row in the archive, and leaves none behind that could be retried', async () => {
    const joined = join();
    const id = await sendRemote('k-archive');
    queueAndAttempt(joined, { failure: 'unreachable' });
    age(id);
    const result = await runAgentMessageExpiry(db, { trigger: 'test' });
    expect(result).toMatchObject({ outcome: 'deleted', expired_message_count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_network_outbox').get()).toEqual({ n: 0 });
    expect(dueMachines(db, Date.now())).toEqual([]);
    db.exec(`ATTACH DATABASE '${result.backup_path}' AS inspected`);
    try {
      const archived = db.prepare(`
        SELECT o.state, o.attempts, o.last_error_code, d.recipient FROM inspected.agent_network_outbox o
        JOIN inspected.agent_message_deliveries d ON d.delivery_id = o.delivery_id WHERE o.message_id = ?
      `).all(id);
      expect(archived).toEqual([{ state: 'pending', attempts: 1, last_error_code: 'unreachable', recipient: REMOTE }]);
    } finally {
      db.exec('DETACH DATABASE inspected');
    }
  });

  it('removes the archived outbox row with its message when the extra day is over', async () => {
    const joined = join();
    const id = await sendRemote('k-purge');
    queueAndAttempt(joined, { delivered: true });
    age(id);
    const result = await runAgentMessageExpiry(db, { trigger: 'test' });
    db.exec(`ATTACH DATABASE '${result.backup_path}' AS inspected`);
    db.prepare('UPDATE inspected.archive_log SET archived_at_ms = ?').run(Date.now() - AGENT_MESSAGE_TTL_MS - 60_000);
    db.exec('DETACH DATABASE inspected');
    await runAgentMessageExpiry(db, { trigger: 'test' });
    db.exec(`ATTACH DATABASE '${result.backup_path}' AS inspected`);
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM inspected.agent_network_outbox').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM inspected.agent_message_deliveries').get()).toEqual({ n: 0 });
    } finally {
      db.exec('DETACH DATABASE inspected');
    }
  });

  it('a copy restored from the archive is never sent to the other machine again', async () => {
    const joined = join();
    const id = await sendRemote('k-restore');
    queueAndAttempt(joined, { delivered: true });
    age(id);
    const result = await runAgentMessageExpiry(db, { trigger: 'test' });
    // The restore command of docs/platforms/agent-messaging.md: message, delivery and event, with a fresh day.
    db.exec(`ATTACH DATABASE '${result.backup_path}' AS archive`);
    db.exec(`
      INSERT OR IGNORE INTO agent_messages (message_id, project, sender, sender_host, recipient, content_type, correlation_id, reply_to_message_id, privacy, payload_json, payload_sha256, payload_original_bytes, payload_tombstoned_at, provenance_json, created_at)
        SELECT message_id, project, sender, sender_host, recipient, content_type, correlation_id, reply_to_message_id, privacy, payload_json, payload_sha256, payload_original_bytes, payload_tombstoned_at, provenance_json, CURRENT_TIMESTAMP FROM archive.agent_messages;
      INSERT OR IGNORE INTO agent_message_deliveries (delivery_id, message_id, project, recipient, target_kind, intended_session, created_at)
        SELECT delivery_id, message_id, project, recipient, target_kind, intended_session, CURRENT_TIMESTAMP FROM archive.agent_message_deliveries;
    `);
    db.exec('DETACH DATABASE archive');
    enqueueOutgoing(db, joined, Date.now());
    const [entry] = dueOutgoingFor(db, peer.machineId, Date.now());
    expect(buildMessageFrame(db, joined, entry)).toBe('message_invalid');
  });

  it('a retry in flight when the message is deleted finds nothing to send and tells no one', async () => {
    const joined = join();
    const id = await sendRemote('k-inflight');
    enqueueOutgoing(db, joined, Date.now());
    const [entry] = dueOutgoingFor(db, peer.machineId, Date.now());
    age(id);
    await runAgentMessageExpiry(db, { trigger: 'test' });
    const noticesBefore = db.prepare('SELECT COUNT(*) AS n FROM agent_messages').get();
    const frame = buildMessageFrame(db, joined, entry);
    expect(frame).toBe('message_gone');
    recordUnsendable(db, entry, String(frame));
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_messages').get()).toEqual(noticesBefore);
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_network_outbox').get()).toEqual({ n: 0 });
  });
});

describe('retries and the one-day line', () => {
  it('the bridge never retries later than the moment the message expires', async () => {
    const joined = join();
    await sendRemote('k-order');
    enqueueOutgoing(db, joined, Date.now());
    const row = db.prepare(`
      SELECT o.expires_at_ms, m.created_at FROM agent_network_outbox o JOIN agent_messages m ON m.message_id = o.message_id
    `).get() as { expires_at_ms: number; created_at: string };
    const createdMs = Date.parse(`${row.created_at.replace(' ', 'T')}Z`);
    expect(DELIVERY_WINDOW_MS).toBeLessThanOrEqual(AGENT_MESSAGE_TTL_MS);
    expect(row.expires_at_ms).toBeLessThanOrEqual(createdMs + AGENT_MESSAGE_TTL_MS);
    expect(dueOutgoingFor(db, peer.machineId, row.expires_at_ms - 1)).toHaveLength(1);
    expect(dueOutgoingFor(db, peer.machineId, row.expires_at_ms)).toHaveLength(0);
    expect(dueMachines(db, row.expires_at_ms)).toEqual([]);
  });
});
