import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { createSchema, migrateEntitiesSchema } from '../../src/storage/schema.js';
import { ConversationMessages } from '../../src/core/conversation-messages.js';
import { LEGACY_CONVERSATION_TABLES, retireLegacyConversationTables } from '../../src/core/conversation-message-migration.js';
import { installLegacyMessageSchema, seedLegacyMessage, seedLegacyReceipt } from '../helpers/agent-session-fixture.js';

const NOW = Date.parse('2026-11-16T12:00:00.000Z'), DAY = 86400000;
const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const close of cleanup.splice(0).reverse()) close(); });

function snapshot(db: MemeshDatabase) {
  return Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) =>
    [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all()]));
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-retire-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'graph.db');
  fs.closeSync(fs.openSync(file, 'wx', 0o600));
  const source = new MemeshDatabase(file); cleanup.push(() => source.close());
  source.pragma('journal_mode=WAL'); source.pragma('foreign_keys=ON'); installLegacyMessageSchema(source);
  source.prepare("INSERT INTO entities(name,type) VALUES ('keep-memory','note')").run();
  source.prepare('INSERT INTO agent_session_aliases VALUES (?,?,?)').run('new-session', 'old-session', NOW);
  source.prepare('INSERT INTO agent_session_launchers VALUES (?,?,?,?)').run(42, 'start', 'new-session', NOW);
  source.exec('CREATE TABLE keep_owner_rows(value TEXT); INSERT INTO keep_owner_rows VALUES (\'unchanged\')');
  const store = new ConversationMessages({ file: path.join(root, 'messages.db'), machine: 'fixture', clock: () => NOW });
  cleanup.push(() => store.close());
  const target = store['db'];
  const seed = (age: number) => {
    const row = seedLegacyMessage(source, { project: 'fixture-project', sender: 'sender', recipient: 'recipient',
      payload: `FULL history ${age}`, content_type: 'text/plain', intended_session: 'recipient-session' });
    source.prepare('UPDATE agent_messages SET created_at=? WHERE message_id=?').run(new Date(NOW - age * DAY).toISOString(), row.message_id);
    return row;
  };
  const retire = () => retireLegacyConversationTables(source, target, { nowMs: NOW, localMachine: 'fixture' });
  return { root, file, source, store, target, seed, retire };
}

it('the default opener copies unread and already-handled history, then removes only retired tables', () => {
  const f = fixture(), recent = f.seed(2), handled = f.seed(13), expired = f.seed(15);
  seedLegacyReceipt(f.source, { project: handled.project, recipient: handled.recipient, message_id: handled.message_id,
    receipt_kind: 'intake', actor: 'recipient', idempotency_key: 'handled', detail: { intake_state: 'ingested' } });
  f.source.prepare('INSERT INTO agent_principals(project,principal_id,activation_event_sequence) VALUES (?,?,0)').run(handled.project, 'recipient');
  f.source.prepare('INSERT INTO agent_session_instances(project,session_instance_id,principal_id,adapter_kind) VALUES (?,?,?,?)').run(handled.project, 'recipient-session', 'recipient', 'codex-cli-queue');
  f.source.prepare('INSERT INTO agent_session_connections(connection_id,project,principal_id,session_instance_id,generation,adapter_kind,router_instance_id,lease_expires_at_ms) VALUES (?,?,?,?,1,?,?,?)')
    .run('connection', handled.project, 'recipient', 'recipient-session', 'codex-cli-queue', 'old-router', NOW);
  f.source.prepare('INSERT INTO agent_dispatch_attempts(attempt_id,delivery_id,project,principal_id,session_instance_id,connection_id,generation,router_instance_id,attempt_number,result) VALUES (?,?,?,?,?,?,1,?,1,?)')
    .run('attempt', handled.delivery_id, handled.project, 'recipient', 'recipient-session', 'connection', 'old-router', 'adapter_returned');
  f.source.prepare('INSERT INTO agent_host_accepts(host_accept_id,attempt_id,delivery_id,adapter_kind,receipt_json) VALUES (?,?,?,?,?)')
    .run('accept', 'attempt', handled.delivery_id, 'codex-cli-queue', JSON.stringify({ accepted: true }));
  const accepted = f.source.prepare('SELECT * FROM agent_host_accepts').get();
  const memory = f.source.prepare('SELECT * FROM entities').all();
  vi.stubEnv('MEMESH_DB_PATH', f.file); vi.stubEnv('MEMESH_DIR', f.root);
  const opened = new ConversationMessages({ machine: 'fixture', clock: () => NOW }); cleanup.push(() => opened.close());
  expect(opened.status().map(row => row.id).sort()).toEqual([recent.message_id, handled.message_id].sort());
  expect(opened.status(undefined, handled.message_id)[0]).toMatchObject({ body: 'FULL history 13', sent_at: new Date(NOW - 13 * DAY).toISOString() });
  expect(opened.status(undefined, handled.message_id)[0].events.some(row => row.event === 'legacy_handled')).toBe(true);
  const facts = opened.status(undefined, handled.message_id)[0].events.filter(row => row.event === 'legacy_fact').map(row => JSON.parse(row.detail));
  expect(facts.find(row => row.table === 'agent_host_accepts').row).toEqual(JSON.parse(JSON.stringify(accepted)));
  expect(opened.status(undefined, expired.message_id)).toEqual([]);
  const names = Object.keys(snapshot(f.source));
  expect(LEGACY_CONVERSATION_TABLES.filter(name => names.includes(name))).toEqual([]);
  expect(f.source.prepare('SELECT * FROM entities').all()).toEqual(memory);
  expect(f.source.prepare('SELECT * FROM keep_owner_rows').all()).toEqual([{ value: 'unchanged' }]);
  expect(f.source.prepare('SELECT * FROM agent_session_aliases').all()).toEqual([{ session_id: 'new-session', previous_session_id: 'old-session', created_at_ms: NOW }]);
  expect(f.source.prepare('SELECT session_id FROM agent_session_launchers').get()).toEqual({ session_id: 'new-session' });
  expect(f.retire()).toEqual({ imported: 0, alreadyImported: 0, retired: 0 });
});

it('a failed destination copy leaves every source row and table unchanged', () => {
  const f = fixture(); f.seed(2); f.seed(13); const before = snapshot(f.source);
  f.target.exec("CREATE TRIGGER copy_fault BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'synthetic copy fault'); END");
  expect(f.retire).toThrow(/synthetic copy fault/);
  expect(snapshot(f.source)).toEqual(before);
  expect(f.store.status()).toEqual([]);
});

it('a later DROP failure rolls back source tables, and the committed copy can be retried without duplicate audit', () => {
  const f = fixture(), row = f.seed(13), before = snapshot(f.source);
  const exec = f.source.exec.bind(f.source);
  const fault = vi.spyOn(f.source, 'exec').mockImplementation(sql => {
    if (sql === 'DROP TABLE agent_messages') throw new Error('synthetic drop fault');
    return exec(sql);
  });
  expect(f.retire).toThrow(/synthetic drop fault/);
  expect(snapshot(f.source)).toEqual(before);
  const copied = f.store.status(undefined, row.message_id);
  expect(copied[0].body).toBe('FULL history 13');
  fault.mockRestore();
  expect(f.retire()).toMatchObject({ imported: 0, alreadyImported: 1, retired: LEGACY_CONVERSATION_TABLES.length });
  expect(f.store.status(undefined, row.message_id)).toEqual(copied);
});

it('refuses to cascade into a retained owner table', () => {
  const f = fixture(), row = f.seed(2);
  f.source.exec('CREATE TABLE owner_links(id TEXT REFERENCES agent_messages(message_id) ON DELETE CASCADE)');
  f.source.prepare('INSERT INTO owner_links VALUES (?)').run(row.message_id);
  const before = snapshot(f.source);
  expect(f.retire).toThrow(/retained table owner_links/);
  expect(snapshot(f.source)).toEqual(before);
  expect(f.store.status()).toEqual([]);
});

it('locks out a legacy writer throughout the final source snapshot and copy', () => {
  const f = fixture(); f.seed(2);
  const writer = new MemeshDatabase(f.file); cleanup.push(() => writer.close()); writer.pragma('busy_timeout=0');
  const prepare = f.target.prepare.bind(f.target); let attempted = false;
  vi.spyOn(f.target, 'prepare').mockImplementation(sql => {
    if (sql.startsWith('INSERT INTO messages') && !attempted) {
      attempted = true;
      expect(() => seedLegacyMessage(writer, { project: 'fixture-project', sender: 'sender', recipient: 'recipient', payload: 'too late' })).toThrow(/locked|busy/i);
    }
    return prepare(sql);
  });
  expect(f.retire().imported).toBe(1); expect(attempted).toBe(true);
  expect(f.store.status().map(row => row.body)).toEqual(['FULL history 2']);
});

it('unknown-age data aborts retirement without dropping valid history', () => {
  const f = fixture(), bad = f.seed(2); f.seed(13);
  f.source.prepare('UPDATE agent_messages SET created_at=? WHERE message_id=?').run('not-a-time', bad.message_id);
  const before = snapshot(f.source);
  expect(f.retire).toThrow(/timestamp/);
  expect(snapshot(f.source)).toEqual(before); expect(f.store.status()).toEqual([]);
});

it.skipIf(process.platform === 'win32')('rejects a writable legacy source in a public directory before retiring anything', () => {
  const f = fixture(); f.seed(2); const before = snapshot(f.source);
  vi.stubEnv('MEMESH_DB_PATH', f.file); vi.stubEnv('MEMESH_DIR', f.root);
  fs.chmodSync(f.root, 0o755);
  try {
    expect(() => new ConversationMessages({ clock: () => NOW })).toThrow(/owner-private/);
    expect(fs.statSync(f.root).mode & 0o777).toBe(0o755);
    expect(snapshot(f.source)).toEqual(before); expect(f.store.status()).toEqual([]);
  } finally { fs.chmodSync(f.root, 0o700); }
});

it('an invalid archive aborts the default opener before graph table retirement', () => {
  const f = fixture(); f.seed(2); const before = snapshot(f.source);
  const backups = path.join(f.root, 'backups'); fs.mkdirSync(backups, { mode: 0o700 });
  const file = path.join(backups, 'agent-messages-expired.db');
  fs.closeSync(fs.openSync(file, 'wx', 0o600));
  const invalid = new MemeshDatabase(file); invalid.exec('CREATE TABLE unrelated(value TEXT)'); invalid.close();
  const bytes = fs.readFileSync(file);
  vi.stubEnv('MEMESH_DB_PATH', f.file); vi.stubEnv('MEMESH_DIR', f.root);
  expect(() => new ConversationMessages({ clock: () => NOW })).toThrow(/Invalid legacy archive/);
  expect(snapshot(f.source)).toEqual(before); expect(f.store.status()).toEqual([]);
  expect(fs.readFileSync(file)).toEqual(bytes);
});

it('fresh memory schemas never recreate retired message tables', () => {
  const db = new MemeshDatabase(':memory:');
  try {
    createSchema(db); migrateEntitiesSchema(db);
    const names = Object.keys(snapshot(db));
    expect(LEGACY_CONVERSATION_TABLES.filter(name => names.includes(name))).toEqual([]);
    expect(names).toEqual(expect.arrayContaining(['entities', 'agent_session_aliases', 'agent_session_launchers', 'agent_network_config']));
  } finally { db.close(); }
});
