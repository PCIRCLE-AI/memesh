import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationMessages, MESSAGE_MAX_BYTES, renderConversationMessage, type ConversationNetworkSnapshot } from '../../src/core/conversation-messages.js';
import { DatabaseSync } from '../../src/storage/sqlite.js';

const roots: string[] = [];
const stores: ConversationMessages[] = [];
const DAY = 86_400_000;
function fixture(network?: ConversationNetworkSnapshot) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-conversation-messages-'));
  roots.push(root);
  let now = Date.parse('2026-11-13T00:00:00.000Z');
  const options = { file: path.join(root, 'messages.db'), machine: 'MAC', clock: () => now, network,
    processAlive: (pid: number) => pid === 101 };
  const open = () => {
    const store = new ConversationMessages(options);
    stores.push(store);
    return store;
  };
  const store = open();
  store.register({ id: 'A', host: 'claude-code', machine: 'mac', pid: 101, wake: { socket: '/tmp/a.sock' } });
  store.register({ id: 'B', host: 'codex', machine: 'Mac', pid: 102, wake: { thread: 'B' } });
  store.register({ id: 'C', host: 'hermes', machine: 'MAC', pid: 103, wake: {} });
  return { root, store, open, advance: (days: number) => { now += days * DAY; } };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Windows message-store ACL subprocess contract', () => {
  function windowsOpen(file: string): ConversationMessages {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try { return new ConversationMessages({ file }); }
    finally { Object.defineProperty(process, 'platform', platform); }
  }

  function storePath(): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-message-acl-')));
    roots.push(root);
    return path.join(root, 'messages.db');
  }

  it('checks the directory and database with one subprocess per ordinary open, including a reopen', () => {
    const file = storePath();
    const root = path.dirname(file);
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    const exec = vi.spyOn(childProcess, 'execFileSync').mockReturnValue('{"ok":true,"requiresRealpath":false}');
    windowsOpen(file).close();
    windowsOpen(file).close();
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls.map(([, , options]) =>
      JSON.parse(Buffer.from(String((options as { input: string }).input).trim(), 'base64').toString('utf8'))))
      .toEqual(Array.from({ length: 2 }, () => ({
        paths: [root], writableDirectory: root, readOnly: false, messageDatabaseName: 'messages.db',
      })));
    const script = Buffer.from((exec.mock.calls[0][1] as string[])[4], 'base64').toString('utf16le');
    const probe = script.indexOf('$stream.WriteByte(0)');
    const findFiles = script.indexOf("foreach ($suffix in @('', '-wal', '-shm'))");
    const protectFiles = script.indexOf('foreach ($file in $files) { Protect-Path $file }');
    expect(probe).toBeGreaterThan(script.indexOf('foreach ($file in $request.paths) {'));
    expect(findFiles).toBeGreaterThan(probe);
    expect(protectFiles).toBeGreaterThan(findFiles);
  });

  it.each(['{"ok":false}', '{"ok":true}'])('fails before opening SQLite on an unverified Windows result %s', result => {
    const file = storePath();
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    const exec = vi.spyOn(childProcess, 'execFileSync').mockReturnValue(result);
    expect(() => windowsOpen(file)).toThrow(/Cannot verify private Windows permissions/);
    expect(fs.readdirSync(path.dirname(file))).toEqual([]);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform === 'win32')('preserves same-directory realpath fallback and refuses an escaping database link before changing its ACL', () => {
    const db = storePath();
    const linked = path.join(path.dirname(db), 'linked.db');
    const external = storePath();
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    const exec = vi.spyOn(childProcess, 'execFileSync')
      .mockReturnValueOnce('{"ok":true,"requiresRealpath":false}')
      .mockReturnValueOnce('{"ok":true,"requiresRealpath":true}')
      .mockReturnValueOnce('{"ok":true}')
      .mockReturnValueOnce('{"ok":true,"requiresRealpath":true}');
    windowsOpen(db).close();
    fs.symlinkSync(db, linked);
    windowsOpen(linked).close();
    expect(exec).toHaveBeenCalledTimes(3);
    const filesFrame = String((exec.mock.calls[2][2] as { input: string }).input);
    expect(JSON.parse(Buffer.from(filesFrame.trim(), 'base64').toString('utf8'))).toEqual({ paths: [db], readOnly: false });
    fs.writeFileSync(external, 'keep external file unchanged');
    fs.unlinkSync(linked);
    fs.symlinkSync(external, linked);
    expect(() => windowsOpen(linked)).toThrow('Message files must remain in their owner-private directory.');
    expect(exec).toHaveBeenCalledTimes(4);
    expect(fs.readFileSync(external, 'utf8')).toBe('keep external file unchanged');
  });
});

describe('conversation message store', () => {
  it('resolves only the current live recipient and records pushes only for the original sender', () => {
    const { store } = fixture();
    const id = store.send('A', { recipient: 'B', kind: 'task', body: 'keep queued until read' }).message.id;
    expect(store.wakeTarget(id)).toBeUndefined();
    store.register({ id: 'B', host: 'codex', machine: 'mac', pid: 101, wake: { thread: 'B' } });
    expect(store.wakeTarget(id)).toMatchObject({ id: 'B', pid: 101, wake: { thread: 'B' } });
    expect(() => store.recordPush('C', id, 'codex-queue')).toThrow('Wrong push actor');
    store.recordPush('A', id, 'codex-queue');
    store.recordPush('A', id, 'codex-queue');
    expect(store.status('A', id)[0].events.map(event => event.event)).toEqual(['queued', 'pushed']);
    expect(JSON.parse(store.status('A', id)[0].events[1].detail)).toEqual({ actor: 'A', route: 'codex-queue' });
    expect(store.hookBatch('B').ids).toEqual([id]);
    store.register({ id: 'B', host: 'claude-code', machine: 'mac', pid: 101, wake: { socket: '/tmp/foreign.sock' } });
    expect(store.wakeTarget(id)).toBeUndefined();
  });
  it('excludes already surfaced IDs before the whole-envelope byte budget without changing queued state', () => {
    const { store } = fixture();
    const excluded: string[] = [];
    for (let i = 0; i < 500; i++) excluded.push(store.send('A', { recipient: 'B', kind: 'task', body: `old ${i}` }).message.id);
    const fresh = store.send('A', { recipient: 'B', kind: 'task', body: 'FRESH_AFTER_500' }).message.id;
    expect(store.hookBatch('B').ids).not.toContain(fresh);
    const batch = store.hookBatch('B', excluded);
    expect(batch.ids).toEqual([fresh]); expect(batch.text).toContain('FRESH_AFTER_500');
    expect(Buffer.byteLength(batch.text)).toBeLessThanOrEqual(MESSAGE_MAX_BYTES);
    expect(store.status().filter(row => row.state === 'queued')).toHaveLength(501);
  });
  it('has exactly three tables, owner-private files and no memory graph', () => {
    const { root } = fixture();
    const db = new DatabaseSync(path.join(root, 'messages.db'), { readOnly: true });
    try {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name))
        .toEqual(['conversations', 'events', 'messages']);
    } finally { db.close(); }
    if (process.platform !== 'win32') {
      expect(fs.statSync(root).mode & 0o077).toBe(0);
      for (const file of fs.readdirSync(root)) expect(fs.statSync(path.join(root, file)).mode & 0o077).toBe(0);
    }
    expect(fs.existsSync(path.join(root, 'knowledge-graph.db'))).toBe(false);
  });

  it('discovers registered online and offline conversations without project fields', () => {
    const { store } = fixture();
    expect(store.discover().map(row => [row.id, row.online, row.machine])).toEqual([
      ['A', true, 'mac'], ['B', false, 'mac'], ['C', false, 'mac'],
    ]);
    expect(store.discover().every(row => !('project' in row))).toBe(true);
    expect(() => store.register({ id: 'bad/id', host: 'codex', machine: 'mac', pid: 1, wake: {} })).toThrow();
  });

  it('queues for an offline registered recipient and reads/replies at the exact conversation', () => {
    const { store } = fixture();
    const sent = store.send('A', { recipient: 'B@MAC', kind: 'question', body: 'START\nMID\nEND' });
    expect(sent.accepted).toBe(true);
    expect(store.status('A', sent.message.id)[0].state).toBe('queued');
    expect(() => store.read('C', sent.message.id)).toThrow('not addressed');
    expect(store.status('C', sent.message.id)).toEqual([]);
    expect(store.read('B', sent.message.id).body).toBe('START\nMID\nEND');
    store.read('B', sent.message.id);
    const reply = store.send('B', { recipient: 'A', kind: 'result', body: 'REPLY', reply_to: sent.message.id });
    expect(store.read('A', reply.message.id).body).toBe('REPLY');
    const status = store.status('A', sent.message.id)[0];
    expect(status.state).toBe('replied');
    expect(status.body).toBe(sent.message.body);
    expect(status.events.map(event => event.event)).toEqual(['queued', 'delivered', 'read', 'replied']);
    expect(status.events.every(event => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(event.at))).toBe(true);
  });

  it('accepts a reply after its original expired without recreating original events', () => {
    const { store, root, advance } = fixture();
    const original = store.send('A', { recipient: 'B', kind: 'question', body: 'old question' }).message.id;
    advance(14);
    store.maintainMessages();
    expect(store.status(undefined, original)).toEqual([]);
    const reply = store.send('B', { recipient: 'A', kind: 'result', body: 'late answer', reply_to: original });
    expect(reply.accepted).toBe(true);
    expect(store.read('A', reply.message.id)).toMatchObject({ body: 'late answer', reply_to: original });
    const db = new DatabaseSync(path.join(root, 'messages.db'), { readOnly: true });
    try {
      expect(db.prepare('SELECT * FROM events WHERE message_id=?').all(original)).toEqual([]);
      expect(db.prepare('SELECT * FROM messages WHERE id=?').all(original)).toEqual([]);
    } finally { db.close(); }
    expect(() => store.send('B', { recipient: 'missing', kind: 'result', body: 'still unknown', reply_to: original }))
      .toThrow('unknown_recipient');
    expect(() => store.send('unknown', { recipient: 'A', kind: 'result', body: 'still unregistered', reply_to: original }))
      .toThrow();
  });

  it('rejects spoofed replies without acknowledging or creating a message', () => {
    const { store } = fixture();
    const { message } = store.send('A', { recipient: 'B', kind: 'task', body: 'task' });
    expect(() => store.send('C', { recipient: 'A', kind: 'result', body: 'spoof', reply_to: message.id })).toThrow('Reply must');
    expect(() => store.send('B', { recipient: 'C', kind: 'result', body: 'wrong target', reply_to: message.id })).toThrow('Reply must');
    expect(store.status()).toHaveLength(1);
    expect(store.status('A')[0].state).toBe('queued');
  });

  it('rejects unknown machines and unregistered addresses without writing either table', () => {
    const self = { id: 'a'.repeat(64), name: 'mac' };
    const { store, root } = fixture({
      network_id: '1'.repeat(32), self, members: [self, { id: 'b'.repeat(64), name: 'dgx' }],
    });
    const send = (recipient: string) => () => store.send('A', { recipient, kind: 'task', body: 'rejected body' });
    expect(send('A@typo')).toThrow(/"error":"unknown_recipient".*"machines":\["mac","dgx"\].*message discover/);
    expect(send('missing@dgx')).toThrow(/"error":"unknown_recipient".*"recipients":\["A","B","C"\].*message discover/);
    expect(send('kt/claude-code@dgx')).toThrow(/"error":"unknown_recipient".*message discover/);
    const db = new DatabaseSync(path.join(root, 'messages.db'), { readOnly: true });
    try {
      expect(db.prepare('SELECT * FROM messages').all()).toEqual([]);
      expect(db.prepare('SELECT * FROM events').all()).toEqual([]);
    } finally { db.close(); }
  });

  it('records oversized failures durably without the body', () => {
    const { store, open } = fixture();
    const long = store.send('A', { recipient: 'B', kind: 'review_request', body: '密'.repeat(8_000) });
    expect(long).toMatchObject({ accepted: false, reason: 'message_too_large' });
    expect(long.message.body).toBeNull();
    expect(long.message.body_bytes).toBe(24_000);
    expect(store.hookBatch('B')).toEqual({ text: '', ids: [] });
    const rows = open().status('A');
    expect(rows.map(row => row.state)).toEqual(['rejected']);
    expect(rows[0].body).toBeNull();
    expect(rows[0].events[0].detail).toContain('message_too_large');
  });

  it('rejects malformed addresses and unbounded reply headers before persisting', () => {
    const { store } = fixture();
    expect(() => store.send('A', { recipient: 'B', kind: 'task', body: 'small', reply_to: 'x'.repeat(100_000) }))
      .toThrow('Invalid reply_to');
    expect(() => store.send('A', { recipient: 'B@', kind: 'task', body: 'small' })).toThrow('Invalid recipient');
    expect(store.status()).toEqual([]);
  });

  it('bounds complete rendered envelopes, including UTF8/JSON escaping and headers', () => {
    const { store } = fixture();
    const accepted = store.send('A', { recipient: 'B', kind: 'task', body: '字'.repeat(2_000) });
    expect(accepted.accepted).toBe(true);
    expect(Buffer.byteLength(renderConversationMessage(accepted.message))).toBeLessThanOrEqual(MESSAGE_MAX_BYTES);
    const escaped = store.send('A', { recipient: 'B', kind: 'task', body: '\n'.repeat(4_000) });
    expect(escaped).toMatchObject({ accepted: false, reason: 'message_too_large' });
    const second = store.send('A', { recipient: 'B', kind: 'result', body: '字'.repeat(1_000) });
    const batch = store.hookBatch('B');
    expect(batch.ids).toEqual([accepted.message.id]);
    expect(Buffer.byteLength(batch.text)).toBeLessThanOrEqual(MESSAGE_MAX_BYTES);
    expect(batch.text).toContain(JSON.stringify(accepted.message));
    expect(store.status('A', accepted.message.id)[0].state).toBe('queued');
    store.recordHookDelivery('B', batch.ids, 'UserPromptSubmit');
    expect(store.hookBatch('B').ids).toEqual([second.message.id]);
  });

  it('does not acknowledge anything when a delivery batch includes another recipient', () => {
    const { store } = fixture();
    const b = store.send('A', { recipient: 'B', kind: 'task', body: 'B' }).message;
    const c = store.send('A', { recipient: 'C', kind: 'task', body: 'C' }).message;
    expect(() => store.recordHookDelivery('B', [b.id, c.id], 'Stop')).toThrow('Wrong recipient');
    expect(store.status('A').map(row => row.state)).toEqual(['queued', 'queued']);
  });

  it('notifies once after a day, keeps the original deliverable and expires by original send time', () => {
    const { store, advance, open, root } = fixture();
    const original = store.send('A', { recipient: 'B', kind: 'task', body: 'pending' }).message;
    advance(1.1);
    let next = open();
    expect(next.status()).toHaveLength(2);
    expect(next.status('A', original.id)[0].events.map(event => event.event)).toEqual(['queued', 'undelivered_notified']);
    expect(next.hookBatch('B').ids).toEqual([original.id]);
    next = open();
    expect(next.status()).toHaveLength(2);
    advance(13);
    next = open();
    expect(next.status(undefined, original.id)).toEqual([]);
    const db = new DatabaseSync(path.join(root, 'messages.db'), { readOnly: true });
    try { expect(db.prepare('SELECT COUNT(*) AS count FROM events WHERE message_id = ?').get(original.id)?.count).toBe(0); }
    finally { db.close(); }
    expect(next.status()).toHaveLength(1); // notification has its own, later send time
    advance(2);
    expect(open().status()).toEqual([]); // never create notifications about notifications
  });

  it('does not notify for rejected or already-delivered messages', () => {
    const { store, advance, open } = fixture();
    const oversized = store.send('A', { recipient: 'B', kind: 'task', body: 'x'.repeat(MESSAGE_MAX_BYTES) });
    expect(oversized).toMatchObject({ accepted: false, reason: 'message_too_large' });
    const delivered = store.send('A', { recipient: 'B', kind: 'question', body: 'read' });
    store.read('B', delivered.message.id);
    advance(2);
    expect(open().status()).toHaveLength(2);
  });

  it('accepts the 31st message with a warning instead of refusing it', () => {
    const { store } = fixture();
    for (let i = 0; i < 30; i++) expect(store.send('A', { recipient: 'B', kind: 'task', body: String(i) }).accepted).toBe(true);
    expect(store.send('A', { recipient: 'B', kind: 'task', body: '31' })).toMatchObject({ accepted: true, warning: '31 messages await delivery' });
  });

  it('preserves identity snapshots after registration changes and rejects unregistered callers', () => {
    const { store } = fixture();
    store.send('A', { recipient: 'B', kind: 'task', body: 'original' });
    store.register({ id: 'B', host: 'hermes', machine: 'mac', pid: 101, wake: {} });
    expect(store.status('A')[0].recipient_host).toBe('codex');
    expect(() => store.send('unknown', { recipient: 'B', kind: 'task', body: 'spoof' })).toThrow('not registered');
    expect(() => store.status('unknown')).toThrow('not registered');
  });
});
