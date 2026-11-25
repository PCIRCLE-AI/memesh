import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { ConversationMessages } from '../../src/core/conversation-messages.js';
import { installLegacyMessageSchema, seedLegacyMessage, seedLegacyReceipt } from '../helpers/agent-session-fixture.js';
import { LEGACY_CONVERSATION_TABLES } from '../../src/core/conversation-message-migration.js';

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
  const home = path.join(root, 'U'), config = path.join(root, 'B'), data = path.join(root, "C'quoted");
  for (const directory of [home, config, data]) { fs.mkdirSync(directory, { mode: 0o700 }); fs.writeFileSync(path.join(directory, 'sentinel'), 'unchanged'); }
  const graph = path.join(data, 'graph.db');
  vi.stubEnv('HOME', home); vi.stubEnv('MEMESH_DIR', config); vi.stubEnv('MEMESH_DB_PATH', graph);
  const source = () => { const db = new MemeshDatabase(graph); installLegacyMessageSchema(db); handles.push(db); return db; };
  const open = (options: ConstructorParameters<typeof ConversationMessages>[0] = {}) => {
    const store = new ConversationMessages({ clock: () => NOW, machine: 'fixture-machine', ...options }); handles.push(store); return store;
  };
  return { root, home, config, data, graph, source, open };
}
function seed(db: MemeshDatabase, age: number) {
  const sent = seedLegacyMessage(db, { project: 'fixture-project', sender: 'sender', recipient: 'recipient', intended_session: 'recipient-session', idempotency_key: `age-${age}`, content_type: 'text/plain', payload: `complete age ${age} body` });
  db.prepare('UPDATE agent_messages SET created_at=? WHERE message_id=?').run(new Date(NOW - age * 86400000).toISOString().replace('T', ' ').replace('.000Z', ''), sent.message_id);
  return sent.message_id;
}
function snapshot(db: MemeshDatabase) {
  return Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => [name,
    db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(row => JSON.stringify(row)).sort()]));
}

function expectKeptState(db: MemeshDatabase, before: ReturnType<typeof snapshot>) {
  const retired = new Set<string>(LEGACY_CONVERSATION_TABLES);
  const kept = (rows: typeof before) => Object.fromEntries(Object.entries(rows).filter(([name]) => !retired.has(name)).map(([name, values]) => [name,
    name === 'sqlite_sequence' ? values.filter(row => !retired.has(JSON.parse(row).name)) : values]));
  expect(kept(snapshot(db))).toEqual(kept(before));
  for (const name of retired) expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)).toBeUndefined();
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

it('bounds an owned legacy source lock and closes it without changing the borrowed writer timeout', () => {
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
  expectKeptState(db, before);
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

it.skipIf(process.platform === 'win32')('default opening keeps a private cross-directory graph symlink with empty backups and no archives', () => {
  const f = fixture();
  const actualDirectory = path.join(f.root, 'actual'); fs.mkdirSync(actualDirectory, { mode: 0o700 });
  const actualGraph = path.join(actualDirectory, 'graph.db');
  const source = new MemeshDatabase(actualGraph); handles.push(source); installLegacyMessageSchema(source);
  const id = seed(source, 0); fs.chmodSync(actualGraph, 0o600);
  fs.symlinkSync(actualGraph, f.graph);
  const backups = path.join(f.data, 'backups'); fs.mkdirSync(backups, { mode: 0o700 });
  fs.chmodSync(backups, 0o755); // No archive exists: archive-only restrictions must not apply.
  const before = snapshot(source), mode = fs.statSync(actualGraph).mode;
  expect(f.open().status().find(row => row.id === id)?.body).toBe('complete age 0 body');
  expectKeptState(source, before);
  expect(fs.statSync(actualGraph).mode).toBe(mode);
  expect(fs.readlinkSync(f.graph)).toBe(actualGraph);
  expect(fs.readdirSync(path.join(f.data, 'backups'))).toEqual([]);
  expect(fs.existsSync(path.join(f.data, 'messages.db'))).toBe(true);
  expect(fs.existsSync(path.join(actualDirectory, 'messages.db'))).toBe(false);
  fs.chmodSync(backups, 0o700);
  const archivedGraph = path.join(f.root, 'archive-fixture.db');
  const archived = new MemeshDatabase(archivedGraph); handles.push(archived); installLegacyMessageSchema(archived);
  const archivedId = seed(archived, 13);
  seedLegacyReceipt(archived, { project: 'fixture-project', recipient: 'recipient', message_id: archivedId,
    receipt_kind: 'intake', intake_state: 'ingested', actor: 'recipient', caller_session: 'recipient-session', idempotency_key: 'symlink-archive-intake' });
  const archivePath = path.join(backups, 'agent-messages-expired.db');
  fs.closeSync(fs.openSync(archivePath, 'wx', 0o600));
  const archive = new MemeshDatabase(archivePath); handles.push(archive);
  archive.prepare('ATTACH DATABASE ? AS fixture_source').run(archivedGraph);
  try {
    for (const table of ['agent_messages', 'agent_message_deliveries', 'agent_network_outbox', 'agent_message_events',
      'agent_message_idempotency', 'agent_message_receipts', 'agent_retention_facts', 'agent_dispatch_attempts',
      'agent_host_accepts', 'agent_ack_facts', 'agent_workflow_facts']) archive.exec(`CREATE TABLE ${table} AS SELECT * FROM fixture_source.${table}`);
  } finally { archive.exec('DETACH DATABASE fixture_source'); }
  archive.exec('CREATE TABLE archive_log(message_id TEXT PRIMARY KEY, archived_at_ms INTEGER NOT NULL)');
  archive.prepare('INSERT INTO archive_log VALUES (?,?)').run(archivedId, NOW - 2 * 86400000);
  const archiveBefore = snapshot(archive), archiveBytes = fs.readFileSync(archivePath), archiveMode = fs.statSync(archivePath).mode;
  expect(f.open().status().find(row => row.id === archivedId)).toMatchObject({
    body: 'complete age 13 body', sent_at: new Date(NOW - 13 * 86400000).toISOString(),
  });
  expect(snapshot(archive)).toEqual(archiveBefore); expect(fs.readFileSync(archivePath)).toEqual(archiveBytes);
  expect(fs.statSync(archivePath).mode).toBe(archiveMode); expectKeptState(source, before);
  expect(fs.readlinkSync(f.graph)).toBe(actualGraph);
});

it('default custom graph opening imports another project from the historical shared eleven-table archive once', () => {
  const f = fixture(), live = f.source(), control = seed(live, 0);
  fs.chmodSync(f.graph, 0o600);
  const original = new MemeshDatabase(path.join(f.data, 'other.db')); handles.push(original);
  installLegacyMessageSchema(original);
  const sent = seedLegacyMessage(original, { project: 'another-project', sender: 'old-sender', recipient: 'old-recipient',
    idempotency_key: 'archive-only', content_type: 'text/plain', payload: 'complete thirteen-day archived body' });
  const at = new Date(NOW - 13 * 86400000).toISOString();
  original.prepare('UPDATE agent_messages SET created_at=? WHERE message_id=?').run(at, sent.message_id);
  seedLegacyReceipt(original, { project: sent.project, recipient: sent.recipient, message_id: sent.message_id,
    receipt_kind: 'intake', intake_state: 'ingested', actor: sent.recipient, idempotency_key: 'archive-intake' });
  const tables = ['agent_messages', 'agent_message_deliveries', 'agent_network_outbox', 'agent_message_events',
    'agent_message_idempotency', 'agent_message_receipts', 'agent_retention_facts', 'agent_dispatch_attempts',
    'agent_host_accepts', 'agent_ack_facts', 'agent_workflow_facts'];
  const backups = path.join(f.data, 'backups'); fs.mkdirSync(backups, { mode: 0o700 });
  const archivePath = path.join(backups, 'agent-messages-expired-graph.db');
  fs.closeSync(fs.openSync(archivePath, 'wx', 0o600));
  const archive = new MemeshDatabase(archivePath); handles.push(archive);
  archive.prepare('ATTACH DATABASE ? AS fixture_source').run(path.join(f.data, 'other.db'));
  try {
    for (const table of tables) archive.exec(`CREATE TABLE ${table} AS SELECT * FROM fixture_source.${table}`);
  } finally { archive.exec('DETACH DATABASE fixture_source'); }
  archive.exec('CREATE TABLE archive_log(message_id TEXT PRIMARY KEY, archived_at_ms INTEGER NOT NULL)');
  archive.prepare('INSERT INTO archive_log VALUES (?,?)').run(sent.message_id, NOW - 2 * 86400000);
  expect(Object.keys(snapshot(archive)).sort()).toEqual([...tables, 'archive_log'].sort());
  const decoys = path.join(f.config, 'backups'); fs.mkdirSync(decoys, { mode: 0o700 });
  const decoy = path.join(decoys, 'agent-messages-expired.db'); fs.writeFileSync(decoy, 'unrelated DIR archive', { mode: 0o600 });
  const beforeArchive = snapshot(archive), beforeLive = snapshot(live);
  const archiveBytes = fs.readFileSync(archivePath), archiveMode = fs.statSync(archivePath).mode;
  const message = original.prepare('SELECT * FROM agent_messages WHERE message_id=?').get(sent.message_id);
  const first = f.open().status();
  const restored = first.find(row => row.id === sent.message_id);
  expect(restored).toMatchObject({ id: sent.message_id, body: 'complete thirteen-day archived body', sent_at: at, kind: 'legacy' });
  const imported = restored!.events.filter(event => event.event === 'legacy_imported');
  expect(imported).toHaveLength(1);
  const importedSource = JSON.parse(imported[0].detail).source;
  expect(importedSource.message).toEqual(message);
  for (const table of tables.filter(table => table !== 'agent_messages')) {
    expect(importedSource.facts[table].map((row: unknown) => JSON.stringify(row)).sort()).toEqual(
      archive.prepare(`SELECT * FROM ${table}`).all().map(row => JSON.stringify(JSON.parse(JSON.stringify(row)), Object.keys(row).sort())).sort());
  }
  expect(importedSource.facts.agent_session_instances).toEqual([]);
  expect(importedSource.facts.archive_log).toEqual(archive.prepare('SELECT * FROM archive_log').all());
  expect(restored!.sender).toMatch(/^legacy:/);
  expect(first.find(row => row.id === control)?.body).toBe('complete age 0 body');
  expect(first).toHaveLength(2);
  expect(f.open().status()).toEqual(first);
  expectKeptState(live, beforeLive); expect(snapshot(archive)).toEqual(beforeArchive);
  expect(fs.readFileSync(archivePath)).toEqual(archiveBytes); expect(fs.statSync(archivePath).mode).toBe(archiveMode);
  expect(fs.readdirSync(f.home)).toEqual(['sentinel']);
  expect(fs.readdirSync(f.config).sort()).toEqual(['backups', 'sentinel']);
  expect(fs.readFileSync(decoy, 'utf8')).toBe('unrelated DIR archive');
  const expired = f.open({ clock: () => NOW + 2 * 86400000 });
  expect(expired.status(undefined, sent.message_id)).toEqual([]);
  expect(expired['db'].prepare('SELECT COUNT(*) AS n FROM events WHERE message_id=?').get(sent.message_id)?.n).toBe(0);
  expect(f.open({ clock: () => NOW + 2 * 86400000 }).status(undefined, sent.message_id)).toEqual([]);
  expect(snapshot(archive)).toEqual(beforeArchive);
  expect(fs.readFileSync(archivePath)).toEqual(archiveBytes);
});

it.skipIf(process.platform === 'win32').each(['symlink', 'public-mode', 'empty-sidecar'] as const)('refuses unsafe default archive %s without modifying it or creating the target', reason => {
  const f = fixture(), db = f.source(); seed(db, 0);
  fs.chmodSync(f.graph, 0o600);
  const backups = path.join(f.data, 'backups'); fs.mkdirSync(backups, { mode: 0o700 });
  const archive = path.join(backups, 'agent-messages-expired.db');
  fs.writeFileSync(archive, 'untouched fixture', { mode: 0o600 });
  if (reason === 'symlink') {
    fs.renameSync(archive, archive + '.original'); fs.symlinkSync(archive + '.original', archive);
  } else if (reason === 'public-mode') {
    fs.chmodSync(archive, 0o640);
  } else {
    fs.writeFileSync(archive + '-shm', '', { mode: 0o400 });
  }
  const before = fs.readdirSync(backups).map(name => ({ name, mode: fs.lstatSync(path.join(backups, name)).mode, bytes: fs.readFileSync(path.join(backups, name)) }));
  expect(() => f.open()).toThrow();
  expect(fs.existsSync(path.join(f.data, 'messages.db'))).toBe(false);
  expect(fs.readdirSync(backups).map(name => ({ name, mode: fs.lstatSync(path.join(backups, name)).mode, bytes: fs.readFileSync(path.join(backups, name)) }))).toEqual(before);
  // Explicit destinations and borrowed sources must never inspect this ambient archive.
  expect(f.open({ file: path.join(f.root, 'explicit.db') }).status()).toEqual([]);
  expect(f.open({ file: path.join(f.root, 'borrowed.db'), legacySource: db }).status()).toHaveLength(1);
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
