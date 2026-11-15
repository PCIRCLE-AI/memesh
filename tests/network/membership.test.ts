import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ensureIdentity } from '../../src/network/identity.js';
import { createRoster, signRoster } from '../../src/network/roster.js';
import { openNetworkStore, insertConfig, readConfig, saveRoster } from '../../src/network/store.js';
import { clearMembership, removeMember, receiveMembershipRoster, parseMembershipFrame, parseMembershipAck, parseMembershipAction } from '../../src/network/membership.js';

const roots: string[] = [];
const stores: ReturnType<typeof openNetworkStore>[] = [];
afterEach(() => { stores.splice(0).forEach(db => db.close()); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-unit-')); roots.push(root);
  const owner = ensureIdentity(path.join(root, 'a')), peer = ensureIdentity(path.join(root, 'b'));
  const members = [owner, peer].map((id, i) => ({ machine_id: id.machineId, name: i ? 'beta' : 'alpha', person: 'test', joined_at: new Date().toISOString() }));
  const roster = { ...createRoster('a'.repeat(32), members[0]), members };
  const signed = signRoster(owner, roster);
  const db = openNetworkStore(path.join(root, 'metadata.db'), { metadataOnly: true }); stores.push(db);
  const config = { network_id: roster.network_id, machine_id: owner.machineId, owner_id: owner.machineId, machine_name: 'alpha', person: 'test', relay_url: 'off', roster_json: signed.roster_json, roster_signature: signed.signature };
  insertConfig(db, config, Date.now());
  return { db, owner, peer, config, roster, signed };
}

it('owner removes atomically and lost-ACK retry does not advance the version', () => {
  const { db, owner, peer, config } = fixture();
  const first = removeMember(db, owner, config, 'BETA');
  expect(first.alreadyRemoved).toBe(false);
  expect(JSON.parse(first.signed.roster_json).version).toBe(2);
  const retry = removeMember(db, owner, config, peer.machineId);
  expect(retry).toMatchObject({ alreadyRemoved: true, removed: peer.machineId, signed: first.signed });
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).toHaveLength(3);
});

it('nonowner cannot remove another and owner cannot remove itself', () => {
  const { db, owner, peer, config } = fixture();
  expect(() => removeMember(db, peer, config, owner.machineId)).toThrow('Only the network owner');
  expect(() => removeMember(db, owner, config, owner.machineId)).toThrow('Owner departure is not supported');
  expect(readConfig(db)).toEqual(config);
});

it('signed newer roster accepted; unsigned, fork, wrong owner/network and rollback rejected', () => {
  const { db, config, owner, peer, roster, signed } = fixture();
  const next = signRoster(owner, { ...roster, version: 2 });
  expect(receiveMembershipRoster(db, config, next)).toEqual({ version: 2, member: true });
  expect(() => receiveMembershipRoster(db, config, signed)).toThrow('older');
  expect(() => receiveMembershipRoster(db, config, signRoster(owner, { ...roster, version: 2, members: [roster.members[0]] }))).toThrow('differs');
  expect(() => receiveMembershipRoster(db, config, { ...next, signature: 'invalid' })).toThrow('not signed');
  expect(() => receiveMembershipRoster(db, config, signRoster(peer, { ...roster, version: 3 }))).toThrow('not signed');
  expect(() => receiveMembershipRoster(db, config, signRoster(owner, { ...roster, version: 3, network_id: 'b'.repeat(32) }))).toThrow('different network');
  expect(readConfig(db)?.roster_json).toBe(next.roster_json);
});

it('confirmed cleanup cannot clear a switched network or newer membership', () => {
  const { db, config, owner, roster } = fixture();
  const next = signRoster(owner, { ...roster, version: 3 }); saveRoster(db, next);
  expect(() => clearMembership(db, config, 2)).toThrow('changed after');
  expect(() => clearMembership(db, { ...config, network_id: 'b'.repeat(32) })).toThrow('Network changed');
  expect(readConfig(db)?.roster_json).toBe(next.roster_json);
});

it('local membership cleanup removes only metadata rows and retains the file', () => {
  const { db, config } = fixture();
  db.exec("INSERT INTO agent_network_invites VALUES ('synthetic', 9999999999999, NULL)");
  clearMembership(db, config);
  for (const table of ['agent_network_config', 'agent_network_invites', 'agent_network_peers']) expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
});

it('strict remote self requests have no victim, roster reads or business payload', () => {
  const raw = { version: 1, op: 'leave-self', network_id: 'a'.repeat(32) };
  const parse = (value: unknown) => parseMembershipFrame(Buffer.from(JSON.stringify(value)));
  expect(parse(raw)).toEqual(raw);
  expect(parse({ ...raw, op: 'self-status' })).toEqual({ ...raw, op: 'self-status' });
  for (const extra of [{ victim: 'b'.repeat(64) }, { body: 'private' }, { members: [] }]) expect(() => parse({ ...raw, ...extra })).toThrow();
  for (const bad of [{ ...raw, op: 'remove' }, { ...raw, version: 2 }, { ...raw, network_id: ['a'.repeat(32)] }]) expect(() => parse(bad)).toThrow();
  expect(() => parseMembershipFrame(Buffer.alloc(140_000))).toThrow();
});

it('ACK only carries own membership/version and private control stays bound', () => {
  const ack = { version: 1, network_id: 'a'.repeat(32), roster_version: 2, member: false };
  const parse = (v: unknown) => parseMembershipAck(Buffer.from(JSON.stringify(v)), ack.network_id);
  expect(parse(ack)).toEqual(ack);
  for (const bad of [{ ...ack, members: [] }, { ...ack, network_id: 'b'.repeat(32) }, { ...ack, roster_version: 0 }, { ...ack, member: 'false' }]) expect(() => parse(bad)).toThrow();
  const action = { action: 'leave', network_id: ack.network_id, machine_id: 'b'.repeat(64) };
  expect(parseMembershipAction(action)).toEqual(action);
  expect(() => parseMembershipAction({ ...action, target: 'alpha' })).toThrow();
});
