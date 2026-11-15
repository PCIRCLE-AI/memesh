import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationMessages, renderConversationMessage, type ConversationNetworkSnapshot, type NetworkConversationMessage } from '../../src/core/conversation-messages.js';
import { MemeshDatabase } from '../../src/storage/sqlite.js';

const roots: string[] = [];
const opened: ConversationMessages[] = [];
afterEach(() => { opened.splice(0).forEach(s => s.close()); roots.splice(0).forEach(r => fs.rmSync(r, { recursive: true, force: true })); });
const ids = { a: 'a'.repeat(64), b: 'b'.repeat(64), c: 'c'.repeat(64) };
const networkId = '1'.repeat(32);
const day = 86_400_000;
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-network-')); roots.push(root);
  let now = Date.parse('2026-11-15T00:00:00.000Z');
  const offsets = { a: 0, b: 0, c: 0 };
  const members = [{ id: ids.a, name: 'mac' }, { id: ids.b, name: 'dgx' }, { id: ids.c, name: 'third' }];
  const open = (key: keyof typeof ids, network: ConversationNetworkSnapshot | null = { network_id: networkId, self: members.find(m => m.id === ids[key])!, members }) => {
    const s = new ConversationMessages({ file: path.join(root, key, 'messages.db'), machine: 'local-hostname', ...(network ? { network } : {}),
      clock: () => now + offsets[key], processAlive: pid => { if (pid === 0) throw new Error('remote PID checked'); return pid === 101; } });
    opened.push(s); return s;
  };
  const a = open('a'), b = open('b'), c = open('c');
  for (const s of [a, b, c]) s.register({ id: 'same-id', host: 'codex', machine: s.machine, pid: 101, wake: { thread: 'same-id' } });
  b.register({ id: 'offline', host: 'claude-code', machine: b.machine, pid: 102, wake: { socket: '/private/synthetic-only' } });
  const exchange = (left: ConversationMessages, leftId: string, right: ConversationMessages, rightId: string) => {
    left.replaceRemoteRegistrations(rightId, right.exportRegistrations()); right.replaceRemoteRegistrations(leftId, left.exportRegistrations());
  };
  exchange(a, ids.a, b, ids.b); exchange(a, ids.a, c, ids.c); exchange(b, ids.b, c, ids.c);
  const wire = () => {
    const result = a.send('same-id', { recipient: 'same-id@DGX', kind: 'question', body: 'HEAD🙂\nMIDDLE\nTAIL' });
    expect(result.accepted).toBe(true);
    return a.outgoingFor(ids.b).find(w => w.message.id === result.message.id)!;
  };
  const shut = (s: ConversationMessages) => { s.close(); opened.splice(opened.indexOf(s), 1); };
  return { root, a, b, c, wire, open, shut, members, exchange, offsets, advance: (days: number) => { now += days * day; } };
}

describe('messages.db authenticated cross-machine copy and receipts', () => {
  it('warns on the 31st exact-recipient queued message despite copy ACKs, and counts down only on real receipts', () => {
    const f = fixture();
    const copied: string[] = [];
    for (let i = 1; i <= 31; i++) {
      const sent = f.a.send('same-id', { recipient: 'same-id@dgx', kind: 'task', body: `queued ${i}` });
      expect(sent.warning).toBe(i === 31 ? '31 messages await delivery' : undefined);
      const wire = f.a.outgoingFor(ids.b).find(w => w.message.id === sent.message.id)!;
      f.b.receiveFrom(ids.a, wire); f.a.recordCopyAccepted(ids.b, sent.message.id); copied.push(sent.message.id);
    }
    expect(f.a.outgoingFor(ids.b)).toEqual([]);
    expect(f.a.status().filter(m => m.state === 'queued')).toHaveLength(31);
    for (const id of copied.slice(0, 2)) f.b.read('same-id', id);
    for (const receipt of f.b.receiptsFor(ids.a)) {
      f.a.receiveReceipt(ids.b, receipt); f.b.recordReceiptAccepted(ids.a, receipt);
    }
    expect(f.a.send('same-id', { recipient: 'same-id@dgx', kind: 'task', body: 'back to 30' }).warning).toBeUndefined();
    expect(f.a.send('same-id', { recipient: 'same-id@dgx', kind: 'task', body: 'back to 31' }).warning).toBe('31 messages await delivery');
  });

  it('does not aggregate different conversations on the same peer toward the pending warning', () => {
    const f = fixture();
    for (const recipient of ['same-id', 'offline']) {
      for (let i = 0; i < 30; i++) {
        const sent = f.a.send('same-id', { recipient: `${recipient}@dgx`, kind: 'question', body: `${recipient} ${i}` });
        expect(sent.accepted).toBe(true); expect(sent.warning).toBeUndefined();
      }
    }
    expect(f.a.outgoingFor(ids.b)).toHaveLength(60);
    expect(f.a.send('same-id', { recipient: 'offline@dgx', kind: 'question', body: '31 offline' }).warning).toBe('31 messages await delivery');
  });

  it.each([-1000, 1000])('accepts bounded peer clock skew %s ms, not extreme future timestamps', (offset) => {
    const f = fixture(); f.offsets.b = offset;
    const w = f.wire();
    expect(() => f.b.receiveFrom(ids.a, { ...w, message: { ...w.message, sent_at: '2026-11-15T01:00:00.000Z' } })).toThrow();
    f.b.receiveFrom(ids.a, w); f.b.read('same-id', w.message.id);
    const receipts = f.b.receiptsFor(ids.a);
    expect(() => f.a.receiveReceipt(ids.b, { ...receipts[0], at: '2026-11-15T01:00:00.000Z' })).toThrow();
    for (const receipt of receipts) expect(f.a.receiveReceipt(ids.b, receipt)).toBe('accepted');
    expect(f.a.status('same-id', w.message.id)[0].state).toBe('read');
    expect(f.a.status('same-id', w.message.id)[0].events.filter(e => ['delivered', 'read'].includes(e.event)).map(e => e.at)).toEqual(receipts.map(r => r.at));
  });
  it('copies, acknowledges only queued, delivers by read, returns actual receipts and reply, idempotently', () => {
    const f = fixture(), w = f.wire();
    expect(f.b.receiveFrom(ids.a, w)).toBe('accepted');
    expect(f.b.receiveFrom(ids.a, w)).toBe('duplicate');
    f.a.recordCopyAccepted(ids.b, w.message.id);
    f.a.recordCopyAccepted(ids.b, w.message.id);
    expect(f.a.outgoingFor(ids.b)).toEqual([]);
    expect(f.a.status('same-id', w.message.id)[0].state).toBe('queued');
    expect(f.b.receiptsFor(ids.a)).toEqual([]);
    expect(f.b.hookBatch('same-id').text).toContain('HEAD🙂');
    expect(f.b.read('same-id', w.message.id).body).toBe(w.message.body);
    const receipts = f.b.receiptsFor(ids.a);
    expect(receipts.map(r => r.event)).toEqual(['delivered', 'read']);
    for (const receipt of receipts) {
      expect(f.a.receiveReceipt(ids.b, receipt)).toBe('accepted');
      expect(f.a.receiveReceipt(ids.b, receipt)).toBe('duplicate');
      f.b.recordReceiptAccepted(ids.a, receipt); f.b.recordReceiptAccepted(ids.a, receipt);
      expect(() => f.b.recordReceiptAccepted(ids.c, receipt)).toThrow('binding');
    }
    expect(f.b.receiptsFor(ids.a)).toEqual([]);
    expect(f.a.status('same-id', w.message.id)[0].state).toBe('read');
    const reply = f.b.send('same-id', { recipient: 'same-id@mac', kind: 'result', body: 'exact reply', reply_to: w.message.id });
    expect(reply.accepted).toBe(true);
    const answer = f.b.outgoingFor(ids.a)[0];
    expect(f.a.receiveFrom(ids.b, answer)).toBe('accepted');
    expect(f.a.status('same-id', w.message.id)[0].state).toBe('replied');
    expect(f.a.read('same-id', answer.message.id).body).toBe('exact reply');
    expect(Object.keys(f.a.read('same-id', answer.message.id))).toHaveLength(12);
    expect(renderConversationMessage(f.a.status(undefined, answer.message.id)[0])).not.toContain('sender_local');
  });

  it('keeps same-ID local/remote registrations distinct, never probes remote PIDs, preserves offline', () => {
    const f = fixture();
    expect(f.a.discover().filter(r => r.id === 'same-id')).toHaveLength(3);
    expect(f.a.discover().find(r => r.machine === 'dgx' && r.id === 'same-id')).toMatchObject({ pid: 0, wake: {}, online: true });
    const local = f.a.send('same-id', { recipient: 'same-id', kind: 'task', body: 'local' });
    expect(f.a.wakeTarget(local.message.id)?.pid).toBe(101);
    const remote = f.a.send('same-id', { recipient: 'offline@dgx', kind: 'task', body: 'offline survives' });
    expect(remote.accepted).toBe(true); expect(f.a.wakeTarget(remote.message.id)).toBeUndefined();
    expect(f.b.exportRegistrations().find(r => r.id === 'offline')?.online).toBe(false);
    expect(f.b.receiveFrom(ids.a, f.a.outgoingFor(ids.b)[0])).toBe('accepted');
  });

  it('uses authenticated snapshot names, ignores claimed wire names, and detects immutable content collisions', () => {
    const f = fixture(), w = f.wire();
    const forgedNames = { ...w, message: { ...w.message, sender_machine: 'spoof', recipient_machine: 'spoof' } };
    f.b.receiveFrom(ids.a, forgedNames);
    expect(f.b.status(undefined, w.message.id)[0]).toMatchObject({ sender_machine: 'mac', recipient_machine: 'dgx' });
    expect(f.b.receiveFrom(ids.a, w)).toBe('duplicate');
    for (const delta of [{ body: 'evil', body_bytes: 4 }, { recipient: 'offline', recipient_host: 'claude-code' }, { kind: 'task' as const }, { sent_at: '2026-11-14T23:59:59.000Z' }]) {
      expect(() => f.b.receiveFrom(ids.a, { ...w, message: { ...w.message, ...delta } })).toThrow('collision');
    }
    expect(f.b.status(undefined, w.message.id)).toHaveLength(1);
  });

  it('rejects wrong peer, network, receiver, oversize, malformed bytes/time and forged reply without writes', () => {
    const f = fixture(), w = f.wire();
    const bad: NetworkConversationMessage[] = [
      { ...w, network_id: '2'.repeat(32) }, { ...w, sender_machine_id: ids.c }, { ...w, recipient_machine_id: ids.c },
      { ...w, message: { ...w.message, body: 'x'.repeat(8000), body_bytes: 8000 } },
      { ...w, message: { ...w.message, body_bytes: 1 } }, { ...w, message: { ...w.message, sent_at: 'yesterday' } },
      { ...w, message: { ...w.message, recipient: 'absent' } }, { ...w, message: { ...w.message, reply_to: '00000000-0000-0000-0000-000000000001' } },
    ];
    for (const invalid of bad) expect(() => f.b.receiveFrom(ids.a, invalid)).toThrow();
    expect(() => f.b.receiveFrom(ids.c, w)).toThrow();
    expect(f.b.status()).toEqual([]);
    expect(f.a.send('same-id', { recipient: 'missing@dgx', kind: 'task', body: 'rejected audit' })).toMatchObject({ accepted: false, reason: 'unknown_recipient' });
    expect(f.a.send('same-id', { recipient: 'same-id@dgx', kind: 'task', body: 'x'.repeat(8000) })).toMatchObject({ accepted: false, message: { body: null } });
  });

  it('only accepts receipts from original recipient peer and actor, never from sender or a third store', () => {
    const f = fixture(), w = f.wire(); f.b.receiveFrom(ids.a, w); f.b.recordHookDelivery('same-id', [w.message.id], 'UserPromptSubmit');
    const receipt = f.b.receiptsFor(ids.a)[0];
    expect(() => f.a.receiveReceipt(ids.c, receipt)).toThrow();
    expect(() => f.a.receiveReceipt(ids.b, { ...receipt, actor: 'other' })).toThrow();
    expect(() => f.a.receiveReceipt(ids.b, { ...receipt, at: 'unknown' })).toThrow();
    expect(() => f.c.receiveReceipt(ids.b, receipt)).toThrow();
    expect(() => f.b.recordReceiptAccepted(ids.a, { ...receipt, actor: 'other' })).toThrow();
    expect(f.a.status('same-id', w.message.id)[0].state).toBe('queued');
    f.a.receiveReceipt(ids.b, receipt);
    expect(f.a.status('same-id', w.message.id)[0].state).toBe('delivered');
    f.advance(1 / 86_400);
    expect(() => f.a.receiveReceipt(ids.b, { ...receipt, at: '2026-11-15T00:00:01.000Z' })).toThrow('conflict');
  });

  it('does not confuse a remote roster name with the former local hostname or collide with an existing local message', () => {
    const f = fixture();
    f.shut(f.a);
    const members = f.members.map(m => ({ ...m, name: m.id === ids.a ? 'renamed-self' : m.id === ids.b ? 'local-hostname' : m.name }));
    const a = f.open('a', { network_id: networkId, self: members[0], members });
    const local = a.send('same-id', { recipient: 'same-id', kind: 'task', body: 'only local' });
    const remote = a.send('same-id', { recipient: 'same-id@local-hostname', kind: 'task', body: 'only remote' });
    expect(a.wakeTarget(local.message.id)?.pid).toBe(101);
    expect(a.wakeTarget(remote.message.id)).toBeUndefined();
    expect(() => a.read('same-id', remote.message.id)).toThrow('not addressed');
    const incoming = { network_id: networkId, sender_machine_id: ids.b, recipient_machine_id: ids.a,
      message: { ...local.message, sender_machine: 'anything', recipient_machine: 'anything' } };
    expect(() => a.receiveFrom(ids.b, incoming)).toThrow('collision');
    expect(a.status(undefined, local.message.id)[0].body).toBe('only local');
  });

  it('preserves local history and renamed peer duplicate/reply while isolating another network and revoked member', () => {
    const f = fixture(), w = f.wire(); f.b.receiveFrom(ids.a, w);
    const renamed = f.members.map(m => ({ ...m, name: `new-${m.name}` }));
    f.shut(f.a); f.shut(f.b);
    const a = f.open('a', { network_id: networkId, self: renamed[0], members: renamed });
    const b = f.open('b', { network_id: networkId, self: renamed[1], members: renamed });
    expect(b.receiveFrom(ids.a, w)).toBe('duplicate');
    expect(b.read('same-id', w.message.id).recipient_machine).toBe('dgx');
    expect(b.send('same-id', { recipient: 'same-id@mac', kind: 'result', body: 'after rename', reply_to: w.message.id }).accepted).toBe(true);
    expect(a.outgoingFor(ids.b)[0].message.sender_machine).toBe('mac');
    f.shut(a); f.shut(b);
    const other = f.open('a', { network_id: '2'.repeat(32), self: renamed[0], members: renamed });
    expect(other.outgoingFor(ids.b)).toEqual([]); expect(other.discover().filter(r => r.pid === 0)).toEqual([]);
    expect(other.status('same-id', w.message.id)).toHaveLength(1);
    const revoked = f.open('b', { network_id: networkId, self: renamed[1], members: renamed.slice(1) });
    expect(revoked.read('same-id', w.message.id).body).toBe(w.message.body);
    expect(revoked.send('same-id', { recipient: 'same-id@mac', kind: 'result', body: 'refused after revoke', reply_to: w.message.id })).toMatchObject({ accepted: false, reason: 'unknown_recipient' });
    expect(() => revoked.receiveFrom(ids.a, w)).toThrow();
    f.shut(revoked);
    const left = f.open('b', null);
    expect(left.status('same-id', w.message.id)).toHaveLength(1); expect(left.read('same-id', w.message.id).body).toBe(w.message.body);
  });

  it('notifies only local sender after one day, and cannot resurrect a 14-day old received copy', () => {
    const f = fixture(), w = f.wire(); f.b.receiveFrom(ids.a, w);
    f.advance(1); f.a.maintainMessages(); f.b.maintainMessages();
    expect(f.a.status().filter(m => m.sender_host === 'system')).toHaveLength(1);
    expect(f.b.status().filter(m => m.sender_host === 'system')).toHaveLength(0);
    f.advance(13); f.a.maintainMessages(); f.b.maintainMessages();
    expect(f.b.status()).toEqual([]); expect(() => f.b.receiveFrom(ids.a, w)).toThrow('expired');
  });

  it('rejects incomplete or unsafe registration shapes atomically without removing existing entries', () => {
    const f = fixture(), prior = f.a.discover();
    expect(() => f.a.replaceRemoteRegistrations(ids.b, [{ id: 'x', host: 'codex', online: true, pid: 999 } as never])).toThrow();
    expect(f.a.discover()).toEqual(prior);
    expect(() => f.a.replaceRemoteRegistrations('d'.repeat(64), [])).toThrow();
    f.a.replaceRemoteRegistrations(ids.b, []);
    expect(f.a.discover().filter(r => r.machine === 'dgx')).toEqual([]);
    expect(f.a.send('same-id', { recipient: 'offline@dgx', kind: 'task', body: 'no longer registered' }).accepted).toBe(false);
  });

  it('keeps pre-join local read/reply local even when another member later takes the old hostname', () => {
    const f = fixture(); f.shut(f.a);
    const standalone = f.open('a', null);
    standalone.register({ id: 'receiver', host: 'codex', machine: standalone.machine, pid: 101, wake: {} });
    const message = standalone.send('same-id', { recipient: 'receiver', kind: 'question', body: 'before join' }).message;
    f.shut(standalone);
    const members = f.members.map(m => ({ ...m, name: m.id === ids.b ? 'local-hostname' : m.name }));
    const joined = f.open('a', { network_id: networkId, self: members[0], members });
    expect(joined.read('receiver', message.id).body).toBe('before join');
    const reply = joined.send('receiver', { recipient: 'same-id@local-hostname', kind: 'result', body: 'still local', reply_to: message.id });
    expect(reply.accepted).toBe(true); expect(joined.read('same-id', reply.message.id).body).toBe('still local');
    expect(joined.outgoingFor(ids.b)).toEqual([]);
  });

  it('migrates original three-table schema once without changing old public rows or granting unknown legacy identities', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-old-schema-')); roots.push(root);
    const file = path.join(root, 'messages.db'), db = new MemeshDatabase(file);
    db.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY,host TEXT NOT NULL,machine TEXT NOT NULL,pid INTEGER NOT NULL,wake TEXT NOT NULL);
      CREATE TABLE messages(id TEXT PRIMARY KEY,sender TEXT NOT NULL,sender_host TEXT NOT NULL,sender_machine TEXT NOT NULL,recipient TEXT NOT NULL,recipient_host TEXT,recipient_machine TEXT NOT NULL,kind TEXT NOT NULL,body TEXT,body_bytes INTEGER NOT NULL,reply_to TEXT,sent_at TEXT NOT NULL);
      CREATE TABLE events(message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,at TEXT NOT NULL,event TEXT NOT NULL,detail TEXT NOT NULL);
      INSERT INTO conversations VALUES('old','codex','previous-host',101,'{}');
      INSERT INTO messages VALUES('old-message','old','codex','previous-host','old','codex','previous-host','task','retained',8,NULL,'2026-11-15T00:00:00.000Z');
      INSERT INTO messages VALUES('unknown-legacy','legacy:x','unknown','unknown','legacy:y',NULL,'unknown','legacy','audit',5,NULL,'2026-11-15T00:00:00.000Z');`);
    db.close(); fs.chmodSync(file, 0o600);
    for (let pass = 0; pass < 2; pass++) {
      const store = new ConversationMessages({ file, machine: 'renamed-host', clock: () => Date.parse('2026-11-15T00:00:00.000Z'), processAlive: () => true });
      expect(store.read('old', 'old-message')).toMatchObject({ body: 'retained', sender_machine: 'previous-host', recipient_machine: 'previous-host' });
      expect(store.status('old').map(m => m.id)).toEqual(['old-message']);
      expect(store.status()).toHaveLength(2); store.close();
    }
    const check = new MemeshDatabase(file);
    expect(check.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual([{ name: 'conversations' }, { name: 'events' }, { name: 'messages' }]);
    check.close();
  });
});
