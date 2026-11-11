import fs from 'node:fs';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../../src/storage/schema.js';
import { sqliteUtcToIso } from '../../src/core/time-utils.js';
import { startServer } from '../../src/transports/http/server.js';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { describe, expect, it } from 'vitest';
import {
  AGENT_MESSAGE_EXPIRY_INTERVAL_MS,
  lastAgentMessageExpiryRun,
  latestAgentMessageExpiryArchive,
  runAgentMessageExpiry,
  runAgentMessageExpiryIfDue,
  startAgentMessageExpiryScheduler,
} from '../../src/core/agent-message-expiry.js';
import {
  AgentMessageExpiredError,
  fetchAgentMessage,
  pollAgentEvents,
  recordAgentAckFact,
  recordAgentReceipt,
  recordAgentRetentionFact,
  recordAgentWorkflowFact,
  sendAgentMessage,
  type SentAgentMessage,
} from '../../src/core/agent-messaging.js';
import { unreadDeliveryCount } from '../../src/core/agent-message-inbox.js';
import { agentMessageExpiryCutoff } from '../../src/core/agent-message-ttl.js';
import { executeAgentMessageAction } from '../../src/transports/agent-messaging.js';
import { closeDatabase, getDatabase, openDatabase } from '../../src/db.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

const dbHandle = useTestDatabase('memesh-agent-message-expiry-');
const PROJECT = 'expiry-project';

// Every table the pass is responsible for, so a new one cannot be forgotten.
const MESSAGE_TABLES = [
  'agent_messages', 'agent_message_deliveries', 'agent_message_events', 'agent_message_idempotency',
  'agent_message_receipts', 'agent_retention_facts', 'agent_dispatch_attempts', 'agent_host_accepts',
  'agent_ack_facts', 'agent_workflow_facts',
] as const;

function db() { return getDatabase(); }

function count(table: string): number {
  return (db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** Messages other than MeMesh's own expiry notices. */
function userMessages(): number {
  return (db().prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE sender <> 'memesh'").get() as { n: number }).n;
}

function counts(): Record<string, number> {
  return Object.fromEntries(MESSAGE_TABLES.map((table) => [table, count(table)]));
}

function send(sender: string, recipient: string, extra: { reply_to?: string; key?: string } = {}): SentAgentMessage {
  return sendAgentMessage(db(), {
    project: PROJECT,
    sender,
    recipient,
    idempotency_key: extra.key ?? `key-${randomUUID()}`,
    content_type: 'application/json',
    payload: { body: `from ${sender}` },
    reply_to: extra.reply_to,
  });
}

/** Moves a message, and every row that carries its creation time, `-2 days` into the past. */
function age(messageId: string, modifier = '-2 days'): void {
  const when = `datetime('now', '${modifier}')`;
  db().prepare(`UPDATE agent_messages SET created_at = ${when} WHERE message_id = ?`).run(messageId);
  db().prepare(`UPDATE agent_message_deliveries SET created_at = ${when} WHERE message_id = ?`).run(messageId);
  db().prepare(`UPDATE agent_message_events SET created_at = ${when} WHERE message_id = ?`).run(messageId);
}

interface Chain { hostAcceptId: string; attemptId: string; connectionId: string; sessionId: string }

/** The router's own chain for one delivery: instance, connection, attempt, host accept. */
function dispatchChain(message: SentAgentMessage, result = 'adapter_returned', completed = true): Chain {
  const suffix = randomUUID();
  const sessionId = `session-${suffix}`;
  const connectionId = `connection-${suffix}`;
  const attemptId = `attempt-${suffix}`;
  const hostAcceptId = `host-accept-${suffix}`;
  db().prepare('INSERT OR IGNORE INTO agent_principals (project, principal_id, activation_event_sequence) VALUES (?, ?, 0)')
    .run(message.project, message.recipient);
  db().prepare("INSERT INTO agent_session_instances (project, session_instance_id, principal_id, adapter_kind) VALUES (?, ?, ?, 'test-adapter')")
    .run(message.project, sessionId, message.recipient);
  db().prepare(`
    INSERT INTO agent_session_connections (connection_id, project, principal_id, session_instance_id, generation,
      adapter_kind, router_instance_id, lease_expires_at_ms)
    VALUES (?, ?, ?, ?, 1, 'test-adapter', 'test-router', ?)
  `).run(connectionId, message.project, message.recipient, sessionId, Date.now() + 60_000);
  db().prepare(`
    INSERT INTO agent_dispatch_attempts (attempt_id, delivery_id, project, principal_id, session_instance_id,
      connection_id, generation, router_instance_id, attempt_number, result, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 'test-router', 1, ?, ${completed ? 'CURRENT_TIMESTAMP' : 'NULL'})
  `).run(attemptId, message.delivery_id, message.project, message.recipient, sessionId, connectionId, result);
  if (completed) {
    db().prepare("INSERT INTO agent_host_accepts (host_accept_id, attempt_id, delivery_id, adapter_kind, receipt_json) VALUES (?, ?, ?, 'test-adapter', '{\"accepted\":true}')")
      .run(hostAcceptId, attemptId, message.delivery_id);
  }
  return { hostAcceptId, attemptId, connectionId, sessionId };
}

/** Fills every table that hangs off one message, so a delete has something to cascade through. */
function populate(message: SentAgentMessage): void {
  const chain = dispatchChain(message);
  recordAgentReceipt(db(), {
    project: message.project, recipient: message.recipient, message_id: message.message_id,
    receipt_kind: 'intake', intake_state: 'ingested', actor: message.recipient, idempotency_key: `intake-${message.message_id}`,
  });
  recordAgentReceipt(db(), {
    project: message.project, recipient: message.recipient, message_id: message.message_id,
    receipt_kind: 'ack', actor: message.recipient, idempotency_key: `ack-${message.message_id}`,
  });
  recordAgentReceipt(db(), {
    project: message.project, recipient: message.recipient, message_id: message.message_id,
    receipt_kind: 'disposition', disposition: 'completed', actor: message.recipient, idempotency_key: `disp-${message.message_id}`,
  });
  recordAgentAckFact(db(), {
    delivery_id: message.delivery_id, host_accept_id: chain.hostAcceptId, actor: message.recipient,
    idempotency_key: `ackfact-${message.message_id}`,
  });
  recordAgentWorkflowFact(db(), {
    delivery_id: message.delivery_id, actor: message.recipient, workflow_state: 'completed',
    idempotency_key: `wf-${message.message_id}`,
  });
  recordAgentRetentionFact(db(), {
    message_id: message.message_id, actor: message.recipient, retention_state: 'kept',
    idempotency_key: `ret-${message.message_id}`,
  });
}

function foreignKeysOn(): boolean {
  return (db().prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys === 1;
}

function foreignKeyViolations(): unknown[] {
  return db().prepare('PRAGMA foreign_key_check').all();
}

function run(extra: { nowMs?: number } = {}) {
  return runAgentMessageExpiry(db(), { trigger: 'test', ...extra });
}

describe('one-day agent message expiry', () => {
  it('deletes an expired message and every dependent row, and leaves a newer message untouched', async () => {
    expect(foreignKeysOn()).toBe(true);
    const oldRead = send('alice', 'bob');
    const oldRead2 = send('carol', 'bob');
    const young = send('alice', 'bob');
    populate(oldRead);
    populate(oldRead2);
    populate(young);
    age(oldRead.message_id);
    age(oldRead2.message_id, '-25 hours');
    const before = counts();
    expect(Object.values(before).every((n) => n >= 3)).toBe(true);

    const result = await run();

    expect(result).toMatchObject({ outcome: 'deleted', expired_message_count: 2, unread_message_count: 0, notice_count: 0 });
    const after = counts();
    for (const table of MESSAGE_TABLES) {
      // 3 populated messages, 2 expired: one populated message is all that remains.
      expect(after[table], table).toBe(before[table] / 3);
    }
    expect(db().prepare('SELECT message_id FROM agent_messages').all()).toEqual([{ message_id: young.message_id }]);
    expect(foreignKeyViolations()).toEqual([]);
    expect(count('agent_message_expiries')).toBe(2);
  });

  it('keeps a message that is 23 hours old', async () => {
    const almost = send('alice', 'bob');
    age(almost.message_id, '-23 hours');
    expect(await run()).toMatchObject({ outcome: 'nothing_expired', expired_message_count: 0 });
    expect(count('agent_messages')).toBe(1);
  });

  it('tells the sender about a message nobody read, readably, and says nothing for a read one', async () => {
    const unread1 = send('alice', 'bob');
    const unread2 = send('alice', 'bob');
    const read = send('alice', 'bob');
    const unreadElsewhere = send('dave', 'bob');
    recordAgentReceipt(db(), {
      project: PROJECT, recipient: 'bob', message_id: read.message_id,
      receipt_kind: 'intake', intake_state: 'fetched', actor: 'bob', idempotency_key: 'read-it',
    });
    for (const message of [unread1, unread2, read, unreadElsewhere]) age(message.message_id);

    const result = await run();

    expect(result).toMatchObject({ outcome: 'deleted', expired_message_count: 4, unread_message_count: 3, notice_count: 2 });
    // The sender reads it the way it reads anything: poll its own inbox, then fetch.
    const polled = pollAgentEvents(db(), { project: PROJECT, recipient: 'alice' });
    expect(polled.events).toHaveLength(1);
    const notice = fetchAgentMessage(db(), { project: PROJECT, recipient: 'alice', message_id: polled.events[0].message_id });
    expect(notice.sender).toBe('memesh');
    const payload = notice.payload as { kind: string; summary: string; messages: Array<Record<string, string>> };
    expect(payload.kind).toBe('message_expired');
    expect(payload.summary).toContain('recorded no intake, acknowledgement or disposition and sent no reply');
    expect(payload.summary).not.toContain('never read');
    expect(payload.messages.map((m) => m.message_id).sort()).toEqual([unread1.message_id, unread2.message_id].sort());
    expect(payload.messages[0]).toMatchObject({ recipient: 'bob' });
    for (const listed of payload.messages) {
      expect(Date.parse(listed.expired_at) - Date.parse(listed.created_at), listed.message_id).toBe(86_400_000);
    }
    // dave is told too; bob, whose mail expired, is not.
    expect(pollAgentEvents(db(), { project: PROJECT, recipient: 'dave' }).events).toHaveLength(1);
    expect(pollAgentEvents(db(), { project: PROJECT, recipient: 'bob' }).events).toHaveLength(0);
    expect(unreadDeliveryCount(db(), PROJECT, 'alice')).toBe(1);
  });

  it('does not answer an unread notice with another notice', async () => {
    const lost = send('alice', 'bob');
    age(lost.message_id);
    expect((await run()).notice_count).toBe(1);
    // The notice itself sits unread past its own day.
    const notice = db().prepare("SELECT message_id FROM agent_messages WHERE sender = 'memesh'").get() as { message_id: string };
    age(notice.message_id);
    const again = await run();
    expect(again).toMatchObject({ outcome: 'deleted', expired_message_count: 1, unread_message_count: 0, notice_count: 0 });
    expect(count('agent_messages')).toBe(0);
  });

  it('counts a sender it cannot address instead of failing the pass', async () => {
    const lost = send('/Users/someone/agent', 'bob');
    age(lost.message_id);
    const result = await run();
    expect(result).toMatchObject({ outcome: 'deleted', expired_message_count: 1, notice_count: 0 });
    expect(result.detail).toContain('could not be addressed');
    expect(count('agent_messages')).toBe(0);
    // Settled: the next pass does not try that sender again.
    expect(await run()).toMatchObject({ outcome: 'nothing_expired', detail: null });
  });

  it('answers a read of, a receipt for and a reply to an expired id with a specific error', async () => {
    const lost = send('alice', 'bob');
    const keep = send('alice', 'bob');
    age(lost.message_id);
    // Before the pass has run, the message is already gone to its readers.
    expect(() => fetchAgentMessage(db(), { project: PROJECT, recipient: 'bob', message_id: lost.message_id }))
      .toThrow(AgentMessageExpiredError);
    await run();
    expect(userMessages()).toBe(1);
    const sentAt = sqliteUtcToIso((db().prepare('SELECT created_at FROM agent_message_expiries WHERE message_id = ?').get(lost.message_id) as { created_at: string }).created_at);
    const expiredAt = new Date(Date.parse(sentAt) + 86_400_000).toISOString();
    expect(() => fetchAgentMessage(db(), { project: PROJECT, recipient: 'bob', message_id: lost.message_id }))
      .toThrow(`message_expired: message ${lost.message_id} (sent ${sentAt}) expired at ${expiredAt}; MeMesh keeps a message for one day`);
    expect(() => recordAgentReceipt(db(), {
      project: PROJECT, recipient: 'bob', message_id: lost.message_id,
      receipt_kind: 'intake', intake_state: 'fetched', actor: 'bob', idempotency_key: 'late',
    })).toThrow(AgentMessageExpiredError);
    expect(() => send('bob', 'alice', { reply_to: lost.message_id })).toThrow(`message_expired: message ${lost.message_id} (sent ${sentAt}) expired at ${expiredAt}; MeMesh keeps a message for one day and then deletes it, so it cannot be replied to`);
    // An id nobody ever knew, and a live message, keep their old behaviour.
    expect(() => fetchAgentMessage(db(), { project: PROJECT, recipient: 'bob', message_id: 'never-existed' }))
      .toThrow(/not available to recipient/);
    expect(send('bob', 'alice', { reply_to: keep.message_id }).reply_to).toBe(keep.message_id);
    expect(fetchAgentMessage(db(), { project: PROJECT, recipient: 'bob', message_id: keep.message_id }).message_id).toBe(keep.message_id);
  });

  it('hides a message past its day from readers before the pass has deleted it', () => {
    const lost = send('alice', 'bob');
    const fresh = send('alice', 'bob');
    age(lost.message_id);
    expect(pollAgentEvents(db(), { project: PROJECT, recipient: 'bob' }).events.map((e) => e.message_id)).toEqual([fresh.message_id]);
    expect(unreadDeliveryCount(db(), PROJECT, 'bob')).toBe(1);
    expect(count('agent_messages')).toBe(2);
  });

  it('a retry with the same idempotency key after expiry is a new message', async () => {
    const first = send('alice', 'bob', { key: 'retry-me' });
    age(first.message_id);
    await run();
    const second = send('alice', 'bob', { key: 'retry-me' });
    expect(second.message_id).not.toBe(first.message_id);
    expect(second.reused).not.toBe(true);
  });

  it('keeps a cursor that pointed at deleted events working', async () => {
    const early = send('alice', 'bob');
    const first = pollAgentEvents(db(), { project: PROJECT, recipient: 'bob' });
    expect(first.events).toHaveLength(1);
    age(early.message_id);
    await run();
    expect(count('agent_message_events')).toBe(1); // only alice's expiry notice
    const later = send('alice', 'bob');
    const resumed = pollAgentEvents(db(), { project: PROJECT, recipient: 'bob', cursor: first.next_cursor });
    expect(resumed.events.map((e) => e.message_id)).toEqual([later.message_id]);
    // A cursor taken before the delete, held across several passes, still resolves.
    expect(count('agent_message_cursors')).toBeGreaterThan(0);
  });

  it('clears old presence and connections, and keeps a live session and a young attempt', async () => {
    const young = send('alice', 'bob');
    const youngChain = dispatchChain(young);
    const oldMessage = send('alice', 'bob');
    const oldChain = dispatchChain(oldMessage);
    age(oldMessage.message_id);

    const addConnection = (id: string, disconnected: string | null, leaseMs: number, factAge: string): void => {
      const session = `session-${id}`;
      db().prepare("INSERT INTO agent_session_instances (project, session_instance_id, principal_id, adapter_kind) VALUES (?, ?, 'bob', 'test-adapter')")
        .run(PROJECT, session);
      db().prepare(`
        INSERT INTO agent_session_connections (connection_id, project, principal_id, session_instance_id, generation,
          adapter_kind, router_instance_id, lease_expires_at_ms, disconnected_at)
        VALUES (?, ?, 'bob', ?, 1, 'test-adapter', 'r', ?, ${disconnected})
      `).run(id, PROJECT, session, leaseMs);
      db().prepare(`
        INSERT INTO agent_presence_facts (presence_fact_id, project, principal_id, session_instance_id, connection_id,
          generation, presence_kind, detail_json, created_at)
        VALUES (?, ?, 'bob', ?, ?, 1, 'connected', '{}', ${factAge})
      `).run(`fact-${id}`, PROJECT, session, id);
    };
    addConnection('gone', "datetime('now', '-3 days')", Date.now() - 3 * 86_400_000, "datetime('now', '-3 days')");
    addConnection('crashed', 'NULL', Date.now() - 3 * 86_400_000, "datetime('now', '-3 days')");
    addConnection('live-old-fact', 'NULL', Date.now() + 600_000, "datetime('now', '-3 days')");
    addConnection('just-left', "datetime('now', '-1 hours')", Date.now() - 3_600_000, "datetime('now', '-1 hours')");

    const result = await run();

    expect(result.outcome).toBe('deleted');
    expect(result.connection_count).toBe(2);
    expect(result.presence_fact_count).toBe(2);
    const connections = (db().prepare('SELECT connection_id FROM agent_session_connections').all() as Array<{ connection_id: string }>)
      .map((row) => row.connection_id).sort();
    // Live sessions stay (the two with a good lease); a connection that ended an hour ago stays;
    // the one that ended three days ago and the one whose lease ran out three days ago go.
    expect(connections).toEqual(['just-left', 'live-old-fact', youngChain.connectionId, oldChain.connectionId].sort());
    const facts = (db().prepare('SELECT connection_id FROM agent_presence_facts').all() as Array<{ connection_id: string }>)
      .map((row) => row.connection_id).sort();
    // A live connection keeps even an old fact; a dead connection keeps none.
    expect(facts).toEqual(['just-left', 'live-old-fact']);
    expect(count('agent_session_instances')).toBeGreaterThanOrEqual(5);
    expect(foreignKeyViolations()).toEqual([]);
  });

  it('records every pass, including one that found nothing', async () => {
    expect(await run()).toMatchObject({ outcome: 'nothing_expired' });
    const last = lastAgentMessageExpiryRun(db());
    expect(last).toMatchObject({ outcome: 'nothing_expired', expired_message_count: 0, trigger_source: 'test' });
    expect(last!.finished_at_ms).toBeGreaterThanOrEqual(last!.started_at_ms);
    expect(count('agent_message_expiry_runs')).toBe(1);
  });

  it('copies what it deletes into the archive: the message and every row that goes with it', async () => {
    const lost = send('alice', 'bob');
    const lost2 = send('alice', 'bob');
    populate(lost);
    age(lost.message_id);
    age(lost2.message_id);
    const first = await run();
    expect(fs.realpathSync(first.backup_path!)).toBe(fs.realpathSync(archiveFile()));
    expect(userMessages()).toBe(0);
    const archive = new DatabaseSync(first.backup_path!, { readOnly: true });
    try {
      const wanted: Record<string, number> = {
        agent_messages: 2, agent_message_deliveries: 2, agent_message_events: 2, agent_message_idempotency: 2,
        agent_message_receipts: 3, agent_retention_facts: 1, agent_dispatch_attempts: 1, agent_host_accepts: 1,
        agent_ack_facts: 1, agent_workflow_facts: 1,
      };
      for (const table of MESSAGE_TABLES) {
        expect((archive.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, table).toBe(wanted[table]);
      }
      expect((archive.prepare('SELECT COUNT(*) AS n FROM archive_log').get() as { n: number }).n).toBe(2);
      expect(archive.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally {
      archive.close();
    }
    expect(fs.statSync(first.backup_path!).mode & 0o077).toBe(0);
  });

  it('does not create an archive, and does not call it a deletion, when only old presence records were cleared', async () => {
    db().prepare('INSERT OR IGNORE INTO agent_principals (project, principal_id, activation_event_sequence) VALUES (?, ?, 0)').run(PROJECT, 'bob');
    db().prepare("INSERT INTO agent_session_instances (project, session_instance_id, principal_id, adapter_kind) VALUES (?, 's-old', 'bob', 'test-adapter')").run(PROJECT);
    db().prepare(`
      INSERT INTO agent_session_connections (connection_id, project, principal_id, session_instance_id, generation,
        adapter_kind, router_instance_id, lease_expires_at_ms, disconnected_at)
      VALUES ('c-old', ?, 'bob', 's-old', 1, 'test-adapter', 'r', ?, datetime('now', '-3 days'))
    `).run(PROJECT, Date.now() - 3 * 86_400_000);
    const result = await run();
    expect(result).toMatchObject({ outcome: 'presence_cleared', connection_count: 1, expired_message_count: 0, backup_path: null });
    expect(fs.existsSync(path.join(path.dirname(dbHandle.dbPath), 'backups'))).toBe(false);
  });

  it('deletes nothing from a batch whose archive does not hold all its rows', async () => {
    const lost = send('alice', 'bob');
    const lost2 = send('alice', 'bob');
    populate(lost);
    age(lost.message_id);
    age(lost2.message_id);
    // Every table is checked, not only the first one that happens to differ.
    for (const table of MESSAGE_TABLES) {
      const before = count(table);
      const result = await runAgentMessageExpiry(db(), {
        trigger: 'test',
        fault: {
          beforeArchiveCheck: (archive) => {
            const other = new DatabaseSync(archive);
            other.exec(`DELETE FROM ${table}`);
            other.close();
          },
        },
      });
      expect(result.outcome, table).toBe('archive_failed');
      expect(result.detail, table).toContain(`${before} ${table} row(s) of this batch are not in the archive`);
      expect(result.detail, table).toContain('nothing in this batch was deleted');
      expect(userMessages(), table).toBe(2);
      expect(count(table), table).toBe(before);
      expect(lastAgentMessageExpiryRun(db()), table).toMatchObject({ outcome: 'archive_failed' });
    }
  });

  it('deletes nothing, and says why, when the archive file is not a database', async () => {
    const lost = send('alice', 'bob');
    age(lost.message_id);
    const dir = path.join(path.dirname(dbHandle.dbPath), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(archiveFile(), 'this is not a database, not even close '.repeat(40));
    const result = await run();
    // The very first look at the file (to see what is due for removal) already fails.
    expect(['failed', 'archive_failed']).toContain(result.outcome);
    expect(result.detail).toMatch(/not a database/);
    expect(userMessages()).toBe(1);
  });

  // The pass opens the database file itself, so what makes it unwritable is the file, as for a real user.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('does not copy or delete anything on a database it cannot write, and says so', async () => {
    const lost = send('alice', 'bob');
    age(lost.message_id);
    const written: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
    fs.chmodSync(dbHandle.dbPath, 0o400);
    let result;
    try {
      result = await runAgentMessageExpiry(db(), { trigger: 'test' });
    } finally {
      fs.chmodSync(dbHandle.dbPath, 0o600);
      process.stderr.write = realWrite;
    }
    expect(result.outcome).toBe('read_only');
    expect(result.run_id).toBeNull();
    expect(written.join('')).toContain('MeMesh message expiry: pass ended read_only');
    expect(fs.existsSync(path.join(path.dirname(dbHandle.dbPath), 'backups'))).toBe(false);
    expect(userMessages()).toBe(1);
  });

  it('deletes nothing when there is nowhere to put the archive', async () => {
    const memory = new MemeshDatabase(':memory:');
    try {
      memory.exec(SCHEMA_SQL);
      memory.exec('PRAGMA foreign_keys = ON');
      memory.prepare(`
        INSERT INTO agent_messages (message_id, project, sender, recipient, content_type, privacy, payload_json, provenance_json, created_at)
        VALUES ('m1', 'p', 'alice', 'bob', 'text/plain', 'private', '"x"', '{}', datetime('now', '-2 days'))
      `).run();
      const result = await runAgentMessageExpiry(memory, { trigger: 'test' });
      expect(result.outcome).toBe('archive_unavailable');
      expect((memory.prepare('SELECT COUNT(*) AS n FROM agent_messages').get() as { n: number }).n).toBe(1);
      expect((memory.prepare('SELECT outcome FROM agent_message_expiry_runs').get() as { outcome: string }).outcome).toBe('archive_unavailable');
    } finally {
      memory.close();
    }
  });

  it('deletes nothing when the archive cannot be made, and records why', async () => {
    const lost = send('alice', 'bob');
    age(lost.message_id);
    // A file where the backups folder would be.
    fs.writeFileSync(path.dirname(archiveFile()), 'x');
    const result = await run();
    expect(result.outcome).toBe('archive_failed');
    expect(count('agent_messages')).toBe(1);
    expect(lastAgentMessageExpiryRun(db())).toMatchObject({ outcome: 'archive_failed' });
  });

  it('holds back a message whose dispatch is still in flight', async () => {
    const inFlight = send('alice', 'bob');
    dispatchChain(inFlight, 'started', false);
    age(inFlight.message_id);
    const result = await run();
    expect(result.outcome).toBe('deferred_in_flight');
    expect(count('agent_messages')).toBe(1);
  });

  it('holds back a message whose dispatch started after the pass began, in a later batch', async () => {
    const sent = Array.from({ length: 120 }, (_, i) => send(`sender-${i}`, 'bob'));
    for (const message of sent) age(message.message_id);
    let heldId: string | null = null;
    const result = await runAgentMessageExpiry(db(), {
      trigger: 'test',
      fault: {
        afterBatch: (batch) => {
          if (batch !== 1) return;
          const left = new Set(ids());
          const late = sent.find((message) => left.has(message.message_id));
          if (!late) throw new Error('batch 1 left nothing for batch 2');
          heldId = late.message_id;
          dispatchChain(late, 'started', false);
        },
      },
    });
    expect(heldId).not.toBeNull();
    expect(ids()).toEqual([heldId]);
    expect(result.expired_message_count).toBe(119);
  });

  it('only runs when due, and the scheduler stops when told to', async () => {
    expect(await runAgentMessageExpiryIfDue(db(), { trigger: 'test' })).not.toBeNull();
    expect(await runAgentMessageExpiryIfDue(db(), { trigger: 'test' })).toBeNull();
    db().prepare('UPDATE agent_message_expiry_runs SET started_at_ms = ?').run(Date.now() - AGENT_MESSAGE_EXPIRY_INTERVAL_MS - 1);
    expect(await runAgentMessageExpiryIfDue(db(), { trigger: 'test' })).not.toBeNull();
    db().prepare('DELETE FROM agent_message_expiry_runs').run();
    const stop = startAgentMessageExpiryScheduler(() => db(), { trigger: 'stop-test', firstRunDelayMs: 1, intervalMs: 5 });
    for (let waited = 0; count('agent_message_expiry_runs') === 0 && waited < 3_000; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    stop();
    // A pass may still be finishing when stop() is called; let it end, then nothing more may start.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const after = count('agent_message_expiry_runs');
    db().prepare('UPDATE agent_message_expiry_runs SET started_at_ms = 0').run();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(count('agent_message_expiry_runs')).toBe(after);
  });

  it('runs by itself shortly after the scheduler starts', async () => {
    const lost = send('alice', 'bob');
    age(lost.message_id);
    const stop = startAgentMessageExpiryScheduler(() => db(), { trigger: 'scheduler-test', firstRunDelayMs: 5, intervalMs: 60_000 });
    try {
      for (let waited = 0; lastAgentMessageExpiryRun(db()) === null && waited < 3_000; waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      stop();
    }
    expect(userMessages()).toBe(0);
    expect(lastAgentMessageExpiryRun(db())).toMatchObject({ outcome: 'deleted', trigger_source: 'scheduler-test' });
  });

  it('keeps the run log bounded', async () => {
    for (let i = 0; i < 520; i++) await run();
    expect(count('agent_message_expiry_runs')).toBe(500);
  });
});

const CLI_CONTEXT = { transport: 'cli', sourceHost: 'test' } as const;

describe('expired ids: who is told, what a retry does', () => {
  it('a resend with the same key of a message that is past its day but not deleted yet is a new message', async () => {
    const first = send('alice', 'bob', { key: 'same-key' });
    age(first.message_id, '-25 hours');
    const second = send('alice', 'bob', { key: 'same-key' });
    expect(second.message_id).not.toBe(first.message_id);
    expect(second.reused).not.toBe(true);
    expect(pollAgentEvents(db(), { project: PROJECT, recipient: 'bob' }).events.map((e) => e.message_id))
      .toEqual([second.message_id]);
    // The old one is still waiting for the pass, and the pass still deletes it.
    expect((await run()).expired_message_count).toBe(1);
    expect(fetchAgentMessage(db(), { project: PROJECT, recipient: 'bob', message_id: second.message_id }).message_id)
      .toBe(second.message_id);
  });

  it('retrying a reply that was stored before its parent expired returns that reply', async () => {
    const parent = send('alice', 'bob');
    const reply = send('bob', 'alice', { reply_to: parent.message_id, key: 'reply-key' });
    age(parent.message_id);
    // It was answered, so nobody is told it went unanswered.
    expect(await run()).toMatchObject({ outcome: 'deleted', unread_message_count: 0, notice_count: 0 });
    const retried = send('bob', 'alice', { reply_to: parent.message_id, key: 'reply-key' });
    expect(retried.message_id).toBe(reply.message_id);
    expect(retried.reused).toBe(true);
    // A new reply to the same expired parent is still refused.
    expect(() => send('bob', 'alice', { reply_to: parent.message_id, key: 'another-reply' })).toThrow(/cannot be replied to/);
  });

  it('receipts for a message that is already deleted say message_expired', async () => {
    const lost = send('alice', 'bob');
    age(lost.message_id);
    await run();
    await expect(executeAgentMessageAction(db(), {
      action: 'receipts', project: PROJECT, recipient: 'bob', message_id: lost.message_id,
    }, CLI_CONTEXT)).rejects.toThrow(/message_expired/);
    await expect(executeAgentMessageAction(db(), {
      action: 'ack', project: PROJECT, recipient: 'bob', message_id: lost.message_id, idempotency_key: 'late-ack',
    }, CLI_CONTEXT)).rejects.toThrow(/message_expired/);
  });

  it('only the sender and the recipient learn that an expired id existed, and when it was sent', async () => {
    const lost = send('alice', 'bob');
    const stale = send('alice', 'bob');
    age(lost.message_id);
    age(stale.message_id);
    await run(); // lost is deleted; stale is deleted too, so make a third that is only stale
    const unswept = send('alice', 'bob');
    age(unswept.message_id, '-25 hours');
    for (const id of [lost.message_id, unswept.message_id]) {
      for (const party of ['alice', 'bob']) {
        expect(() => fetchAgentMessage(db(), { project: PROJECT, recipient: party, message_id: id }), `${party} ${id}`)
          .toThrow(AgentMessageExpiredError);
      }
      expect(() => fetchAgentMessage(db(), { project: PROJECT, recipient: 'mallory', message_id: id }))
        .toThrow(/not available to recipient mallory/);
      expect(() => recordAgentReceipt(db(), {
        project: PROJECT, recipient: 'mallory', message_id: id,
        receipt_kind: 'intake', intake_state: 'fetched', actor: 'mallory', idempotency_key: 'm-1',
      })).toThrow(/not available to recipient mallory/);
    }
    // A reply by someone who was never a party is not told about the expired parent either.
    expect(send('mallory', 'alice', { reply_to: lost.message_id }).reply_to).toBe(lost.message_id);
    expect(() => send('bob', 'alice', { reply_to: lost.message_id })).toThrow(AgentMessageExpiredError);
  });
});

/** Writes one bare message row (no delivery) created at exactly `createdAt`. */
function bareMessage(createdAt: string, sender = 'alice', id: string = randomUUID()): string {
  db().prepare(`
    INSERT INTO agent_messages (message_id, project, sender, recipient, content_type, privacy, payload_json, provenance_json, created_at)
    VALUES (?, ?, ?, 'bob', 'text/plain', 'private', '"x"', '{}', ?)
  `).run(id, PROJECT, sender, createdAt);
  return id;
}

function ids(): string[] {
  return (db().prepare("SELECT message_id FROM agent_messages WHERE sender <> 'memesh'").all() as Array<{ message_id: string }>)
    .map((row) => row.message_id);
}

function setCreatedAt(messageId: string, ...modifiers: string[]): void {
  const when = `datetime('now', ${modifiers.map((m) => `'${m}'`).join(', ')})`;
  db().prepare(`UPDATE agent_messages SET created_at = ${when} WHERE message_id = ?`).run(messageId);
  db().prepare(`UPDATE agent_message_deliveries SET created_at = ${when} WHERE message_id = ?`).run(messageId);
  db().prepare(`UPDATE agent_message_events SET created_at = ${when} WHERE message_id = ?`).run(messageId);
}

describe('where the one-day line is', () => {
  it('keeps a message created exactly at the cutoff second, and deletes one a second older', async () => {
    const now = Date.now();
    const atCutoff = bareMessage(agentMessageExpiryCutoff(now));
    const older = bareMessage(agentMessageExpiryCutoff(now - 1000));
    const result = await run({ nowMs: now });
    expect(result.expired_message_count).toBe(1);
    expect(ids()).toEqual([atCutoff]);
    expect(ids()).not.toContain(older);
  });

  it('keeps a message that is 23 hours 30 minutes old, and deletes one that is 24 hours 30 minutes old', async () => {
    const now = Date.now();
    const young = bareMessage(agentMessageExpiryCutoff(now + 30 * 60_000));
    const old = bareMessage(agentMessageExpiryCutoff(now - 30 * 60_000));
    await run({ nowMs: now });
    expect(ids()).toEqual([young]);
    expect(ids()).not.toContain(old);
  });

  it('readers use the same line: 23 hours 30 minutes old is visible, 24 hours 30 minutes old is not', () => {
    const young = send('alice', 'bob');
    const old = send('alice', 'bob');
    setCreatedAt(young.message_id, '-23 hours', '-30 minutes');
    setCreatedAt(old.message_id, '-24 hours', '-30 minutes');
    expect(pollAgentEvents(db(), { project: PROJECT, recipient: 'bob' }).events.map((e) => e.message_id)).toEqual([young.message_id]);
    expect(fetchAgentMessage(db(), { project: PROJECT, recipient: 'bob', message_id: young.message_id }).message_id).toBe(young.message_id);
    expect(() => fetchAgentMessage(db(), { project: PROJECT, recipient: 'bob', message_id: old.message_id })).toThrow(AgentMessageExpiredError);
  });

  it('a receipt for a message past its day, not yet deleted, is refused', () => {
    const stale = send('alice', 'bob');
    age(stale.message_id, '-25 hours');
    expect(() => recordAgentReceipt(db(), {
      project: PROJECT, recipient: 'bob', message_id: stale.message_id,
      receipt_kind: 'intake', intake_state: 'fetched', actor: 'bob', idempotency_key: 'too-late',
    })).toThrow(AgentMessageExpiredError);
    expect(count('agent_message_receipts')).toBe(0);
  });
});

describe('a large or failing pass', () => {
  it('rolls the whole batch back, notices included, when the delete fails part way', async () => {
    const doomed = send('alice', 'bob');
    const other = send('carol', 'bob');
    age(doomed.message_id);
    age(other.message_id);
    db().exec(`
      CREATE TRIGGER refuse_delete BEFORE DELETE ON agent_messages
      WHEN OLD.message_id = '${other.message_id}'
      BEGIN SELECT RAISE(ABORT, 'refused for the test'); END
    `);
    const result = await run();
    db().exec('DROP TRIGGER refuse_delete');
    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain('refused for the test');
    expect(userMessages()).toBe(2);
    expect(count('agent_message_expiries')).toBe(0);
    expect(db().prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE sender = 'memesh'").get()).toEqual({ n: 0 });
    expect(count('agent_message_events')).toBe(2);
    // Nothing was half done: the next pass finishes the job.
    expect(await run()).toMatchObject({ outcome: 'deleted', expired_message_count: 2, notice_count: 2 });
  });

  it('rolls the batch back when the delete removes fewer messages than it should', async () => {
    const kept = send('alice', 'bob');
    const other = send('carol', 'bob');
    age(kept.message_id);
    age(other.message_id);
    // A trigger that quietly skips one row: the delete "succeeds" with the wrong count.
    db().exec(`
      CREATE TRIGGER skip_one BEFORE DELETE ON agent_messages
      WHEN OLD.message_id = '${kept.message_id}'
      BEGIN SELECT RAISE(IGNORE); END
    `);
    const result = await run();
    db().exec('DROP TRIGGER skip_one');
    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain('expected to delete 2 message(s), deleted 1');
    expect(userMessages()).toBe(2);
    expect(count('agent_message_expiries')).toBe(0);
    expect(db().prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE sender = 'memesh'").get()).toEqual({ n: 0 });
  });

  it('works through more than one batch of messages', async () => {
    const old = agentMessageExpiryCutoff(Date.now() - 60_000);
    db().transaction(() => {
      for (let i = 0; i < 1100; i++) bareMessage(old, ['alice', 'carol', 'dave'][i % 3]);
    }).immediate();
    const young = bareMessage(agentMessageExpiryCutoff(Date.now() + 3_600_000));
    const result = await run();
    expect(result).toMatchObject({ outcome: 'deleted', expired_message_count: 1100, unread_message_count: 1100 });
    expect(ids()).toEqual([young]);
    expect(count('agent_message_expiries')).toBe(1100);
    // 11 batches of 100: one notice per sender for the whole pass, not one per batch.
    expect(result.notice_count).toBe(3);
    expect(foreignKeyViolations()).toEqual([]);
  });

  it('lists 20 expired messages in a notice and says how many it left out', async () => {
    const old = agentMessageExpiryCutoff(Date.now() - 60_000);
    for (let i = 0; i < 25; i++) bareMessage(old, 'alice');
    expect((await run()).notice_count).toBe(1);
    const events = pollAgentEvents(db(), { project: PROJECT, recipient: 'alice' }).events;
    const notice = fetchAgentMessage(db(), { project: PROJECT, recipient: 'alice', message_id: events[0].message_id });
    const payload = notice.payload as { messages: unknown[]; not_listed?: number; summary: string };
    expect(payload.messages).toHaveLength(20);
    expect(payload.not_listed).toBe(5);
    expect(payload.summary).toContain('25 messages');
  });

  it('forgets an expired id after 30 days and not before', async () => {
    const remember = db().prepare(`
      INSERT INTO agent_message_expiries (message_id, project, created_at, expired_at_ms, was_read)
      VALUES (?, ?, datetime('now', '-40 days'), ?, 1)
    `);
    remember.run('forty-days', PROJECT, Date.now() - 31 * 86_400_000);
    remember.run('twenty-nine-days', PROJECT, Date.now() - 29 * 86_400_000);
    expect((await run()).outcome).toBe('nothing_expired');
    expect((db().prepare('SELECT message_id FROM agent_message_expiries').all() as Array<{ message_id: string }>).map((r) => r.message_id))
      .toEqual(['twenty-nine-days']);
  });
});

describe('opening an older database', () => {
  it('adds the indexes the cascade needs, and the sender and recipient columns of the id table', async () => {
    const file = dbHandle.dbPath;
    db().exec('DROP INDEX idx_agent_message_receipts_message; DROP INDEX idx_agent_message_events_message; DROP INDEX idx_agent_message_events_delivery;');
    db().exec('DROP TABLE agent_message_expiries');
    db().exec('CREATE TABLE agent_message_expiries (message_id TEXT PRIMARY KEY, project TEXT NOT NULL, created_at TIMESTAMP NOT NULL, expired_at_ms INTEGER NOT NULL, was_read INTEGER NOT NULL, notice_message_id TEXT)');
    closeDatabase();
    openDatabase(file);
    const names = (db().prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining([
      'idx_agent_message_receipts_message', 'idx_agent_message_events_message', 'idx_agent_message_events_delivery',
    ]));
    const columns = (db().prepare('PRAGMA table_info(agent_message_expiries)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(['sender', 'recipient']));
    const planOf = (sql: string): string => (db().prepare(`EXPLAIN QUERY PLAN ${sql}`).all('x') as Array<{ detail: string }>).map((r) => r.detail).join(' | ');
    expect(planOf('SELECT 1 FROM agent_message_receipts WHERE message_id = ?')).toMatch(/idx_agent_message_receipts_message\b/);
    expect(planOf('SELECT 1 FROM agent_message_events WHERE message_id = ?')).toMatch(/idx_agent_message_events_message\b/);
    expect(planOf('SELECT 1 FROM agent_message_events WHERE delivery_id = ?')).toMatch(/idx_agent_message_events_delivery\b/);
    expect(planOf('SELECT 1 FROM agent_messages WHERE reply_to_message_id = ?')).toMatch(/idx_agent_messages_reply_to\b/);
  });
});

describe('what starts the pass in a real install', () => {
  function fresh(): { home: string; dbFile: string } {
    const home = fs.mkdtempSync('/tmp/mxw-');
    const dir = path.join(home, '.memesh');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dbFile = path.join(dir, 'knowledge-graph.db');
    const seeded = new DatabaseSync(dbFile);
    seeded.exec(SCHEMA_SQL);
    seeded.prepare(`
      INSERT INTO agent_messages (message_id, project, sender, recipient, content_type, privacy, payload_json, provenance_json, created_at)
      VALUES ('old-1', 'p', 'alice', 'bob', 'text/plain', 'private', '"x"', '{}', datetime('now', '-2 days'))
    `).run();
    seeded.close();
    return { home, dbFile };
  }

  /** The trigger of the run that deleted the seeded message; null when none did within the wait. */
  async function waitForRun(dbFile: string): Promise<string | null> {
    for (let waited = 0; waited < 12_000; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        const reader = new DatabaseSync(dbFile, { readOnly: true });
        try {
          const row = reader.prepare("SELECT trigger_source FROM agent_message_expiry_runs WHERE outcome = 'deleted' AND expired_message_count = 1 ORDER BY run_id LIMIT 1").get() as { trigger_source: string } | undefined;
          const left = (reader.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE message_id = 'old-1'").get() as { n: number }).n;
          if (row && left === 0) return row.trigger_source;
        } finally {
          reader.close();
        }
      } catch { /* the process is still starting up */ }
    }
    return null;
  }

  it.skipIf(process.platform === 'win32')('the MCP server runs it by itself', async () => {
    const { home, dbFile } = fresh();
    const child = spawn(process.execPath, [path.join(process.cwd(), 'dist/mcp/server.js')], {
      env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' }, stdio: ['pipe', 'ignore', 'ignore'],
    });
    try {
      expect(await waitForRun(dbFile)).toBe('mcp-server');
    } finally {
      child.kill('SIGTERM');
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  it.skipIf(process.platform === 'win32')('the router daemon runs it by itself', async () => {
    const { home, dbFile } = fresh();
    const child = spawn(process.execPath, [path.join(process.cwd(), 'dist/host-runtime/router.js')], {
      env: { ...process.env, HOME: home, MEMESH_ROUTER_SOCKET: path.join(home, 'r.sock') }, stdio: 'ignore',
    });
    try {
      expect(await waitForRun(dbFile)).toBe('router');
    } finally {
      child.kill('SIGTERM');
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});

function leaseRow(): { holder: string; expires_at_ms: number } | undefined {
  return db().prepare('SELECT holder, expires_at_ms FROM agent_message_expiry_lease').get() as { holder: string; expires_at_ms: number } | undefined;
}

describe('one process runs the pass at a time', () => {
  it('a second process that starts while the first is running stops, says so, and changes nothing', async () => {
    const lost = send('alice', 'bob');
    populate(lost);
    age(lost.message_id);
    const older = agentMessageExpiryCutoff(Date.now() - 60_000);
    db().transaction(() => { for (let i = 0; i < 249; i++) bareMessage(older, 'carol'); }).immediate();
    const second = new MemeshDatabase(dbHandle.dbPath);
    second.exec('PRAGMA foreign_keys = ON');
    let overlapped: Awaited<ReturnType<typeof runAgentMessageExpiry>> | null = null;
    try {
      const first = await runAgentMessageExpiry(db(), {
        trigger: 'first',
        fault: {
          // The first process holds the lease and has just deleted its first batch.
          afterBatch: async (batch) => { if (batch === 1) overlapped = await runAgentMessageExpiry(second, { trigger: 'second' }); },
        },
      });
      expect(first).toMatchObject({ outcome: 'deleted', expired_message_count: 250 });
      expect(overlapped).toMatchObject({ outcome: 'skipped_concurrent', expired_message_count: 0, backup_path: null });
      expect(overlapped!.detail).toContain('another process is running the pass');
      expect(overlapped!.run_id).not.toBeNull();
    } finally {
      second.close();
    }
    expect(fs.readdirSync(path.join(path.dirname(dbHandle.dbPath), 'backups'))).toEqual([path.basename(archiveFile())]);
    expect(userMessages()).toBe(0);
    const rows = db().prepare('SELECT trigger_source, outcome FROM agent_message_expiry_runs ORDER BY run_id').all();
    // The first pass wrote its row when it began (before the second started), then filled it in.
    expect(rows).toEqual([
      { trigger_source: 'first', outcome: 'deleted' },
      { trigger_source: 'second', outcome: 'skipped_concurrent' },
    ]);
    expect(leaseRow()).toBeUndefined();
    // The skip is recorded, but it is not "the last pass" doctor shows.
    expect(lastAgentMessageExpiryRun(db())).toMatchObject({ trigger_source: 'first', outcome: 'deleted' });
  });

  it('a lease held by a live process blocks the pass, and a lease that has run out is taken over', async () => {
    const lost = send('alice', 'bob');
    age(lost.message_id);
    db().prepare("INSERT INTO agent_message_expiry_lease (lease_id, holder, expires_at_ms) VALUES (1, 'someone-else', ?)").run(Date.now() + 60_000);
    expect(await run()).toMatchObject({ outcome: 'skipped_concurrent' });
    expect(userMessages()).toBe(1);
    expect(leaseRow()).toMatchObject({ holder: 'someone-else' });

    db().prepare('UPDATE agent_message_expiry_lease SET expires_at_ms = ?').run(Date.now() - 1);
    expect(await run()).toMatchObject({ outcome: 'deleted', expired_message_count: 1 });
    expect(userMessages()).toBe(0);
    expect(leaseRow()).toBeUndefined();
  });

  it('stops before deleting anything when another process takes the lease over mid-pass', async () => {
    const lost = send('alice', 'bob');
    age(lost.message_id);
    const result = await runAgentMessageExpiry(db(), {
      trigger: 'test',
      fault: { beforeArchiveCheck: () => { db().prepare("UPDATE agent_message_expiry_lease SET holder = 'thief'").run(); } },
    });
    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain('another process took over the expiry lease');
    expect(userMessages()).toBe(1);
    // The thief's lease is not released by the pass that lost it.
    expect(leaseRow()).toMatchObject({ holder: 'thief' });
  });

  it('two real processes that overlap: one runs the pass, the other is turned away', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mxl-'));
    const dir = path.join(home, '.memesh');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'knowledge-graph.db');
    const seeded = new DatabaseSync(file);
    seeded.exec(SCHEMA_SQL);
    seeded.exec('BEGIN');
    const insert = seeded.prepare(`
      INSERT INTO agent_messages (message_id, project, sender, recipient, content_type, privacy, payload_json, provenance_json, created_at)
      VALUES (?, 'p', 'alice', 'bob', 'text/plain', 'private', '"x"', '{}', datetime('now', '-2 days'))
    `);
    for (let i = 0; i < 3000; i++) insert.run(`m-${i}`);
    seeded.exec('COMMIT');
    seeded.close();
    const inBatch = path.join(home, 'first-is-in-its-first-batch');
    const turnedAway = path.join(home, 'second-has-been-turned-away');
    const script = `
      import fs from 'node:fs';
      const { MemeshDatabase } = await import(${JSON.stringify(pathToFileURL(path.join(process.cwd(), 'dist/storage/sqlite.js')).href)});
      const { runAgentMessageExpiry } = await import(${JSON.stringify(pathToFileURL(path.join(process.cwd(), 'dist/core/agent-message-expiry.js')).href)});
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const db = new MemeshDatabase(${JSON.stringify(file)});
      db.exec('PRAGMA foreign_keys = ON');
      const first = process.argv[1] === 'first';
      const fault = first
        // The first holds the lease and stays in its first batch until the second has been turned away.
        ? { afterBatch: async (n) => { if (n === 1) { fs.writeFileSync(${JSON.stringify(inBatch)}, '1'); while (!fs.existsSync(${JSON.stringify(turnedAway)})) await wait(20); } } }
        : undefined;
      if (!first) while (!fs.existsSync(${JSON.stringify(inBatch)})) await wait(20);
      const r = await runAgentMessageExpiry(db, { trigger: process.argv[1], fault });
      if (!first) fs.writeFileSync(${JSON.stringify(turnedAway)}, '1');
      process.stdout.write(JSON.stringify({ outcome: r.outcome, expired: r.expired_message_count }));
    `;
    const runOne = (name: string) => new Promise<{ outcome: string; expired: number }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, name], { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`exit ${code}`))));
    });
    try {
      const [first, second] = await Promise.all([runOne('first'), runOne('second')]);
      expect(first).toEqual({ outcome: 'deleted', expired: 3000 });
      expect(second).toEqual({ outcome: 'skipped_concurrent', expired: 0 });
      const check = new DatabaseSync(file, { readOnly: true });
      try {
        expect((check.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE sender <> 'memesh'").get() as { n: number }).n).toBe(0);
        expect(check.prepare('SELECT trigger_source, outcome FROM agent_message_expiry_runs ORDER BY run_id').all()).toEqual([
          { trigger_source: 'first', outcome: 'deleted' },
          { trigger_source: 'second', outcome: 'skipped_concurrent' },
        ]);
      } finally {
        check.close();
      }
      expect(fs.readdirSync(path.join(dir, 'backups'))).toEqual(['agent-messages-expired.db']);
      expect(countIn(path.join(dir, 'backups', 'agent-messages-expired.db'), 'agent_messages')).toBe(3000);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('a long pass does not hold the process', () => {
  it('lets other work run between batches', async () => {
    const old = agentMessageExpiryCutoff(Date.now() - 60_000);
    db().transaction(() => {
      for (let i = 0; i < 1600; i++) bareMessage(old, 'alice');
    }).immediate();
    // Event-loop turns that happen while the 16 batches run.
    let turns = 0;
    let spinning = true;
    const spin = (): void => { if (!spinning) return; turns += 1; setImmediate(spin); };
    spin();
    let result;
    try {
      result = await runAgentMessageExpiry(db(), { trigger: 'test' });
    } finally {
      spinning = false;
    }
    expect(result).toMatchObject({ outcome: 'deleted', expired_message_count: 1600 });
    expect(turns).toBeGreaterThanOrEqual(16);
  });

  it('lets other work run while it clears a large archive', async () => {
    const old = agentMessageExpiryCutoff(Date.now() - 60_000);
    db().transaction(() => {
      for (let i = 0; i < 1600; i++) bareMessage(old, 'alice');
    }).immediate();
    await run();
    inArchive(`UPDATE archive_log SET archived_at_ms = ${Date.now() - 25 * 3_600_000}`);
    let turns = 0;
    let spinning = true;
    const spin = (): void => { if (!spinning) return; turns += 1; setImmediate(spin); };
    spin();
    let result;
    try {
      result = await runAgentMessageExpiry(db(), { trigger: 'test' });
    } finally {
      spinning = false;
    }
    expect(result).toMatchObject({ outcome: 'archive_purged' });
    expect(countIn(archiveFile(), 'archive_log')).toBe(0);
    // One turn is the spin's own first call; the rest happen between the purge's batches.
    expect(turns).toBeGreaterThanOrEqual(1 + 15);
  });
});

describe('the HTTP server runs the pass too', () => {
  it.skipIf(process.platform === 'win32')('`memesh serve` deletes by itself and records the run', async () => {
    const home = fs.mkdtempSync('/tmp/mxs-');
    const dir = path.join(home, '.memesh');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'knowledge-graph.db');
    const seeded = new DatabaseSync(file);
    seeded.exec(SCHEMA_SQL);
    seeded.prepare(`
      INSERT INTO agent_messages (message_id, project, sender, recipient, content_type, privacy, payload_json, provenance_json, created_at)
      VALUES ('old-1', 'p', 'alice', 'bob', 'text/plain', 'private', '"x"', '{}', datetime('now', '-2 days'))
    `).run();
    seeded.close();
    const child = spawn(process.execPath, [path.join(process.cwd(), 'dist/transports/cli/cli.js'), 'serve', '--port', '0'], {
      env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false', MEMESH_SKIP_UPDATE_CHECK: '1' }, stdio: 'ignore',
    });
    try {
      let trigger: string | null = null;
      for (let waited = 0; waited < 12_000 && trigger === null; waited += 100) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
          const reader = new DatabaseSync(file, { readOnly: true });
          try {
            trigger = (reader.prepare('SELECT trigger_source FROM agent_message_expiry_runs ORDER BY run_id LIMIT 1').get() as { trigger_source: string } | undefined)?.trigger_source ?? null;
          } finally {
            reader.close();
          }
        } catch { /* still starting */ }
      }
      expect(trigger).toBe('http-serve');
    } finally {
      // serve closes a running pass on the way out: let it finish before its folder goes.
      const exited = child.exitCode === null && child.signalCode === null ? new Promise((resolve) => { child.once('exit', resolve); }) : undefined;
      child.kill('SIGTERM');
      await exited;
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});


describe('what a pass leaves behind while it works', () => {
  it('saves its counts and the archive path on its row after every batch', async () => {
    const old = agentMessageExpiryCutoff(Date.now() - 60_000);
    db().transaction(() => {
      for (let i = 0; i < 350; i++) bareMessage(old, 'alice');
    }).immediate();
    const seen: Array<{ outcome: string; expired_message_count: number; backup_path: string | null }> = [];
    await run2({
      afterBatch: (batch: number) => {
        seen.push(db().prepare("SELECT outcome, expired_message_count, backup_path FROM agent_message_expiry_runs WHERE outcome = 'started'").get() as never);
        expect(batch).toBeGreaterThan(0);
      },
    });
    expect(seen.map((row) => row.expired_message_count)).toEqual([100, 200, 300, 350]);
    expect(new Set(seen.map((row) => row.backup_path)).size).toBe(1);
    expect(fs.realpathSync(seen[0].backup_path!)).toBe(fs.realpathSync(archiveFile()));
  });
});

function run2(fault: NonNullable<Parameters<typeof runAgentMessageExpiry>[1]['fault']>) {
  return runAgentMessageExpiry(db(), { trigger: 'test', fault });
}

describe('the pass is started by every long-lived process, in the source', () => {
  const source = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');

  it('the router daemon, the MCP server and `memesh serve` start the scheduler', () => {
    expect(source('src/host-runtime/router.ts')).toMatch(/startAgentMessageExpiryScheduler\([\s\S]{0,120}?\{ trigger: 'router' \}/);
    expect(source('src/mcp/server.ts')).toMatch(/startAgentMessageExpiryScheduler\([\s\S]{0,120}?\{ trigger: 'mcp-server' \}/);
    expect(source('src/transports/http/server.ts')).toMatch(/startAgentMessageExpiryScheduler\([\s\S]*?trigger: 'http-serve'/);
    expect(source('src/transports/cli/cli.ts')).toMatch(/startServer\(opts\.host, opts\.port, \{[^}]*agentMessageExpiry: true/);
  });

  it('a server started with the option deletes by itself, in this process', async () => {
    const lost = send('alice', 'bob');
    age(lost.message_id);
    const server = startServer('127.0.0.1', 0, { agentMessageExpiry: true });
    try {
      for (let waited = 0; waited < 8_000 && userMessages() > 0; waited += 50) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      for (let waited = 0; waited < 2_000 && lastAgentMessageExpiryRun(db()) === null; waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(userMessages()).toBe(0);
    expect(lastAgentMessageExpiryRun(db())).toMatchObject({ trigger_source: 'http-serve', outcome: 'deleted', expired_message_count: 1 });
  }, 20_000);
});

describe('a pass that is killed half way', () => {
  function killedPass(): { archive: string } {
    const old = agentMessageExpiryCutoff(Date.now() - 60_000);
    db().transaction(() => {
      for (let i = 0; i < 1500; i++) bareMessage(old, 'alice');
    }).immediate();
    db().exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const script = `
      const { MemeshDatabase } = await import(${JSON.stringify(path.join(process.cwd(), 'dist/storage/sqlite.js'))});
      const { runAgentMessageExpiry } = await import(${JSON.stringify(path.join(process.cwd(), 'dist/core/agent-message-expiry.js'))});
      const db = new MemeshDatabase(${JSON.stringify(dbHandle.dbPath)});
      db.exec('PRAGMA foreign_keys = ON');
      await runAgentMessageExpiry(db, { trigger: 'doomed', fault: { afterBatch: (n) => { if (n === 3) process.kill(process.pid, 'SIGKILL'); } } });
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(child.signal).toBe('SIGKILL');
    return { archive: fs.realpathSync(archiveFile()) };
  }

  it('leaves a row that says what it had deleted and where it put it', () => {
    const { archive } = killedPass();
    const started = db().prepare("SELECT expired_message_count, backup_path FROM agent_message_expiry_runs WHERE outcome = 'started'").all();
    expect(started).toEqual([{ expired_message_count: 300, backup_path: archive }]);
    expect(countIn(archive, 'agent_messages')).toBe(300);
    expect(userMessages()).toBe(1200);
    expect(latestAgentMessageExpiryArchive(db())).toBe(archive);
  });

  it('after the lease runs out, the next pass closes it as interrupted, finishes the job, and the archive holds everything', async () => {
    const { archive } = killedPass();
    // The killed process still holds the lease until it runs out.
    expect(await run()).toMatchObject({ outcome: 'skipped_concurrent' });
    db().prepare('UPDATE agent_message_expiry_lease SET expires_at_ms = 0').run();
    const result = await run();
    expect(result).toMatchObject({ outcome: 'deleted', expired_message_count: 1200, backup_path: archive });
    expect(userMessages()).toBe(0);
    expect(countIn(archive, 'agent_messages')).toBe(1500);
    expect(db().prepare("SELECT outcome, expired_message_count FROM agent_message_expiry_runs WHERE trigger_source = 'doomed'").all())
      .toEqual([{ outcome: 'interrupted', expired_message_count: 300 }]);
    expect(db().prepare("SELECT COUNT(*) AS n FROM agent_message_expiry_runs WHERE outcome = 'started'").get()).toEqual({ n: 0 });
    expect(latestAgentMessageExpiryArchive(db())).toBe(archive);
  });

  it('a dead pass\'s row does not hold the next pass off for the five-minute interval', async () => {
    db().prepare(`
      INSERT INTO agent_message_expiry_runs (started_at_ms, finished_at_ms, trigger_source, outcome)
      VALUES (?, ?, 'router', 'started')
    `).run(Date.now() - 60_000, Date.now() - 60_000);
    expect(await runAgentMessageExpiryIfDue(db(), { trigger: 'test' })).not.toBeNull();
  });

  it('doctor warns about a pass that started long ago and never finished, naming the archive only if it is there', async () => {
    db().prepare(`
      INSERT INTO agent_message_expiry_runs (started_at_ms, finished_at_ms, trigger_source, outcome, backup_path)
      VALUES (?, ?, 'router', 'started', ?)
    `).run(Date.now() - 2 * 3_600_000, Date.now() - 2 * 3_600_000, archiveFile());
    let row = await doctorRow();
    expect(row?.status).toBe('warn');
    expect(row?.summary).toContain('has not finished');
    expect(row?.summary).toContain('probably stopped');
    expect(row?.summary).toContain('2 hour(s) ago');
    expect(row?.summary).toContain('closes it as interrupted');
    expect(row?.summary).not.toContain(archiveFile());
    fs.mkdirSync(path.dirname(archiveFile()), { recursive: true });
    fs.writeFileSync(archiveFile(), 'x');
    row = await doctorRow();
    expect(row?.summary).toContain(archiveFile());
    expect(row?.summary).not.toContain('keeps pointing');
  });

  it('doctor, right after the kill and before the lease runs out, says what happened and not that nothing ran', async () => {
    const { archive } = killedPass();
    const row = await doctorRow();
    expect(row?.status).toBe('pass');
    expect(row?.summary).not.toContain('No expiry pass has run');
    expect(row?.summary).toContain('A pass started under a minute ago');
    expect(row?.summary).toContain('it is still working, or it was stopped a moment ago');
    expect(row?.summary).toContain('has not finished');
    expect(row?.summary).toContain('it had deleted 300 message(s)');
    expect(row?.summary).toContain(archive);
    expect(row?.summary).toContain('takes over once its lease runs out');
  });

  it('doctor does not let an unfinished pass hide the failure of the last finished one', async () => {
    db().prepare(`
      INSERT INTO agent_message_expiry_runs (started_at_ms, finished_at_ms, trigger_source, outcome, detail)
      VALUES (?, ?, 'router', 'archive_failed', 'could not archive the rows of 3 message(s) (disk full)')
    `).run(Date.now() - 3 * 3_600_000, Date.now() - 3 * 3_600_000);
    db().prepare(`
      INSERT INTO agent_message_expiry_runs (started_at_ms, finished_at_ms, trigger_source, outcome)
      VALUES (?, ?, 'mcp-server', 'started')
    `).run(Date.now() - 20_000, Date.now() - 20_000);
    const row = await doctorRow();
    expect(row?.status).toBe('warn');
    expect(row?.summary).toContain('has not finished');
    expect(row?.summary).toContain('archive_failed');
    expect(row?.summary).toContain('disk full');
    expect(row?.fix).toContain('Nothing more is deleted while this fails');
  });

  function finishedPass(): void {
    db().prepare(`
      INSERT INTO agent_message_expiry_runs (started_at_ms, finished_at_ms, trigger_source, outcome, expired_message_count)
      VALUES (?, ?, 'router', 'deleted', 7)
    `).run(Date.now() - 3 * 3_600_000, Date.now() - 3 * 3_600_000);
  }

  it('doctor shows a fresh unfinished pass and the last good pass together, without a warning', async () => {
    finishedPass();
    db().prepare(`
      INSERT INTO agent_message_expiry_runs (started_at_ms, finished_at_ms, trigger_source, outcome)
      VALUES (?, ?, 'mcp-server', 'started')
    `).run(Date.now() - 20_000, Date.now() - 20_000);
    const row = await doctorRow();
    expect(row?.status).toBe('pass');
    expect(row?.summary).toContain('has not finished');
    expect(row?.summary).toContain('Last pass 3 hour(s) ago (deleted, started by router): 7 message(s) deleted');
  });

  it('doctor warns about an old unfinished pass even when the last finished pass was fine, and shows both', async () => {
    finishedPass();
    db().prepare(`
      INSERT INTO agent_message_expiry_runs (started_at_ms, finished_at_ms, trigger_source, outcome)
      VALUES (?, ?, 'mcp-server', 'started')
    `).run(Date.now() - 30 * 60_000, Date.now() - 30 * 60_000);
    const row = await doctorRow();
    expect(row?.status).toBe('warn');
    expect(row?.summary).toContain('probably stopped');
    expect(row?.summary).toContain('Last pass 3 hour(s) ago');
    expect(row?.fix).toContain('start a MeMesh session');
  });
});

async function doctorRow() {
  const { runDoctor } = await import('../../src/core/doctor.js');
  const result = await runDoctor({
    packageRoot: process.cwd(), packageVersion: 'test',
    openDatabaseImpl: () => db(), closeDatabaseImpl: () => undefined, isDatabaseOpenImpl: () => true,
    getConfigPathImpl: () => path.join(dbHandle.tmpDir, 'config.json'),
    getUpdateCheckImpl: async () => ({ checkSucceeded: true, updateAvailable: false }) as never,
    getCurrentInstallChannelImpl: () => 'npm-global',
    getInstallChannelSupportImpl: () => ({ label: 'npm global', canSelfUpdate: false }) as never,
    nativeBindingProbeImpl: () => ({ ok: true }),
    resolveShellMemeshImpl: () => null,
  });
  return result.checks.find((check) => check.id === 'agent_message_expiry');
}

/** The test database is `test.db`, not the default `knowledge-graph.db`, so its archive carries its name. */
function archiveFile(): string {
  return path.join(path.dirname(dbHandle.dbPath), 'backups', 'agent-messages-expired-test.db');
}

function countIn(file: string, table: string): number {
  const handle = new DatabaseSync(file, { readOnly: true });
  try {
    return (handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    handle.close();
  }
}

function inArchive(sql: string): void {
  const handle = new DatabaseSync(archiveFile());
  try {
    handle.exec(sql);
  } finally {
    handle.close();
  }
}

describe('the archive of deleted messages is kept one more day', () => {
  it('removes what was archived more than a day ago, by the time in the archive and not by file name, and keeps what this pass archived', async () => {
    const first = send('alice', 'bob');
    populate(first);
    age(first.message_id);
    await run();
    expect(countIn(archiveFile(), 'agent_messages')).toBe(1);
    // That batch was archived 25 hours ago.
    inArchive("UPDATE archive_log SET archived_at_ms = " + (Date.now() - 25 * 3_600_000));
    const second = send('carol', 'bob');
    age(second.message_id);
    const result = await run();
    expect(result.outcome).toBe('deleted');
    for (const table of MESSAGE_TABLES) {
      expect(countIn(archiveFile(), table), table).toBe(table === 'agent_messages' || table === 'agent_message_deliveries' || table === 'agent_message_events' || table === 'agent_message_idempotency' ? 1 : 0);
    }
    expect((new DatabaseSync(archiveFile(), { readOnly: true }).prepare('SELECT message_id FROM agent_messages').get() as { message_id: string }).message_id).toBe(second.message_id);
    expect(countIn(archiveFile(), 'archive_log')).toBe(1);
  });

  it('removes it even when nothing new is expiring, and records that', async () => {
    const first = send('alice', 'bob');
    age(first.message_id);
    await run();
    inArchive("UPDATE archive_log SET archived_at_ms = " + (Date.now() - 25 * 3_600_000));
    const result = await run();
    expect(result.outcome).toBe('archive_purged');
    expect(countIn(archiveFile(), 'agent_messages')).toBe(0);
    expect(countIn(archiveFile(), 'archive_log')).toBe(0);
    expect(await run()).toMatchObject({ outcome: 'nothing_expired' });
  });

  it('keeps what is archived a little less than a day ago, and what looks archived in the future', async () => {
    const first = send('alice', 'bob');
    const second = send('carol', 'bob');
    age(first.message_id);
    age(second.message_id);
    await run();
    inArchive(`UPDATE archive_log SET archived_at_ms = ${Date.now() - 23 * 3_600_000} WHERE message_id = '${first.message_id}'`);
    inArchive(`UPDATE archive_log SET archived_at_ms = ${Date.now() + 5 * 3_600_000} WHERE message_id = '${second.message_id}'`);
    expect(await run()).toMatchObject({ outcome: 'nothing_expired' });
    expect(countIn(archiveFile(), 'agent_messages')).toBe(2);
    // And when the purge does run (a third copy is past its day), it still keeps those two.
    const third = send('dave', 'bob');
    age(third.message_id);
    await run();
    inArchive(`UPDATE archive_log SET archived_at_ms = ${Date.now() - 25 * 3_600_000} WHERE message_id = '${third.message_id}'`);
    expect(await run()).toMatchObject({ outcome: 'archive_purged' });
    expect(countIn(archiveFile(), 'agent_messages')).toBe(2);
  });

  it('says so, and does not call it a purge, when old archive rows cannot be removed', async () => {
    const first = send('alice', 'bob');
    age(first.message_id);
    await run();
    inArchive("UPDATE archive_log SET archived_at_ms = " + (Date.now() - 25 * 3_600_000));
    inArchive("CREATE TRIGGER refuse_purge BEFORE DELETE ON archive_log BEGIN SELECT RAISE(ABORT, 'refused for the test'); END");
    const result = await run();
    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain('could not remove archive rows older than a day');
    expect(result.detail).toContain('refused for the test');
    expect(countIn(archiveFile(), 'agent_messages')).toBe(1);
  });

  it('copies the same rows again without duplicating them when a batch is archived twice', async () => {
    const lost = send('alice', 'bob');
    populate(lost);
    age(lost.message_id);
    // The first attempt archives, then fails to delete: the rows are in both files.
    db().exec(`
      CREATE TRIGGER refuse_delete BEFORE DELETE ON agent_messages
      BEGIN SELECT RAISE(ABORT, 'refused for the test'); END
    `);
    const failed = await run();
    db().exec('DROP TRIGGER refuse_delete');
    expect(failed.outcome).toBe('failed');
    expect(countIn(archiveFile(), 'agent_messages')).toBe(1);
    expect(userMessages()).toBe(1);
    expect(await run()).toMatchObject({ outcome: 'deleted', expired_message_count: 1 });
    for (const table of MESSAGE_TABLES) {
      expect(countIn(archiveFile(), table), table).toBe(table === 'agent_message_receipts' ? 3 : 1);
    }
  });

  /** Archives a message, then fails to delete it, so its rows are in the archive and in the database. */
  async function archivedNotDeleted(): Promise<SentAgentMessage> {
    const lost = send('alice', 'bob');
    populate(lost);
    age(lost.message_id);
    db().exec("CREATE TRIGGER refuse_delete BEFORE DELETE ON agent_messages BEGIN SELECT RAISE(ABORT, 'refused for the test'); END");
    expect((await run()).outcome).toBe('failed');
    db().exec('DROP TRIGGER refuse_delete');
    return lost;
  }

  function archivedAt(messageId: string): number | undefined {
    const handle = new DatabaseSync(archiveFile(), { readOnly: true });
    try {
      return (handle.prepare('SELECT archived_at_ms FROM archive_log WHERE message_id = ?').get(messageId) as { archived_at_ms: number } | undefined)?.archived_at_ms;
    } finally {
      handle.close();
    }
  }

  // Two defences keep this copy, and either alone keeps this test green: archiving again restarts the extra day
  // ('starts the extra day again...'), and old archive rows are removed before the batches ('still removes archive
  // rows past their extra day when a batch cannot be archived'). Each of those tests guards its own.
  it('keeps the copy of a message it deletes, even when that message was first archived more than a day ago', async () => {
    const lost = await archivedNotDeleted();
    // No pass ran for 25 hours after the first copy was made.
    inArchive(`UPDATE archive_log SET archived_at_ms = ${Date.now() - 25 * 3_600_000}`);
    expect(await run()).toMatchObject({ outcome: 'deleted', expired_message_count: 1 });
    expect(userMessages()).toBe(0);
    expect(countIn(archiveFile(), 'agent_messages')).toBe(1);
    expect(archivedAt(lost.message_id)).toBeDefined();
  });

  it('starts the extra day again when it archives a message a second time', async () => {
    const lost = await archivedNotDeleted();
    inArchive(`UPDATE archive_log SET archived_at_ms = ${Date.now() - 23 * 3_600_000}`);
    const before = Date.now();
    expect(await run()).toMatchObject({ outcome: 'deleted', expired_message_count: 1 });
    // The copy is kept a day from the deletion, not from the first copy (which would go in an hour).
    expect(archivedAt(lost.message_id)).toBeGreaterThanOrEqual(before);
  });

  it('a message resent with the key of one already archived is archived too, and does not hold up the others in its batch', async () => {
    const first = send('alice', 'bob', { key: 'same-key' });
    age(first.message_id);
    expect(await run()).toMatchObject({ outcome: 'deleted', expired_message_count: 1 });
    // An archive made by the first release of this code keys its idempotency copies by (project, sender, key).
    inArchive('DROP INDEX IF EXISTS ux_agent_message_idempotency; CREATE UNIQUE INDEX ux_agent_message_idempotency ON agent_message_idempotency(project, sender, idempotency_key)');
    const again = send('alice', 'bob', { key: 'same-key' });
    const other = send('carol', 'bob');
    expect(again.message_id).not.toBe(first.message_id);
    age(again.message_id);
    age(other.message_id);
    expect(await run()).toMatchObject({ outcome: 'deleted', expired_message_count: 2 });
    expect(userMessages()).toBe(0);
    // The first copy (archived today), the resend and carol's message.
    expect(countIn(archiveFile(), 'agent_message_idempotency')).toBe(3);
    expect(countIn(archiveFile(), 'agent_messages')).toBe(3);
  });

  it('still removes archive rows past their extra day when a batch cannot be archived', async () => {
    const first = send('alice', 'bob');
    age(first.message_id);
    await run();
    inArchive(`UPDATE archive_log SET archived_at_ms = ${Date.now() - 25 * 3_600_000}`);
    const second = send('carol', 'bob');
    age(second.message_id);
    const result = await runAgentMessageExpiry(db(), {
      trigger: 'test',
      fault: { beforeArchiveCheck() { throw new Error('refused for the test'); } },
    });
    expect(result.outcome).toBe('archive_failed');
    expect(result.backup_path).toBeNull();
    expect(userMessages()).toBe(1);
    // A full disk or a stuck batch must not also stop the archive from shrinking.
    expect(archivedAt(first.message_id)).toBeUndefined();
  });

  function liveColumns(table: string): string[] {
    return (db().prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).map((row) => row.name);
  }

  function archivedMessage(messageId: string): Record<string, unknown> | undefined {
    const handle = new DatabaseSync(archiveFile(), { readOnly: true });
    try {
      return handle.prepare('SELECT * FROM agent_messages WHERE message_id = ?').get(messageId) as Record<string, unknown> | undefined;
    } finally {
      handle.close();
    }
  }

  it('puts every column in the archive under its own name when the archive table has its columns in another order', async () => {
    // The order of an archive made from a database created before 2026-08-27 and upgraded since: the payload_*
    // columns were added at the end (src/storage/schema.ts), so they come after created_at, not before provenance_json.
    const late = ['payload_sha256', 'payload_original_bytes', 'payload_tombstoned_at'];
    const upgraded = [...liveColumns('agent_messages').filter((name) => !late.includes(name)), ...late];
    fs.mkdirSync(path.dirname(archiveFile()), { recursive: true, mode: 0o700 });
    inArchive(`CREATE TABLE agent_messages (${upgraded.map((name) => `"${name}"`).join(', ')})`);
    const lost = send('alice', 'bob');
    age(lost.message_id);
    const live = db().prepare('SELECT * FROM agent_messages WHERE message_id = ?').get(lost.message_id) as Record<string, unknown>;
    expect(await run()).toMatchObject({ outcome: 'deleted', expired_message_count: 1 });
    expect(archivedMessage(lost.message_id)).toEqual(live);
  });

  it('adds to the archive a column the database has and the archive does not, and fills it', async () => {
    fs.mkdirSync(path.dirname(archiveFile()), { recursive: true, mode: 0o700 });
    inArchive(`CREATE TABLE agent_messages (${liveColumns('agent_messages').filter((name) => name !== 'payload_sha256').map((name) => `"${name}"`).join(', ')})`);
    const lost = send('alice', 'bob');
    db().prepare("UPDATE agent_messages SET payload_sha256 = 'sha-for-the-test' WHERE message_id = ?").run(lost.message_id);
    age(lost.message_id);
    expect(await run()).toMatchObject({ outcome: 'deleted', expired_message_count: 1 });
    expect(archivedMessage(lost.message_id)?.payload_sha256).toBe('sha-for-the-test');
  });

  it('deletes nothing when any table of the archive holds the batch\'s rows with other content, whatever the row counts', async () => {
    const kept = send('alice', 'bob');
    populate(kept);
    age(kept.message_id);
    for (const table of MESSAGE_TABLES) {
      const result = await runAgentMessageExpiry(db(), {
        trigger: 'test',
        fault: { beforeArchiveCheck: () => inArchive(`UPDATE ${table} SET created_at = '1999-01-01 00:00:00'`) },
      });
      expect(result.outcome, table).toBe('archive_failed');
      expect(result.detail, table).toContain(table);
      expect(userMessages(), table).toBe(1);
    }
    // Every column is compared, the message body too.
    const changedBody = await runAgentMessageExpiry(db(), {
      trigger: 'test', fault: { beforeArchiveCheck: () => inArchive("UPDATE agent_messages SET payload_json = '\"changed\"'") },
    });
    expect(changedBody.outcome).toBe('archive_failed');
    expect(userMessages()).toBe(1);
    // Once the copy matches again, the message goes.
    expect(await run()).toMatchObject({ outcome: 'deleted', expired_message_count: 1 });
  });
});

describe('getting deleted messages back from the archive', () => {
  const haveSqlite = process.platform !== 'win32' && spawnSync('sqlite3', ['-version']).status === 0;

  function guideCommand(): string {
    const guide = fs.readFileSync(path.join(process.cwd(), 'docs/platforms/agent-messaging.md'), 'utf8');
    const block = /```bash\n((?:(?!```)[\s\S])*?ATTACH(?:(?!```)[\s\S])*?)```/.exec(guide)?.[1];
    expect(block, 'the guide must show the restore command').toBeTruthy();
    // The block sits inside a list item, indented by two spaces; a reader copying it from the rendered page gets it without.
    return block!.replace(/^ {2}/gm, '');
  }

  async function prepared(): Promise<{ home: string; live: string; lostId: string; keepId: string }> {
    const lost = send('alice', 'bob');
    populate(lost);
    const keep = send('alice', 'bob');
    age(lost.message_id);
    await run();
    const later = send('carol', 'bob'); // written after the deletion
    expect(later.message_id).toBeTruthy();
    db().exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const home = fs.mkdtempSync(path.join(dbHandle.tmpDir, 'home-'));
    fs.mkdirSync(path.join(home, '.memesh', 'backups'), { recursive: true });
    const live = path.join(home, '.memesh', 'knowledge-graph.db');
    fs.copyFileSync(dbHandle.dbPath, live);
    fs.chmodSync(live, 0o600);
    fs.copyFileSync(archiveFile(), path.join(home, '.memesh', 'backups', 'agent-messages-expired.db'));
    return { home, live, lostId: lost.message_id, keepId: keep.message_id };
  }

  it.skipIf(!haveSqlite)('the restore command in the guide puts the deleted message back for another day and leaves everything else as it is', async () => {
    const { home, live, lostId, keepId } = await prepared();
    const before = countIn(live, 'agent_messages');
    const handleBefore = new DatabaseSync(live, { readOnly: true });
    try {
      expect(handleBefore.prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE message_id = ?').get(lostId)).toEqual({ n: 0 });
    } finally {
      handleBefore.close();
    }
    const ran = spawnSync('sh', ['-c', guideCommand()], { env: { ...process.env, HOME: home, MEMESH_DB_PATH: '', MEMESH_DIR: '' }, encoding: 'utf8' });
    // `${MEMESH_DB_PATH:-...}` treats an empty value as unset.
    expect(ran.status, ran.stderr).toBe(0);
    const handle = new DatabaseSync(live, { readOnly: true });
    try {
      const ids = (handle.prepare("SELECT message_id FROM agent_messages WHERE sender <> 'memesh'").all() as Array<{ message_id: string }>).map((r) => r.message_id);
      expect(ids).toContain(lostId);
      expect(ids).toContain(keepId);
      expect((handle.prepare('SELECT COUNT(*) AS n FROM agent_messages').get() as { n: number }).n).toBe(before + 1);
      const restored = handle.prepare('SELECT created_at FROM agent_messages WHERE message_id = ?').get(lostId) as { created_at: string };
      expect(restored.created_at >= agentMessageExpiryCutoff(Date.now() - 120_000)).toBe(true);
      expect(handle.prepare('SELECT COUNT(*) AS n FROM agent_message_events WHERE message_id = ?').get(lostId)).toEqual({ n: 1 });
      expect(handle.prepare('SELECT COUNT(*) AS n FROM agent_message_expiries WHERE message_id = ?').get(lostId)).toEqual({ n: 0 });
      expect(handle.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      handle.close();
    }
    // Running it again changes nothing.
    const eventsAfterFirst = countIn(live, 'agent_message_events');
    const again = spawnSync('sh', ['-c', guideCommand()], { env: { ...process.env, HOME: home, MEMESH_DB_PATH: '', MEMESH_DIR: '' }, encoding: 'utf8' });
    expect(again.status, again.stderr).toBe(0);
    expect(countIn(live, 'agent_messages')).toBe(before + 1);
    expect(countIn(live, 'agent_message_events')).toBe(eventsAfterFirst);
  });

  it.skipIf(!haveSqlite)('the restored message can be read again, and is deleted again a day later', async () => {
    const { home, live, lostId } = await prepared();
    const ran = spawnSync('sh', ['-c', guideCommand()], { env: { ...process.env, HOME: home, MEMESH_DB_PATH: '', MEMESH_DIR: '' }, encoding: 'utf8' });
    expect(ran.status, ran.stderr).toBe(0);
    // Put the restored database in place of the live one.
    const restored = new MemeshDatabase(live);
    restored.exec('PRAGMA foreign_keys = ON');
    try {
      expect(fetchAgentMessage(restored, { project: PROJECT, recipient: 'bob', message_id: lostId }).message_id).toBe(lostId);
      expect(pollAgentEvents(restored, { project: PROJECT, recipient: 'bob' }).events.map((e) => e.message_id)).toContain(lostId);
      // A day later, with no pass in between: it is deleted again, and its copy is in the archive for another day.
      const restoredArchive = path.join(home, '.memesh', 'backups', 'agent-messages-expired.db');
      const archiveHandle = new DatabaseSync(restoredArchive);
      archiveHandle.exec(`UPDATE archive_log SET archived_at_ms = ${Date.now() - 30 * 3_600_000}`);
      archiveHandle.close();
      for (const table of ['agent_messages', 'agent_message_deliveries', 'agent_message_events']) {
        restored.prepare(`UPDATE ${table} SET created_at = datetime('now', '-25 hours') WHERE message_id = ?`).run(lostId);
      }
      expect(await runAgentMessageExpiry(restored, { trigger: 'test' })).toMatchObject({ outcome: 'deleted', expired_message_count: 1 });
      const after = new DatabaseSync(restoredArchive, { readOnly: true });
      try {
        expect(after.prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE message_id = ?').get(lostId)).toEqual({ n: 1 });
        expect(after.prepare('SELECT COUNT(*) AS n FROM archive_log WHERE message_id = ?').get(lostId)).toEqual({ n: 1 });
      } finally {
        after.close();
      }
    } finally {
      restored.close();
    }
  });

  it.skipIf(!haveSqlite)('finds the files from MEMESH_DB_PATH, and from MEMESH_DIR, as the guide says', async () => {
    const { home } = await prepared();
    const elsewhere = fs.mkdtempSync(path.join(dbHandle.tmpDir, 'elsewhere-'));
    fs.mkdirSync(path.join(elsewhere, 'backups'));
    fs.copyFileSync(path.join(home, '.memesh', 'knowledge-graph.db'), path.join(elsewhere, 'custom.db'));
    fs.copyFileSync(archiveFile(), path.join(elsewhere, 'backups', 'agent-messages-expired-custom.db'));
    const before = countIn(path.join(elsewhere, 'custom.db'), 'agent_messages');
    const ran = spawnSync('sh', ['-c', guideCommand()], { env: { ...process.env, HOME: home, MEMESH_DB_PATH: path.join(elsewhere, 'custom.db') }, encoding: 'utf8' });
    expect(ran.status, ran.stderr).toBe(0);
    expect(countIn(path.join(elsewhere, 'custom.db'), 'agent_messages')).toBe(before + 1);

    const dirHome = fs.mkdtempSync(path.join(dbHandle.tmpDir, 'dir-'));
    fs.mkdirSync(path.join(dirHome, 'backups'));
    fs.copyFileSync(path.join(home, '.memesh', 'knowledge-graph.db'), path.join(dirHome, 'knowledge-graph.db'));
    fs.copyFileSync(archiveFile(), path.join(dirHome, 'backups', 'agent-messages-expired.db'));
    const viaDir = spawnSync('sh', ['-c', guideCommand()], { env: { ...process.env, HOME: home, MEMESH_DB_PATH: '', MEMESH_DIR: dirHome }, encoding: 'utf8' });
    expect(viaDir.status, viaDir.stderr).toBe(0);
    expect(countIn(path.join(dirHome, 'knowledge-graph.db'), 'agent_messages')).toBe(before + 1);
  });

  it.skipIf(!haveSqlite)('works when MEMESH_DB_PATH is a symlink to the database, and when the path holds a quote', async () => {
    const { home } = await prepared();
    // The archive is beside the real file, which is where MeMesh writes it.
    const real = fs.mkdtempSync(path.join(dbHandle.tmpDir, "it's real-"));
    fs.mkdirSync(path.join(real, 'backups'));
    fs.copyFileSync(path.join(home, '.memesh', 'knowledge-graph.db'), path.join(real, 'work.db'));
    fs.copyFileSync(archiveFile(), path.join(real, 'backups', 'agent-messages-expired-work.db'));
    const links = fs.mkdtempSync(path.join(dbHandle.tmpDir, 'links-'));
    fs.symlinkSync(path.join(real, 'work.db'), path.join(links, 'kg.db'));
    const before = countIn(path.join(real, 'work.db'), 'agent_messages');
    const ran = spawnSync('sh', ['-c', guideCommand()], { env: { ...process.env, HOME: home, MEMESH_DB_PATH: path.join(links, 'kg.db') }, encoding: 'utf8' });
    expect(ran.status, ran.stderr).toBe(0);
    expect(countIn(path.join(real, 'work.db'), 'agent_messages')).toBe(before + 1);
  });
});

describe('what the sender is told, and when a message counts as read', () => {
  it('counts a message the recipient replied to as read, and tells the sender nothing', async () => {
    const asked = send('alice', 'bob');
    send('bob', 'alice', { reply_to: asked.message_id });
    age(asked.message_id);
    const result = await run();
    expect(result).toMatchObject({ outcome: 'deleted', expired_message_count: 1, unread_message_count: 0, notice_count: 0 });
    expect(db().prepare('SELECT was_read FROM agent_message_expiries WHERE message_id = ?').get(asked.message_id)).toEqual({ was_read: 1 });
    expect(pollAgentEvents(db(), { project: PROJECT, recipient: 'alice' }).events.map((e) => e.sender)).not.toContain('memesh');
  });

  it('does not count the sender\'s own follow-up, or a reply from someone else, as the recipient answering', async () => {
    const followedUp = send('alice', 'bob');
    send('alice', 'bob', { reply_to: followedUp.message_id });
    const answeredByCarol = send('alice', 'bob');
    send('carol', 'alice', { reply_to: answeredByCarol.message_id });
    age(followedUp.message_id);
    age(answeredByCarol.message_id);
    const result = await run();
    expect(result).toMatchObject({ outcome: 'deleted', expired_message_count: 2, unread_message_count: 2, notice_count: 1 });
    for (const id of [followedUp.message_id, answeredByCarol.message_id]) {
      expect(db().prepare('SELECT was_read FROM agent_message_expiries WHERE message_id = ?').get(id), id).toEqual({ was_read: 0 });
    }
    const events = pollAgentEvents(db(), { project: PROJECT, recipient: 'alice' }).events.filter((e) => e.sender === 'memesh');
    expect(events).toHaveLength(1);
    const notice = fetchAgentMessage(db(), { project: PROJECT, recipient: 'alice', message_id: events[0].message_id });
    expect((notice.payload as { messages: Array<{ message_id: string }> }).messages.map((m) => m.message_id).sort())
      .toEqual([followedUp.message_id, answeredByCarol.message_id].sort());
  });

  it('counts a reply from the principal of a session the message was sent to as the recipient answering', async () => {
    db().prepare("INSERT OR IGNORE INTO agent_principals (project, principal_id, activation_event_sequence) VALUES (?, 'bob', 0)").run(PROJECT);
    db().prepare("INSERT INTO agent_session_instances (project, session_instance_id, principal_id, adapter_kind) VALUES (?, 'bob-session', 'bob', 'test-adapter')").run(PROJECT);
    const asked = sendAgentMessage(db(), {
      project: PROJECT, sender: 'alice', recipient: 'bob-session', target_kind: 'session',
      idempotency_key: `key-${randomUUID()}`, content_type: 'application/json', payload: { body: 'to a session' },
    });
    send('bob', 'alice', { reply_to: asked.message_id });
    age(asked.message_id);
    expect(await run()).toMatchObject({ outcome: 'deleted', expired_message_count: 1, unread_message_count: 0, notice_count: 0 });
    expect(db().prepare('SELECT was_read FROM agent_message_expiries WHERE message_id = ?').get(asked.message_id)).toEqual({ was_read: 1 });
  });

  function session(project: string, sessionId: string, principal: string): void {
    db().prepare('INSERT OR IGNORE INTO agent_principals (project, principal_id, activation_event_sequence) VALUES (?, ?, 0)').run(project, principal);
    db().prepare("INSERT INTO agent_session_instances (project, session_instance_id, principal_id, adapter_kind) VALUES (?, ?, ?, 'claude-channel')")
      .run(project, sessionId, principal);
  }

  function sendFrom(project: string, sender: string, recipient: string, extra: { reply_to?: string; target_kind?: 'session' } = {}): SentAgentMessage {
    return sendAgentMessage(db(), {
      project, sender, recipient, idempotency_key: `key-${randomUUID()}`, content_type: 'application/json',
      payload: { body: `from ${sender}` }, reply_to: extra.reply_to, target_kind: extra.target_kind,
    });
  }

  /** A session send that its session refused, and the copy MeMesh then sent to that session's principal (fallback_to_principal). */
  function refusedWithFallback(): { refused: SentAgentMessage; fallback: SentAgentMessage } {
    session(PROJECT, 'bob-session', 'bob');
    const refused = sendFrom(PROJECT, 'alice', 'bob-session', { target_kind: 'session' });
    const fallback = sendAgentMessage(db(), {
      project: PROJECT, sender: 'alice', recipient: 'bob', intended_session: 'bob-session',
      idempotency_key: `principal-fallback:${randomUUID()}`, content_type: 'application/json', payload: { body: 'from alice' },
    }, { fallback_of_message_id: refused.message_id });
    return { refused, fallback };
  }

  it('counts a reply to the principal copy of a refused session send as the answer to both, and tells the sender nothing', async () => {
    const { refused, fallback } = refusedWithFallback();
    send('bob', 'alice', { reply_to: fallback.message_id });
    age(refused.message_id);
    age(fallback.message_id);
    expect(await run()).toMatchObject({ outcome: 'deleted', expired_message_count: 2, unread_message_count: 0, notice_count: 0 });
    expect(noticesTo('alice')).toHaveLength(0);
    expect(db().prepare('SELECT was_read FROM agent_message_expiries WHERE message_id = ?').get(refused.message_id)).toEqual({ was_read: 1 });
  });

  it('settles the refused send with its answered copy even when the two are deleted in different batches', async () => {
    // 99 older messages fill the first batch up to the send; its copy is the first of the second batch.
    const older = agentMessageExpiryCutoff(Date.now() - 2 * 86_400_000);
    db().transaction(() => { for (let i = 0; i < 99; i++) bareMessage(older, 'carol'); }).immediate();
    const { refused, fallback } = refusedWithFallback();
    send('bob', 'alice', { reply_to: fallback.message_id });
    age(refused.message_id);
    age(fallback.message_id);
    expect(await run()).toMatchObject({ outcome: 'deleted', expired_message_count: 101 });
    expect(noticesTo('alice')).toHaveLength(0);
    expect(db().prepare('SELECT was_read FROM agent_message_expiries WHERE message_id = ?').get(refused.message_id)).toEqual({ was_read: 1 });
  });

  it('tells the sender once about a refused session send nobody answered, naming the copy it got back as its message', async () => {
    const { refused, fallback } = refusedWithFallback();
    age(refused.message_id);
    age(fallback.message_id);
    expect(await run()).toMatchObject({ outcome: 'deleted', expired_message_count: 2, notice_count: 1 });
    const notices = noticesTo('alice');
    expect(notices).toHaveLength(1);
    expect((JSON.parse(notices[0].payload_json) as { messages: Array<{ message_id: string }> }).messages.map((m) => m.message_id))
      .toEqual([fallback.message_id]);
  });

  it('counts a reply its recipient\'s session sent under its own session id as the recipient answering', async () => {
    session(PROJECT, 'bob-s1', 'bob');
    const asked = send('alice', 'bob');
    send('bob-s1', 'alice', { reply_to: asked.message_id });
    age(asked.message_id);
    expect(await run()).toMatchObject({ outcome: 'deleted', expired_message_count: 1, notice_count: 0 });
  });

  it('does not count a reply in another project, from the recipient or a session of it, or from the principal of a same-named session there', async () => {
    const fromElsewhere = send('alice', 'bob');
    sendFrom('elsewhere', 'bob', 'alice', { reply_to: fromElsewhere.message_id });
    session('elsewhere', 'bob-s2', 'bob');
    const fromOtherSession = send('alice', 'bob');
    send('bob-s2', 'alice', { reply_to: fromOtherSession.message_id });
    session('elsewhere', 'shared-session', 'carol');
    const toSession = sendFrom(PROJECT, 'alice', 'shared-session', { target_kind: 'session' });
    send('carol', 'alice', { reply_to: toSession.message_id });
    for (const id of [fromElsewhere.message_id, fromOtherSession.message_id, toSession.message_id]) age(id);
    expect(await run()).toMatchObject({ outcome: 'deleted', expired_message_count: 3, unread_message_count: 3, notice_count: 1 });
  });

  it('writes one notice for each project and sender for the whole pass, however many batches it takes', async () => {
    const old = agentMessageExpiryCutoff(Date.now() - 60_000);
    db().transaction(() => {
      for (let i = 0; i < 1100; i++) bareMessage(old, ['alice', 'carol', 'dave'][i % 3]);
    }).immediate();
    const result = await run();
    expect(result).toMatchObject({ outcome: 'deleted', expired_message_count: 1100, notice_count: 3 });
    expect(db().prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE sender = 'memesh'").get()).toEqual({ n: 3 });
    for (const [sender, expectedCount] of [['alice', 367], ['carol', 367], ['dave', 366]] as const) {
      const events = pollAgentEvents(db(), { project: PROJECT, recipient: sender }).events;
      expect(events).toHaveLength(1);
      const notice = fetchAgentMessage(db(), { project: PROJECT, recipient: sender, message_id: events[0].message_id });
      const payload = notice.payload as { summary: string; messages: unknown[]; not_listed?: number };
      expect(payload.summary).toContain(`${expectedCount} messages`);
      expect(payload.messages).toHaveLength(20);
      expect(payload.not_listed).toBe(expectedCount - 20);
    }
  });

  it('says the recipient recorded nothing and did not reply, rather than that it never read it', async () => {
    const lost = send('alice', 'bob');
    age(lost.message_id);
    await run();
    const events = pollAgentEvents(db(), { project: PROJECT, recipient: 'alice' }).events;
    const notice = fetchAgentMessage(db(), { project: PROJECT, recipient: 'alice', message_id: events[0].message_id });
    const summary = (notice.payload as { summary: string }).summary;
    expect(summary).toContain('recorded no intake, acknowledgement or disposition and sent no reply');
    expect(summary).not.toMatch(/never read|unread/);
  });
});

/**
 * Another process takes the database's write lock (EXCLUSIVE: readers of a rollback-journal file are
 * kept out too) and holds it for `ms`; resolves once it holds it.
 */
async function lockFromAnotherProcess(file: string, ms: number, mode: 'IMMEDIATE' | 'EXCLUSIVE' = 'IMMEDIATE'): Promise<{ exited: Promise<void> }> {
  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA busy_timeout = 10000');
    db.exec('BEGIN ' + process.argv[3]);
    process.stdout.write('locked\\n');
    setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, Number(process.argv[2]));
  `;
  const child = spawn(process.execPath, ['--no-warnings', '-e', script, file, String(ms), mode], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise<void>((resolve) => { child.on('exit', () => resolve()); });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('locked')) resolve(); });
    child.on('exit', (code) => reject(new Error(`the lock holder exited (${code}) before it held the lock`)));
  });
  return { exited };
}

/** The longest time the event loop went without a turn, from now until `stop()`. */
function eventLoopGaps(): { stop(): number } {
  let longest = 0;
  let last = Date.now();
  const ticker = setInterval(() => { const now = Date.now(); longest = Math.max(longest, now - last); last = now; }, 20);
  return { stop: () => { clearInterval(ticker); return Math.max(longest, Date.now() - last); } };
}

function busyTimeout(): number {
  return (db().prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
}

function lateRows(): Array<{ outcome: string; expired_message_count: number; detail: string }> {
  return db().prepare("SELECT outcome, expired_message_count, detail FROM agent_message_expiry_runs WHERE detail LIKE '%recorded late%' ORDER BY run_id")
    .all() as Array<{ outcome: string; expired_message_count: number; detail: string }>;
}

describe('a database that is locked is not a database that cannot be written', () => {
  it('records database_busy, not read_only, without holding the process while another process holds the write lock', async () => {
    const lost = send('alice', 'bob');
    age(lost.message_id);
    const lock = await lockFromAnotherProcess(dbHandle.dbPath, 3_000);
    const gaps = eventLoopGaps();
    const started = Date.now();
    const result = await runAgentMessageExpiry(db(), { trigger: 'test' });
    const took = Date.now() - started;
    const longest = gaps.stop();
    expect(longest).toBeLessThan(1_000);
    expect(took).toBeLessThan(1_000);
    expect(result.outcome).toBe('database_busy');
    expect(result.detail).toContain('locked by another process');
    // The lock is still held, so the row cannot be written now; the next pass writes it.
    expect(result.run_id).toBeNull();
    expect(busyTimeout()).toBe(30_000);
    await lock.exited;
    expect(userMessages()).toBe(1);
    expect(await run()).toMatchObject({ outcome: 'deleted', expired_message_count: 1 });
    const late = lateRows();
    expect(late).toHaveLength(1);
    expect(late[0].outcome).toBe('database_busy');
    expect(late[0].detail).toMatch(/recorded late: the database was locked by another process when this pass ended at \d{4}-\d\d-\d\dT/);
  }, 60_000);

  it('does not hold the process on a lock when it has nothing to do', async () => {
    const lock = await lockFromAnotherProcess(dbHandle.dbPath, 3_000);
    const gaps = eventLoopGaps();
    const started = Date.now();
    const result = await run();
    const took = Date.now() - started;
    const longest = gaps.stop();
    expect(longest).toBeLessThan(1_000);
    expect(took).toBeLessThan(1_000);
    expect(result.outcome).toBe('database_busy');
    expect(busyTimeout()).toBe(30_000);
    await lock.exited;
    expect(await run()).toMatchObject({ outcome: 'nothing_expired' });
    expect(lateRows().map((row) => row.outcome)).toEqual(['database_busy']);
    // Written once: a later pass does not write it again.
    expect(await run()).toMatchObject({ outcome: 'nothing_expired' });
    expect(lateRows()).toHaveLength(1);
  }, 60_000);

  it('calls an archive another process has locked busy, not broken, and does not wait on it', async () => {
    const first = send('alice', 'bob');
    age(first.message_id);
    expect((await run()).outcome).toBe('deleted');
    const lost = send('carol', 'bob');
    age(lost.message_id);
    const lock = await lockFromAnotherProcess(archiveFile(), 3_000);
    const gaps = eventLoopGaps();
    const result = await run();
    expect(gaps.stop()).toBeLessThan(1_000);
    await lock.exited;
    expect(result.outcome).toBe('database_busy');
    expect(ids()).toContain(lost.message_id);
    expect(await run()).toMatchObject({ outcome: 'deleted', expired_message_count: 1 });
  }, 60_000);

  it('calls an archive another process locked between two batches busy too', async () => {
    const old = agentMessageExpiryCutoff(Date.now() - 60_000);
    db().transaction(() => { for (let i = 0; i < 150; i++) bareMessage(old, 'alice'); }).immediate();
    let lock: { exited: Promise<void> } | undefined;
    const result = await runAgentMessageExpiry(db(), {
      trigger: 'test',
      fault: { afterBatch: async (batch) => { if (batch === 1) lock = await lockFromAnotherProcess(archiveFile(), 3_000); } },
    });
    await lock!.exited;
    expect(result).toMatchObject({ outcome: 'database_busy', expired_message_count: 100 });
    expect(ids()).toHaveLength(50);
  }, 60_000);

  it('writes the row of a pass that met a lock as the process stops, if it can by then', async () => {
    const lock = await lockFromAnotherProcess(dbHandle.dbPath, 1_500);
    expect((await run()).run_id).toBeNull();
    await lock.exited;
    expect(lateRows()).toHaveLength(0);
    const stop = startAgentMessageExpiryScheduler(() => db(), { trigger: 'test', firstRunDelayMs: 60_000 });
    stop();
    expect(lateRows().map((row) => row.outcome)).toEqual(['database_busy']);
  }, 60_000);

  it('stops at the next step, keeping what it did, when another process takes the lock after the pass started', async () => {
    const old = agentMessageExpiryCutoff(Date.now() - 60_000);
    db().transaction(() => { for (let i = 0; i < 300; i++) bareMessage(old, 'alice'); }).immediate();
    let lock: { exited: Promise<void> } | undefined;
    const gaps = eventLoopGaps();
    const result = await runAgentMessageExpiry(db(), {
      trigger: 'test',
      fault: { afterBatch: async (batch) => { if (batch === 1) lock = await lockFromAnotherProcess(dbHandle.dbPath, 3_000); } },
    });
    const longest = gaps.stop();
    expect(longest).toBeLessThan(1_000);
    expect(result).toMatchObject({ outcome: 'database_busy', expired_message_count: 100, run_id: null });
    expect(result.detail).toContain('locked by another process');
    expect(busyTimeout()).toBe(30_000);
    await lock!.exited;
    expect(ids()).toHaveLength(200);
    // Nothing was half done: the next pass archives and deletes the rest, and the busy pass is on record.
    expect(await run()).toMatchObject({ outcome: 'deleted', expired_message_count: 200 });
    expect(ids()).toHaveLength(0);
    expect(countIn(archiveFile(), 'archive_log')).toBe(300);
    expect(lateRows()).toMatchObject([{ outcome: 'database_busy', expired_message_count: 100 }]);
    expect(db().prepare("SELECT COUNT(*) AS n FROM agent_message_expiry_runs WHERE outcome = 'started'").get()).toEqual({ n: 0 });
    expect(noticesTo('alice')).toHaveLength(1);
  }, 60_000);
});

describe('a pass in a process that is shutting down', () => {
  it('closes its row as interrupted and lets go of its lease at once, and deletes nothing more', async () => {
    const old = agentMessageExpiryCutoff(Date.now() - 60_000);
    db().transaction(() => { for (let i = 0; i < 300; i++) bareMessage(old, 'alice'); }).immediate();
    const stop = new AbortController();
    let rowAtStop: unknown;
    let leaseAtStop: unknown = 'not read';
    await runAgentMessageExpiry(db(), {
      trigger: 'test',
      signal: stop.signal,
      fault: {
        afterBatch: (batch) => {
          if (batch !== 1) return;
          stop.abort();
          rowAtStop = db().prepare('SELECT outcome, expired_message_count FROM agent_message_expiry_runs ORDER BY run_id DESC LIMIT 1').get();
          leaseAtStop = leaseRow();
        },
      },
    });
    expect(rowAtStop).toEqual({ outcome: 'interrupted', expired_message_count: 100 });
    expect(leaseAtStop).toBeUndefined();
    expect(ids()).toHaveLength(200);
    expect(await run()).toMatchObject({ outcome: 'deleted', expired_message_count: 200 });
  });

  it('the scheduler\'s stop does the same to the pass it is running', async () => {
    const old = agentMessageExpiryCutoff(Date.now() - 60_000);
    db().transaction(() => { for (let i = 0; i < 1000; i++) bareMessage(old, 'alice'); }).immediate();
    const started = (): number => (db().prepare("SELECT COUNT(*) AS n FROM agent_message_expiry_runs WHERE outcome = 'started'").get() as { n: number }).n;
    const stop = startAgentMessageExpiryScheduler(() => db(), { trigger: 'test', firstRunDelayMs: 0 });
    for (let i = 0; i < 5_000 && started() === 0; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(started()).toBe(1);
    stop();
    expect(started()).toBe(0);
    expect(leaseRow()).toBeUndefined();
    // Let the stopped pass unwind before the test's database goes away.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ids().length).toBeGreaterThan(0);
  });
});

describe('a clock that was set back', () => {
  it('runs a pass even though the last one "started" in the future', async () => {
    const lost = send('alice', 'bob');
    age(lost.message_id);
    db().prepare(`
      INSERT INTO agent_message_expiry_runs (started_at_ms, finished_at_ms, trigger_source, outcome)
      VALUES (?, ?, 'router', 'nothing_expired')
    `).run(Date.now() + 6 * 3_600_000, Date.now() + 6 * 3_600_000);
    const result = await runAgentMessageExpiryIfDue(db(), { trigger: 'test' });
    expect(result).toMatchObject({ outcome: 'deleted', expired_message_count: 1 });
  });
});

describe('a run that never finished', () => {
  it('is closed as interrupted by a pass that finds nothing to do, once nobody holds the lease', async () => {
    db().prepare(`
      INSERT INTO agent_message_expiry_runs (started_at_ms, finished_at_ms, trigger_source, outcome)
      VALUES (?, ?, 'router', 'started')
    `).run(Date.now() - 3_600_000, Date.now() - 3_600_000);
    expect(await run()).toMatchObject({ outcome: 'nothing_expired' });
    expect(db().prepare("SELECT COUNT(*) AS n FROM agent_message_expiry_runs WHERE outcome = 'started'").get()).toEqual({ n: 0 });
    expect(db().prepare("SELECT COUNT(*) AS n FROM agent_message_expiry_runs WHERE outcome = 'interrupted'").get()).toEqual({ n: 1 });
  });

  it('is left alone while a live process holds the lease', async () => {
    db().prepare(`
      INSERT INTO agent_message_expiry_runs (started_at_ms, finished_at_ms, trigger_source, outcome)
      VALUES (?, ?, 'router', 'started')
    `).run(Date.now() - 30_000, Date.now() - 30_000);
    db().prepare("INSERT INTO agent_message_expiry_lease (lease_id, holder, expires_at_ms) VALUES (1, 'live', ?)").run(Date.now() + 60_000);
    expect(await run()).toMatchObject({ outcome: 'nothing_expired' });
    expect(db().prepare("SELECT COUNT(*) AS n FROM agent_message_expiry_runs WHERE outcome = 'started'").get()).toEqual({ n: 1 });
  });
});

describe('bookkeeping and limits', () => {
  it('trims the run log and the remembered ids in a pass that deletes messages too', async () => {
    const insertRun = db().prepare("INSERT INTO agent_message_expiry_runs (started_at_ms, finished_at_ms, trigger_source, outcome) VALUES (?, ?, 'router', 'nothing_expired')");
    db().transaction(() => { for (let i = 0; i < 510; i++) insertRun.run(i, i); }).immediate();
    db().prepare(`
      INSERT INTO agent_message_expiries (message_id, project, created_at, expired_at_ms, was_read)
      VALUES ('forty-days', ?, datetime('now', '-40 days'), ?, 1)
    `).run(PROJECT, Date.now() - 31 * 86_400_000);
    const lost = send('alice', 'bob');
    age(lost.message_id);
    expect(await run()).toMatchObject({ outcome: 'deleted' });
    expect(count('agent_message_expiry_runs')).toBe(500);
    expect(db().prepare("SELECT COUNT(*) AS n FROM agent_message_expiries WHERE message_id = 'forty-days'").get()).toEqual({ n: 0 });
  });

  it('deletes at most 20,000 messages in one pass and leaves the rest for the next', async () => {
    const old = agentMessageExpiryCutoff(Date.now() - 60_000);
    db().transaction(() => {
      for (let i = 0; i < 20_050; i++) bareMessage(old, 'alice');
    }).immediate();
    const first = await run();
    expect(first).toMatchObject({ outcome: 'deleted', expired_message_count: 20_000 });
    expect(first.detail).toContain('50 expired message(s) left for the next pass');
    expect(userMessages()).toBe(50);
    expect(await run()).toMatchObject({ outcome: 'deleted', expired_message_count: 50 });
  }, 240_000);

  it('does not start a second pass in the same process while one is still running', async () => {
    const old = agentMessageExpiryCutoff(Date.now() - 60_000);
    db().transaction(() => {
      for (let i = 0; i < 2500; i++) bareMessage(old, 'alice');
    }).immediate();
    const stop = startAgentMessageExpiryScheduler(() => db(), { trigger: 'overlap-test', firstRunDelayMs: 1, intervalMs: 1 });
    try {
      for (let waited = 0; waited < 20_000; waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (userMessages() === 0 && lastAgentMessageExpiryRun(db()) !== null) break;
      }
    } finally {
      stop();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(db().prepare("SELECT COUNT(*) AS n FROM agent_message_expiry_runs WHERE outcome = 'skipped_concurrent'").get()).toEqual({ n: 0 });
    expect(db().prepare("SELECT COUNT(*) AS n FROM agent_message_expiry_runs WHERE outcome = 'deleted'").get()).toEqual({ n: 1 });
  }, 60_000);

  it('treats a remembered id with no sender or recipient as nobody\'s: only the ordinary "not available"', () => {
    db().prepare(`
      INSERT INTO agent_message_expiries (message_id, project, created_at, expired_at_ms, was_read)
      VALUES ('old-format', ?, datetime('now', '-2 days'), ?, 0)
    `).run(PROJECT, Date.now());
    for (const caller of ['alice', 'bob']) {
      expect(() => fetchAgentMessage(db(), { project: PROJECT, recipient: caller, message_id: 'old-format' }))
        .toThrow(/not available to recipient/);
    }
  });
});

describe('what doctor says about the expiry', () => {
  it('points at the archive after a pass that deleted, and still after a later pass that found nothing', async () => {
    const lost = send('alice', 'bob');
    age(lost.message_id);
    const first = await run();
    expect((await doctorRow())?.summary).toContain(first.backup_path!);
    expect(await run()).toMatchObject({ outcome: 'nothing_expired' });
    const row = await doctorRow();
    expect(row?.summary).toContain('nothing_expired');
    expect(row?.summary).toContain(first.backup_path!);
    expect(row?.summary).toContain('kept one more day');
  });

  it('says the archive is gone instead of naming a file that is not there', async () => {
    const lost = send('alice', 'bob');
    age(lost.message_id);
    const first = await run();
    fs.rmSync(first.backup_path!);
    const row = await doctorRow();
    expect(row?.summary).toContain('is not there any more');
  });

  it('warns when the database file cannot be written, though no pass could record that', async () => {
    fs.chmodSync(dbHandle.dbPath, 0o400);
    try {
      const row = await doctorRow();
      expect(row?.status).toBe('warn');
      expect(row?.summary).toContain('cannot be written');
      expect(row?.fix).toContain('chmod u+w');
    } finally {
      fs.chmodSync(dbHandle.dbPath, 0o600);
    }
  });

  it('warns for every outcome that means nothing could be deleted', async () => {
    for (const outcome of ['failed', 'archive_failed', 'archive_unavailable', 'no_message_tables', 'read_only']) {
      db().prepare(`
        INSERT INTO agent_message_expiry_runs (started_at_ms, finished_at_ms, trigger_source, outcome, detail)
        VALUES (?, ?, 'router', ?, 'refused for the test')
      `).run(Date.now(), Date.now(), outcome);
      const row = await doctorRow();
      expect(row?.status, outcome).toBe('warn');
      expect(row?.summary, outcome).toContain(outcome);
    }
  });

  it('with no pass on record and messages waiting, names a lock another program keeps as a cause too', async () => {
    const lost = send('alice', 'bob');
    age(lost.message_id);
    const row = await doctorRow();
    expect(row?.status).toBe('warn');
    expect(row?.summary).toContain('No expiry pass has run on this database');
    expect(row?.summary).toMatch(/another program may be keeping the database locked/);
    expect(row?.fix).toMatch(/another program may be keeping the database locked/);
  });

  it('says a database that was locked is not a failure', async () => {
    db().prepare(`
      INSERT INTO agent_message_expiry_runs (started_at_ms, finished_at_ms, trigger_source, outcome, detail)
      VALUES (?, ?, 'router', 'database_busy', 'the database was locked by another process, so nothing was deleted this time')
    `).run(Date.now(), Date.now());
    const row = await doctorRow();
    expect(row?.status).toBe('pass');
    expect(row?.summary).toContain('database_busy');
  });
});

/** Notices from MeMesh to one sender, with the payload each holds now. */
function noticesTo(sender: string): Array<{ message_id: string; payload_json: string }> {
  return db().prepare("SELECT message_id, payload_json FROM agent_messages WHERE sender = 'memesh' AND recipient = ? ORDER BY created_at")
    .all(sender) as Array<{ message_id: string; payload_json: string }>;
}

describe('the notices a pass writes match its record', () => {
  it('records as many notices as it wrote when it stops after writing them', async () => {
    const lost = send('alice', 'bob');
    age(lost.message_id);
    // The presence clean-up, which comes after the notices, fails.
    db().exec("CREATE TRIGGER refuse_presence BEFORE DELETE ON agent_session_connections BEGIN SELECT RAISE(ABORT, 'refused for the test'); END");
    db().prepare("INSERT OR IGNORE INTO agent_principals (project, principal_id, activation_event_sequence) VALUES (?, 'bob', 0)").run(PROJECT);
    db().prepare("INSERT INTO agent_session_instances (project, session_instance_id, principal_id, adapter_kind) VALUES (?, 's-gone', 'bob', 'test-adapter')").run(PROJECT);
    db().prepare(`
      INSERT INTO agent_session_connections (connection_id, project, principal_id, session_instance_id, generation,
        adapter_kind, router_instance_id, lease_expires_at_ms, disconnected_at)
      VALUES ('c-gone', ?, 'bob', 's-gone', 1, 'test-adapter', 'r', ?, datetime('now', '-3 days'))
    `).run(PROJECT, Date.now() - 3 * 86_400_000);
    let result;
    try {
      result = await run();
    } finally {
      db().exec('DROP TRIGGER refuse_presence');
    }
    expect(result.outcome).toBe('failed');
    expect(noticesTo('alice')).toHaveLength(1);
    expect(result.notice_count).toBe(1);
    expect(lastAgentMessageExpiryRun(db())?.notice_count).toBe(1);
  });

  it('never rewrites a notice already written: a later pass writes a new one', async () => {
    const first = send('alice', 'bob');
    age(first.message_id);
    expect((await run()).notice_count).toBe(1);
    const [written] = noticesTo('alice');
    const second = send('alice', 'bob');
    age(second.message_id);
    expect((await run()).notice_count).toBe(1);
    const notices = noticesTo('alice');
    expect(notices).toHaveLength(2);
    expect(notices.find((n) => n.message_id === written.message_id)?.payload_json).toBe(written.payload_json);
  });

  it('tells the sender once about everything, even when the pass that deleted the first batch died', async () => {
    const old = agentMessageExpiryCutoff(Date.now() - 60_000);
    db().transaction(() => { for (let i = 0; i < 150; i++) bareMessage(old, 'alice'); }).immediate();
    const died = await runAgentMessageExpiry(db(), { trigger: 'test', fault: { afterBatch: () => { throw new Error('stopped for the test'); } } });
    expect(died.outcome).toBe('failed');
    expect(died.notice_count).toBe(noticesTo('alice').length);
    const next = await run();
    expect(next).toMatchObject({ outcome: 'deleted', expired_message_count: 50 });
    const notices = noticesTo('alice');
    expect(notices).toHaveLength(1);
    expect((JSON.parse(notices[0].payload_json) as { summary: string }).summary).toContain('150 messages');
    expect(next.notice_count).toBe(1);
  });

  it('keeps the notice count on the row even when the pass cannot write its final record', async () => {
    const lost = send('alice', 'bob');
    age(lost.message_id);
    // Every update that would close the row fails, as for a process killed right after its notices.
    db().exec("CREATE TRIGGER refuse_finish BEFORE UPDATE OF outcome ON agent_message_expiry_runs WHEN NEW.outcome <> 'started' BEGIN SELECT RAISE(ABORT, 'refused for the test'); END");
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      expect((await run()).run_id).toBeNull();
    } finally {
      process.stderr.write = realWrite;
      db().exec('DROP TRIGGER refuse_finish');
    }
    expect(db().prepare("SELECT outcome, notice_count FROM agent_message_expiry_runs WHERE outcome = 'started'").get())
      .toEqual({ outcome: 'started', notice_count: noticesTo('alice').length });
    expect(noticesTo('alice')).toHaveLength(1);
  });

  it('writes the notice owed by a pass that died after its last batch, in a pass that has nothing else to do', async () => {
    const lost = send('alice', 'bob');
    age(lost.message_id);
    expect((await runAgentMessageExpiry(db(), { trigger: 'test', fault: { afterBatch: () => { throw new Error('stopped for the test'); } } })).outcome).toBe('failed');
    const next = await run();
    expect(next).toMatchObject({ outcome: 'notices_sent', notice_count: 1 });
    expect(noticesTo('alice')).toHaveLength(1);
  });
});

describe('an archive that keeps failing does not stop the work that does not need it', () => {
  function stalePresence(): void {
    db().prepare("INSERT OR IGNORE INTO agent_principals (project, principal_id, activation_event_sequence) VALUES (?, 'bob', 0)").run(PROJECT);
    db().prepare("INSERT INTO agent_session_instances (project, session_instance_id, principal_id, adapter_kind) VALUES (?, 's-gone', 'bob', 'test-adapter')").run(PROJECT);
    db().prepare(`
      INSERT INTO agent_session_connections (connection_id, project, principal_id, session_instance_id, generation,
        adapter_kind, router_instance_id, lease_expires_at_ms, disconnected_at)
      VALUES ('c-gone', ?, 'bob', 's-gone', 1, 'test-adapter', 'r', ?, datetime('now', '-3 days'))
    `).run(PROJECT, Date.now() - 3 * 86_400_000);
  }

  it('writes the notices it owes and clears old presence, and still deletes nothing more', async () => {
    const first = send('alice', 'bob');
    age(first.message_id);
    // Deleted, its notice still owed: the pass stopped after its batch.
    expect((await runAgentMessageExpiry(db(), { trigger: 'test', fault: { afterBatch: () => { throw new Error('stopped for the test'); } } })).outcome).toBe('failed');
    expect(noticesTo('alice')).toHaveLength(0);
    fs.writeFileSync(archiveFile(), 'not a database at all, just text that is long enough to be a header');
    stalePresence();
    const next = send('carol', 'bob');
    age(next.message_id);
    const result = await run();
    expect(result.outcome).toBe('archive_failed');
    expect(result.detail).toMatch(/^could not archive the rows of 1 message\(s\) before deleting them .*not a database/);
    expect(result.notice_count).toBe(1);
    expect(noticesTo('alice')).toHaveLength(1);
    expect(result.connection_count).toBe(1);
    expect(ids()).toContain(next.message_id);
  });

  it('keeps the id of a deleted message whose notice is still owed past the 30 days, until the notice is written', async () => {
    const insert = db().prepare(`
      INSERT INTO agent_message_expiries (message_id, project, created_at, expired_at_ms, was_read, notice_message_id, sender, recipient)
      VALUES (?, ?, '2026-01-01 00:00:00', ?, 0, ?, 'alice', 'bob')
    `);
    const longAgo = Date.now() - 31 * 86_400_000;
    insert.run('owed', PROJECT, longAgo, null);
    insert.run('told', PROJECT, longAgo, 'notice-1');
    // The notices cannot be written this time.
    db().exec("CREATE TRIGGER refuse_notice BEFORE INSERT ON agent_messages WHEN NEW.sender = 'memesh' BEGIN SELECT RAISE(ABORT, 'refused for the test'); END");
    try {
      expect((await run()).outcome).toBe('failed');
    } finally {
      db().exec('DROP TRIGGER refuse_notice');
    }
    const kept = (db().prepare('SELECT message_id FROM agent_message_expiries').all() as Array<{ message_id: string }>).map((row) => row.message_id);
    expect(kept).toEqual(['owed']);
  });
});

describe('clearing a large archive', () => {
  it('renews its lease as it goes, and stops when another process took the lease over', async () => {
    const old = agentMessageExpiryCutoff(Date.now() - 60_000);
    db().transaction(() => { for (let i = 0; i < 300; i++) bareMessage(old, 'alice'); }).immediate();
    expect((await run()).expired_message_count).toBe(300);
    inArchive(`UPDATE archive_log SET archived_at_ms = ${Date.now() - 25 * 3_600_000}`);
    const pass = run();
    let taken = false;
    await new Promise<void>((resolve) => {
      const watch = (): void => {
        if (countIn(archiveFile(), 'archive_log') < 300) {
          db().prepare("UPDATE agent_message_expiry_lease SET holder = 'another process', expires_at_ms = ?").run(Date.now() + 60_000);
          taken = true;
          resolve();
        } else {
          setImmediate(watch);
        }
      };
      setImmediate(watch);
    });
    const result = await pass;
    expect(taken).toBe(true);
    expect(countIn(archiveFile(), 'archive_log')).toBeGreaterThan(0);
    expect(result.detail).toContain('another process took over the expiry lease');
  });
});

describe('the notice count of a pass is what it committed', () => {
  // The transaction fails while it marks the ids, or after the notices, as it saves the run's count.
  it.each([
    'BEFORE UPDATE OF notice_message_id ON agent_message_expiries',
    'BEFORE UPDATE OF notice_count ON agent_message_expiry_runs WHEN NEW.notice_count > 0',
  ])('counts no notice when the transaction that wrote it rolled back (%s)', async (when) => {
    const lost = send('alice', 'bob');
    age(lost.message_id);
    db().exec(`CREATE TRIGGER refuse_mark ${when} BEGIN SELECT RAISE(ABORT, 'refused for the test'); END`);
    let result;
    try {
      result = await run();
    } finally {
      db().exec('DROP TRIGGER refuse_mark');
    }
    expect(result.outcome).toBe('failed');
    expect(noticesTo('alice')).toHaveLength(0);
    expect(result.notice_count).toBe(0);
    expect(lastAgentMessageExpiryRun(db())?.notice_count).toBe(0);
  });
});

describe('the archive an earlier MeMesh shared between the databases of a folder', () => {
  it('a database not named knowledge-graph.db removes its own rows from it after their extra day, and nobody else\'s', async () => {
    const workPath = path.join(path.dirname(dbHandle.dbPath), 'work.db');
    const work = new MemeshDatabase(workPath);
    work.exec(SCHEMA_SQL);
    try {
      const theirs = sendAgentMessage(work, {
        project: PROJECT, sender: 'alice', recipient: 'bob', idempotency_key: 'work-key', content_type: 'application/json', payload: { body: 'work' },
      });
      work.prepare("UPDATE agent_messages SET created_at = datetime('now', '-2 days') WHERE message_id = ?").run(theirs.message_id);
      const first = await runAgentMessageExpiry(work, { trigger: 'test' });
      expect(first.outcome).toBe('deleted');
      // What an earlier MeMesh did: every database of the folder archived into the one shared file.
      const shared = path.join(path.dirname(first.backup_path!), 'agent-messages-expired.db');
      fs.renameSync(first.backup_path!, shared);
      const handle = new DatabaseSync(shared);
      try {
        handle.exec(`UPDATE archive_log SET archived_at_ms = ${Date.now() - 25 * 3_600_000}`);
        handle.exec(`INSERT INTO archive_log (message_id, archived_at_ms) VALUES ('someone-elses', ${Date.now() - 25 * 3_600_000})`);
        handle.exec("INSERT INTO agent_messages (message_id) VALUES ('someone-elses')");
      } finally {
        handle.close();
      }
      const purged = await runAgentMessageExpiry(work, { trigger: 'test' });
      expect(purged.outcome).toBe('archive_purged');
      const left = new DatabaseSync(shared, { readOnly: true });
      try {
        expect(left.prepare('SELECT message_id FROM archive_log').all()).toEqual([{ message_id: 'someone-elses' }]);
        expect(left.prepare('SELECT message_id FROM agent_messages').all()).toEqual([{ message_id: 'someone-elses' }]);
      } finally {
        left.close();
      }
      // Nothing more of its own there: the next pass has nothing to do.
      expect((await runAgentMessageExpiry(work, { trigger: 'test' })).outcome).toBe('nothing_expired');
    } finally {
      work.close();
    }
  });
});

describe('what doctor says about the archive and the fix', () => {
  const unix = process.platform !== 'win32';

  async function deletedOnce(): Promise<string> {
    const lost = send('alice', 'bob');
    age(lost.message_id);
    const first = await run();
    expect(first.outcome).toBe('deleted');
    return first.backup_path!;
  }

  it.skipIf(!unix)('warns about an archive path that became a dangling symlink, before a pass fails on it', async () => {
    const archive = await deletedOnce();
    fs.rmSync(archive);
    fs.symlinkSync(path.join(dbHandle.tmpDir, 'nowhere.db'), archive);
    const row = await doctorRow();
    expect(row?.status).toBe('warn');
    expect(row?.summary).toContain('is a symlink');
  });

  it.skipIf(!unix || process.getuid?.() === 0)('warns about an archive this user cannot write', async () => {
    const archive = await deletedOnce();
    fs.chmodSync(archive, 0o400);
    try {
      const row = await doctorRow();
      expect(row?.status).toBe('warn');
      expect(row?.summary).toContain('this user cannot write it');
    } finally {
      fs.chmodSync(archive, 0o600);
    }
  });

  it('does not say "nothing is deleted" about a pass that deleted messages before its archive failed', async () => {
    const old = agentMessageExpiryCutoff(Date.now() - 60_000);
    db().transaction(() => { for (let i = 0; i < 150; i++) bareMessage(old, 'alice'); }).immediate();
    const result = await runAgentMessageExpiry(db(), {
      trigger: 'test', fault: { beforeArchiveCheck: (_file, batch) => { if (batch === 2) throw new Error('refused for the test'); } },
    });
    expect(result).toMatchObject({ outcome: 'archive_failed', expired_message_count: 100 });
    const row = await doctorRow();
    expect(row?.status).toBe('warn');
    expect(row?.summary).toContain('100 message(s) deleted');
    expect(row?.fix).not.toContain('Nothing is deleted');
    expect(row?.fix).toContain('Nothing more is deleted');
  });

  it.skipIf(process.platform !== 'darwin' || process.getuid?.() === 0)('does not tell the owner to chmod a database whose write bit is already set', async () => {
    const user = os.userInfo().username;
    expect(spawnSync('chmod', ['+a', `user:${user} deny write`, dbHandle.dbPath]).status).toBe(0);
    try {
      const row = await doctorRow();
      expect(row?.status).toBe('warn');
      expect(row?.summary).toContain('cannot be written');
      expect(row?.fix).not.toContain('chmod u+w');
      expect(row?.fix).toContain('write bit is already set');
    } finally {
      spawnSync('chmod', ['-N', dbHandle.dbPath]);
    }
  });

  for (const outcome of ['skipped_concurrent', 'interrupted', 'database_busy', 'started', 'archive_failed', 'probe']) {
    it(`does not count a pass that ended ${outcome} as keeping up`, async () => {
      const insert = db().prepare("INSERT INTO agent_message_expiry_runs (started_at_ms, finished_at_ms, trigger_source, outcome) VALUES (?, ?, 'router', ?)");
      insert.run(Date.now() - 3_600_000, Date.now() - 3_600_000, 'deleted');
      insert.run(Date.now() - 1_000, Date.now() - 500, outcome);
      const lost = send('alice', 'bob');
      age(lost.message_id);
      expect((await doctorRow())?.status, outcome).toBe('warn');
    });
  }

  it('names a lock another program keeps, not a missing session, when the passes keep meeting one', async () => {
    db().prepare("INSERT INTO agent_message_expiry_runs (started_at_ms, finished_at_ms, trigger_source, outcome) VALUES (?, ?, 'router', 'database_busy')")
      .run(Date.now() - 1_000, Date.now() - 500);
    const lost = send('alice', 'bob');
    age(lost.message_id);
    const row = await doctorRow();
    expect(row?.status).toBe('warn');
    expect(row?.fix).toMatch(/another program may be keeping the database locked/);
  });

  it.skipIf(!unix)('calls an archive another process is writing busy, not unusable, and does not warn about it', async () => {
    const archive = await deletedOnce();
    const lock = await lockFromAnotherProcess(archive, 2_500, 'EXCLUSIVE');
    const started = Date.now();
    const row = await doctorRow();
    expect(Date.now() - started).toBeLessThan(1_000);
    await lock.exited;
    expect(row?.status).toBe('pass');
    expect(row?.summary).toContain('in use by another process right now');
    expect(row?.summary).not.toContain('cannot be used');
  }, 30_000);
});

describe('rules a review found unguarded', () => {
  it('names the archive of the default database knowledge-graph.db as it always was', async () => {
    const dir = fs.mkdtempSync(path.join(dbHandle.tmpDir, 'default-'));
    const handle = new MemeshDatabase(path.join(dir, 'knowledge-graph.db'));
    handle.exec(SCHEMA_SQL);
    try {
      const sent = sendAgentMessage(handle, {
        project: PROJECT, sender: 'alice', recipient: 'bob', idempotency_key: 'k', content_type: 'application/json', payload: { body: 'x' },
      });
      handle.prepare("UPDATE agent_messages SET created_at = datetime('now', '-2 days') WHERE message_id = ?").run(sent.message_id);
      const result = await runAgentMessageExpiry(handle, { trigger: 'test' });
      expect(path.basename(result.backup_path!)).toBe('agent-messages-expired.db');
    } finally {
      handle.close();
    }
  });

  it('owes no notice for an id a MeMesh notice left, whatever an older MeMesh wrote on its row', async () => {
    db().prepare(`
      INSERT INTO agent_message_expiries (message_id, project, created_at, expired_at_ms, was_read, notice_message_id, sender, recipient)
      VALUES ('old-notice', ?, '2026-01-01 00:00:00', ?, 0, NULL, 'memesh', 'alice')
    `).run(PROJECT, Date.now());
    expect(await run()).toMatchObject({ outcome: 'nothing_expired', notice_count: 0 });
    expect(noticesTo('memesh')).toHaveLength(0);
  });

  it.skipIf(process.platform === 'win32')('deletes nothing when the archive path is a folder', async () => {
    fs.mkdirSync(archiveFile(), { recursive: true });
    const lost = send('alice', 'bob');
    age(lost.message_id);
    const result = await run();
    expect(result.outcome).toBe('archive_failed');
    expect(result.detail).toContain('is not a plain file');
    expect(userMessages()).toBe(1);
  });

  it('names the archive on its row before the first batch is done', async () => {
    const lost = send('alice', 'bob');
    age(lost.message_id);
    let row: unknown;
    await runAgentMessageExpiry(db(), {
      trigger: 'test',
      fault: { beforeArchiveCheck: () => { row = db().prepare("SELECT backup_path FROM agent_message_expiry_runs WHERE outcome = 'started'").get(); } },
    });
    expect(row).toEqual({ backup_path: fs.realpathSync(archiveFile()) });
  });

  it.skipIf(process.platform === 'win32')('takes group and other access away from an archive that has it', async () => {
    const first = send('alice', 'bob');
    age(first.message_id);
    await run();
    fs.chmodSync(archiveFile(), 0o644);
    const second = send('carol', 'bob');
    age(second.message_id);
    expect((await run()).outcome).toBe('deleted');
    expect(fs.statSync(archiveFile()).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('with only messages still being delivered, does not even try to write', async () => {
    const inFlight = send('alice', 'bob');
    dispatchChain(inFlight, 'started', false);
    age(inFlight.message_id);
    fs.chmodSync(dbHandle.dbPath, 0o400);
    let result;
    try {
      result = await run();
    } finally {
      fs.chmodSync(dbHandle.dbPath, 0o600);
    }
    expect(result.outcome).toBe('deferred_in_flight');
  });

  it('counts an acknowledgement or a workflow record alone as read', async () => {
    const acked = send('alice', 'bob');
    const ackChain = dispatchChain(acked);
    recordAgentAckFact(db(), { delivery_id: acked.delivery_id, host_accept_id: ackChain.hostAcceptId, actor: 'bob', idempotency_key: `a-${acked.message_id}` });
    const worked = send('carol', 'bob');
    recordAgentWorkflowFact(db(), { delivery_id: worked.delivery_id, actor: 'bob', workflow_state: 'completed', idempotency_key: `w-${worked.message_id}` });
    age(acked.message_id);
    age(worked.message_id);
    expect(await run()).toMatchObject({ outcome: 'deleted', expired_message_count: 2, unread_message_count: 0, notice_count: 0 });
  });

  it('writes one notice per project for a sender with expired messages in two projects', async () => {
    const here = send('alice', 'bob');
    const there = sendAgentMessage(db(), {
      project: 'elsewhere', sender: 'alice', recipient: 'bob', idempotency_key: 'k2', content_type: 'application/json', payload: { body: 'x' },
    });
    age(here.message_id);
    age(there.message_id);
    expect(await run()).toMatchObject({ outcome: 'deleted', notice_count: 2 });
    expect((db().prepare("SELECT project FROM agent_messages WHERE sender = 'memesh' ORDER BY project").all() as Array<{ project: string }>).map((r) => r.project))
      .toEqual(['elsewhere', PROJECT].sort());
  });

  it('gives the archive\'s freed pages back as it removes old copies', async () => {
    const old = agentMessageExpiryCutoff(Date.now() - 60_000);
    const insert = db().prepare(`
      INSERT INTO agent_messages (message_id, project, sender, recipient, content_type, privacy, payload_json, provenance_json, created_at)
      VALUES (?, ?, 'alice', 'bob', 'text/plain', 'private', ?, '{}', ?)
    `);
    db().transaction(() => { for (let i = 0; i < 200; i++) insert.run(randomUUID(), PROJECT, JSON.stringify('x'.repeat(4000)), old); }).immediate();
    await run();
    const pages = (): { pages: number; free: number } => {
      const handle = new DatabaseSync(archiveFile(), { readOnly: true });
      try {
        return {
          pages: (handle.prepare('PRAGMA page_count').get() as { page_count: number }).page_count,
          free: (handle.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count,
        };
      } finally {
        handle.close();
      }
    };
    const full = pages();
    inArchive(`UPDATE archive_log SET archived_at_ms = ${Date.now() - 25 * 3_600_000}`);
    expect((await run()).outcome).toBe('archive_purged');
    const after = pages();
    expect(after.free).toBe(0);
    expect(after.pages).toBeLessThan(full.pages / 4);
  });

  it('is not due when the last pass started four minutes ago', async () => {
    const lost = send('alice', 'bob');
    age(lost.message_id);
    db().prepare("INSERT INTO agent_message_expiry_runs (started_at_ms, finished_at_ms, trigger_source, outcome) VALUES (?, ?, 'router', 'nothing_expired')")
      .run(Date.now() - 4 * 60_000, Date.now() - 4 * 60_000);
    expect(await runAgentMessageExpiryIfDue(db(), { trigger: 'test' })).toBeNull();
  });
});

describe('a creation time that cannot be read', () => {
  it('does not stop the pass: such a message is deleted like any other past its day, and the run says so', async () => {
    const empty = bareMessage('', 'alice');
    const normal = bareMessage(agentMessageExpiryCutoff(Date.now() - 60_000), 'carol');
    const result = await run();
    expect(result).toMatchObject({ outcome: 'deleted', expired_message_count: 2 });
    expect(result.detail).toContain('1 message(s) had a creation time that cannot be read');
    expect(ids()).not.toContain(empty);
    expect(ids()).not.toContain(normal);
    expect(countIn(archiveFile(), 'agent_messages')).toBe(2);
    // A later read of it gets the ordinary expired answer, not a crash on the time.
    expect(() => fetchAgentMessage(db(), { project: PROJECT, recipient: 'alice', message_id: empty }))
      .toThrow(/message_expired: .*expired at an unknown time/);
  });
});

describe('the pass is due every interval, not every second interval', () => {
  it('runs again when the last pass started a few seconds less than one interval ago', async () => {
    const lost = send('alice', 'bob');
    age(lost.message_id);
    db().prepare(`
      INSERT INTO agent_message_expiry_runs (started_at_ms, finished_at_ms, trigger_source, outcome)
      VALUES (?, ?, 'router', 'nothing_expired')
    `).run(Date.now() - AGENT_MESSAGE_EXPIRY_INTERVAL_MS + 2_000, Date.now() - AGENT_MESSAGE_EXPIRY_INTERVAL_MS + 2_500);
    expect(await runAgentMessageExpiryIfDue(db(), { trigger: 'test' })).toMatchObject({ outcome: 'deleted' });
  });
});

describe('an archive path that is not a plain archive file', () => {
  const unix = process.platform !== 'win32';

  it.skipIf(!unix)('deletes nothing when the archive is a symlink to the database itself', async () => {
    fs.mkdirSync(path.dirname(archiveFile()), { recursive: true, mode: 0o700 });
    fs.symlinkSync(dbHandle.dbPath, archiveFile());
    const lost = send('alice', 'bob');
    age(lost.message_id);
    const result = await run();
    expect(result.outcome).toBe('archive_failed');
    expect(result.detail).toContain('is a symlink');
    expect(userMessages()).toBe(1);
    expect(db().prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'archive_log'").get()).toEqual({ n: 0 });
  });

  it.skipIf(!unix)('deletes nothing when the archive is a hard link to the database itself', async () => {
    fs.mkdirSync(path.dirname(archiveFile()), { recursive: true, mode: 0o700 });
    fs.linkSync(dbHandle.dbPath, archiveFile());
    const lost = send('alice', 'bob');
    age(lost.message_id);
    const result = await run();
    expect(result.outcome).toBe('archive_failed');
    expect(result.detail).toContain('is the database itself');
    expect(userMessages()).toBe(1);
    expect(db().prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'archive_log'").get()).toEqual({ n: 0 });
  });

  it.skipIf(!unix)('writes nothing into another database the archive path is a symlink to, deletes nothing, and doctor warns', async () => {
    const first = send('alice', 'bob');
    age(first.message_id);
    expect((await run()).outcome).toBe('deleted');
    const otherPath = path.join(dbHandle.tmpDir, 'other.db');
    const other = new MemeshDatabase(otherPath);
    other.exec(SCHEMA_SQL);
    other.close();
    const otherBefore = fs.readFileSync(otherPath);
    fs.rmSync(archiveFile());
    fs.symlinkSync(otherPath, archiveFile());
    const lost = send('carol', 'bob');
    age(lost.message_id);
    const result = await run();
    expect(result.outcome).toBe('archive_failed');
    expect(result.detail).toContain('is a symlink');
    expect(ids()).toContain(lost.message_id);
    expect(fs.readFileSync(otherPath).equals(otherBefore)).toBe(true);
    const row = await doctorRow();
    expect(row?.status).toBe('warn');
    expect(row?.summary).toContain('is a symlink');
  });

  it.skipIf(!unix)('does not follow a symlink even to a MeMesh archive of its own', async () => {
    const first = send('alice', 'bob');
    age(first.message_id);
    expect((await run()).outcome).toBe('deleted');
    const moved = path.join(dbHandle.tmpDir, 'moved-archive.db');
    fs.renameSync(archiveFile(), moved);
    fs.symlinkSync(moved, archiveFile());
    const before = fs.readFileSync(moved);
    const lost = send('carol', 'bob');
    age(lost.message_id);
    expect((await run()).outcome).toBe('archive_failed');
    expect(ids()).toContain(lost.message_id);
    expect(fs.readFileSync(moved).equals(before)).toBe(true);
  });

  it.skipIf(!unix)('leaves a file that is not a database alone, permissions included, and deletes nothing', async () => {
    const mine = path.join(dbHandle.tmpDir, 'notes.txt');
    fs.writeFileSync(mine, 'my own notes\n');
    fs.chmodSync(mine, 0o644);
    fs.mkdirSync(path.dirname(archiveFile()), { recursive: true, mode: 0o700 });
    fs.symlinkSync(mine, archiveFile());
    const lost = send('alice', 'bob');
    age(lost.message_id);
    const result = await run();
    expect(result.outcome).toBe('archive_failed');
    expect(result.detail).toContain(archiveFile());
    expect(fs.statSync(mine).mode & 0o777).toBe(0o644);
    expect(fs.readFileSync(mine, 'utf8')).toBe('my own notes\n');
    expect(userMessages()).toBe(1);
  });

  it.skipIf(!unix)('does not create a file where a dangling symlink points', async () => {
    const nowhere = path.join(dbHandle.tmpDir, 'nowhere.db');
    fs.mkdirSync(path.dirname(archiveFile()), { recursive: true, mode: 0o700 });
    fs.symlinkSync(nowhere, archiveFile());
    const lost = send('alice', 'bob');
    age(lost.message_id);
    expect((await run()).outcome).toBe('archive_failed');
    expect(fs.existsSync(nowhere)).toBe(false);
    expect(userMessages()).toBe(1);
  });
});

describe('two databases in one folder', () => {
  it('each keeps its own archive, so restoring one never brings in the other\'s messages', async () => {
    const otherPath = path.join(path.dirname(dbHandle.dbPath), 'work.db');
    const other = new MemeshDatabase(otherPath);
    other.exec('PRAGMA foreign_keys = ON');
    other.exec(SCHEMA_SQL);
    try {
      const mine = send('alice', 'bob');
      age(mine.message_id);
      const theirs = sendAgentMessage(other, {
        project: PROJECT, sender: 'alice', recipient: 'bob', idempotency_key: 'work-key',
        content_type: 'application/json', payload: { body: 'work-secret' },
      });
      other.prepare("UPDATE agent_messages SET created_at = datetime('now', '-2 days') WHERE message_id = ?").run(theirs.message_id);
      const first = await run();
      const second = await runAgentMessageExpiry(other, { trigger: 'test' });
      expect(first.outcome).toBe('deleted');
      expect(second.outcome).toBe('deleted');
      expect(first.backup_path).not.toBe(second.backup_path);
      const mineArchived = new DatabaseSync(first.backup_path!, { readOnly: true });
      try {
        expect((mineArchived.prepare('SELECT message_id FROM agent_messages').all() as Array<{ message_id: string }>).map((r) => r.message_id)).toEqual([mine.message_id]);
      } finally {
        mineArchived.close();
      }
    } finally {
      other.close();
    }
  });
});

describe('doctor and the archive', () => {
  it('does not say the deleted messages are kept in an archive that the next day emptied', async () => {
    const lost = send('alice', 'bob');
    age(lost.message_id);
    await run();
    inArchive(`UPDATE archive_log SET archived_at_ms = ${Date.now() - 25 * 3_600_000}`);
    const purged = await run();
    expect(purged.outcome).toBe('archive_purged');
    expect(purged.detail).toContain('removed 1 archived message(s) past their extra day');
    const row = await doctorRow();
    expect(row?.summary).not.toContain('Deleted messages are kept one more day in');
    expect(row?.summary).toContain('holds no deleted message now');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('says an archive it cannot read cannot be read, not that it is gone, and warns', async () => {
    const lost = send('alice', 'bob');
    age(lost.message_id);
    const first = await run();
    const folder = path.dirname(first.backup_path!);
    fs.chmodSync(folder, 0o000);
    try {
      const row = await doctorRow();
      expect(row?.status).toBe('warn');
      expect(row?.summary).toContain('cannot be read');
      expect(row?.summary).not.toContain('is not there any more');
    } finally {
      fs.chmodSync(folder, 0o700);
    }
  });

  it('warns about an archive file that is not a database before any pass fails on it, and names that file in the fix', async () => {
    const lost = send('alice', 'bob');
    age(lost.message_id);
    const first = await run();
    fs.writeFileSync(first.backup_path!, 'not a database at all, just text that is long enough to be a header');
    const before = await doctorRow();
    expect(before?.status).toBe('warn');
    expect(before?.fix).toContain(first.backup_path!);
    const again = send('carol', 'bob');
    age(again.message_id);
    const failed = await run();
    expect(failed.outcome).toBe('archive_failed');
    expect(failed.detail).toContain(first.backup_path!);
    const after = await doctorRow();
    expect(after?.status).toBe('warn');
    expect(after?.fix).toContain(first.backup_path!);
  });

  it.skipIf(process.platform === 'win32')('gives, for a database it cannot write, the same quoted command the database check gives', async () => {
    fs.chmodSync(dbHandle.dbPath, 0o400);
    try {
      const row = await doctorRow();
      expect(row?.status).toBe('warn');
      expect(row?.fix).toContain(`chmod u+w '${fs.realpathSync(dbHandle.dbPath)}'`);
    } finally {
      fs.chmodSync(dbHandle.dbPath, 0o600);
    }
  });

  it('warns when messages are waiting and no pass has succeeded for a while, however recent the last busy pass is', async () => {
    const insert = db().prepare("INSERT INTO agent_message_expiry_runs (started_at_ms, finished_at_ms, trigger_source, outcome) VALUES (?, ?, 'router', ?)");
    insert.run(Date.now() - 3_600_000, Date.now() - 3_600_000, 'deleted');
    insert.run(Date.now() - 1_000, Date.now() - 500, 'database_busy');
    const lost = send('alice', 'bob');
    age(lost.message_id);
    const row = await doctorRow();
    expect(row?.status).toBe('warn');
    expect(row?.summary).toContain('past their one day');
  });

  it('warns when messages are waiting and every pass so far met a lock', async () => {
    db().prepare("INSERT INTO agent_message_expiry_runs (started_at_ms, finished_at_ms, trigger_source, outcome) VALUES (?, ?, 'router', 'database_busy')")
      .run(Date.now() - 1_000, Date.now() - 500);
    const lost = send('alice', 'bob');
    age(lost.message_id);
    expect((await doctorRow())?.status).toBe('warn');
  });
});
