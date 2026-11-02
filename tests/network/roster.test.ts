import { afterAll, describe, expect, it } from 'vitest';
import { ensureIdentity } from '../../src/network/identity.js';
import {
  acceptRoster, addMember, assertValidName, canonicalJson, createRoster, parseRoster, signRoster, verifyRoster,
} from '../../src/network/roster.js';
import type { RosterMember } from '../../src/network/types.js';
import { makeHome, removeTree } from './helpers.js';

const homes = [makeHome(), makeHome()];
afterAll(() => homes.forEach(removeTree));
const owner = ensureIdentity(homes[0]);
const stranger = ensureIdentity(homes[1]);
const member = (name: string, seed: string): RosterMember => ({
  machine_id: seed.repeat(64), name, person: 'kt', joined_at: '2026-11-03T00:00:00.000Z',
});
const first = createRoster('net-1', { ...member('owner', '0'), machine_id: owner.machineId });

describe('roster', () => {
  it('signs canonical JSON: key order does not change the bytes', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    const signed = signRoster(owner, first);
    expect(signed.roster_json).toBe(canonicalJson(JSON.parse(signed.roster_json)));
  });

  it('verifies against the expected owner, not the one the document names', () => {
    const signed = signRoster(owner, first);
    expect(verifyRoster(signed, owner.machineId, 'net-1').version).toBe(1);
    // A stranger signs a roster that claims the real owner.
    const forged = signRoster(stranger, first);
    expect(() => verifyRoster(forged, owner.machineId, 'net-1')).toThrowError(/not signed by the network owner/);
    expect(() => verifyRoster(signed, stranger.machineId, 'net-1')).toThrowError(/not signed by the network owner/);
    expect(() => verifyRoster(signed, owner.machineId, 'net-2')).toThrowError(/different network/);
  });

  it('rejects any change to the signed bytes', () => {
    const signed = signRoster(owner, first);
    const changed = { ...signed, roster_json: signed.roster_json.replace('"version":1', '"version":9') };
    expect(() => verifyRoster(changed, owner.machineId, 'net-1')).toThrowError(/not signed/);
  });

  it('never accepts a lower version, and refuses a fork at the same version', () => {
    const v1 = signRoster(owner, first);
    const v2 = signRoster(owner, addMember(first, member('b', '1')));
    const fork = signRoster(owner, addMember(first, member('c', '2')));
    expect(acceptRoster(v1, v2, owner.machineId, 'net-1').version).toBe(2);
    expect(acceptRoster(v2, v2, owner.machineId, 'net-1').version).toBe(2);
    expect(() => acceptRoster(v2, v1, owner.machineId, 'net-1')).toThrowError(/older team list/);
    expect(() => acceptRoster(v2, fork, owner.machineId, 'net-1')).toThrowError(/differs/);
  });

  it('keeps machine names unique, ignoring case', () => {
    const next = addMember(first, member('mac', '1'));
    expect(next.version).toBe(2);
    expect(() => addMember(next, member('MAC', '2'))).toThrowError(expect.objectContaining({ code: 'name_taken' }));
    const twice = JSON.stringify({ ...next, members: [...next.members, member('Mac', '3')] });
    expect(() => parseRoster(twice)).toThrowError(/share a name/);
  });

  it('allows only names that keep person/handle@machine unambiguous', () => {
    for (const good of ['kt', 'mac-mini', 'A.b_c-9']) expect(() => assertValidName('person', good)).not.toThrow();
    for (const bad of ['a/b', 'a@b', 'a b', '', '-x', '.x', 'a\nb', 'é', 'x'.repeat(65), 42]) {
      expect(() => assertValidName('person', bad)).toThrowError(expect.objectContaining({ code: 'invalid_name' }));
    }
  });

  it('rejects a roster that omits its owner or has a bad shape', () => {
    const base = JSON.parse(signRoster(owner, first).roster_json) as Record<string, unknown>;
    expect(() => parseRoster(JSON.stringify({ ...base, members: [] }))).toThrowError(/owner is not a member/);
    expect(() => parseRoster(JSON.stringify({ ...base, version: 0 }))).toThrowError(/bad version/);
    expect(() => parseRoster(JSON.stringify({ ...base, members: [{ ...first.members[0], machine_id: 'x' }] }))).toThrowError(/bad machine id/);
    expect(() => parseRoster('not json')).toThrowError(/not JSON/);
  });
});
