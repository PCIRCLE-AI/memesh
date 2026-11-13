import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { SCHEMA_SQL } from '../../src/storage/schema.js';
import { ConversationMessages } from '../../src/core/conversation-messages.js';
import { sendAgentMessage } from '../../src/core/agent-messaging.js';
import { runAgentMessageExpiry } from '../../src/core/agent-message-expiry.js';
import { AgentRouter } from '../../src/core/agent-router.js';

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const roots: string[] = [];
const handles: Array<{ close(): void }> = [];
beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const handle of handles.splice(0).reverse()) handle.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-conversation-entry-')); roots.push(root);
  const home = path.join(root, 'U'), config = path.join(root, 'B'), data = path.join(root, 'C');
  for (const directory of [home, config, data]) { fs.mkdirSync(directory, { mode: 0o700 }); fs.writeFileSync(path.join(directory, 'sentinel'), 'unchanged'); }
  const graph = path.join(data, 'graph.db');
  vi.stubEnv('HOME', home); vi.stubEnv('MEMESH_DIR', config); vi.stubEnv('MEMESH_DB_PATH', graph);
  const source = () => { const db = new MemeshDatabase(graph); db.exec(SCHEMA_SQL); handles.push(db); return db; };
  const open = (options: ConstructorParameters<typeof ConversationMessages>[0] = {}) => {
    const store = new ConversationMessages({ clock: () => NOW, machine: 'fixture-machine', ...options }); handles.push(store); return store;
  };
  return { root, home, config, data, graph, source, open };
}
function seed(db: MemeshDatabase, age: number) {
  const sent = sendAgentMessage(db, { project: 'fixture-project', sender: 'sender', recipient: 'recipient', intended_session: 'recipient-session', idempotency_key: `age-${age}`, content_type: 'text/plain', payload: `complete age ${age} body` });
  db.prepare('UPDATE agent_messages SET created_at=? WHERE message_id=?').run(new Date(NOW - age * 86400000).toISOString().replace('T', ' ').replace('.000Z', ''), sent.message_id);
  return sent.message_id;
}
function snapshot(db: MemeshDatabase) {
  return Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => [name,
    db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(row => JSON.stringify(row)).sort()]));
}

it('bounds owned source and target timeouts while preserving defaults and borrowed handles', () => {
  const f = fixture(), db = f.source(); seed(db, 2);
  db.pragma('busy_timeout = 731');
  const observed: Array<{ file: string; timeout: unknown }> = [];
  const prepare = MemeshDatabase.prototype.prepare;
  vi.spyOn(MemeshDatabase.prototype, 'prepare').mockImplementation(function (this: MemeshDatabase, sql: string) {
    if (/sqlite_master|INSERT INTO messages|CREATE TABLE/i.test(sql)) {
      observed.push({ file: (prepare.call(this, "SELECT file FROM pragma_database_list WHERE name='main'").get() as { file: string }).file,
        timeout: prepare.call(this, 'PRAGMA busy_timeout').get()?.timeout });
    }
    return prepare.call(this, sql);
  });
  const capped = f.open({ busyTimeoutMs: 17 });
  expect(capped['db'].prepare('PRAGMA busy_timeout').get()?.timeout).toBe(17);
  expect(observed.some(row => row.file === fs.realpathSync(f.graph) && row.timeout === 17)).toBe(true);
  expect(db.prepare('PRAGMA busy_timeout').get()?.timeout).toBe(731);
  const borrowed = f.open({ file: path.join(f.data, 'borrowed.db'), legacySource: db, busyTimeoutMs: 19 });
  expect(borrowed['db'].prepare('PRAGMA busy_timeout').get()?.timeout).toBe(19);
  expect(db.prepare('PRAGMA busy_timeout').get()?.timeout).toBe(731);
  expect(f.open({ file: path.join(f.data, 'default.db') })['db'].prepare('PRAGMA busy_timeout').get()?.timeout).toBe(30000);
});

it('rejects invalid timeout budgets before creating or altering destination files', () => {
  const f = fixture(), existing = path.join(f.data, 'existing.db');
  fs.writeFileSync(existing, 'sentinel', { mode: 0o640 });
  const before = { bytes: fs.readFileSync(existing), mode: fs.statSync(existing).mode };
  for (const busyTimeoutMs of [-1, 0.5, NaN, Infinity, 30001, Number.MAX_SAFE_INTEGER]) {
    expect(() => f.open({ file: path.join(f.root, 'absent', 'messages.db'), busyTimeoutMs })).toThrow('busyTimeoutMs');
    expect(() => f.open({ file: existing, busyTimeoutMs })).toThrow('busyTimeoutMs');
  }
  expect(fs.existsSync(path.join(f.root, 'absent'))).toBe(false);
  expect({ bytes: fs.readFileSync(existing), mode: fs.statSync(existing).mode }).toEqual(before);
});

it('bounds an owned readonly source lock and closes it without changing the borrowed writer timeout', () => {
  const f = fixture(), db = f.source(), id = seed(db, 2);
  const close = vi.spyOn(MemeshDatabase.prototype, 'close');
  db.pragma('busy_timeout = 733');
  db.exec('BEGIN EXCLUSIVE');
  const started = performance.now();
  try { expect(() => f.open({ busyTimeoutMs: 20 })).toThrow(); }
  finally { db.exec('ROLLBACK'); }
  expect(performance.now() - started).toBeLessThan(1000);
  // The locked source's preflight fails before a target handle is opened.
  expect(close).toHaveBeenCalledTimes(1);
  const closed = close.mock.contexts[0];
  if (!(closed instanceof MemeshDatabase)) throw new Error('Expected owned SQLite handle');
  expect(closed === db).toBe(false);
  expect(() => closed.prepare('SELECT 1')).toThrow(/not open/);
  expect(db.prepare('PRAGMA busy_timeout').get()?.timeout).toBe(733);
  expect(f.open({ busyTimeoutMs: 20 }).status().find(row => row.id === id)?.body).toBe('complete age 2 body');
});

it('expiry target contention fails within its short budget without archive or message loss', async () => {
  const f = fixture(), db = f.source(); seed(db, 2); seed(db, 13);
  f.open({ file: path.join(f.data, 'messages.db') });
  const locker = new MemeshDatabase(path.join(f.data, 'messages.db'));
  const before = snapshot(db), schema = db.prepare('SELECT * FROM sqlite_master ORDER BY name').all();
  locker.exec('BEGIN IMMEDIATE');
  const started = performance.now();
  let result;
  try { result = await runAgentMessageExpiry(db, { trigger: 'manual', nowMs: NOW }); }
  finally { locker.exec('ROLLBACK'); locker.close(); }
  expect(performance.now() - started).toBeLessThan(2000);
  expect(result.outcome).toBe('database_busy'); expect(result.expired_message_count).toBe(0); expect(result.backup_path).toBeNull();
  const after = snapshot(db);
  expect(after.agent_message_expiry_runs).toHaveLength(before.agent_message_expiry_runs.length + 1);
  expect(JSON.parse(after.agent_message_expiry_runs.at(-1)!)).toMatchObject({ outcome: 'database_busy' });
  expect(after.sqlite_sequence).toEqual([...before.sqlite_sequence, JSON.stringify({ name: 'agent_message_expiry_runs', seq: result.run_id })].sort());
  before.sqlite_sequence = after.sqlite_sequence;
  delete before.agent_message_expiry_runs; delete after.agent_message_expiry_runs;
  expect(after).toEqual(before); expect(db.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(schema);
  expect(fs.readdirSync(f.data).some(name => /archive/.test(name))).toBe(false);
});

it('default opening imports the actual C graph including live WAL, leaving B and U untouched and closing only its owned source', () => {
  const f = fixture(), db = f.source(); db.exec('PRAGMA journal_mode=WAL');
  const id = seed(db, 13), before = snapshot(db);
  const closed: string[] = [];
  const close = MemeshDatabase.prototype.close;
  vi.spyOn(MemeshDatabase.prototype, 'close').mockImplementation(function (this: MemeshDatabase) {
    closed.push((this.prepare("SELECT file FROM pragma_database_list WHERE name='main'").get() as { file: string }).file);
    return close.call(this);
  });
  const store = f.open();
  expect(store.status().find(row => row.id === id)?.body).toBe('complete age 13 body');
  expect(closed).toContain(fs.realpathSync(f.graph));
  expect(snapshot(db)).toEqual(before);
  for (const directory of [f.home, f.config]) expect(fs.readdirSync(directory)).toEqual(['sentinel']);
  expect(fs.existsSync(path.join(f.data, 'messages.db'))).toBe(true);
});

it('explicit destination without source ignores an ambient invalid graph, while missing default graph is never created', () => {
  const f = fixture();
  fs.writeFileSync(f.graph, 'not SQLite');
  expect(f.open({ file: path.join(f.root, 'explicit.db') }).status()).toEqual([]);
  expect(fs.readFileSync(f.graph, 'utf8')).toBe('not SQLite');
  fs.unlinkSync(f.graph);
  expect(f.open().status()).toEqual([]);
  expect(fs.existsSync(f.graph)).toBe(false);
});

it.each([false, true])('refuses default graph basename messages.db before side effects (exists=%s)', exists => {
  const f = fixture(), file = path.join(f.data, 'messages.db');
  vi.stubEnv('MEMESH_DB_PATH', file);
  if (exists) {
    const db = new MemeshDatabase(file); handles.push(db); db.exec('CREATE TABLE original(value TEXT); INSERT INTO original VALUES (\'keep\')');
    fs.chmodSync(file, 0o640);
  }
  const before = fs.readdirSync(f.data).map(name => [name, fs.statSync(path.join(f.data, name)).mode, fs.readFileSync(path.join(f.data, name))]);
  expect(() => f.open()).toThrow('different files');
  expect(fs.readdirSync(f.data).map(name => [name, fs.statSync(path.join(f.data, name)).mode, fs.readFileSync(path.join(f.data, name))])).toEqual(before);
});

it('explicit borrowed source stays open and overrides an unrelated ambient graph', () => {
  const f = fixture(), db = f.source(), id = seed(db, 2);
  vi.stubEnv('MEMESH_DB_PATH', path.join(f.root, 'ambient-must-not-exist.db'));
  const store = f.open({ file: path.join(f.data, 'explicit.db'), legacySource: db });
  expect(store.status().find(row => row.id === id)).toBeDefined();
  expect(db.prepare('SELECT message_id FROM agent_messages').get()).toBeDefined();
  expect(fs.existsSync(path.join(f.root, 'ambient-must-not-exist.db'))).toBe(false);
});

it('expiry preserves both 2-day and 13-day histories before deleting legacy rows from its actual graph', async () => {
  const f = fixture(), db = f.source(), ids = [seed(db, 2), seed(db, 13)];
  vi.stubEnv('MEMESH_DB_PATH', path.join(f.root, 'wrong-ambient.db'));
  const result = await runAgentMessageExpiry(db, { trigger: 'manual', nowMs: NOW });
  expect(result.outcome).toBe('deleted');
  expect(result.expired_message_count).toBe(2);
  const status = f.open({ file: path.join(f.data, 'messages.db') }).status();
  for (const id of ids) {
    const row = status.find(item => item.id === id); expect(row?.body).toMatch(/^complete age (2|13) body$/);
    expect(row?.events.some(event => event.event === 'legacy_imported')).toBe(true);
    expect(db.prepare('SELECT message_id FROM agent_messages WHERE message_id=?').get(id)).toBeUndefined();
  }
  expect(fs.existsSync(path.join(f.root, 'wrong-ambient.db'))).toBe(false);
});

it('failed target import prevents archive/delete and changes only the existing expiry run diagnostic', async () => {
  const f = fixture(), db = f.source(); seed(db, 2); seed(db, 13);
  fs.writeFileSync(path.join(f.data, 'messages.db'), 'invalid SQLite target');
  const before = snapshot(db), schema = db.prepare('SELECT * FROM sqlite_master ORDER BY name').all();
  const files = fs.readdirSync(f.data).sort();
  const result = await runAgentMessageExpiry(db, { trigger: 'manual', nowMs: NOW });
  expect(result.outcome).toBe('failed'); expect(result.expired_message_count).toBe(0); expect(result.backup_path).toBeNull();
  const after = snapshot(db);
  expect(after.agent_message_expiry_runs).toHaveLength(before.agent_message_expiry_runs.length + 1);
  expect(JSON.parse(after.agent_message_expiry_runs.at(-1)!)).toMatchObject({ outcome: 'failed' });
  expect(after.sqlite_sequence).toEqual([...before.sqlite_sequence, JSON.stringify({ name: 'agent_message_expiry_runs', seq: result.run_id })].sort());
  before.sqlite_sequence = after.sqlite_sequence;
  delete before.agent_message_expiry_runs; delete after.agent_message_expiry_runs;
  expect(after).toEqual(before); expect(db.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(schema);
  expect(fs.readdirSync(f.data).sort()).toEqual(files);
});

it('expiry with an empty legacy table does not create a messages database', async () => {
  const f = fixture(), db = f.source();
  await runAgentMessageExpiry(db, { trigger: 'manual', nowMs: NOW });
  expect(fs.existsSync(path.join(f.data, 'messages.db'))).toBe(false);
});

it('imports a message added after the initial migration before its later expiry batch deletes it', async () => {
  const f = fixture(), db = f.source();
  const first = seed(db, 13);
  let added: string | undefined;
  const result = await runAgentMessageExpiry(db, { trigger: 'test-interleaving', nowMs: NOW, fault: { afterBatch(batch) {
    if (batch === 1) added = seed(db, 2);
  } } });
  expect(added).toBeDefined();
  if (added === undefined) throw new Error('interleaved message was not created');
  expect(result.outcome).toBe('deleted');
  expect(result.expired_message_count).toBe(2);
  expect(db.prepare('SELECT message_id FROM agent_messages WHERE message_id IN (?, ?)').all(first, added)).toEqual([]);
  const target = new MemeshDatabase(path.join(f.data, 'messages.db'), { readOnly: true });
  try {
    const row = target.prepare('SELECT body FROM messages WHERE id = ?').get(added);
    expect(row?.body).toBe('complete age 2 body');
    expect(target.prepare("SELECT event FROM events WHERE message_id = ? AND event = 'legacy_imported'").get(added)).toBeDefined();
  } finally { target.close(); }
});

it.each([false, true])('refreshes interleaved host acceptance inside the deletion transaction (target fault=%s)', async fault => {
  const f = fixture(), db = f.source(), first = seed(db, 13), late = seed(db, 2);
  const project = 'fixture-project';
  const delivery = (db.prepare('SELECT delivery_id FROM agent_message_deliveries WHERE message_id=?').get(late) as { delivery_id: string }).delivery_id;
  db.prepare('INSERT INTO agent_principals(project,principal_id,activation_event_sequence) VALUES (?,?,0)').run(project, 'recipient');
  db.prepare('INSERT INTO agent_session_instances(project,session_instance_id,principal_id,adapter_kind) VALUES (?,?,?,?)').run(project, 'recipient-session', 'recipient', 'codex-cli-queue');
  db.prepare('INSERT INTO agent_session_connections(connection_id,project,principal_id,session_instance_id,generation,adapter_kind,router_instance_id,lease_expires_at_ms) VALUES (?,?,?,?,1,?,?,?)').run('connection', project, 'recipient', 'recipient-session', 'codex-cli-queue', 'synthetic-router', NOW + 60000);
  db.prepare("INSERT INTO agent_dispatch_attempts(attempt_id,delivery_id,project,principal_id,session_instance_id,connection_id,generation,router_instance_id,attempt_number,result) VALUES (?,?,?,?,?,?,1,?,1,'started')").run('attempt', delivery, project, 'recipient', 'recipient-session', 'connection', 'synthetic-router');
  const router = new AgentRouter({ db, socket_path: path.join(f.root, 'unused.sock'), memesh_version: '4.13.0', router_instance_id: 'synthetic-router', adapters: [] });
  let observed: unknown, message: unknown, attempt: unknown;
  const result = await runAgentMessageExpiry(db, { trigger: 'test-interleaving', nowMs: NOW, fault: { afterBatch(batch) {
    if (batch !== 1) return;
    expect(db.prepare('SELECT message_id FROM agent_messages WHERE message_id=?').get(late)).toBeDefined();
    // Exercise the router's actual write methods at the existing yield seam; no host or socket is started.
    router['finishAttempt']('attempt', 'adapter_returned', null);
    expect(router['insertHostAccept']('attempt', delivery, 'codex-cli-queue', { synthetic_late_accept: true })).toBe(true);
    observed = db.prepare('SELECT * FROM agent_host_accepts WHERE delivery_id=?').get(delivery);
    message = db.prepare('SELECT * FROM agent_messages WHERE message_id=?').get(late);
    attempt = db.prepare('SELECT * FROM agent_dispatch_attempts WHERE attempt_id=?').get('attempt');
    if (fault) {
      const target = new MemeshDatabase(path.join(f.data, 'messages.db'));
      try { target.exec("CREATE TRIGGER synthetic_copy_failure BEFORE INSERT ON events WHEN NEW.event='legacy_fact' AND json_extract(NEW.detail,'$.table')='agent_host_accepts' BEGIN SELECT RAISE(ABORT,'synthetic audit copy failure'); END"); }
      finally { target.close(); }
    }
  } } });
  expect(observed).toBeDefined();
  expect(db.prepare('SELECT message_id FROM agent_messages WHERE message_id=?').get(first)).toBeUndefined();
  const target = new MemeshDatabase(path.join(f.data, 'messages.db'), { readOnly: true });
  try {
    const facts = (target.prepare('SELECT event,detail FROM events WHERE message_id=?').all(late) as Array<{ event: string; detail: string }>).filter(row => row.event === 'legacy_fact').map(row => JSON.parse(row.detail));
    if (fault) {
      expect(result.outcome).toBe('failed'); expect(result.expired_message_count).toBe(1);
      expect(result.backup_path).not.toBeNull(); // Archive/earlier committed batch are non-destructive retained effects.
      expect(db.prepare('SELECT * FROM agent_messages WHERE message_id=?').get(late)).toEqual(message);
      expect(db.prepare('SELECT * FROM agent_host_accepts WHERE delivery_id=?').get(delivery)).toEqual(observed);
      expect(db.prepare('SELECT * FROM agent_dispatch_attempts WHERE attempt_id=?').get('attempt')).toEqual(attempt);
      expect(facts.some(fact => fact.table === 'agent_host_accepts')).toBe(false);
    } else {
      expect(result.outcome).toBe('deleted'); expect(result.expired_message_count).toBe(2);
      expect(db.prepare('SELECT message_id FROM agent_messages WHERE message_id=?').get(late)).toBeUndefined();
      expect(facts.find(fact => fact.table === 'agent_host_accepts')?.row).toEqual(JSON.parse(JSON.stringify(observed)));
    }
  } finally { target.close(); }
});
