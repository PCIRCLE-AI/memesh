import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureIdentity } from '../../src/network/identity.js';
import { addMember, createRoster, signRoster } from '../../src/network/roster.js';
import { authorizeNetworkPeer, exchangeRoster, insertConfig, openNetworkStore, readConfig, signedRosterOf } from '../../src/network/store.js';
import { exchangeRosterStream, parseRosterExchange, ROSTER_EXCHANGE_MAX_BYTES } from '../../src/network/frames.js';
import type { BiStream } from '../../src/network/iroh-types.js';
import type { SignedRoster } from '../../src/network/types.js';

const roots: string[] = [];
const handles: ReturnType<typeof openNetworkStore>[] = [];
afterEach(() => { for (const db of handles.splice(0)) db.close(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-exchange-')); roots.push(root);
  const owner = ensureIdentity(path.join(root, 'owner'));
  const b = ensureIdentity(path.join(root, 'b'));
  const c = ensureIdentity(path.join(root, 'c'));
  const member = (id: string, name: string) => ({ machine_id: id, name, person: 'test', joined_at: '2026-11-15T00:00:00.000Z' });
  const first = createRoster('0123456789abcdef0123456789abcdef', member(owner.machineId, 'owner'));
  const second = addMember(first, member(b.machineId, 'b'));
  const third = addMember(second, member(c.machineId, 'c'));
  const old = signRoster(owner, second), latest = signRoster(owner, third);
  const store = (name: string, id: string, signed: SignedRoster) => {
    const db = openNetworkStore(path.join(root, name, 'graph.db')); handles.push(db);
    insertConfig(db, { network_id: first.network_id, owner_id: owner.machineId, machine_id: id,
      machine_name: name, person: 'test', relay_url: 'off', roster_json: signed.roster_json, roster_signature: signed.signature }, Date.now());
    return db;
  };
  return { owner, b, c, old, latest, third, store };
}

/** Paired bounded streams exercise the same exchange used by the native bridge, without a network/provider. */
function streams(): [BiStream, BiStream] {
  const pipe = () => {
    let resolve!: (bytes: number[]) => void;
    const done = new Promise<number[]>((r) => { resolve = r; });
    const bytes: number[] = [];
    return { send: { writeAll: async (part: number[]) => { bytes.push(...part); }, finish: async () => { resolve(bytes); } },
      recv: { readToEnd: async (limit: number) => { const data = await done; if (data.length > limit) throw new Error('size limit'); return data; } } };
  };
  const a = pipe(), b = pipe();
  return [{ send: a.send, recv: b.recv }, { send: b.send, recv: a.recv }];
}

describe('signed roster exchange before business frames', () => {
  it.each([true, false])('converges stale B and newly joined C (C initiates=%s)', async (cInitiates) => {
    const f = fixture(), b = f.store('b-db', f.b.machineId, f.old), c = f.store('c-db', f.c.machineId, f.latest);
    expect(() => authorizeNetworkPeer(b, f.c.machineId)).toThrow('not_a_member');
    const [left, right] = streams();
    const acceptB = (incoming: SignedRoster) => { const selected = exchangeRoster(b, incoming); authorizeNetworkPeer(b, f.c.machineId); return selected; };
    const acceptC = (incoming: SignedRoster) => { const selected = exchangeRoster(c, incoming); authorizeNetworkPeer(c, f.b.machineId); return selected; };
    await Promise.all(cInitiates
      ? [exchangeRosterStream(left, f.latest, acceptC, 100), exchangeRosterStream(right, null, acceptB, 100)]
      : [exchangeRosterStream(left, f.old, acceptB, 100), exchangeRosterStream(right, null, acceptC, 100)]);
    expect(signedRosterOf(readConfig(b)!)).toEqual(f.latest);
    expect(signedRosterOf(readConfig(c)!)).toEqual(f.latest);
  });

  it('does not persist a lower advertisement, unsigned data, another owner, or a same-version fork', () => {
    const f = fixture(), db = f.store('db', f.b.machineId, f.latest);
    expect(exchangeRoster(db, f.old)).toEqual(f.latest);
    for (const invalid of [
      { ...f.latest, signature: 'invalid' }, signRoster(f.c, f.third),
      signRoster(f.owner, { ...f.third, members: f.third.members.map((m) => ({ ...m, person: 'fork' })) }),
      signRoster(f.owner, { ...f.third, network_id: 'f'.repeat(32) }),
    ]) expect(() => exchangeRoster(db, invalid)).toThrow();
    expect(signedRosterOf(readConfig(db)!)).toEqual(f.latest);
  });

  it('rechecks authorization for existing peers and self after a signed removal, without rollback resurrection', () => {
    const f = fixture(), db = f.store('db', f.b.machineId, f.latest);
    authorizeNetworkPeer(db, f.c.machineId);
    const removed = signRoster(f.owner, { ...f.third, version: 4, members: f.third.members.filter((m) => m.machine_id !== f.c.machineId) });
    exchangeRoster(db, removed);
    expect(() => authorizeNetworkPeer(db, f.c.machineId)).toThrow('not_a_member');
    expect(exchangeRoster(db, f.latest)).toEqual(removed);
    expect(() => authorizeNetworkPeer(db, f.c.machineId)).toThrow('not_a_member');
    exchangeRoster(db, signRoster(f.owner, { ...f.third, version: 5, members: [f.third.members[0]] }));
    expect(() => authorizeNetworkPeer(db, f.owner.machineId)).toThrow('not_a_member');
  });

  it('does not send a roster reply to a removed sender and bounds malformed/oversized exchanges', async () => {
    const f = fixture(), db = f.store('db', f.b.machineId, f.old);
    const write = { count: 0 };
    const stream: BiStream = { send: { writeAll: async () => { write.count++; }, finish: async () => {} },
      recv: { readToEnd: async () => [...Buffer.from(JSON.stringify(f.old))] } };
    await expect(exchangeRosterStream(stream, null, (incoming) => {
      const selected = exchangeRoster(db, incoming); authorizeNetworkPeer(db, f.c.machineId); return selected;
    }, 100)).rejects.toThrow('not_a_member');
    expect(write.count).toBe(0);
    expect(() => parseRosterExchange(Buffer.alloc(ROSTER_EXCHANGE_MAX_BYTES + 1))).toThrow();
    expect(() => parseRosterExchange(Buffer.from(JSON.stringify({ ...f.old, payload: 'not allowed' })))).toThrow();
  });

  it('times out a peer that sends no roster without calling authorization', async () => {
    let accepted = false;
    const stream: BiStream = { send: { writeAll: async () => {}, finish: async () => {} }, recv: { readToEnd: () => new Promise(() => {}) } };
    await expect(exchangeRosterStream(stream, null, (incoming) => { accepted = true; return incoming; }, 5)).rejects.toThrow();
    expect(accepted).toBe(false);
  });
});
