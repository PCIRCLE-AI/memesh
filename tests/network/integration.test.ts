// Real processes on real sockets: throwaway HOMEs, real bridges, the real native
// transport, relay off, direct addresses. Needs the npm registry once per run to
// install the runtime. Skipped on a computer the pin does not cover (Intel Mac),
// and on Windows, where this path has never been measured.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBridge, stopBridge } from '../../src/network/bridge-control.js';
import { logPath, readStatus, statusPath, type BridgeStatus } from '../../src/network/bridge-state.js';
import { controlPath, probeBridge } from '../../src/network/control-socket.js';
import { ensureIdentity, identityPath, loadIdentity } from '../../src/network/identity.js';
import type { Connection, Endpoint, IrohModule } from '../../src/network/iroh-types.js';
import { encodeLink, hashToken, parseLink } from '../../src/network/invites.js';
import { JOIN_REQUEST_MAX_BYTES } from '../../src/network/join-protocol.js';
import { bridgeUp, createLink, createNetwork, getNetworkStatus as readNetworkStatus, joinNetwork, type JoinedStatus } from '../../src/network/operations.js';
import { verifyRoster } from '../../src/network/roster.js';
import { checkRuntime, ensureRuntime, isPlatformSupported } from '../../src/network/runtime.js';
import { BRIDGE_BUSY_TIMEOUT_MS } from '../../src/network/bridge-serve.js';
import { openNetworkStore, readConfig, signedRosterOf } from '../../src/network/store.js';
import {
  EXIT_ALREADY_RUNNING, JOIN_ALPN, NET_ALPN, NetworkError, childEnv, runtimeDir, type NetworkContext,
} from '../../src/network/types.js';
import {
  buildTree, contextFor, installRuntimeOnce, linkRuntime, loadIrohForTest, makeHome, removeTree, writeTtyPreload, type Tree,
} from './helpers.js';

const lockText = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/network/runtime-lock.json'), 'utf8');
const supported = isPlatformSupported(lockText, process.platform, process.arch, process.platform === 'linux' ? 'glibc' : null);

const NET_OTHER = 'fedcba9876543210fedcba9876543210';
const bytes = (value: string | Buffer): number[] => Array.from(Buffer.from(value));

const getNetworkStatus = async (ctx: NetworkContext): Promise<JoinedStatus> => {
  const status = await readNetworkStatus(ctx);
  if (!status.joined) throw new Error('expected a joined machine');
  return status;
};

describe.skipIf(!supported || process.platform === 'win32')('two machines, relay off', () => {
  let tree: Tree;
  let runtime: string;
  let iroh: IrohModule;
  let owner: NetworkContext;
  const homes: string[] = [];
  const contexts: NetworkContext[] = [];
  const endpoints: Endpoint[] = [];

  const machine = (): NetworkContext => {
    const home = makeHome();
    homes.push(home);
    const ctx = contextFor(tree, home);
    linkRuntime(ctx, runtime);
    contexts.push(ctx);
    return ctx;
  };
  const issuedTokens: string[] = [];
  const inviteFrom = async (ctx: NetworkContext) => {
    const result = await createLink(ctx, { includeAddresses: true, ttlHours: 1 });
    issuedTokens.push(parseLink(result.link).token);
    return result;
  };
  const joinWith = (link: string, name: string, ctx = machine()) => joinNetwork(ctx, { link, name, person: 'kt', relay: 'off' });
  const assertNoIssuedTokenLeaked = (ctx: NetworkContext): void => {
    expect(issuedTokens.length).toBeGreaterThan(0);
    const texts = [fs.readFileSync(statusPath(ctx.dataDir), 'utf8'), fs.readFileSync(logPath(ctx.dataDir), 'utf8')];
    for (const text of texts) for (const token of issuedTokens) expect(text).not.toContain(token);
  };
  const refusal = async (attempt: Promise<unknown>): Promise<string> => {
    try {
      await attempt;
    } catch (err) {
      if (err instanceof NetworkError) return err.code;
      throw err;
    }
    return 'joined';
  };
  const ownerStatus = (): BridgeStatus => readStatus(owner.dataDir) as BridgeStatus;

  /** An outside endpoint, with any key, dialing the owner's bridge. */
  const dial = async (alpn: string, secret: Buffer = randomBytes(32)): Promise<Connection> => {
    const builder = iroh.Endpoint.builder();
    builder.applyMinimal();
    builder.secretKey(bytes(secret));
    builder.relayMode(iroh.RelayMode.disabled());
    const endpoint = await builder.bind();
    endpoints.push(endpoint);
    const addresses = ownerStatus().direct_addresses;
    const target = new iroh.EndpointAddr(iroh.EndpointId.fromString(loadIdentity(owner.dataDir).machineId), null, addresses);
    return endpoint.connect(target, bytes(alpn));
  };

  beforeAll(async () => {
    tree = await buildTree({ cli: true });
    runtime = installRuntimeOnce(tree);
    iroh = loadIrohForTest(runtime);
    owner = machine();
    createNetwork(owner, { name: 'owner', person: 'kt', relay: 'off' });
  }, 300_000);

  afterAll(async () => {
    await Promise.all(endpoints.map((endpoint) => endpoint.close().catch(() => undefined)));
    for (const ctx of contexts) await stopBridge(ctx);
    homes.forEach(removeTree);
    removeTree(path.dirname(path.dirname(path.dirname(runtime))));
    removeTree(tree.root);
  }, 120_000);

  it("node:crypto's public key is the transport's endpoint id", async () => {
    const identity = loadIdentity(owner.dataDir);
    const builder = iroh.Endpoint.builder();
    builder.applyMinimal();
    builder.secretKey(bytes(identity.secret));
    builder.relayMode(iroh.RelayMode.disabled());
    const endpoint = await builder.bind();
    try {
      expect(endpoint.id().toString()).toBe(identity.machineId);
    } finally {
      await endpoint.close();
    }
    expect(fs.statSync(identityPath(owner.dataDir)).size).toBe(32);
  });

  it('create, link and join: both machines hold the same signed list', async () => {
    const { link, bridgeStarted } = await inviteFrom(owner);
    expect(bridgeStarted).toBe(true);
    const fields = parseLink(link);
    expect(fields.relay).toBeNull();
    expect(fields.addrs?.length).toBeGreaterThan(0);

    const member = machine();
    const joined = await joinWith(link, 'second', member);
    expect(joined.member.name).toBe('second');
    expect(joined.member.machine_id).toBe(loadIdentity(member.dataDir).machineId);

    const ownerView = await getNetworkStatus(owner);
    const memberView = await getNetworkStatus(member);
    expect(ownerView.role).toBe('owner');
    expect(memberView.role).toBe('member');
    expect(memberView.roster_version).toBe(2);
    expect(memberView.members).toEqual(ownerView.members);
    expect(ownerView.bridge.running).toBe(true);

    const db = openNetworkStore(member.dbPath);
    try {
      const config = readConfig(db);
      if (!config) throw new Error('no config');
      expect(verifyRoster(signedRosterOf(config), fields.owner_id, fields.network_id).version).toBe(2);
    } finally {
      db.close();
    }

    // The token is nowhere a person or a log could read it later.
    const token = fields.token;
    const looked = [
      JSON.stringify(ownerView), JSON.stringify(memberView),
      fs.readFileSync(statusPath(owner.dataDir), 'utf8'), fs.readFileSync(logPath(owner.dataDir), 'utf8'),
    ];
    for (const text of looked) expect(text).not.toContain(token);
  });

  it('a second use from another machine is refused invite_used', async () => {
    const { link } = await inviteFrom(owner);
    expect(await refusal(joinWith(link, 'third'))).toBe('joined');
    expect(await refusal(joinWith(link, 'fourth'))).toBe('invite_used');
  });

  it('an expired link is refused locally, and by the owner when the local clock is fooled', async () => {
    const { link } = await createLink(owner, { includeAddresses: true, ttlHours: 1 / 3_600_000 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await refusal(joinWith(link, 'expired-local'))).toBe('invite_expired');

    const { link: fresh } = await inviteFrom(owner);
    const db = openNetworkStore(owner.dbPath);
    try {
      db.prepare('UPDATE agent_network_invites SET expires_at_ms = 1 WHERE used_at IS NULL').run();
    } finally {
      db.close();
    }
    expect(await refusal(joinWith(fresh, 'expired-owner'))).toBe('invite_expired');
  });

  it('a tampered link is refused, and a forged token by the owner is unknown to it', async () => {
    const { link } = await inviteFrom(owner);
    const prefix = 'memesh://join/';
    const raw = JSON.parse(Buffer.from(link.slice(prefix.length), 'base64url').toString()) as Record<string, unknown>;
    const changed = prefix + Buffer.from(JSON.stringify({ ...raw, token: randomBytes(32).toString('base64url') })).toString('base64url');
    expect(await refusal(joinWith(changed, 'tampered'))).toBe('link_tampered');
    expect(await refusal(joinWith(`${link}!`, 'tampered'))).toBe('link_malformed');

    const fields = parseLink(link);
    const identity = loadIdentity(owner.dataDir);
    const unknown = encodeLink(identity, { ...fields, token: randomBytes(32).toString('base64url') });
    expect(await refusal(joinWith(unknown, 'unknown'))).toBe('invite_unknown');
    const otherNetwork = encodeLink(identity, { ...fields, network_id: NET_OTHER });
    expect(await refusal(joinWith(otherNetwork, 'wrong'))).toBe('wrong_network');
  });

  it('a taken name is refused, and the same link then works with another name', async () => {
    const { link } = await inviteFrom(owner);
    const ctx = machine();
    expect(await refusal(joinWith(link, 'owner', ctx))).toBe('name_taken');
    assertNoIssuedTokenLeaked(owner);
    expect(await refusal(joinWith(link, 'renamed', ctx))).toBe('joined');
  });

  it('simultaneous joins of one link give exactly one winner', async () => {
    const { link } = await inviteFrom(owner);
    const outcomes = await Promise.all(['race-a', 'race-b', 'race-c'].map((name) => refusal(joinWith(link, name))));
    expect([...outcomes].sort()).toEqual(['invite_used', 'invite_used', 'joined']);
    assertNoIssuedTokenLeaked(owner);
  });

  it('a non-member is closed with no data read', async () => {
    const before = ownerStatus().non_member_refused;
    // It opens no stream at all. A bridge that waited to read from it first would
    // leave this connection open until its 15 s stream deadline, so the close has to
    // arrive well before that.
    const connection = await dial(NET_ALPN);
    const silent = await Promise.race([
      connection.closed(),
      new Promise((resolve) => setTimeout(() => resolve('still open'), 5_000)),
    ]);
    expect(String(silent)).toMatch(/not_a_member/);
    await expect.poll(() => ownerStatus().non_member_refused).toBe(before + 1);

    // Data sent regardless goes nowhere and comes back as nothing.
    const marker = `marker-${randomBytes(8).toString('hex')}`;
    const pushy = await dial(NET_ALPN);
    let reply: Buffer | null = null;
    let streamError: unknown = null;
    try {
      const stream = await pushy.openBi();
      await stream.send.writeAll(bytes(marker));
      await stream.send.finish();
      reply = Buffer.from(await stream.recv.readToEnd(1024));
    } catch (err) {
      streamError = err;
    }
    expect(reply).toBeNull();
    expect(streamError).not.toBeNull();
    expect(ownerStatus().frames_received).toBe(0);
    expect(fs.readFileSync(logPath(owner.dataDir), 'utf8')).not.toContain(marker);
  });

  it('a member gets through, and bytes that are not a frame are refused with a code', async () => {
    const member = machine();
    const { link } = await inviteFrom(owner);
    await joinWith(link, 'frame-member', member);
    const connection = await dial(NET_ALPN, loadIdentity(member.dataDir).secret);
    const stream = await connection.openBi();
    await stream.send.writeAll(bytes('hello'));
    await stream.send.finish();
    const reply = Buffer.from(await stream.recv.readToEnd(1024)).toString();
    connection.close(0n, bytes('done'));
    expect(JSON.parse(reply)).toEqual({ result: 'rejected', code: 'frame_invalid' });
    await expect.poll(() => ownerStatus().frames_received).toBeGreaterThan(0);
  });

  it('an oversized join request is bounded: refused, recorded, and the bridge survives', async () => {
    const earlierErrorAt = ownerStatus().last_error_at;
    const connection = await dial(JOIN_ALPN);
    const stream = await connection.openBi();
    await stream.send.writeAll(bytes(Buffer.alloc(JOIN_REQUEST_MAX_BYTES + 1, 0x61)));
    await stream.send.finish();
    const reason = await Promise.race([
      connection.closed(),
      new Promise((resolve) => setTimeout(() => resolve('still open'), 20_000)),
    ]);
    expect(String(reason)).not.toBe('still open');
    expect((await getNetworkStatus(owner)).bridge.running).toBe(true);
    await expect.poll(() => ownerStatus().last_error_at).not.toBe(earlierErrorAt);
    expect(ownerStatus().last_error).toMatch(/TooLong/);
    const { link } = await inviteFrom(owner);
    expect(await refusal(joinWith(link, 'after-oversize'))).toBe('joined');
  });

  it('a bad MEMESH_TEST_NETWORK_BIND stops the bridge with a recorded reason; a loopback one advertises no addresses', async () => {
    const bad = machine();
    createNetwork(bad, { name: 'bad-bind', person: 'kt', relay: 'off' });
    bad.env = { ...bad.env, MEMESH_TEST_NETWORK_BIND: 'localhost:0' };
    await expect(startBridge(bad)).rejects.toThrowError(/MEMESH_TEST_NETWORK_BIND must be an IP address and port/);
    expect(readStatus(bad.dataDir)).toMatchObject({ state: 'failed', last_error: expect.stringMatching(/MEMESH_TEST_NETWORK_BIND/) });

    const loop = machine();
    createNetwork(loop, { name: 'loop-bind', person: 'kt', relay: 'off' });
    loop.env = { ...loop.env, MEMESH_TEST_NETWORK_BIND: '127.0.0.1:0' };
    await startBridge(loop);
    try {
      await new Promise((resolve) => setTimeout(resolve, 3_000)); // past a heartbeat
      expect(readStatus(loop.dataDir)?.direct_addresses).toHaveLength(0);
      // Without the hook a bridge here does advertise addresses, so the empty list above is the hook's doing.
      expect(ownerStatus().direct_addresses.length).toBeGreaterThan(0);
    } finally {
      await stopBridge(loop);
    }
  }, 60_000);

  it('one bridge per data dir: a second exits and the first keeps running', async () => {
    const first = (await getNetworkStatus(owner)).bridge.pid;
    const statusBefore = readStatus(owner.dataDir)?.updated_at;
    const second = spawnSync(process.execPath, [owner.bridgeEntry, 'serve'], { env: childEnv(owner), encoding: 'utf8', timeout: 30_000 });
    expect(second.status).toBe(EXIT_ALREADY_RUNNING);
    expect((await getNetworkStatus(owner)).bridge.pid).toBe(first);
    expect(readStatus(owner.dataDir)).toMatchObject({ pid: first, updated_at: statusBefore });
    expect((await startBridge(owner)).started).toBe(false);
    expect((await bridgeUp(owner)).pid).toBe(first);
  });

  it('a member cannot make invites', async () => {
    const member = machine();
    const { link } = await inviteFrom(owner);
    await joinWith(link, 'no-invites', member);
    expect(await refusal(inviteFrom(member))).toBe('not_owner');
  });

  it('down stops the bridge and leaves a record; a killed bridge\'s stale socket is replaced', async () => {
    const stopped = await stopBridge(owner);
    expect(stopped.stopped).toBe(true);
    expect((await getNetworkStatus(owner)).bridge.running).toBe(false);
    expect(readStatus(owner.dataDir)?.state).toBe('stopped');
    expect(fs.existsSync(controlPath(owner.dataDir))).toBe(false);
    expect((await stopBridge(owner)).stopped).toBe(false);

    const again = await startBridge(owner);
    expect(again.started).toBe(true);
    expect((await getNetworkStatus(owner)).bridge.pid).toBe(again.pid);
    process.kill(again.pid, 'SIGKILL');
    await expect.poll(async () => (await getNetworkStatus(owner)).bridge.running, { timeout: 10_000 }).toBe(false);
    expect(fs.lstatSync(controlPath(owner.dataDir)).isSocket()).toBe(true);
    const after = await startBridge(owner);
    expect(after.started).toBe(true);
    expect(readStatus(owner.dataDir)).toMatchObject({ pid: after.pid, state: 'running' });
  }, 120_000);

  it('a relay that does not answer is recorded, the bridge keeps serving, and a join reports it', async () => {
    const ctx = machine();
    createNetwork(ctx, { name: 'no-relay', person: 'kt', relay: 'http://127.0.0.1:9/' });
    await startBridge(ctx);

    // A link made without the flag has no addresses in it.
    const relayOnly = await createLink(ctx, { ttlHours: 1 });
    expect(parseLink(relayOnly.link).addrs).toBeUndefined();
    expect(relayOnly.addressesMissing).toBe(false);

    await expect.poll(() => readStatus(ctx.dataDir)?.relay_state, { timeout: 40_000, interval: 500 }).toBe('unreachable');
    expect(readStatus(ctx.dataDir)?.last_error).toMatch(/not answering/);
    expect((await getNetworkStatus(ctx)).bridge.running).toBe(true);

    // This machine's relay is the link's relay, it is down, and there is no other
    // way: said about this machine, before the invite is touched.
    const stranded = machine();
    await expect(joinNetwork(stranded, { link: relayOnly.link, name: 'stranded', person: 'kt' })).rejects.toMatchObject({
      code: 'relay_unreachable', message: expect.stringMatching(/This machine could not reach its relay.*not used/),
    });
    expect((await getNetworkStatus(ctx)).roster_version).toBe(1);

    // Still serving: a direct connection gets through with the relay down, and the
    // joiner is told its relay was not reached.
    const direct = await createLink(ctx, { includeAddresses: true, ttlHours: 1 });
    const joined = await joinNetwork(machine(), { link: direct.link, name: 'direct-join', person: 'kt' });
    expect(joined.relayReached).toBe(false);
    await stopBridge(ctx);
  }, 180_000);

  it('a --relay that does not answer refuses before using the invite, and stores nothing', async () => {
    const { link } = await inviteFrom(owner);
    const ctx = machine();
    await expect(joinNetwork(ctx, { link, name: 'typo', person: 'kt', relay: 'http://127.0.0.1:9/' })).rejects.toMatchObject({ code: 'relay_unreachable' });
    expect((await readNetworkStatus(ctx)).joined).toBe(false);
    const db = openNetworkStore(owner.dbPath);
    try {
      expect(db.prepare('SELECT used_at FROM agent_network_invites WHERE hash = ?').get(hashToken(parseLink(link).token))).toEqual({ used_at: null });
    } finally {
      db.close();
    }
    expect((await joinWith(link, 'corrected', ctx)).relayReached).toBeNull();
  }, 120_000);

  it('a relay-only link with --relay off is refused at once, naming why', async () => {
    const ctx = machine();
    createNetwork(ctx, { name: 'relay-owner', person: 'kt', relay: 'http://127.0.0.1:9/' });
    const { link } = await createLink(ctx, { ttlHours: 1 });
    await expect(joinWith(link, 'cannot')).rejects.toMatchObject({ code: 'invalid_option', message: expect.stringMatching(/--relay off/) });
    await stopBridge(ctx);
  });

  it('an owner that closes mid-join gets a separate error saying a retry is safe', async () => {
    const fakeOwnerHome = makeHome();
    homes.push(fakeOwnerHome);
    const fakeOwner = ensureIdentity(path.join(fakeOwnerHome, 'data'));
    const builder = iroh.Endpoint.builder();
    builder.applyMinimal();
    builder.secretKey(bytes(fakeOwner.secret));
    builder.relayMode(iroh.RelayMode.disabled());
    builder.alpns([bytes(JOIN_ALPN)]);
    const endpoint = await builder.bind();
    endpoints.push(endpoint);
    await expect.poll(() => endpoint.addr().directAddresses().length, { timeout: 10_000 }).toBeGreaterThan(0);
    void endpoint.acceptNext().then(async (incoming) => {
      const accepting = await incoming?.accept();
      const connection = await accepting?.connect();
      connection?.close(7n, bytes('\u001b]0;PWNED\u0007'));
    });
    const link = encodeLink(fakeOwner, {
      v: 1, network_id: NET_OTHER, owner_id: fakeOwner.machineId, relay: null,
      token: randomBytes(32).toString('base64url'), expires_at_ms: Date.now() + 60_000, addrs: endpoint.addr().directAddresses(),
    });
    const err = await joinWith(link, 'interrupted').then(() => null, (e: unknown) => e as NetworkError);
    expect(err?.code).toBe('join_interrupted');
    expect(err?.message).toMatch(/same link is safe/);
    expect(err?.message).not.toMatch(/[\u0000-\u001f]/);
  }, 60_000);

  it('membership and joins use a verified roster; a bad one is recorded and admits nobody', async () => {
    const ctx = machine();
    createNetwork(ctx, { name: 'tamper-owner', person: 'kt', relay: 'off' });
    const member = machine();
    const first = await createLink(ctx, { includeAddresses: true, ttlHours: 1 });
    await joinWith(first.link, 'real-member', member);

    const second = await createLink(ctx, { includeAddresses: true, ttlHours: 1 });
    const db = openNetworkStore(ctx.dbPath);
    db.prepare('UPDATE agent_network_config SET roster_signature = ?').run(Buffer.alloc(64, 1).toString('base64url'));
    db.close();

    // The owner's own fault: the joiner hears "internal", the owner's status says why.
    expect(await refusal(joinWith(second.link, 'after-tamper'))).toBe('internal');
    expect(readStatus(ctx.dataDir)?.last_error).toMatch(/not signed/);

    const dialOwner = async (): Promise<Connection> => {
      const builder = iroh.Endpoint.builder();
      builder.applyMinimal();
      builder.secretKey(bytes(loadIdentity(member.dataDir).secret));
      builder.relayMode(iroh.RelayMode.disabled());
      const endpoint = await builder.bind();
      endpoints.push(endpoint);
      const target = new iroh.EndpointAddr(iroh.EndpointId.fromString(loadIdentity(ctx.dataDir).machineId), null, readStatus(ctx.dataDir)?.direct_addresses);
      return endpoint.connect(target, bytes(NET_ALPN));
    };
    const servedBefore = readStatus(ctx.dataDir)?.frames_received;
    const connection = await dialOwner();
    const reason = await Promise.race([connection.closed(), new Promise((resolve) => setTimeout(() => resolve('still open'), 5_000))]);
    expect(String(reason)).not.toBe('still open');
    expect(readStatus(ctx.dataDir)?.frames_received).toBe(servedBefore);
    await stopBridge(ctx);
  }, 60_000);

  it('a held write lock cannot stop the bridge for long', async () => {
    const ctx = machine();
    createNetwork(ctx, { name: 'locked-owner', person: 'kt', relay: 'off' });
    const { link } = await createLink(ctx, { includeAddresses: true, ttlHours: 1 });
    const holder = openNetworkStore(ctx.dbPath);
    holder.exec('BEGIN IMMEDIATE');
    const started = Date.now();
    const outcome = await refusal(joinWith(link, 'while-locked'));
    holder.exec('ROLLBACK');
    holder.close();
    expect(outcome).toBe('internal');
    expect(Date.now() - started).toBeLessThan(BRIDGE_BUSY_TIMEOUT_MS + 12_000);
    expect(readStatus(ctx.dataDir)?.last_error).toMatch(/locked/);
    await stopBridge(ctx);
  }, 60_000);

  it('two starters at once: one wins, and the losers exit without touching status', async () => {
    const ctx = machine();
    createNetwork(ctx, { name: 'two-starters', person: 'kt', relay: 'off' });
    const [a, b] = await Promise.all([startBridge(ctx), startBridge(ctx)]);
    expect(a.pid).toBe(b.pid);
    expect((await getNetworkStatus(ctx)).bridge.pid).toBe(a.pid);
    expect([a.started, b.started].filter(Boolean).length).toBe(1);
    await stopBridge(ctx);

    // Bare processes, straight at the race, onto a stale socket left by a killed bridge.
    const killed = await startBridge(ctx);
    process.kill(killed.pid, 'SIGKILL');
    await expect.poll(async () => (await getNetworkStatus(ctx)).bridge.running, { timeout: 10_000 }).toBe(false);
    const children = Array.from({ length: 6 }, () => spawn(process.execPath, [ctx.bridgeEntry, 'serve'], { env: childEnv(ctx), stdio: 'ignore' }));
    const exits: Array<number | null> = [];
    children.forEach((child) => child.on('exit', (code) => exits.push(code)));
    await expect.poll(() => exits.length, { timeout: 30_000 }).toBe(5);
    expect(exits).toEqual([3, 3, 3, 3, 3]);
    await expect.poll(async () => (await getNetworkStatus(ctx)).bridge.running, { timeout: 10_000 }).toBe(true);
    const winner = children.find((child) => child.exitCode === null);
    expect((await getNetworkStatus(ctx)).bridge.pid).toBe(winner?.pid);
    expect(readStatus(ctx.dataDir)?.pid).toBe(winner?.pid);
    await stopBridge(ctx);
  }, 120_000);

  it('the socket file removed under a live bridge: it exits with a record, untouched status, and a new one serves', async () => {
    const ctx = machine();
    createNetwork(ctx, { name: 'lost-socket', person: 'kt', relay: 'off' });
    const first = await startBridge(ctx);
    fs.rmSync(controlPath(ctx.dataDir));
    const second = await startBridge(ctx);
    expect(second.started).toBe(true);
    expect(second.pid).not.toBe(first.pid);
    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await expect.poll(() => isAlive(first.pid), { timeout: 8_000 }).toBe(false);
    expect(fs.readFileSync(logPath(ctx.dataDir), 'utf8')).toContain('control_socket_lost');
    // The old one touched neither the newer bridge's status nor its socket.
    expect(readStatus(ctx.dataDir)).toMatchObject({ pid: second.pid, state: 'running', last_error: null });
    expect((await getNetworkStatus(ctx)).bridge).toMatchObject({ running: true, pid: second.pid });
    const token = fs.readFileSync(path.join(path.dirname(controlPath(ctx.dataDir)), 'control.token'), 'utf8');
    expect(token.length).toBe(64);
    expect(await stopBridge(ctx)).toEqual({ stopped: true, pid: second.pid });
    expect(isAlive(second.pid)).toBe(false);
    for (const text of [fs.readFileSync(logPath(ctx.dataDir), 'utf8'), fs.readFileSync(statusPath(ctx.dataDir), 'utf8')]) {
      expect(text).not.toContain(token);
    }
  }, 60_000);

  it('a socket folder unreadable for 1.5 s does not kill the bridge: it stays and answers', async () => {
    const ctx = machine();
    createNetwork(ctx, { name: 'blip', person: 'kt', relay: 'off' });
    const started = await startBridge(ctx);
    const folder = path.dirname(controlPath(ctx.dataDir));
    fs.chmodSync(folder, 0o000);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    fs.chmodSync(folder, 0o700);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await probeBridge(ctx.dataDir)).toMatchObject({ kind: 'running', pid: started.pid, ready: true });
    const log = fs.readFileSync(logPath(ctx.dataDir), 'utf8');
    expect(log).toContain('control_socket_unreadable_retrying');
    expect(log).toContain('control_socket_readable_again');
    expect(log).not.toContain('control_socket_lost');
    await stopBridge(ctx);
  }, 60_000);

  it('a socket folder unreadable for good: the bridge gives up after 30 s, records why, and status does not say running', async () => {
    const ctx = machine();
    createNetwork(ctx, { name: 'gone-dark', person: 'kt', relay: 'off' });
    const started = await startBridge(ctx);
    const folder = path.dirname(controlPath(ctx.dataDir));
    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    fs.chmodSync(folder, 0o000);
    const darkAt = Date.now();
    let gaveUpAfterMs: number;
    try {
      await expect.poll(() => isAlive(started.pid), { timeout: 45_000, interval: 500 }).toBe(false);
      gaveUpAfterMs = Date.now() - darkAt;
    } finally {
      fs.chmodSync(folder, 0o700);
    }
    // Not much earlier than the 30 s it promises: a brief read error must not stop a healthy bridge.
    // (The bridge checks every few seconds, so it may notice the folder up to one check late.)
    expect(gaveUpAfterMs).toBeGreaterThanOrEqual(27_000);
    // Exact events: the retrying line also contains "control_socket_unreadable" as a substring.
    const log = fs.readFileSync(logPath(ctx.dataDir), 'utf8');
    expect(log).toContain('"event":"control_socket_unreadable"');
    expect(log).toMatch(/"event":"stopped","reason":"control_socket_unreadable"/);
    // The status file could not be written while its folder was unreadable; what status reports comes from the socket.
    expect((await getNetworkStatus(ctx)).bridge).toMatchObject({ running: false, unresponsive: false });
  }, 90_000);

  it('a socket lost while a connection is in flight: the old bridge does not overwrite the new one\'s status', async () => {
    const ctx = machine();
    createNetwork(ctx, { name: 'in-flight', person: 'kt', relay: 'off' });
    const member = machine();
    const { link } = await createLink(ctx, { includeAddresses: true, ttlHours: 1 });
    await joinWith(link, 'in-flight-member', member);
    const first = (await getNetworkStatus(ctx)).bridge.pid as number;
    // Connected as a member and silent: the old bridge sits waiting for a stream.
    const builder = iroh.Endpoint.builder();
    builder.applyMinimal();
    builder.secretKey(bytes(loadIdentity(member.dataDir).secret));
    builder.relayMode(iroh.RelayMode.disabled());
    const endpoint = await builder.bind();
    endpoints.push(endpoint);
    const target = new iroh.EndpointAddr(iroh.EndpointId.fromString(loadIdentity(ctx.dataDir).machineId), null, readStatus(ctx.dataDir)?.direct_addresses);
    await endpoint.connect(target, bytes(NET_ALPN));

    fs.rmSync(controlPath(ctx.dataDir));
    const second = await startBridge(ctx);
    expect(second.pid).not.toBe(first);
    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const owners = new Set<number>();
    const until = Date.now() + 8_000;
    while (Date.now() < until && (isAlive(first) || owners.size === 0)) {
      const pid = readStatus(ctx.dataDir)?.pid;
      if (pid) owners.add(pid);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (let i = 0; i < 100; i++) {
      const pid = readStatus(ctx.dataDir)?.pid;
      if (pid) owners.add(pid);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(isAlive(first)).toBe(false);
    expect([...owners]).toEqual([second.pid]);
    await stopBridge(ctx);
  }, 90_000);

  it('stale startup lock, stale socket and 8 real bridges: every round settles to one holder that answers', async () => {
    // Each layer has its own deterministic test in control-socket.test.ts. This is the
    // end-to-end check, kept short for CI; 1000 rounds settled when it was introduced.
    const rounds = 20;
    const settleMs = 2_500;
    const ctx = machine();
    createNetwork(ctx, { name: 'stress', person: 'kt', relay: 'off' });
    const lock = `${controlPath(ctx.dataDir)}.startup.lock`;
    const unsettled: string[] = [];
    const doubleHeld: string[] = [];
    let settled = 0;
    for (let round = 0; round < rounds; round++) {
      // A socket file nobody holds, and a lock from a process that is gone.
      const staleSocket = spawnSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(controlPath(ctx.dataDir))}, () => process.kill(process.pid, 'SIGKILL'));`]);
      expect(staleSocket.signal).toBe('SIGKILL');
      fs.writeFileSync(lock, `${2 ** 30}\n`, { mode: 0o600 });
      const children = Array.from({ length: 8 }, () => spawn(process.execPath, [ctx.bridgeEntry, 'serve'], { env: childEnv(ctx), stdio: 'ignore' }));
      const started = Date.now();
      let holder: number | null = null;
      for (;;) {
        const live = children.filter((child) => child.exitCode === null && child.signalCode === null);
        const probe = await probeBridge(ctx.dataDir, 500);
        if (live.length === 1 && probe.kind === 'running' && probe.ready && probe.pid === live[0].pid) {
          holder = probe.pid;
          break;
        }
        if (Date.now() - started > settleMs) {
          // Report how late it was, and what it looked like, rather than only that it was late.
          const lockText = fs.existsSync(lock) ? fs.readFileSync(lock, 'utf8').trim() : 'none';
          while (Date.now() - started < 20_000 && !(await probeBridge(ctx.dataDir, 500) as { ready?: boolean }).ready) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          unsettled.push(`round ${round}: ${live.length} alive, probe ${JSON.stringify(probe)}, lock ${lockText}, answered after ${Date.now() - started} ms`);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (holder !== null) settled++;
      // Losing is exit 3. Anything else means two got as far as holding the socket, and the heartbeat had to clean up.
      const held = children.filter((child) => child.pid !== holder && child.exitCode !== EXIT_ALREADY_RUNNING).map((child) => child.exitCode ?? child.signalCode);
      if (held.length > 0) doubleHeld.push(`round ${round}: ${JSON.stringify(held)}`);
      await stopBridge(ctx).catch(() => undefined);
      for (const child of children) child.kill('SIGKILL');
      await Promise.all(children.map((child) => (child.exitCode === null && child.signalCode === null ? new Promise((resolve) => { child.once('exit', resolve); }) : null)));
      fs.rmSync(controlPath(ctx.dataDir), { force: true });
    }
    if (process.env.STRESS_LOG_DIR) fs.writeFileSync(path.join(process.env.STRESS_LOG_DIR, 'memesh-stress-result.txt'), `rounds ${rounds} settled ${settled} double-held ${doubleHeld.length}\n${unsettled.join('\n')}\n${doubleHeld.join('\n')}\n`);
    expect(unsettled).toEqual([]);
    expect(doubleHeld).toEqual([]);
    expect(settled).toBe(rounds);
  }, 590_000);

  it('a data dir with a space, a quote and non-ASCII works under a C locale, with the real bridge', async () => {
    const home = makeHome();
    homes.push(home);
    const dataDir = path.join(home, 'q"uo te 測試');
    const ctx: NetworkContext = { ...contextFor(tree, home), dataDir, dbPath: path.join(dataDir, 'knowledge-graph.db') };
    ctx.env = { ...ctx.env, LC_ALL: 'C', LANG: 'C' };
    linkRuntime(ctx, runtime);
    contexts.push(ctx);
    createNetwork(ctx, { name: 'odd-path', person: 'kt', relay: 'off' });
    const started = await startBridge(ctx);
    expect(started.started).toBe(true);
    expect((await getNetworkStatus(ctx)).bridge).toMatchObject({ running: true, pid: started.pid });
    const { link } = await createLink(ctx, { includeAddresses: true, ttlHours: 1 });
    expect(await refusal(joinWith(link, 'odd-member'))).toBe('joined');
    expect(await stopBridge(ctx)).toEqual({ stopped: true, pid: started.pid });
  }, 60_000);

  it('relay state follows its /ping: 200, then 500, before the startup allowance could say the same', async () => {
    const answers = { status: 200 };
    const hits: string[] = [];
    const stub = spawn(process.execPath, ['-e', `
const http = require('http');
let status = 200;
process.stdin.on('data', (d) => { status = Number(d.toString()); });
http.createServer((req, res) => { console.log(req.url); res.statusCode = status; res.end(); }).listen(0, '127.0.0.1', function () { console.log('port=' + this.address().port); });`], { stdio: ['pipe', 'pipe', 'inherit'] });
    stub.stdout.setEncoding('utf8').on('data', (chunk: string) => hits.push(...chunk.trim().split('\n')));
    try {
      await expect.poll(() => hits.some((line) => line.startsWith('port='))).toBe(true);
      const port = (hits.find((line) => line.startsWith('port=')) as string).slice(5);
      const ctx = machine();
      createNetwork(ctx, { name: 'ping-owner', person: 'kt', relay: `http://127.0.0.1:${port}/` });
      await startBridge(ctx);
      await expect.poll(() => hits.includes('/ping'), { timeout: 5_000 }).toBe(true);
      expect(readStatus(ctx.dataDir)).toMatchObject({ relay_state: 'connecting', last_error: null });

      answers.status = 500;
      stub.stdin.write(String(answers.status));
      await expect.poll(() => readStatus(ctx.dataDir)?.relay_state, { timeout: 18_000, interval: 200 }).toBe('unreachable');
      const status = readStatus(ctx.dataDir) as BridgeStatus;
      // Within 20 s of the start, so the ping did this and not the startup allowance.
      expect(Date.parse(status.last_error_at as string) - Date.parse(status.started_at)).toBeLessThan(19_000);
      expect(status.last_error).toMatch(/not answering/);
      await stopBridge(ctx);
    } finally {
      stub.kill('SIGKILL');
    }
  }, 60_000);

  describe('the bridge\'s early exits leave a record', () => {
    const expectFailed = async (ctx: NetworkContext, pattern: RegExp): Promise<void> => {
      const err = await startBridge(ctx).then(() => null, (e: unknown) => e as NetworkError);
      expect(err?.code).toBe('bridge_failed');
      expect(err?.message).toMatch(pattern);
      expect(readStatus(ctx.dataDir)).toMatchObject({ state: 'failed', last_error: expect.stringMatching(pattern) });
      expect(fs.existsSync(controlPath(ctx.dataDir))).toBe(false);
    };

    it('database', async () => {
      const ctx = machine();
      fs.mkdirSync(ctx.dbPath, { recursive: true });
      await expectFailed(ctx, /Cannot open the database/);
    });

    it('not joined', async () => {
      const ctx = machine();
      await expectFailed(ctx, /has not joined/);
    });

    it('identity: wrong size and wrong key', async () => {
      const ctx = machine();
      createNetwork(ctx, { name: 'id-owner', person: 'kt', relay: 'off' });
      fs.writeFileSync(identityPath(ctx.dataDir), Buffer.alloc(31));
      await expectFailed(ctx, /not a valid machine key/);
      fs.writeFileSync(identityPath(ctx.dataDir), randomBytes(32));
      await expectFailed(ctx, /does not match/);
    });

    it('native', async () => {
      const ctx = machine();
      createNetwork(ctx, { name: 'native-owner', person: 'kt', relay: 'off' });
      fs.rmSync(runtimeDir(ctx.dataDir));
      await expectFailed(ctx, /Cannot load the networking component/);
    });

    it('bind', async () => {
      const ctx = machine();
      createNetwork(ctx, { name: 'bind-owner', person: 'kt', relay: 'off' });
      const db = openNetworkStore(ctx.dbPath);
      db.prepare('UPDATE agent_network_config SET relay_url = ?').run('not a url');
      db.close();
      await expectFailed(ctx, /Cannot open a network connection/);
    });

    it('a failure before it holds the socket goes to stderr, not a bare stack, and writes no status', () => {
      const ctx = machine();
      // A file where the network folder should be: the socket cannot even be attempted.
      fs.rmSync(path.dirname(controlPath(ctx.dataDir)), { recursive: true });
      fs.writeFileSync(path.dirname(controlPath(ctx.dataDir)), 'in the way');
      const result = spawnSync(process.execPath, [ctx.bridgeEntry, 'serve'], { env: childEnv(ctx), encoding: 'utf8', timeout: 30_000 });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/failed before it could start/);
      expect(result.stderr).not.toMatch(/\n\s+at /);
    });
  });

  describe('a damaged install', () => {
    const copyRuntime = (ctx: NetworkContext): string => {
      fs.rmSync(runtimeDir(ctx.dataDir), { force: true, recursive: true });
      fs.cpSync(runtime, runtimeDir(ctx.dataDir), { recursive: true });
      const nativePackage = fs.readdirSync(path.join(runtimeDir(ctx.dataDir), 'node_modules/@number0')).find((name) => name !== 'iroh') as string;
      return path.join(runtimeDir(ctx.dataDir), 'node_modules/@number0', nativePackage);
    };

    it('a truncated native file is a clear error, not a crash, and reinstalling repairs it', async () => {
      const ctx = machine();
      createNetwork(ctx, { name: 'damaged', person: 'kt', relay: 'off' });
      const nativePackage = copyRuntime(ctx);
      const nativeFile = fs.readdirSync(nativePackage).find((name) => name.endsWith('.node')) as string;
      fs.truncateSync(path.join(nativePackage, nativeFile), 4096);

      await expect(Promise.resolve().then(() => checkRuntime(ctx))).rejects.toMatchObject({ code: 'runtime_load_failed' });
      const start = await startBridge(ctx).then(() => null, (err: unknown) => err as NetworkError);
      expect(start).toBeInstanceOf(NetworkError);
      expect(start?.code).toBe('bridge_failed');
      expect(start?.message).toMatch(/network up --reinstall/);

      ensureRuntime(ctx, { force: true });
      expect(() => checkRuntime(ctx)).not.toThrow();
    }, 180_000);

    it('start waits until the bridge is really accepting, not just holding its socket', async () => {
      const ctx = machine();
      createNetwork(ctx, { name: 'slow-native', person: 'kt', relay: 'off' });
      // The native load comes after the socket is held and before the bridge is ready.
      const preload = path.join(ctx.dataDir, 'slow-dlopen.cjs');
      fs.writeFileSync(preload, `const real = process.dlopen; process.dlopen = function (...args) { const until = Date.now() + 2500; while (Date.now() < until); return real.apply(this, args); };`);
      ctx.env = { ...ctx.env, NODE_OPTIONS: `--require=${preload}` };
      const started = await startBridge(ctx);
      expect(started.started).toBe(true);
      expect(readStatus(ctx.dataDir)).toMatchObject({ pid: started.pid, state: 'running' });
      await stopBridge(ctx);
    }, 60_000);

    it('a missing platform package is explained plainly', () => {
      const ctx = machine();
      const nativePackage = copyRuntime(ctx);
      fs.rmSync(nativePackage, { recursive: true });
      const check = spawnSync(process.execPath, [ctx.bridgeEntry, 'check'], { env: childEnv(ctx), encoding: 'utf8' });
      expect(check.status).toBe(1);
      expect((JSON.parse(check.stdout) as { reason: string }).reason).toMatch(/missing from the install/);
      expect(check.stdout).not.toMatch(/npm has a bug/);
    });

    it('the real wrapper\'s other names are never tried: planted copies and its environment override do not load', () => {
      const ctx = machine();
      const nativePackage = copyRuntime(ctx);
      const home = ctx.env?.HOME as string;
      const proof = path.join(home, 'PLANTED-LOADED');
      for (const name of ['iroh-darwin-universal', 'iroh-wasm32-wasi', 'iroh-linux-x64-gnu', 'iroh-darwin-arm64']) {
        const planted = path.join(home, 'node_modules/@number0', name);
        fs.mkdirSync(planted, { recursive: true });
        fs.writeFileSync(path.join(planted, 'package.json'), JSON.stringify({ name: `@number0/${name}`, version: '1.2.0', main: 'index.js' }));
        fs.writeFileSync(path.join(planted, 'index.js'), `require('fs').writeFileSync(${JSON.stringify(proof)}, ${JSON.stringify(name)}); module.exports = { Endpoint: { builder() { return {}; } } };`);
      }
      const byVariable = path.join(home, 'by-variable.js');
      fs.writeFileSync(byVariable, `require('fs').writeFileSync(${JSON.stringify(proof)}, 'variable'); module.exports = { Endpoint: { builder() { return {}; } } };`);
      const env = { ...childEnv(ctx), NAPI_RS_NATIVE_LIBRARY_PATH: byVariable };
      const healthy = spawnSync(process.execPath, [ctx.bridgeEntry, 'check'], { env, encoding: 'utf8' });
      expect(healthy.status).toBe(0);
      expect(fs.existsSync(proof)).toBe(false);

      // And with the pinned file damaged, which is when the wrapper would fall back.
      const nativeFile = fs.readdirSync(nativePackage).find((name) => name.endsWith('.node')) as string;
      fs.truncateSync(path.join(nativePackage, nativeFile), 4096);
      const damaged = spawnSync(process.execPath, [ctx.bridgeEntry, 'check'], { env, encoding: 'utf8' });
      expect(damaged.status).not.toBe(0);
      expect(fs.existsSync(proof)).toBe(false);
    });
  });

  describe('the real command line, with a terminal', () => {
    let preload: string;
    let argvLog: string;
    const cliFor = (ctx: NetworkContext, args: string[], input?: string) => spawnSync(
      process.execPath,
      [`--import=${preload}`, tree.cli, 'network', ...args],
      {
        encoding: 'utf8',
        input,
        timeout: 120_000,
        env: { ...ctx.env, ARGV_LOG: argvLog, MEMESH_DIR: undefined, MEMESH_DB_PATH: undefined },
      },
    );

    beforeAll(() => {
      preload = writeTtyPreload(tree.root);
      argvLog = path.join(tree.root, 'argv.jsonl');
    });

    it('create, link and join work end to end, the link is prompted for, and it stays out of the CLI\'s argv', async () => {
      const a = machine();
      const b = machine();
      const c = machine();
      const created = cliFor(a, ['create', '--name', 'cli-a', '--person', 'kt', '--relay', 'off']);
      expect(created.status).toBe(0);
      expect(created.stdout).toMatch(/Created a network/);

      const linked = cliFor(a, ['link', '--include-addresses', '--ttl-hours', '1']);
      expect(linked.status).toBe(0);
      expect(linked.stderr).toMatch(/Started the network bridge/);
      const link = linked.stdout.trim();
      const fields = parseLink(link);
      expect(fields.addrs?.length).toBeGreaterThan(0);

      const joined = cliFor(b, ['join', '--name', 'cli-b', '--person', 'kt', '--relay', 'off'], `${link}\n`);
      expect(joined.status).toBe(0);
      expect(joined.stdout).toMatch(/Joined as kt@cli-b/);
      expect(joined.stdout + joined.stderr).not.toContain(fields.token);
      expect(joined.stderr).toMatch(/Paste the invite link/);
      // Echo off before anything is read, and back on after.
      expect(joined.stderr.indexOf('RAW:true')).toBeGreaterThanOrEqual(0);
      expect(joined.stderr.indexOf('RAW:false')).toBeGreaterThan(joined.stderr.indexOf('RAW:true'));

      const again = cliFor(c, ['join', '--name', 'cli-c', '--person', 'kt', '--relay', 'off'], `${link}\n`);
      expect(again.status).toBe(1);
      expect(again.stderr).toMatch(/already been used/);

      const argvs = fs.readFileSync(argvLog, 'utf8');
      expect(argvs).toContain('cli-b');
      expect(argvs).not.toContain(fields.token);
      expect(argvs).not.toContain('memesh://');

      const status = cliFor(a, ['status', '--json']);
      expect(status.status).toBe(0);
      const view = JSON.parse(status.stdout) as JoinedStatus;
      expect(view.members.map((member) => member.name)).toEqual(['cli-a', 'cli-b']);
      expect(status.stdout).not.toContain(fields.token);

      const plain = cliFor(a, ['status']);
      expect(plain.stdout).toMatch(/Bridge: +running/);
      expect(plain.stdout).toMatch(/kt@cli-b/);
      expect(cliFor(a, ['down']).stdout).toMatch(/Stopped the network bridge/);
      expect(cliFor(a, ['status']).stdout).toMatch(/Bridge: +not running/);
    }, 180_000);

    it('link without the flag puts no address in the link, and only the link on stdout', () => {
      const ctx = machine();
      expect(cliFor(ctx, ['create', '--name', 'cli-relay', '--person', 'kt', '--relay', 'http://127.0.0.1:9/']).status).toBe(0);
      const linked = cliFor(ctx, ['link']);
      expect(linked.status).toBe(0);
      expect(linked.stdout.trim().split('\n').length).toBe(1);
      expect(parseLink(linked.stdout.trim()).addrs).toBeUndefined();
      expect(linked.stderr).toMatch(/Single use/);
      expect(cliFor(ctx, ['down']).status).toBe(0);
    }, 60_000);

    it('an error from the bridge shows in status, stripped of control characters', () => {
      const ctx = machine();
      expect(cliFor(ctx, ['create', '--name', 'cli-status', '--person', 'kt', '--relay', 'off']).status).toBe(0);
      fs.mkdirSync(path.dirname(statusPath(ctx.dataDir)), { recursive: true });
      fs.writeFileSync(statusPath(ctx.dataDir), JSON.stringify({ pid: 1, state: 'failed', last_error: 'boom\u001b]0;PWNED\u0007', last_error_at: 'then' }));
      const status = cliFor(ctx, ['status']);
      // No bridge runs, so its error is history, not current (and still stripped).
      expect(status.stdout).toMatch(/Before it stopped: boom/);
      expect(status.stdout).not.toMatch(/Last error:/);
      expect(status.stdout).not.toMatch(/\u001b/);
    });

    it('with only one side a terminal, the real CLI refuses', () => {
      const ctx = machine();
      const half = path.join(tree.root, 'half-tty.mjs');
      fs.writeFileSync(half, 'process.stdin.isTTY = true;\n');
      const result = spawnSync(process.execPath, [`--import=${half}`, tree.cli, 'network', 'link'], { encoding: 'utf8', env: ctx.env, timeout: 30_000 });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/meant for a person/);
    });
  });
});
