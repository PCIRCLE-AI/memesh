import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { ConversationMessages } from '../../src/core/conversation-messages.js';
import { importLegacyConversationMessages } from '../../src/core/conversation-message-migration.js';

const NOW = Date.parse('2026-11-13T12:00:00.000Z'), DAY = 86_400_000;
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-legacy-migration-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = new MemeshDatabase(path.join(root, 'legacy.db'));
  cleanup.push(() => source.close());
  source.exec(`
    CREATE TABLE agent_messages (message_id TEXT PRIMARY KEY, project TEXT, sender TEXT, sender_host TEXT,
      recipient TEXT, content_type TEXT, correlation_id TEXT, reply_to_message_id TEXT, privacy TEXT,
      payload_json TEXT, payload_sha256 TEXT, payload_original_bytes INTEGER, payload_tombstoned_at TEXT,
      provenance_json TEXT, created_at TEXT);
    CREATE TABLE agent_message_deliveries (delivery_id TEXT PRIMARY KEY, message_id TEXT, project TEXT, recipient TEXT, target_kind TEXT, intended_session TEXT, created_at TEXT);
    CREATE TABLE agent_message_receipts (receipt_id TEXT PRIMARY KEY, message_id TEXT, actor TEXT, receipt_kind TEXT, detail_json TEXT, created_at TEXT);
    CREATE TABLE agent_session_instances (project TEXT, session_instance_id TEXT, principal_id TEXT, adapter_kind TEXT, last_generation INTEGER);
    CREATE TABLE agent_session_connections (connection_id TEXT PRIMARY KEY, project TEXT, session_instance_id TEXT, disconnected_at TEXT);
    CREATE TABLE agent_dispatch_attempts (attempt_id TEXT, delivery_id TEXT, connection_id TEXT, result TEXT);
    CREATE TABLE agent_network_outbox (delivery_id TEXT, message_id TEXT, machine_id TEXT, state TEXT);
  `);
  const file = path.join(root, 'messages.db');
  const open = (migrate = false) => {
    const store = new ConversationMessages({ file, machine: 'test-machine', clock: () => NOW, ...(migrate ? { legacySource: source } : {}) });
    cleanup.push(() => store.close());
    return store;
  };
  const store = open();
  const target = new MemeshDatabase(file);
  cleanup.push(() => target.close());
  const add = (id: string, age = 0, payload = 'body', intended: string | null = null, origin = {}) => {
    const at = new Date(NOW - age * DAY).toISOString();
    source.prepare('INSERT INTO agent_messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, 'project', 'principal-A', 'codex', 'principal-B', 'text/plain', 'correlation', null, 'private', JSON.stringify(payload), null, null, null, JSON.stringify(origin), at);
    source.prepare('INSERT INTO agent_message_deliveries VALUES (?,?,?,?,?,?,?)').run(`d-${id}`, id, 'project', 'principal-B', 'principal', intended, at);
  };
  const migrate = () => importLegacyConversationMessages(source, target, { nowMs: NOW, localMachine: 'test-machine' });
  const rows = () => JSON.stringify((source.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>)
    .map(({ name }) => [name, source.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  return { root, source, target, store, open, add, migrate, rows };
}

it('preserves a verified historical sender session so its one-day notice is actually available', () => {
  const f = fixture();
  f.add('notice-original', 2, 'pending', null, { sender_session: 'A', source_host: 'codex' });
  f.source.prepare('INSERT INTO agent_session_instances VALUES (?,?,?,?,?)').run('project', 'A', 'principal-A', 'codex-cli-queue', 1);
  f.source.prepare('INSERT INTO agent_network_outbox VALUES (?,?,?,?)').run('d-notice-original', 'notice-original', 'remote-machine', 'pending');
  const before = f.rows();
  const store = f.open(true);
  store.register({ id: 'A', host: 'codex', machine: 'test-machine', pid: process.pid, wake: {} });
  const original = store.status()[0];
  expect(original).toMatchObject({ sender: 'A', sender_machine: 'test-machine', kind: 'legacy' });
  expect(store.hookBatch('A').text).toContain('notice-original has not been delivered');
  expect(f.rows()).toBe(before);
  f.source.prepare('DELETE FROM agent_session_instances').run();
  const afterRemoval = f.rows();
  expect(f.migrate()).toEqual({ imported: 0, alreadyImported: 1 });
  expect(store.status().find(row => row.id === 'notice-original')).toMatchObject({ sender: 'A', sender_machine: 'test-machine' });
  expect(f.rows()).toBe(afterRemoval);
});

it.each(['wrong-host', 'inbound', 'missing-session'])('does not invent sender identity for %s evidence', reason => {
  const f = fixture();
  f.add('unknown', 0, 'body', null, { sender_session: 'A', ...(reason === 'inbound' ? { via: 'network', from_machine: 'unverified' } : {}) });
  if (reason !== 'missing-session') f.source.prepare('INSERT INTO agent_session_instances VALUES (?,?,?,?,?)')
    .run('project', 'A', 'principal-A', reason === 'wrong-host' ? 'claude-inbox' : 'codex-cli-queue', 1);
  f.migrate();
  expect(f.store.status()[0].sender).toMatch(/^legacy:/);
  expect(f.store.status()[0].sender_machine).toBe('unknown');
});

it.each([
  ['codex-cli-queue', 'codex-mcp-client', 'codex-mcp-client', 'mcp', true],
  ['codex-cli-queue', 'codex', 'codex-mcp-client', 'mcp', true],
  ['claude-channel', 'claude-code', 'claude-code', 'mcp', true],
  ['claude-inbox', 'claude-code', 'claude-code', 'mcp', true],
  ['codex-cli-queue', 'unknown-codex-client', 'unknown-codex-client', 'mcp', false],
  ['codex-cli-queue', 'codex-mcp-client', 'claude-code', 'mcp', false],
  ['claude-inbox', 'codex-mcp-client', 'codex-mcp-client', 'mcp', false],
  ['codex-cli-queue', 'cli', 'cli', 'cli', true],
  ['claude-inbox', 'cli', 'cli', 'cli', true],
  ['codex-cli-queue', 'cli', 'cli', 'mcp', false],
  ['claude-channel', 'cli', 'codex', 'cli', false],
  ['unknown-adapter', 'cli', 'cli', 'cli', false],
] as const)('decodes historical adapter %s / client %s / source %s / transport %s', (adapter, host, sourceHost, transport, known) => {
  const f = fixture();
  f.add('historical-host', 2, 'complete historical body', null, { sender_session: 'A', source_host: sourceHost, transport });
  f.source.prepare('UPDATE agent_messages SET sender_host=?').run(host);
  f.source.prepare('INSERT INTO agent_session_instances VALUES (?,?,?,?,?)').run('project', 'A', 'principal-A', adapter, 1);
  const before = f.rows();
  const store = f.open(true);
  const original = store.status().find(row => row.id === 'historical-host')!;
  expect(original.body).toBe('complete historical body');
  store.register({ id: 'A', host: adapter === 'codex-cli-queue' ? 'codex' : 'claude-code', machine: 'test-machine', pid: process.pid, wake: {} });
  if (known) {
    expect(original.sender).toBe('A');
    expect(original.sender_machine).toBe('test-machine');
    expect(store.hookBatch('A').text).toContain('historical-host has not been delivered');
  } else {
    expect(original.sender).toMatch(/^legacy:/);
    expect(original.sender_machine).toBe('unknown');
    expect(store.hookBatch('A').ids).toEqual([]);
  }
  expect(f.rows()).toBe(before);
});

it('appends exact audit versions and new handled facts without duplicating the initial import', () => {
  const f = fixture();
  f.add('audit', 0, 'body', 'B', { sender_session: 'A' });
  f.source.prepare('INSERT INTO agent_session_instances VALUES (?,?,?,?,?)').run('project', 'A', 'principal-A', 'codex-cli-queue', 1);
  f.source.prepare('INSERT INTO agent_session_connections VALUES (?,?,?,?)').run('c', 'project', 'A', null);
  f.source.prepare('INSERT INTO agent_dispatch_attempts VALUES (?,?,?,?)').run('attempt', 'd-audit', 'c', 'started');
  expect(f.migrate()).toEqual({ imported: 1, alreadyImported: 0 });
  const oldEvents = f.store.status()[0].events;
  f.source.prepare('UPDATE agent_session_instances SET last_generation=2').run();
  f.source.prepare('UPDATE agent_session_connections SET disconnected_at=?').run(new Date(NOW).toISOString());
  f.source.prepare('INSERT INTO agent_message_receipts VALUES (?,?,?,?,?,?)').run('receipt', 'audit', 'B', 'intake', '{"intake_state":"ingested"}', new Date(NOW).toISOString());
  expect(f.migrate()).toEqual({ imported: 0, alreadyImported: 1 });
  const result = f.store.status()[0];
  expect(result.state).toBe('legacy_handled');
  expect(result.events.slice(0, oldEvents.length)).toEqual(oldEvents);
  expect(result.events.filter(e => e.event === 'legacy_imported')).toHaveLength(1);
  const versions = result.events.filter(e => e.event === 'legacy_fact').map(e => JSON.parse(e.detail))
    .filter(v => v.table === 'agent_session_instances').map(v => v.row.last_generation);
  expect(versions).toEqual([1, 2]);
  expect(JSON.parse(result.events.find(e => e.event === 'legacy_handled')!.detail).row.detail_json).toBe('{"intake_state":"ingested"}');
  f.migrate();
  expect(f.store.status()[0].events).toEqual(result.events);
});

it('imports every under-14-day row including handled JSON while preserving source and rejecting legacy registration', () => {
  const f = fixture();
  f.add('recent', 13); f.add('expired', 14); f.add('handled', 3);
  f.source.prepare('UPDATE agent_messages SET content_type=?,payload_json=? WHERE message_id=?').run('application/json', '{"z":1,"nested":[true]}', 'handled');
  f.source.prepare('INSERT INTO agent_message_receipts VALUES (?,?,?,?,?,?)').run('r', 'handled', 'B', 'ack', '{}', new Date(NOW).toISOString());
  const before = f.rows();
  expect(f.migrate()).toEqual({ imported: 2, alreadyImported: 0 });
  const messages = f.store.status();
  expect(messages.map(m => m.id).sort()).toEqual(['handled', 'recent']);
  expect(messages.find(m => m.id === 'handled')).toMatchObject({ body: '{"z":1,"nested":[true]}', state: 'legacy_handled' });
  expect(f.rows()).toBe(before);
  expect(() => f.store.register({ id: messages[0].recipient, host: 'codex', machine: 'test-machine', pid: process.pid, wake: {} })).toThrow('Legacy audit');
});

it('keeps oversized legacy bodies without blocking a later small message', () => {
  const f = fixture();
  f.add('big', 0.2, 'x'.repeat(9000), 'B'); f.add('small', 0, 'small complete body', 'B');
  f.migrate();
  f.store.register({ id: 'B', host: 'codex', machine: 'test-machine', pid: process.pid, wake: {} });
  expect(f.store.status().find(m => m.id === 'big')!.body).toHaveLength(9000);
  expect(f.store.hookBatch('B').ids).toEqual(['small']);
});

it.each(['payload', 'target', 'timestamp'])('rolls back the whole target batch on changed %s and leaves source intact', reason => {
  const f = fixture();
  f.add('z-existing', 0, 'original', 'B'); f.migrate();
  f.add('a-new');
  if (reason === 'payload') f.source.prepare('UPDATE agent_messages SET payload_json=? WHERE message_id=?').run('"changed"', 'z-existing');
  if (reason === 'target') f.source.prepare('UPDATE agent_message_deliveries SET intended_session=? WHERE message_id=?').run('C', 'z-existing');
  if (reason === 'timestamp') f.source.prepare('UPDATE agent_messages SET created_at=? WHERE message_id=?').run('invalid-time', 'z-existing');
  const before = f.rows(), target = f.store.status();
  expect(() => f.migrate()).toThrow();
  expect(f.store.status()).toEqual(target);
  expect(f.rows()).toBe(before);
});

it('refuses two handles pointing at the same inode', () => {
  const f = fixture();
  const alias = new MemeshDatabase(path.join(f.root, 'legacy.db'));
  try { expect(() => importLegacyConversationMessages(f.source, alias, { nowMs: NOW, localMachine: 'test-machine' })).toThrow('different files'); }
  finally { alias.close(); }
});

it.each(['same-path', 'hardlink', 'symlink'])('constructor refuses %s before changing source schema, data, journal or modes', kind => {
  const f = fixture();
  f.add('untouched');
  const sourceFile = path.join(f.root, 'legacy.db');
  const file = kind === 'same-path' ? sourceFile : path.join(f.root, 'alias.db');
  if (kind === 'hardlink') fs.linkSync(sourceFile, file);
  if (kind === 'symlink') fs.symlinkSync(sourceFile, file);
  // Deliberately retain a mode which destination privacy handling would change.
  fs.chmodSync(sourceFile, 0o640);
  f.source.exec('PRAGMA journal_mode=DELETE');
  const snapshot = () => ({
    schema: f.source.prepare('SELECT * FROM sqlite_master ORDER BY name').all(),
    data: f.rows(), journal: f.source.prepare('PRAGMA journal_mode').get(),
    mode: fs.statSync(sourceFile).mode & 0o777,
    directoryMode: fs.statSync(f.root).mode & 0o777,
    files: fs.readdirSync(f.root).sort(), bytes: fs.readFileSync(sourceFile),
  });
  const before = snapshot();
  expect(() => new ConversationMessages({ file, legacySource: f.source, machine: 'test-machine', clock: () => NOW })).toThrow('different files');
  expect(snapshot()).toEqual(before);
});

it('keeps the initial mapping immutable when sender identity appears, changes, or disappears later', () => {
  const f = fixture();
  f.add('late-identity', 0, 'body', 'B', { sender_session: 'A', source_host: 'codex' });
  f.migrate();
  const original = f.store.status()[0];
  expect(original.sender).toMatch(/^legacy:/);
  f.source.prepare('INSERT INTO agent_session_instances VALUES (?,?,?,?,?)').run('project', 'A', 'principal-A', 'codex-cli-queue', 1);
  let before = f.rows();
  expect(f.migrate()).toEqual({ imported: 0, alreadyImported: 1 });
  expect(f.rows()).toBe(before);
  expect(f.store.status()[0].sender).toBe(original.sender);
  expect(f.store.status()[0].events.some(e => e.event === 'legacy_fact' && JSON.parse(e.detail).table === 'agent_session_instances')).toBe(true);
  f.source.prepare('UPDATE agent_session_instances SET adapter_kind=?').run('claude-inbox');
  before = f.rows(); f.migrate(); expect(f.rows()).toBe(before);
  f.source.prepare('DELETE FROM agent_session_instances').run();
  before = f.rows(); f.migrate(); expect(f.rows()).toBe(before);
  expect(f.store.status()[0].sender).toBe(original.sender);
});

it('rolls back a real target write failure and retries without changing any source table', () => {
  const f = fixture();
  f.add('a-first'); f.add('z-second');
  f.source.prepare('INSERT INTO agent_message_receipts VALUES (?,?,?,?,?,?)').run('receipt', 'a-first', 'B', 'ack', '{"kept":true}', new Date(NOW).toISOString());
  const before = f.rows();
  f.target.exec("CREATE TRIGGER fail_second BEFORE INSERT ON messages WHEN NEW.id='z-second' BEGIN SELECT RAISE(ABORT, 'synthetic migration interruption'); END");
  expect(() => f.migrate()).toThrow('synthetic migration interruption');
  expect(f.store.status()).toEqual([]);
  expect(f.target.prepare('SELECT count(*) AS n FROM events').get()).toMatchObject({ n: 0 });
  expect(f.rows()).toBe(before);
  f.target.exec('DROP TRIGGER fail_second');
  expect(f.migrate()).toEqual({ imported: 2, alreadyImported: 0 });
  expect(f.rows()).toBe(before);
  expect(f.store.status()).toHaveLength(2);
});
