// Real processes on real sockets: throwaway HOMEs, real bridges, the real native
// transport, relay off, direct addresses. Needs the npm registry once per run to
// install the runtime. Skipped on a computer the pin does not cover (Intel Mac),
// and on Windows, where this path has never been measured.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBridge, stopBridge } from '../../src/network/bridge-control.js';
import { lockPath, logPath, readStatus, statusPath, type BridgeStatus } from '../../src/network/bridge-state.js';
import { identityPath, loadIdentity } from '../../src/network/identity.js';
import type { Connection, Endpoint, IrohModule } from '../../src/network/iroh-types.js';
import { encodeLink, parseLink } from '../../src/network/invites.js';
import { JOIN_REQUEST_MAX_BYTES } from '../../src/network/join-protocol.js';
import { bridgeUp, createLink, createNetwork, getNetworkStatus as readNetworkStatus, joinNetwork, type JoinedStatus } from '../../src/network/operations.js';
import { verifyRoster } from '../../src/network/roster.js';
import { checkRuntime, ensureRuntime, isPlatformSupported } from '../../src/network/runtime.js';
import { openNetworkStore, readConfig, signedRosterOf } from '../../src/network/store.js';
import {
  EXIT_ALREADY_RUNNING, JOIN_ALPN, NET_ALPN, NetworkError, childEnv, runtimeDir, type NetworkContext,
} from '../../src/network/types.js';
import { buildTree, contextFor, installRuntimeOnce, linkRuntime, loadIrohForTest, makeHome, removeTree, type Tree } from './helpers.js';

const lockText = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/network/runtime-lock.json'), 'utf8');
const supported = isPlatformSupported(lockText, process.platform, process.arch, process.platform === 'linux' ? 'glibc' : null);

const bytes = (value: string | Buffer): number[] => Array.from(Buffer.from(value));

const getNetworkStatus = (ctx: NetworkContext): JoinedStatus => {
  const status = readNetworkStatus(ctx);
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
  const inviteFrom = (ctx: NetworkContext) => createLink(ctx, { includeAddresses: true, ttlHours: 1 });
  const joinWith = (link: string, name: string, ctx = machine()) => joinNetwork(ctx, { link, name, person: 'kt', relay: 'off' });
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
    tree = await buildTree();
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

    const ownerView = getNetworkStatus(owner);
    const memberView = getNetworkStatus(member);
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
    const { link } = await createLink(owner, { includeAddresses: true, ttlMs: 1 });
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
    const otherNetwork = encodeLink(identity, { ...fields, network_id: 'some-other-network' });
    expect(await refusal(joinWith(otherNetwork, 'wrong'))).toBe('wrong_network');
  });

  it('a taken name is refused, and the same link then works with another name', async () => {
    const { link } = await inviteFrom(owner);
    const ctx = machine();
    expect(await refusal(joinWith(link, 'owner', ctx))).toBe('name_taken');
    expect(await refusal(joinWith(link, 'renamed', ctx))).toBe('joined');
  });

  it('simultaneous joins of one link give exactly one winner', async () => {
    const { link } = await inviteFrom(owner);
    const outcomes = await Promise.all(['race-a', 'race-b', 'race-c'].map((name) => refusal(joinWith(link, name))));
    expect([...outcomes].sort()).toEqual(['invite_used', 'invite_used', 'joined']);
  });

  it('a non-member is closed with no data read', async () => {
    const before = ownerStatus().non_member_refused;
    const marker = `marker-${randomBytes(8).toString('hex')}`;
    const connection = await dial(NET_ALPN);
    let reply: Buffer | null = null;
    let streamError: unknown = null;
    try {
      const stream = await connection.openBi();
      await stream.send.writeAll(bytes(marker));
      await stream.send.finish();
      reply = Buffer.from(await stream.recv.readToEnd(1024));
    } catch (err) {
      streamError = err;
    }
    const reason = await Promise.race([
      connection.closed(),
      new Promise((resolve) => setTimeout(() => resolve('still open'), 10_000)),
    ]);
    expect(String(reason)).toMatch(/not_a_member/);
    expect(reply).toBeNull();
    expect(streamError).not.toBeNull();
    await expect.poll(() => ownerStatus().non_member_refused).toBe(before + 1);
    expect(ownerStatus().member_stub_served).toBe(0);
    expect(fs.readFileSync(logPath(owner.dataDir), 'utf8')).not.toContain(marker);
  });

  it('a member gets through to the stub', async () => {
    const member = machine();
    const { link } = await inviteFrom(owner);
    await joinWith(link, 'stub-member', member);
    const connection = await dial(NET_ALPN, loadIdentity(member.dataDir).secret);
    const stream = await connection.openBi();
    await stream.send.writeAll(bytes('hello'));
    await stream.send.finish();
    const reply = Buffer.from(await stream.recv.readToEnd(1024)).toString();
    connection.close(0n, bytes('done'));
    expect(JSON.parse(reply)).toEqual({ ok: false, error: 'not_implemented' });
    await expect.poll(() => ownerStatus().member_stub_served).toBeGreaterThan(0);
  });

  it('an oversized join request is bounded: refused, recorded, and the bridge survives', async () => {
    const connection = await dial(JOIN_ALPN);
    const stream = await connection.openBi();
    await stream.send.writeAll(bytes(Buffer.alloc(JOIN_REQUEST_MAX_BYTES + 1, 0x61)));
    await stream.send.finish();
    const reason = await Promise.race([
      connection.closed(),
      new Promise((resolve) => setTimeout(() => resolve('still open'), 20_000)),
    ]);
    expect(String(reason)).not.toBe('still open');
    expect(getNetworkStatus(owner).bridge.running).toBe(true);
    expect(ownerStatus().last_error).toBeTruthy();
    const { link } = await inviteFrom(owner);
    expect(await refusal(joinWith(link, 'after-oversize'))).toBe('joined');
  });

  it('one bridge per data dir: a second exits and the first keeps running', async () => {
    const first = getNetworkStatus(owner).bridge.pid;
    const second = spawnSync(process.execPath, [owner.bridgeEntry, 'serve'], { env: childEnv(owner), encoding: 'utf8', timeout: 30_000 });
    expect(second.status).toBe(EXIT_ALREADY_RUNNING);
    expect(getNetworkStatus(owner).bridge.pid).toBe(first);
    expect((await startBridge(owner)).started).toBe(false);
    expect((await bridgeUp(owner)).pid).toBe(first);
  });

  it('a member cannot make invites', async () => {
    const member = machine();
    const { link } = await inviteFrom(owner);
    await joinWith(link, 'no-invites', member);
    expect(await refusal(inviteFrom(member))).toBe('not_owner');
  });

  it('down stops the bridge and leaves a record; up starts again; a stale lock is cleared', async () => {
    const stopped = await stopBridge(owner);
    expect(stopped.stopped).toBe(true);
    expect(getNetworkStatus(owner).bridge.running).toBe(false);
    expect(readStatus(owner.dataDir)?.state).toBe('stopped');
    expect((await stopBridge(owner)).stopped).toBe(false);

    // A pid that is alive but is not a bridge: this test process. It must not be
    // mistaken for one, and `down` must never signal it.
    fs.writeFileSync(lockPath(owner.dataDir), `${process.pid}\n`);
    expect((await stopBridge(owner)).stopped).toBe(false);
    const again = await startBridge(owner);
    expect(again.started).toBe(true);
    expect(getNetworkStatus(owner).bridge.pid).toBe(again.pid);

    // A bridge that died without cleaning up leaves a lock the next start clears.
    process.kill(again.pid, 'SIGKILL');
    await expect.poll(() => getNetworkStatus(owner).bridge.running, { timeout: 10_000 }).toBe(false);
    expect((await startBridge(owner)).started).toBe(true);
  }, 120_000);

  it('a relay that does not answer is recorded, and the bridge keeps serving', async () => {
    const ctx = machine();
    createNetwork(ctx, { name: 'no-relay', person: 'kt', relay: 'http://127.0.0.1:9/' });
    await startBridge(ctx);
    expect(readStatus(ctx.dataDir)?.relay_state).toBe('connecting');
    await expect.poll(() => readStatus(ctx.dataDir)?.relay_state, { timeout: 40_000, interval: 500 }).toBe('unreachable');
    expect(readStatus(ctx.dataDir)?.last_error).toMatch(/did not answer/);
    expect(getNetworkStatus(ctx).bridge.running).toBe(true);
    await stopBridge(ctx);
  }, 90_000);

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
      expect(start?.message).not.toMatch(/npm has a bug/);

      ensureRuntime(ctx, { force: true });
      expect(() => checkRuntime(ctx)).not.toThrow();
    }, 180_000);

    it('a missing platform package is explained without the misleading npm message', () => {
      const ctx = machine();
      fs.mkdirSync(path.dirname(runtimeDir(ctx.dataDir)), { recursive: true });
      const nativePackage = copyRuntime(ctx);
      fs.rmSync(nativePackage, { recursive: true });
      const check = spawnSync(process.execPath, [ctx.bridgeEntry, 'check'], { env: childEnv(ctx), encoding: 'utf8' });
      expect(check.status).toBe(1);
      expect(JSON.parse(check.stdout).reason).toMatch(/missing from the install/);
      expect(check.stdout).not.toMatch(/npm has a bug/);
    });
  });
});
