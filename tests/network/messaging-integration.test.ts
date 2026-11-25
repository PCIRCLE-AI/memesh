// Core messages.db → two source-built native NET/2 bridges. Public CLI/hook
// wiring is covered separately by conversation-courier.test.ts; no model runs.
import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../../src/db.js';
import { ConversationMessages } from '../../src/core/conversation-messages.js';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { readPublicNetworkContext } from '../../src/core/public-network-context.js';
import { startBridge, stopBridge } from '../../src/network/bridge-control.js';
import { readStatus } from '../../src/network/bridge-state.js';
import { createLink, createNetwork, joinNetwork } from '../../src/network/operations.js';
import { isPlatformSupported } from '../../src/network/runtime.js';
import { NET_ALPN, networkMetadataPath, type NetworkContext } from '../../src/network/types.js';
import { rememberPeer } from '../../src/network/courier.js';
import { loadIdentity, ensureIdentity } from '../../src/network/identity.js';
import { openNetworkStore, readConfig, signedRosterOf } from '../../src/network/store.js';
import { bindEndpoint, deadline, toBytes } from '../../src/network/endpoint.js';
import { ACK_MAX_BYTES, exchangeRosterStream, parseAck, parseConversationFrame, type ConversationFrame } from '../../src/network/frames.js';
import { verifyRoster } from '../../src/network/roster.js';
import type { Connection, IrohModule } from '../../src/network/iroh-types.js';
import { buildIsolatedRuntimeEnv } from '../../scripts/lib/isolated-env.mjs';
import { buildTree, contextFor, installRuntimeOnce, linkRuntime, loadIrohForTest, makeHome, removeTree, type Tree } from './helpers.js';

const lockText = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/network/runtime-lock.json'), 'utf8');
const supported = isPlatformSupported(lockText, process.platform, process.arch, process.platform === 'linux' ? 'glibc' : null);
const MARKER = `memory-marker-${randomBytes(6).toString('hex')}`;
const DAY = 86_400_000;

function messageDb<T>(ctx: NetworkContext, use: (db: MemeshDatabase) => T): T {
  const db = new MemeshDatabase(path.join(ctx.dataDir, 'messages.db'));
  try { return use(db); } finally { db.close(); }
}

function metadata<T>(ctx: NetworkContext, use: (db: MemeshDatabase) => T): T {
  const db = openNetworkStore(networkMetadataPath(ctx.dataDir));
  try { return use(db); } finally { db.close(); }
}

function withMessages<T>(ctx: NetworkContext, use: (store: ConversationMessages) => T): T {
  const network = readPublicNetworkContext(ctx.dataDir);
  if (!network) throw new Error('Fixture network is not joined');
  const store = new ConversationMessages({ file: path.join(ctx.dataDir, 'messages.db'), machine: network.self.name, network });
  try { return use(store); } finally { store.close(); }
}

// A failed cleanup retains fixture files rather than deleting a live process's state.
describe.skipIf(!supported || process.platform === 'win32')('messages between two machines (NET/2)', () => {
  let tree: Tree;
  let runtime: string;
  let alpha: NetworkContext;
  let beta: NetworkContext;
  let gamma: NetworkContext;
  let iroh: IrohModule;
  let blackHole: dgram.Socket;
  const children: ChildProcess[] = [];
  const knownBridgePids = new Set<number>();
  const originalMemory = new Map<NetworkContext, unknown>();
  const homes: string[] = [];
  const contexts: NetworkContext[] = [];
  const cleanup: Array<{ pid?: number; stopped: boolean }> = [];
  const frameLog = { alpha: '', beta: '', gamma: '' };
  let bridgesUpAt = 0;

  const machine = (name: 'alpha' | 'beta' | 'gamma'): NetworkContext => {
    const home = fs.realpathSync(makeHome());
    fs.chmodSync(home, 0o700);
    homes.push(home);
    const ctx = contextFor(tree, home);
    fs.mkdirSync(ctx.dataDir, { mode: 0o700 });
    ctx.env = {
      ...buildIsolatedRuntimeEnv(process.env, { runtimeHome: home, memeshDir: ctx.dataDir, dbPath: ctx.dbPath }),
      MEMESH_AUTO_UPDATE: 'off', MEMESH_SKIP_UPDATE_CHECK: '1', MEMESH_AUTO_CAPTURE: 'false', MEMESH_TEST_NETWORK_FRAME_LOG: frameLog[name],
    };
    fs.writeFileSync(path.join(ctx.dataDir, 'config.json'), JSON.stringify({ autoUpdate: 'off', updateCheck: false, autoCapture: false }), { mode: 0o600 });
    linkRuntime(ctx, runtime);
    contexts.push(ctx);
    return ctx;
  };
  const status = (ctx: NetworkContext, id: string) => withMessages(ctx, s => s.status(undefined, id));
  const cards = (ctx: NetworkContext) => withMessages(ctx, s => s.discover());
  const start = async (ctx: NetworkContext) => {
    const result = await startBridge(ctx); knownBridgePids.add(result.pid); return result;
  };
  const memory = (ctx: NetworkContext) => {
    const db = openDatabase(ctx.dbPath);
    try { return { entities: db.prepare('SELECT name,type FROM entities ORDER BY id').all(), observations: db.prepare('SELECT entity_id,content FROM observations ORDER BY id').all() }; }
    finally { closeDatabase(); }
  };
  const send = (body: string, recipient = 'session-b@beta') => withMessages(alpha, s => s.send('session-a', { recipient, kind: 'question', body }));
  const accepted = (id: string) => status(alpha, id)[0]?.events.some(e => e.event === 'network_accepted');
  const age = (ctx: NetworkContext, id: string, days: number) => messageDb(ctx, db => db.prepare('UPDATE messages SET sent_at=? WHERE id=?').run(new Date(Date.now() - days * DAY).toISOString(), id));
  const wireRequest = async (connection: Connection, frame: ConversationFrame) => {
    const stream = await deadline(connection.openBi(), 5000, 'business stream');
    await stream.send.writeAll(toBytes(JSON.stringify(frame))); await stream.send.finish();
    return parseAck(Buffer.from(await deadline(stream.recv.readToEnd(ACK_MAX_BYTES), 5000, 'business ACK')));
  };
  const withWire = async (sender: NetworkContext, recipient: NetworkContext, use: (connection: Connection) => Promise<void>) => {
    await expect.poll(() => readStatus(recipient.dataDir)?.direct_addresses.length ?? 0, { timeout: 5000, interval: 50 }).toBeGreaterThan(0);
    const identity = loadIdentity(sender.dataDir);
    const config = metadata(alpha, db => readConfig(db)!);
    const endpoint = await bindEndpoint(iroh, identity.secret, 'off', []);
    let connection: Connection | undefined;
    try {
      connection = await deadline(endpoint.connect(new iroh.EndpointAddr(iroh.EndpointId.fromString(loadIdentity(recipient.dataDir).machineId), null,
        readStatus(recipient.dataDir)!.direct_addresses), toBytes(NET_ALPN)), 20_000, 'wire connect');
      await exchangeRosterStream(await deadline(connection.openBi(), 5000, 'roster stream'), signedRosterOf(config), offered => {
        verifyRoster(offered, config.owner_id, config.network_id); return offered;
      }, 5000);
      await use(connection);
    } finally {
      connection?.close(0n, toBytes('fixture complete'));
      await endpoint.close();
    }
  };

  beforeAll(async () => {
    tree = await buildTree();
    runtime = installRuntimeOnce(tree);
    iroh = loadIrohForTest(runtime);
    frameLog.alpha = path.join(tree.root, 'frames-alpha.jsonl');
    frameLog.beta = path.join(tree.root, 'frames-beta.jsonl');
    frameLog.gamma = path.join(tree.root, 'frames-gamma.jsonl');
    alpha = machine('alpha'); gamma = machine('gamma'); beta = machine('beta');
    createNetwork(alpha, { name: 'alpha', person: 'synthetic', relay: 'off' });
    const gammaLink = await createLink(alpha, { includeAddresses: true, ttlHours: 1 });
    knownBridgePids.add(gammaLink.bridgePid);
    await joinNetwork(gamma, { link: gammaLink.link, name: 'gamma', person: 'synthetic', relay: 'off' });
    blackHole = dgram.createSocket('udp4');
    await new Promise<void>(resolve => blackHole.bind(0, '127.0.0.1', resolve));
    metadata(alpha, db => rememberPeer(db, loadIdentity(gamma.dataDir).machineId, null, [`127.0.0.1:${blackHole.address().port}`], Date.now()));
    const betaLink = await createLink(alpha, { includeAddresses: true, ttlHours: 1 });
    knownBridgePids.add(betaLink.bridgePid);
    await joinNetwork(beta, { link: betaLink.link, name: 'beta', person: 'synthetic', relay: 'off' });
    for (const [ctx, id, name] of [[alpha, 'session-a', 'alpha'], [beta, 'session-b', 'beta']] as const) {
      const db = openDatabase(ctx.dbPath);
      try {
        const entity = db.prepare("INSERT INTO entities (name, type) VALUES (?, 'note')").run(MARKER);
        db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(entity.lastInsertRowid, `observation ${MARKER}`);
      } finally { closeDatabase(); }
      withMessages(ctx, s => s.register({ id, host: 'codex', machine: name, pid: process.pid, wake: {} }));
      originalMemory.set(ctx, memory(ctx));
    }
    // A known offline recipient, not a discovery positive control. Gamma joined first.
    withMessages(alpha, s => s.upsertRemoteRegistrations(loadIdentity(gamma.dataDir).machineId, [{ id: 'session-g', host: 'codex', online: false }]));
    await start(alpha); await start(beta);
    bridgesUpAt = Date.now();
  }, 300_000);

  afterAll(async () => {
    let allStopped = true;
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await deadline(new Promise<void>(resolve => child.once('close', () => resolve())), 5000, 'fixture child exit').catch(() => { allStopped = false; });
    }
    for (const ctx of contexts) {
      const pid = readStatus(ctx.dataDir)?.pid;
      try {
        const result = await stopBridge(ctx);
        const stopped = result.stopped || result.pid === null;
        cleanup.push({ pid, stopped });
        if (!stopped) allStopped = false;
      } catch { allStopped = false; cleanup.push({ pid, stopped: false }); }
    }
    console.log(`NET/2 owned bridge cleanup: ${JSON.stringify(cleanup)}`);
    const gone = (pid: number) => {
      try { process.kill(pid, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    };
    const stopDeadline = Date.now() + 5000;
    while (![...knownBridgePids].every(gone) && Date.now() < stopDeadline) await new Promise(resolve => setTimeout(resolve, 50));
    if (![...knownBridgePids].every(gone)) allStopped = false;
    console.log(`NET/2 known bridge terminal: ${JSON.stringify([...knownBridgePids].map(pid => ({ pid, gone: gone(pid) })))}`);
    blackHole?.close();
    if (allStopped) {
      homes.forEach(removeTree);
      if (runtime) removeTree(path.dirname(path.dirname(path.dirname(runtime))));
      if (tree) removeTree(tree.root);
    }
    expect(allStopped, 'Known bridges must stop before removing fixtures').toBe(true);
  }, 120_000);

  it('first contact exchanges conversation registrations within 20 seconds', async () => {
    await expect.poll(() => cards(beta).some(c => c.id === 'session-a' && c.machine === 'alpha'), { timeout: 20_000, interval: 100 }).toBe(true);
    await expect.poll(() => cards(alpha).some(c => c.id === 'session-b' && c.machine === 'beta'), { timeout: 20_000, interval: 100 }).toBe(true);
    expect(Date.now() - bridgesUpAt).toBeLessThan(20_000);
  }, 40_000);

  it('copies exact full text while queued; only recipient read returns delivered/read receipts', async () => {
    const body = 'HEAD🙂\nMIDDLE 漢字\nTAIL';
    const sent = withMessages(alpha, s => s.send('session-a', { recipient: 'session-b@beta', kind: 'question', body }));
    expect(sent.accepted).toBe(true);
    const id = sent.message.id;
    await expect.poll(() => status(alpha, id)[0]?.events.some(e => e.event === 'network_accepted'), { timeout: 20_000, interval: 100 }).toBe(true);
    expect(status(alpha, id)[0]).toMatchObject({ ...sent.message, state: 'queued' });
    expect(status(alpha, id)[0].events.some(e => ['delivered', 'read'].includes(e.event))).toBe(false);
    expect(status(beta, id)).toHaveLength(1);
    expect(status(beta, id)[0]).toMatchObject({ ...sent.message, state: 'queued' });
    expect(withMessages(beta, s => s.read('session-b', id))).toEqual(sent.message);
    await expect.poll(() => status(alpha, id)[0]?.state, { timeout: 20_000, interval: 100 }).toBe('read');
    for (const event of ['delivered', 'read']) {
      const receipts = status(alpha, id)[0].events.filter(e => e.event === event);
      expect(receipts).toHaveLength(1);
      expect(JSON.parse(receipts[0].detail)).toMatchObject({ actor: 'session-b' });
      expect(Number.isFinite(Date.parse(receipts[0].at))).toBe(true);
    }
  }, 40_000);

  // Project/principal/address aliases and connection leases are retired. A known
  // conversation stays addressable offline; its actual registered process controls online.
  it('publishes real process online/offline changes within five seconds without deleting its address', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: beta.env, stdio: 'ignore' });
    children.push(child);
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    withMessages(beta, s => s.register({ id: 'short-session', host: 'hermes', machine: 'beta', pid: child.pid!, wake: {} }));
    const began = Date.now();
    await expect.poll(() => cards(alpha).find(c => c.id === 'short-session')?.online, { timeout: 5000, interval: 100 }).toBe(true);
    expect(Date.now() - began).toBeLessThan(5000);
    child.kill('SIGTERM');
    await deadline(new Promise<void>(resolve => child.once('close', () => resolve())), 5000, 'registered fixture process exit');
    const ended = Date.now();
    await expect.poll(() => cards(alpha).find(c => c.id === 'short-session')?.online, { timeout: 5000, interval: 100 }).toBe(false);
    expect(Date.now() - ended).toBeLessThan(5000);
    expect(cards(alpha).find(c => c.id === 'short-session')).toMatchObject({ id: 'short-session', machine: 'beta', host: 'hermes', online: false, pid: 0, wake: {} });
    const queued = send('Offline conversation stays addressable', 'short-session@beta');
    expect(queued.accepted).toBe(true);
    await expect.poll(() => accepted(queued.message.id), { timeout: 20_000 }).toBe(true);
    expect(status(alpha, queued.message.id)[0].state).toBe('queued');
  }, 40_000);

  it('does not send unchanged conversation presence every second', async () => {
    const count = () => fs.readFileSync(frameLog.beta, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(frame => frame.kind === 'conversations').length;
    const before = count();
    await new Promise(resolve => setTimeout(resolve, 8000));
    expect(count() - before).toBeLessThanOrEqual(1);
  }, 30_000);

  it('returns an exact linked reply to the original conversation', async () => {
    const original = send('Please reply to this exact ID').message;
    await expect.poll(() => status(beta, original.id).length, { timeout: 20_000 }).toBe(1);
    const reply = withMessages(beta, s => s.send('session-b', { recipient: 'session-a@alpha', kind: 'result', body: 'FULL REPLY🙂\nlast byte', reply_to: original.id }));
    expect(reply.accepted).toBe(true);
    await expect.poll(() => status(alpha, reply.message.id).length, { timeout: 20_000 }).toBe(1);
    expect(withMessages(alpha, s => s.read('session-a', reply.message.id))).toEqual(reply.message);
    expect(reply.message.reply_to).toBe(original.id);
    expect(status(alpha, original.id)[0].state).toBe('replied');
  }, 40_000);

  it('retries a lost copy ACK over real streams without inserting a second message', async () => {
    expect((await stopBridge(alpha)).stopped).toBe(true);
    const sent = send('Same ID across a deliberately unread ACK').message;
    const betaId = loadIdentity(beta.dataDir).machineId;
    const wire = withMessages(alpha, s => s.outgoingFor(betaId).find(row => row.message.id === sent.id)!);
    expect(wire.message).toEqual(sent);
    await withWire(alpha, beta, async connection => {
      const first = await deadline(connection.openBi(), 5000, 'lost ACK request');
      await first.send.writeAll(toBytes(JSON.stringify({ version: 2, kind: 'conversation-message', row: wire })));
      await first.send.finish();
      // Do not read/record the first response: recipient commit is observed independently.
      await expect.poll(() => status(beta, sent.id).length, { timeout: 5000 }).toBe(1);
      expect(accepted(sent.id)).toBe(false);
    });
    await withWire(alpha, beta, async connection => {
      expect(await wireRequest(connection, { version: 2, kind: 'conversation-message', row: wire })).toEqual({ result: 'duplicate' });
      expect(status(beta, sent.id)).toHaveLength(1);
      expect(status(beta, sent.id)[0]).toMatchObject(sent);
    });
    await start(alpha);
    await expect.poll(() => accepted(sent.id), { timeout: 20_000 }).toBe(true);
    expect(status(alpha, sent.id)[0].events.filter(e => e.event === 'network_accepted')).toHaveLength(1);
    expect(status(beta, sent.id)).toHaveLength(1);
  }, 60_000);

  it('queues while a known machine is offline and delivers once after restart', async () => {
    expect((await stopBridge(beta)).stopped).toBe(true);
    const sent = send('OFFLINE\nFULL BODY🙂').message;
    expect(status(alpha, sent.id)[0].state).toBe('queued');
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(accepted(sent.id)).toBe(false);
    expect(status(beta, sent.id)).toHaveLength(0);
    await start(beta);
    await expect.poll(() => accepted(sent.id), { timeout: 30_000 }).toBe(true);
    expect(status(beta, sent.id)).toHaveLength(1);
    expect(withMessages(beta, s => s.read('session-b', sent.id))).toEqual(sent);
    await expect.poll(() => status(alpha, sent.id)[0].state, { timeout: 20_000 }).toBe('read');
  }, 60_000);

  it('maintains 14-day expiry within 45 seconds while four messages wait for one offline peer', async () => {
    expect((await stopBridge(beta)).stopped).toBe(true);
    const waiting = Array.from({ length: 4 }, (_, i) => send(`WAITING-${i}`).message);
    const expired = send('Expire this fifth message, not the four waiting').message;
    age(alpha, expired.id, 15);
    const began = Date.now();
    // Raw inspection deliberately does not invoke ConversationMessages maintenance.
    await expect.poll(() => messageDb(alpha, db => db.prepare('SELECT id FROM messages WHERE id=?').get(expired.id)), { timeout: 45_000, interval: 250 }).toBeUndefined();
    expect(Date.now() - began).toBeLessThan(45_000);
    expect(messageDb(alpha, db => db.prepare('SELECT * FROM events WHERE message_id=?').all(expired.id))).toHaveLength(0);
    for (const item of waiting) expect(status(alpha, item.id)[0]).toMatchObject({ ...item, state: 'queued' });
    await start(beta);
    await expect.poll(() => waiting.filter(item => accepted(item.id)).length, { timeout: 30_000 }).toBe(4);
    for (const item of waiting) { expect(status(beta, item.id)).toHaveLength(1); expect(status(beta, item.id)[0]).toMatchObject(item); }
  }, 80_000);

  it('notifies once after one day but retains delivery until the original 14-day deadline', async () => {
    expect((await stopBridge(beta)).stopped).toBe(true);
    const old = send('25-hour body stays deliverable').message;
    const retained = send('13-day control').message;
    const purged = send('15-day purge').message;
    age(alpha, old.id, 25 / 24); age(alpha, retained.id, 13); age(alpha, purged.id, 15);
    await expect.poll(() => messageDb(alpha, db => db.prepare("SELECT * FROM events WHERE message_id=? AND event='undelivered_notified'").all(old.id).length), { timeout: 45_000 }).toBe(1);
    expect(status(alpha, old.id)[0].body).toBe(old.body);
    expect(status(alpha, retained.id)).toHaveLength(1);
    expect(status(alpha, purged.id)).toHaveLength(0);
    expect(messageDb(alpha, db => db.prepare('SELECT * FROM events WHERE message_id=?').all(purged.id))).toHaveLength(0);
    const notices = () => withMessages(alpha, s => s.status('session-a').filter(m => m.sender_host === 'system' && m.reply_to === old.id));
    expect(notices()).toHaveLength(1); expect(notices()[0].body).toContain(old.id);
    await new Promise(resolve => setTimeout(resolve, 2200));
    expect(notices()).toHaveLength(1);
    const originalTime = status(alpha, old.id)[0].sent_at;
    await start(beta);
    await expect.poll(() => status(beta, old.id).length, { timeout: 30_000 }).toBe(1);
    expect(withMessages(beta, s => s.read('session-b', old.id))).toMatchObject({ body: old.body, sent_at: originalTime });
    await expect.poll(() => status(alpha, old.id)[0].state, { timeout: 20_000 }).toBe('read');
  }, 80_000);

  it('rejects an unknown conversation with an audit, not a retired project_unknown requirement', () => {
    const before = withMessages(beta, s => s.status());
    const result = send('Do not route by a shared project', 'unknown-session@beta');
    expect(result.accepted).toBe(false);
    expect(status(alpha, result.message.id)[0].state).toBe('rejected');
    expect(status(alpha, result.message.id)[0].events.some(e => e.event === 'rejected')).toBe(true);
    expect(withMessages(beta, s => s.status())).toEqual(before);
  });

  it('exposes conversation identity but never remote process routes or memory summaries', () => {
    const card = cards(alpha).find(c => c.id === 'session-b' && c.machine === 'beta');
    expect(card).toEqual({ id: 'session-b', host: 'codex', machine: 'beta', pid: 0, wake: {}, online: true });
    expect(JSON.stringify(cards(alpha))).not.toContain(MARKER);
  });

  it('an unreachable earlier peer cannot delay a reachable message past three seconds', async () => {
    const unreachable = send('Gamma has no bridge', 'session-g@gamma').message;
    const began = Date.now();
    const reachable = send('Beta must not wait for gamma').message;
    await expect.poll(() => accepted(reachable.id), { timeout: 3000, interval: 50 }).toBe(true);
    expect(Date.now() - began).toBeLessThan(3000);
    expect(status(beta, reachable.id)[0]).toMatchObject(reachable);
    expect(status(alpha, unreachable.id)[0]).toMatchObject({ ...unreachable, state: 'queued' });
    expect(accepted(unreachable.id)).toBe(false);
  }, 10_000);

  it('an unreachable earlier peer cannot delay first-contact presence past five seconds', async () => {
    expect((await stopBridge(beta)).stopped).toBe(true);
    const betaId = loadIdentity(beta.dataDir).machineId;
    const alphaId = loadIdentity(alpha.dataDir).machineId;
    messageDb(alpha, db => db.prepare('DELETE FROM conversations WHERE is_local=0 AND machine_id=?').run(betaId));
    messageDb(beta, db => db.prepare('DELETE FROM conversations WHERE is_local=0 AND machine_id=?').run(alphaId));
    metadata(alpha, db => db.prepare('DELETE FROM agent_network_peers WHERE machine_id=?').run(betaId));
    expect(cards(alpha).some(c => c.id === 'session-b')).toBe(false);
    const began = Date.now();
    await start(beta);
    await expect.poll(() => cards(alpha).some(c => c.id === 'session-b'), { timeout: 5000, interval: 50 }).toBe(true);
    await expect.poll(() => cards(beta).some(c => c.id === 'session-a'), { timeout: 5000, interval: 50 }).toBe(true);
    expect(Date.now() - began).toBeLessThan(5000);
  }, 15_000);

  it('refuses valid-member wrong peer, recipient, network and receipt bindings without writes', async () => {
    const original = send('Unforgeable receipt target').message;
    await expect.poll(() => accepted(original.id), { timeout: 20_000 }).toBe(true);
    const network = readPublicNetworkContext(alpha.dataDir)!;
    const wire = { network_id: network.network_id, sender_machine_id: loadIdentity(alpha.dataDir).machineId,
      recipient_machine_id: loadIdentity(beta.dataDir).machineId, message: original };
    const before = status(beta, original.id);
    const beforeCount = withMessages(beta, s => s.status()).length;
    // Gamma is a genuine signed member, but cannot submit Alpha's message or receipt.
    for (const row of [wire, { ...wire, sender_machine_id: loadIdentity(gamma.dataDir).machineId, recipient_machine_id: loadIdentity(alpha.dataDir).machineId },
      { ...wire, sender_machine_id: loadIdentity(gamma.dataDir).machineId, network_id: '0'.repeat(32) }]) {
      await withWire(gamma, beta, async connection => {
        expect(await wireRequest(connection, { version: 2, kind: 'conversation-message', row })).toEqual({ result: 'retry', code: 'internal' });
      });
      expect(status(beta, original.id)).toEqual(before);
      expect(withMessages(beta, s => s.status())).toHaveLength(beforeCount);
    }
    const senderBefore = status(alpha, original.id);
    await withWire(gamma, alpha, async connection => {
      expect(await wireRequest(connection, { version: 2, kind: 'conversation-receipt', receipt: {
        message_id: original.id, event: 'read', actor: 'session-b', at: new Date().toISOString(),
      } })).toEqual({ result: 'retry', code: 'internal' });
    });
    expect(status(alpha, original.id)).toEqual(senderBefore);
    // Legitimate transport peer with a wrong actor is separately refused.
    expect((await stopBridge(beta)).stopped).toBe(true);
    await withWire(beta, alpha, async connection => {
      expect(await wireRequest(connection, { version: 2, kind: 'conversation-receipt', receipt: {
        message_id: original.id, event: 'read', actor: 'someone-else', at: new Date().toISOString(),
      } })).toEqual({ result: 'retry', code: 'internal' });
    });
    expect(status(alpha, original.id)).toEqual(senderBefore);
    await start(beta);
  }, 90_000);

  it('refuses a nonmember during real signed-roster authorization, not merely old-frame parsing', async () => {
    const home = fs.realpathSync(makeHome()); homes.push(home);
    const outsider = contextFor(tree, home);
    ensureIdentity(outsider.dataDir);
    const before = withMessages(beta, s => s.status());
    const config = metadata(alpha, db => readConfig(db)!);
    await expect.poll(() => readStatus(beta.dataDir)?.direct_addresses.length ?? 0, { timeout: 5000, interval: 50 }).toBeGreaterThan(0);
    const endpoint = await bindEndpoint(iroh, loadIdentity(outsider.dataDir).secret, 'off', []);
    let connection: Connection | undefined;
    try {
      connection = await deadline(endpoint.connect(new iroh.EndpointAddr(iroh.EndpointId.fromString(loadIdentity(beta.dataDir).machineId), null,
        readStatus(beta.dataDir)!.direct_addresses), toBytes(NET_ALPN)), 20_000, 'nonmember connect');
      const stream = await deadline(connection.openBi(), 5000, 'nonmember roster stream');
      await expect(exchangeRosterStream(stream, signedRosterOf(config), offered => {
        verifyRoster(offered, config.owner_id, config.network_id); return offered;
      }, 5000)).rejects.not.toThrow(/timed out/);
      // A generic close or malformed-frame failure is not membership proof.
      expect(await deadline(connection.closed(), 5000, 'nonmember refusal')).toContain('not_a_member');
      expect(withMessages(beta, s => s.status())).toEqual(before);
    } finally {
      connection?.close(0n, toBytes('fixture complete')); await endpoint.close();
    }
  }, 30_000);

  it('captures nonempty exact NET/2 wire frames and leaves both memory graphs unchanged', () => {
    const frames: ConversationFrame[] = [];
    for (const ctx of [alpha, beta]) {
      const file = ctx === alpha ? frameLog.alpha : frameLog.beta;
      expect(fs.statSync(path.dirname(file)).mode & 0o077).toBe(0);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const text = fs.readFileSync(file, 'utf8');
      expect(text).not.toContain(MARKER);
      expect(text).not.toContain('work_summary');
      const rows = text.trim().split('\n').map(line => {
        // Independent raw-wire assertions must not inherit a loosened product parser.
        const raw: ConversationFrame = JSON.parse(line);
        expect(raw.version).toBe(2);
        switch (raw.kind) {
          case 'conversations':
            expect(Object.keys(raw).sort()).toEqual(['version', 'kind', 'relay', 'addrs', 'entries'].sort());
            for (const entry of raw.entries) expect(Object.keys(entry).sort()).toEqual(['id', 'host', 'online'].sort());
            break;
          case 'conversation-message':
            expect(Object.keys(raw).sort()).toEqual(['version', 'kind', 'row'].sort());
            break;
          case 'conversation-receipt':
            expect(Object.keys(raw).sort()).toEqual(['version', 'kind', 'receipt'].sort());
            break;
          default:
            expect.unreachable('Unknown NET/2 frame kind');
        }
        return parseConversationFrame(Buffer.from(line));
      });
      expect(rows.length).toBeGreaterThan(0);
      for (const frame of rows) {
        if (frame.kind === 'conversation-message') {
          expect(Object.keys(frame.row.message).sort()).toEqual(['id','sender','sender_host','sender_machine','recipient','recipient_host','recipient_machine','kind','body','body_bytes','reply_to','sent_at'].sort());
        }
        if (frame.kind === 'conversation-receipt') expect(Object.keys(frame.receipt).sort()).toEqual(['message_id','event','actor','at'].sort());
      }
      frames.push(...rows);
      expect(memory(ctx)).toEqual(originalMemory.get(ctx));
    }
    expect(new Set(frames.map(frame => frame.kind))).toEqual(new Set(['conversations', 'conversation-message', 'conversation-receipt']));
  });
});
