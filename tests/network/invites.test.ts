import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../../src/db.js';
import { ensureIdentity } from '../../src/network/identity.js';
import { consumeInvite, createInvite, encodeLink, hashToken, parseLink, type InviteLink } from '../../src/network/invites.js';
import { encodeJoinRequest, handleJoinRequest, parseJoinReply, refusalMessage, type JoinReply, type JoinRequest } from '../../src/network/join-protocol.js';
import { safeForTerminal, type NetworkErrorCode } from '../../src/network/types.js';
import { createRoster, signRoster, verifyRoster } from '../../src/network/roster.js';
import { insertConfig, openNetworkStore, readConfig } from '../../src/network/store.js';
import type { MemeshDatabase } from '../../src/storage/sqlite.js';
import { makeHome, removeTree } from './helpers.js';

const NET = '0123456789abcdef0123456789abcdef';
const OTHER_NET = 'fedcba9876543210fedcba9876543210';
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

  it('stores only the hash of the token, which is 32 random bytes', () => {
    const { token } = createInvite(db, HOUR, NOW);
    expect(Buffer.from(token, 'base64url').length).toBe(32);
    const rows = db.prepare('SELECT * FROM agent_network_invites').all();
    expect(rows).toEqual([{ hash: hashToken(token), expires_at_ms: NOW + HOUR, used_at: null }]);
    db.pragma('wal_checkpoint(TRUNCATE)');
    for (const file of fs.readdirSync(home)) {
      expect(fs.readFileSync(path.join(home, file)).includes(Buffer.from(token))).toBe(false);
    }
  });

  it('reusing an invite from a second connection is refused (in order; the race is in integration)', () => {
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

  it('the tables also arrive through the normal database open, and reopening keeps the rows', () => {
    const memoryDbPath = path.join(home, 'memory.sqlite');
    const opened = openDatabase(memoryDbPath);
    try {
      const names = (opened.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'agent_network_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
      expect(names).toEqual(['agent_network_config', 'agent_network_invites']);
      createInvite(opened, HOUR, NOW);
    } finally {
      closeDatabase();
    }
    const again = openDatabase(memoryDbPath);
    try {
      const rows = again.prepare('SELECT * FROM agent_network_invites').all();
      expect(rows.length).toBe(1);
    } finally {
      closeDatabase();
    }
  });
});

describe('invite links', () => {
  const home = makeHome();
  afterAll(() => removeTree(home));
  const identity = ensureIdentity(home);
  const fields: InviteLink = {
    v: 1,
    network_id: NET,
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
      { network_id: OTHER_NET },
      { addrs: ['10.0.0.1:1'] },
    ]) {
      expect(failure(encode({ ...good, ...change })).code).toBe('link_tampered');
    }
    const { sig: _sig, ...unsigned } = good;
    expect(failure(encode(unsigned)).code).toBe('link_tampered');
  });

  it('accepts plain http for a relay only on loopback', () => {
    const local = { ...fields, relay: 'http://127.0.0.1:9/' };
    expect(parseLink(encodeLink(identity, local))).toEqual(local);
    for (const relay of ['http://relay.example/', 'https://u:p@relay.example/']) {
      expect(failure(encodeLink(identity, { ...fields, relay })).code).toBe('link_malformed');
    }
  });

  it('refuses malformed links with a specific error and never echoes them', () => {
    const good = decode(encodeLink(identity, fields));
    const cases: Array<[string, string]> = [
      ['https://example.com/', 'link_malformed'],
      ['memesh://join/', 'link_malformed'],
      ['memesh://join/!!!', 'link_malformed'],
      [encode('text'), 'link_malformed'],
      [encode(null), 'link_malformed'],
      [encode({ ...good, pad: 'x'.repeat(8000) }), 'link_malformed'],
      [encode({ ...good, v: 2 }), 'link_version'],
      [encode({ ...good, owner_id: 'nope' }), 'link_malformed'],
      [encode({ ...good, token: 'short' }), 'link_malformed'],
      [encode({ ...good, relay: 'ftp://x/' }), 'link_malformed'],
      [encode({ ...good, relay: 'off' }), 'link_malformed'],
      [encode({ ...good, relay: 'http://relay.example/' }), 'link_malformed'],
      [encode({ ...good, relay: 'https://user:hunter2@relay.example/' }), 'link_malformed'],
      [encode({ ...good, network_id: 'net\u001b]0;PWNED\u0007' }), 'link_malformed'],
      [encode({ ...good, addrs: ['not an address'] }), 'link_malformed'],
    ];
    for (const [link, code] of cases) {
      const err = failure(link);
      expect(err.code).toBe(code);
      expect(err.message).not.toContain(fields.token);
      // Several pieces of the encoded link, the tail included: any one could be echoed.
      const encoded = link.slice('memesh://join/'.length);
      for (const at of [0, Math.floor(encoded.length / 2), Math.max(0, encoded.length - 24)]) {
        const piece = encoded.slice(at, at + 24);
        if (piece.length === 24) expect(err.message).not.toContain(piece);
      }
      for (const fieldValue of ['short', 'ftp://x/', 'not an address', 'hunter2', 'PWNED']) {
        expect(err.message).not.toContain(fieldValue);
      }
    }
  });
});

describe('join decision', () => {
  let home: string;
  let db: MemeshDatabase;
  const ownerHome = makeHome();
  const strangerHome = makeHome();
  const owner = ensureIdentity(ownerHome);
  const stranger = ensureIdentity(strangerHome);
  afterAll(() => [ownerHome, strangerHome].forEach(removeTree));
  const joinerA = 'a'.repeat(64);
  const joinerB = 'b'.repeat(64);

  beforeEach(() => {
    home = makeHome();
    db = openNetworkStore(path.join(home, 'db.sqlite'));
    const signed = signRoster(owner, createRoster(NET, {
      machine_id: owner.machineId, name: 'owner', person: 'kt', joined_at: new Date(NOW).toISOString(),
    }));
    insertConfig(db, {
      network_id: NET, owner_id: owner.machineId, machine_id: owner.machineId, machine_name: 'owner',
      person: 'kt', relay_url: 'off', roster_json: signed.roster_json, roster_signature: signed.signature,
    }, NOW);
  });
  afterEach(() => {
    db.close();
    removeTree(home);
  });

  const request = (token: string, overrides: Partial<JoinRequest> = {}): Buffer =>
    encodeJoinRequest({ network_id: NET, token, name: 'mac', person: 'kt', ...overrides });
  const code = (reply: ReturnType<typeof handleJoinRequest>): string => (reply.ok ? 'ok' : reply.error);

  it('takes the machine id from the connection, ignoring any in the message', () => {
    const { token } = createInvite(db, HOUR, NOW);
    const spoofed = Buffer.from(JSON.stringify({ ...JSON.parse(request(token).toString()), machine_id: joinerB }));
    const reply = handleJoinRequest(db, owner, joinerA, spoofed, NOW);
    if (!reply.ok) throw new Error(reply.error);
    const roster = verifyRoster(reply.roster, owner.machineId, NET);
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
    expect(code(handleJoinRequest(db, owner, joinerA, request(token, { network_id: OTHER_NET }), NOW))).toBe('wrong_network');
    expect(code(handleJoinRequest(db, owner, joinerA, request(token, { name: 'a@b' }), NOW))).toBe('invalid_name');
    expect(code(handleJoinRequest(db, owner, joinerA, Buffer.from('not json'), NOW))).toBe('bad_request');
    expect(code(handleJoinRequest(db, owner, joinerA, request(token), NOW))).toBe('ok');
    expect(code(handleJoinRequest(db, owner, joinerB, request(token, { name: 'other' }), NOW))).toBe('invite_used');
  });

  it('a member whose reply was lost gets the list back without spending another invite', () => {
    const { token } = createInvite(db, HOUR, NOW);
    expect(code(handleJoinRequest(db, owner, joinerA, request(token), NOW))).toBe('ok');
    const { token: unused } = createInvite(db, HOUR, NOW);
    const retried = handleJoinRequest(db, owner, joinerA, request(token), NOW);
    expect(retried.ok && verifyRoster(retried.roster, owner.machineId, NET).version).toBe(2);
    const reply = handleJoinRequest(db, owner, joinerA, request(unused), NOW);
    expect(reply.ok && verifyRoster(reply.roster, owner.machineId, NET).version).toBe(2);
    expect(code(handleJoinRequest(db, owner, joinerB, request(unused, { name: 'other' }), NOW))).toBe('ok');
  });

  it('a fault in the owner\'s own state is not presented as the joiner\'s: it throws for the bridge to record', () => {
    const { token } = createInvite(db, HOUR, NOW);
    expect(() => handleJoinRequest(db, stranger, joinerA, request(token), NOW)).toThrowError(/does not own a network/);
    db.prepare('UPDATE agent_network_config SET roster_signature = ?').run('AAAA');
    expect(() => handleJoinRequest(db, owner, joinerA, request(token), NOW)).toThrowError(/not signed/);
    expect(db.prepare('SELECT used_at FROM agent_network_invites').all()).toEqual([{ used_at: null }]);
  });
});

describe('a join reply', () => {
  const home = makeHome();
  afterAll(() => removeTree(home));
  const parsed = (raw: unknown): JoinReply => parseJoinReply(Buffer.from(JSON.stringify(raw)));

  it('passes only codes it knows, and turns anything else into a fixed string', () => {
    expect(parsed({ ok: false, error: 'invite_used' })).toEqual({ ok: false, error: 'invite_used' });
    for (const error of ['constructor', '__proto__', 'toString', '\u001b]0;pwned\u0007x', 42, null]) {
      expect(parsed({ ok: false, error })).toEqual({ ok: false, error: 'unknown_refusal' });
    }
  });

  it('the message for any code is a plain sentence from the table', () => {
    for (const code of ['constructor', '__proto__', '\u001b]0;pwned\u0007x'] as unknown as NetworkErrorCode[]) {
      const message = refusalMessage(code);
      expect(typeof message).toBe('string');
      expect(message).toMatch(/does not know/);
      expect(message).not.toMatch(/pwned|native code/);
    }
  });

  it('control characters never reach a terminal', () => {
    expect(safeForTerminal('a\u001b]0;PWNED\u0007b\u009b31mc\nd')).toBe('a ]0;PWNED b 31mc d');
  });
});

describe('the store', () => {
  let home: string;
  beforeEach(() => { home = makeHome(); });
  afterEach(() => removeTree(home));
  const posixIt = it.skipIf(process.platform === 'win32');

  posixIt('tightens a loose database and folder, and creates new ones private', () => {
    const folder = path.join(home, 'data');
    fs.mkdirSync(folder, { mode: 0o755 });
    fs.chmodSync(folder, 0o755);
    const dbPath = path.join(folder, 'k.db');
    const previous = process.umask(0o022);
    try {
      openNetworkStore(dbPath).close();
      fs.chmodSync(dbPath, 0o644);
      fs.chmodSync(folder, 0o755);
      openNetworkStore(dbPath).close();
    } finally {
      process.umask(previous);
    }
    expect(fs.statSync(dbPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(folder).mode & 0o777).toBe(0o700);
  });

  posixIt('sets a private umask for the files SQLite creates beside the database', () => {
    const previous = process.umask(0o022);
    try {
      const db = openNetworkStore(path.join(home, 'u.db'));
      db.close();
      expect(process.umask()).toBe(0o077);
    } finally {
      process.umask(previous);
    }
  });

  posixIt('refuses a sidecar whose owner bits do not match the database', () => {
    const dbPath = path.join(home, 's.db');
    openNetworkStore(dbPath).close();
    fs.writeFileSync(`${dbPath}-wal`, '');
    fs.chmodSync(`${dbPath}-wal`, 0o400);
    expect(() => openNetworkStore(dbPath)).toThrow();
    fs.chmodSync(`${dbPath}-wal`, 0o600);
  });

  it('runs in WAL mode', () => {
    const db = openNetworkStore(path.join(home, 'w.db'));
    try {
      expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    } finally {
      db.close();
    }
  });

  it('a short busy timeout gives up quickly on a held write lock', () => {
    const dbPath = path.join(home, 'b.db');
    const holder = openNetworkStore(dbPath);
    const short = openNetworkStore(dbPath, { busyTimeoutMs: 150 });
    try {
      expect(short.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 150 });
      holder.exec('BEGIN IMMEDIATE');
      const started = Date.now();
      expect(() => short.exec('BEGIN IMMEDIATE')).toThrowError(/locked/);
      expect(Date.now() - started).toBeLessThan(5000);
      holder.exec('ROLLBACK');
    } finally {
      short.close();
      holder.close();
    }
  });
});
