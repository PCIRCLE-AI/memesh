import fs from 'node:fs';
import path from 'node:path';
import dgram from 'node:dgram';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ConversationMessages } from '../../src/core/conversation-messages.js';
import { readPublicNetworkContext } from '../../src/core/public-network-context.js';
import { startBridge, stopBridge } from '../../src/network/bridge-control.js';
import { readStatus } from '../../src/network/bridge-state.js';
import { createLink, createNetwork, joinNetwork } from '../../src/network/operations.js';
import { openNetworkStore, readConfig } from '../../src/network/store.js';
import { peerRoute } from '../../src/network/courier.js';
import { networkMetadataPath, type NetworkContext } from '../../src/network/types.js';
import { isPlatformSupported } from '../../src/network/runtime.js';
import { buildIsolatedRuntimeEnv } from '../../scripts/lib/isolated-env.mjs';
import { buildTree, contextFor, installRuntimeOnce, linkRuntime, makeHome, removeTree, type Tree } from './helpers.js';

const lock = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/network/runtime-lock.json'), 'utf8');
const supported = process.platform !== 'win32' && isPlatformSupported(lock, process.platform, process.arch, process.platform === 'linux' ? 'glibc' : null);
const contexts: NetworkContext[] = [];
let tree: Tree;
const metadata = <T>(ctx: NetworkContext, use: (db: ReturnType<typeof openNetworkStore>) => T): T => {
  const db = openNetworkStore(networkMetadataPath(ctx.dataDir));
  try { return use(db); } finally { db.close(); }
};
const messages = <T>(ctx: NetworkContext, use: (store: ConversationMessages) => T): T => {
  const network = readPublicNetworkContext(ctx.dataDir)!;
  const store = new ConversationMessages({ file: path.join(ctx.dataDir, 'messages.db'), machine: network.self.name, network });
  try { return use(store); } finally { store.close(); }
};
const id = (ctx: NetworkContext) => metadata(ctx, db => readConfig(db)!.machine_id);

beforeAll(async () => {
  if (!supported) return;
  tree = await buildTree();
  const runtime = installRuntimeOnce(tree);
  for (let i = 0; i < 3; i++) {
    const home = fs.realpathSync(makeHome());
    const ctx = contextFor(tree, home);
    fs.mkdirSync(ctx.dataDir, { mode: 0o700 });
    ctx.env = { ...buildIsolatedRuntimeEnv(process.env, { runtimeHome: home, memeshDir: ctx.dataDir, dbPath: ctx.dbPath }), MEMESH_AUTO_UPDATE: 'off', MEMESH_AUTO_CAPTURE: 'false' };
    linkRuntime(ctx, runtime);
    contexts.push(ctx);
  }
  const [a, b] = contexts;
  createNetwork(a, { name: 'alpha', person: 'synthetic', relay: 'off' });
  const invite = await createLink(a, { includeAddresses: true });
  await joinNetwork(b, { link: invite.link, name: 'beta', person: 'synthetic', relay: 'off' });
  for (const [ctx, name] of [[a, 'alpha'], [b, 'beta']] as const) messages(ctx, store => store.register({ id: `session-${name}`, host: 'codex', machine: name, pid: process.pid, wake: {} }));
  await startBridge(b);
}, 300_000);

afterAll(async () => {
  let stopped = true;
  for (const ctx of contexts) {
    try { const result = await stopBridge(ctx); if (!result.stopped && result.pid !== null) stopped = false; }
    catch { stopped = false; }
  }
  if (stopped) {
    for (const ctx of contexts) removeTree(path.dirname(ctx.dataDir));
    if (tree) removeTree(tree.root);
  }
});

it.skipIf(!supported)('keeps direct addresses usable when both peers restart', async () => {
  const [a, b] = contexts;
  await expect.poll(() => metadata(a, db => peerRoute(db, id(b))), { timeout: 10_000 }).not.toBeNull();
  await expect.poll(() => [a, b].every(ctx => Boolean(readStatus(ctx.dataDir)?.direct_addresses.length)), { timeout: 5000 }).toBe(true);
  const addresses = [a, b].map(ctx => readStatus(ctx.dataDir)!.direct_addresses);
  for (const ctx of [a, b]) expect((await stopBridge(ctx)).stopped).toBe(true);
  for (const ctx of [a, b]) await startBridge(ctx);
  await expect.poll(() => [a, b].every((ctx, i) => readStatus(ctx.dataDir)!.direct_addresses.some(addr => addresses[i].includes(addr))), { timeout: 5000 }).toBe(true);
  const sent = messages(a, store => store.send('session-alpha', { recipient: 'session-beta@beta', kind: 'question', body: 'After both bridges restart' }));
  await expect.poll(() => messages(b, store => store.status(undefined, sent.message.id)).length, { timeout: 30_000 }).toBe(1);
}, 60_000);

it.skipIf(!supported)('introduces a late member to existing direct-only peers without seeding routes', async () => {
  const [a, b, c] = contexts;
  const invite = await createLink(a, { includeAddresses: true });
  await joinNetwork(c, { link: invite.link, name: 'gamma', person: 'synthetic', relay: 'off' });
  messages(c, store => store.register({ id: 'session-gamma', host: 'codex', machine: 'gamma', pid: process.pid, wake: {} }));
  await startBridge(c);
  await expect.poll(() => contexts.every(ctx => messages(ctx, store => store.discover()).length === 3), { timeout: 30_000 }).toBe(true);
  for (const from of contexts) for (const to of contexts) {
    if (from === to) continue;
    const name = readPublicNetworkContext(to.dataDir)!.self.name;
    const sender = readPublicNetworkContext(from.dataDir)!.self.name;
    const sent = messages(from, store => store.send(`session-${sender}`, { recipient: `session-${name}@${name}`, kind: 'task', body: `Direct ${sender} to ${name}` }));
    await expect.poll(() => messages(to, store => store.status(undefined, sent.message.id)).length, { timeout: 10_000 }).toBe(1);
  }
  expect(metadata(b, db => peerRoute(db, id(c)))).not.toBeNull();
  expect(metadata(c, db => peerRoute(db, id(b)))).not.toBeNull();
}, 90_000);

it.skipIf(!supported)('reports an occupied saved port and keeps it for the next start', async () => {
  const b = contexts[1];
  const saved = readStatus(b.dataDir)!.bind_addresses!;
  const port = Number(saved.find(addr => addr.startsWith('0.0.0.0:'))!.split(':')[1]);
  expect((await stopBridge(b)).stopped).toBe(true);
  const blocker = dgram.createSocket('udp4');
  await new Promise<void>((resolve, reject) => { blocker.once('error', reject); blocker.bind(port, '0.0.0.0', resolve); });
  try {
    await expect(startBridge(b)).rejects.toThrow();
    expect(readStatus(b.dataDir)).toMatchObject({ state: 'failed', bind_addresses: saved });
    expect(readStatus(b.dataDir)!.last_error).toContain('Cannot open a network connection');
  } finally { await new Promise<void>(resolve => blocker.close(() => resolve())); }
  await startBridge(b);
  expect(readStatus(b.dataDir)!.bind_addresses).toEqual(saved);
}, 30_000);
