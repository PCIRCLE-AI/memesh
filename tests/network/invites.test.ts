import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../../src/db.js';
import { ensureIdentity } from '../../src/network/identity.js';
import { consumeInvite, createInvite, encodeLink, hashToken, parseLink, type InviteLink } from '../../src/network/invites.js';
import { encodeJoinRequest, handleJoinRequest, type JoinRequest } from '../../src/network/join-protocol.js';
import { createRoster, signRoster, verifyRoster } from '../../src/network/roster.js';
import { insertConfig, openNetworkStore, readConfig } from '../../src/network/store.js';
import type { MemeshDatabase } from '../../src/storage/sqlite.js';
import { makeHome, removeTree } from './helpers.js';

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

describe('invites', () => {
  let home: string;
  let dbPath: string;
  let db: MemeshDatabase;
  beforeEach(() => {
    home = makeHome();
    dbPath = path.join(home, 'db.sqlite');
    db = openNetworkStore(dbPath);
  });
  afterEach(() => {
    db.close();
    removeTree(home);
  });

  it('stores only the hash of the token', () => {
    const { token } = createInvite(db, HOUR, NOW);
    const rows = db.prepare('SELECT * FROM agent_network_invites').all();
    expect(rows).toEqual([{ hash: hashToken(token), expires_at_ms: NOW + HOUR, used_at: null }]);
    db.pragma('wal_checkpoint(TRUNCATE)');
    for (const file of fs.readdirSync(home)) {
      expect(fs.readFileSync(path.join(home, file)).includes(Buffer.from(token))).toBe(false);
    }
  });

  it('is single use across two connections: exactly one wins', () => {
    const { token } = createInvite(db, HOUR, NOW);
    const other = openNetworkStore(dbPath);
    try {
      const outcomes = [db, other].map((handle) => {
        try {
          consumeInvite(handle, hashToken(token), NOW + 1);
          return 'won';
        } catch (err) {
          return (err as { code: string }).code;
        }
      });
      expect(outcomes).toEqual(['won', 'invite_used']);
    } finally {
      other.close();
    }
  });

  it('names why an invite cannot be used', () => {
    const { token } = createInvite(db, HOUR, NOW);
    const code = (hash: string, at: number): string => {
      try {
        consumeInvite(db, hash, at);
        return 'won';
      } catch (err) {
        return (err as { code: string }).code;
      }
    };
    expect(code(hashToken('nope'), NOW)).toBe('invite_unknown');
    expect(code(hashToken(token), NOW + HOUR)).toBe('invite_expired');
    expect(code(hashToken(token), NOW + HOUR - 1)).toBe('won');
    expect(code(hashToken(token), NOW + HOUR - 1)).toBe('invite_used');
  });

  it('the tables also arrive through the normal database open, and it is repeatable', () => {
    const memoryDbPath = path.join(home, 'memory.sqlite');
    const opened = openDatabase(memoryDbPath);
    try {
      const names = (opened.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'agent_network_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
      expect(names).toEqual(['agent_network_config', 'agent_network_invites']);
    } finally {
      closeDatabase();
    }
    closeDatabase();
    const again = openDatabase(memoryDbPath);
    closeDatabase();
    expect(again).toBeTruthy();
  });
});

describe('invite links', () => {
  const home = makeHome();
  const identity = ensureIdentity(home);
  const fields: InviteLink = {
    v: 1,
    network_id: 'net-1',
    owner_id: identity.machineId,
    relay: 'https://relay.example/',
    token: Buffer.alloc(32, 7).toString('base64url'),
    expires_at_ms: NOW,
  };
  const decode = (link: string): Record<string, unknown> =>
    JSON.parse(Buffer.from(link.slice('memesh://join/'.length), 'base64url').toString()) as Record<string, unknown>;
  const encode = (raw: unknown): string => `memesh://join/${Buffer.from(JSON.stringify(raw)).toString('base64url')}`;
  const failure = (link: string): { code: string; message: string } => {
    try {
      parseLink(link);
    } catch (err) {
      return err as { code: string; message: string };
    }
    throw new Error('expected parseLink to refuse');
  };

  it('round-trips, with addresses only when given', () => {
    const plain = encodeLink(identity, fields);
    expect(parseLink(plain)).toEqual(fields);
    expect(decode(plain)).not.toHaveProperty('addrs');
    const withAddrs = { ...fields, addrs: ['192.168.1.2:4000', '[fe80::1]:4000'] };
    expect(parseLink(encodeLink(identity, withAddrs))).toEqual(withAddrs);
  });

  it('refuses a change to any signed field as tampered', () => {
    const good = decode(encodeLink(identity, fields));
    for (const change of [
      { token: Buffer.alloc(32, 8).toString('base64url') },
      { expires_at_ms: NOW + HOUR },
      { relay: 'https://evil.example/' },
      { network_id: 'net-2' },
      { addrs: ['10.0.0.1:1'] },
    ]) {
      expect(failure(encode({ ...good, ...change })).code).toBe('link_tampered');
    }
    const { sig: _sig, ...unsigned } = good;
    expect(failure(encode(unsigned)).code).toBe('link_tampered');
  });

  it('refuses malformed links with a specific error and never echoes them', () => {
    const good = decode(encodeLink(identity, fields));
    const cases: Array<[string, string]> = [
      ['https://example.com/', 'link_malformed'],
      ['memesh://join/', 'link_malformed'],
      ['memesh://join/!!!', 'link_malformed'],
      [encode('text'), 'link_malformed'],
      ['memesh://join/' + 'A'.repeat(9000), 'link_malformed'],
      [encode({ ...good, v: 2 }), 'link_version'],
      [encode({ ...good, owner_id: 'nope' }), 'link_malformed'],
      [encode({ ...good, token: 'short' }), 'link_malformed'],
      [encode({ ...good, relay: 'ftp://x/' }), 'link_malformed'],
      [encode({ ...good, relay: 'off' }), 'link_malformed'],
      [encode({ ...good, addrs: ['not an address'] }), 'link_malformed'],
    ];
    for (const [link, code] of cases) {
      const err = failure(link);
      expect(err.code).toBe(code);
      expect(err.message).not.toContain(fields.token);
      expect(err.message).not.toContain(link.slice(14, 40) || 'unmatched');
    }
  });
});

describe('join decision', () => {
  let home: string;
  let db: MemeshDatabase;
  const ownerHome = makeHome();
  const owner = ensureIdentity(ownerHome);
  const joinerA = 'a'.repeat(64);
  const joinerB = 'b'.repeat(64);

  beforeEach(() => {
    home = makeHome();
    db = openNetworkStore(path.join(home, 'db.sqlite'));
    const signed = signRoster(owner, createRoster('net-1', {
      machine_id: owner.machineId, name: 'owner', person: 'kt', joined_at: new Date(NOW).toISOString(),
    }));
    insertConfig(db, {
      network_id: 'net-1', owner_id: owner.machineId, machine_id: owner.machineId, machine_name: 'owner',
      person: 'kt', relay_url: 'off', roster_json: signed.roster_json, roster_signature: signed.signature,
    }, NOW);
  });
  afterEach(() => {
    db.close();
    removeTree(home);
  });

  const request = (token: string, overrides: Partial<JoinRequest> = {}): Buffer =>
    encodeJoinRequest({ network_id: 'net-1', token, name: 'mac', person: 'kt', ...overrides });
  const code = (reply: ReturnType<typeof handleJoinRequest>): string => (reply.ok ? 'ok' : reply.error);

  it('takes the machine id from the connection, ignoring any in the message', () => {
    const { token } = createInvite(db, HOUR, NOW);
    const spoofed = Buffer.from(JSON.stringify({ ...JSON.parse(request(token).toString()), machine_id: joinerB }));
    const reply = handleJoinRequest(db, owner, joinerA, spoofed, NOW);
    if (!reply.ok) throw new Error(reply.error);
    const roster = verifyRoster(reply.roster, owner.machineId, 'net-1');
    expect(roster.version).toBe(2);
    expect(roster.members.map((member) => member.machine_id)).toEqual([owner.machineId, joinerA]);
  });

  it('a taken name is refused without burning the invite', () => {
    const { token } = createInvite(db, HOUR, NOW);
    expect(code(handleJoinRequest(db, owner, joinerA, request(token, { name: 'owner' }), NOW))).toBe('name_taken');
    expect((readConfig(db)?.roster_json ?? '')).toContain('"version":1');
    expect(code(handleJoinRequest(db, owner, joinerA, request(token), NOW))).toBe('ok');
  });

  it('refuses a used, expired or unknown invite, the wrong network and a bad name', () => {
    const { token } = createInvite(db, HOUR, NOW);
    const { token: short } = createInvite(db, 1, NOW);
    expect(code(handleJoinRequest(db, owner, joinerA, request('nope'), NOW))).toBe('invite_unknown');
    expect(code(handleJoinRequest(db, owner, joinerA, request(short), NOW + 5))).toBe('invite_expired');
    expect(code(handleJoinRequest(db, owner, joinerA, request(token, { network_id: 'net-2' }), NOW))).toBe('wrong_network');
    expect(code(handleJoinRequest(db, owner, joinerA, request(token, { name: 'a@b' }), NOW))).toBe('invalid_name');
    expect(code(handleJoinRequest(db, owner, joinerA, Buffer.from('not json'), NOW))).toBe('bad_request');
    expect(code(handleJoinRequest(db, owner, joinerA, request(token), NOW))).toBe('ok');
    expect(code(handleJoinRequest(db, owner, joinerB, request(token, { name: 'other' }), NOW))).toBe('invite_used');
  });

  it('a member whose reply was lost gets the list back without spending another invite', () => {
    const { token } = createInvite(db, HOUR, NOW);
    expect(code(handleJoinRequest(db, owner, joinerA, request(token), NOW))).toBe('ok');
    const { token: unused } = createInvite(db, HOUR, NOW);
    const reply = handleJoinRequest(db, owner, joinerA, request(unused), NOW);
    expect(reply.ok && verifyRoster(reply.roster, owner.machineId, 'net-1').version).toBe(2);
    expect(code(handleJoinRequest(db, owner, joinerB, request(unused, { name: 'other' }), NOW))).toBe('ok');
  });

  it('a machine that does not own the network answers not_owner', () => {
    const someoneElse = ensureIdentity(makeHome());
    expect(code(handleJoinRequest(db, someoneElse, joinerA, request('x'), NOW))).toBe('not_owner');
  });
});
