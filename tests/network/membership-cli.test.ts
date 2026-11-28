import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';
import { buildTree, installRuntimeOnce, linkRuntime, reportBridgeFailure } from './helpers.js';
import { ensureIdentity, identityPath } from '../../src/network/identity.js';
import { createRoster, signRoster, verifyRoster } from '../../src/network/roster.js';
import { openNetworkStore, insertConfig, readConfig, signedRosterOf } from '../../src/network/store.js';
import { rememberPeer } from '../../src/network/courier.js';
import { readStatus } from '../../src/network/bridge-state.js';
import { stopBridge } from '../../src/network/bridge-control.js';
import { probeBridge } from '../../src/network/control-socket.js';
import { bootstrapNetworkBridge } from '../../src/network/auto-start.js';
import { ConversationMessages } from '../../src/core/conversation-messages.js';
import { networkMetadataPath, type NetworkContext } from '../../src/network/types.js';
import { buildIsolatedRuntimeEnv } from '../../scripts/lib/isolated-env.mjs';

// Real CLI/control/iroh on one host, relay off. Not three-host discovery proof.
it('normal CLI leaves/removes, stops revoked peers, preserves history, and rejects returning stale membership', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-')));
  const tree = await buildTree({ cli: true });
  const contexts: NetworkContext[] = [];
  const events: unknown[] = [];
  const errors: unknown[] = [];
  const close = (resource: { close(): void }) => {
    try { resource.close(); } catch (error) { errors.push(error); }
  };
  const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const run = (ctx: NetworkContext, args: string[], expectedExit: number | 'revoked-start' = 0, session?: string) => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [tree.cli, session ? 'message' : 'network', ...args], { cwd: root,
      env: session ? { ...ctx.env, CODEX_THREAD_ID: session, CLAUDE_CODE_SESSION_ID: '' } : ctx.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', expired = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); }, 40_000);
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer); events.push({ args, pid: child.pid, code, signal, expired });
      const valid = expectedExit === 'revoked-start' ? code === 0 || (code === 1 && stderr.includes('no longer in a network')) : code === expectedExit;
      if (!valid || expired) reject(new Error(`CLI ${args[0]} exit=${code}: ${stderr}`));
      else resolve(expectedExit === 0 ? stdout : stderr);
    });
  });
  const wait = async (check: () => boolean | Promise<boolean>, phase: string) => {
    const until = Date.now() + 12_000;
    do { if (await check()) { events.push({ phase }); return; } await new Promise(r => setTimeout(r, 100)); } while (Date.now() < until);
    throw new Error(`Membership phase timeout: ${phase}`);
  };
  try {
    const runtime = installRuntimeOnce(tree);
    for (const name of ['alpha', 'beta', 'gamma']) {
      const home = path.join(root, name); fs.mkdirSync(home, { mode: 0o700 });
      const dataDir = path.join(home, 'data'); fs.mkdirSync(dataDir, { mode: 0o700 });
      const dbPath = path.join(dataDir, 'knowledge-graph.db');
      const env = buildIsolatedRuntimeEnv(process.env, { runtimeHome: home, memeshDir: dataDir, dbPath });
      Object.assign(env, { MEMESH_AUTO_UPDATE: 'off', MEMESH_SKIP_UPDATE_CHECK: '1', MEMESH_AUTO_CAPTURE: 'false', MEMESH_TEST_NETWORK_BIND: '127.0.0.1:0' });
      fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ autoUpdate: 'off', updateCheck: false, autoCapture: false }), { mode: 0o600 });
      const ctx = { dataDir, dbPath, env, bridgeEntry: tree.bridgeEntry, assetsDir: tree.assetsDir };
      contexts.push(ctx); linkRuntime(ctx, runtime);
    }
    const ids = contexts.map(c => ensureIdentity(c.dataDir));
    const names = ['alpha', 'beta', 'gamma'];
    const members = ids.map((id, i) => ({ machine_id: id.machineId, name: names[i], person: 'synthetic', joined_at: new Date().toISOString() }));
    const roster = { ...createRoster('8'.repeat(32), members[0]), members };
    const signed = signRoster(ids[0], roster);
    const configs = contexts.map((_ctx, i) => ({ network_id: roster.network_id, owner_id: ids[0].machineId, machine_id: ids[i].machineId,
      machine_name: names[i], person: 'synthetic', relay_url: 'off', roster_json: signed.roster_json, roster_signature: signed.signature }));
    const graphHashes: string[] = [], keyHashes: string[] = [], messageIds: string[] = [];
    contexts.forEach((ctx, i) => {
      // Deliberately retain the pre-upgrade graph config as the no-resurrection canary.
      for (const file of [ctx.dbPath, networkMetadataPath(ctx.dataDir)]) {
        const db = openNetworkStore(file);
        try {
          insertConfig(db, configs[i], Date.now());
          db.pragma('wal_checkpoint(TRUNCATE)');
        } finally { close(db); }
      }
      graphHashes.push(hash(ctx.dbPath)); keyHashes.push(hash(identityPath(ctx.dataDir)));
      const store = new ConversationMessages({ file: path.join(ctx.dataDir, 'messages.db'), machine: names[i] });
      try {
        store.register({ id: `local-${i}`, host: 'codex', machine: names[i], pid: process.pid, wake: {} });
        const sent = store.send(`local-${i}`, { recipient: `local-${i}`, kind: 'result', body: `LOCAL HISTORY ${i}🙂` });
        if (!sent.accepted) throw new Error('Local seed rejected');
        messageIds.push(sent.message.id);
      } finally { close(store); }
    });
    const [a, b, c] = contexts;
    for (const ctx of contexts) await run(ctx, ['up']);
    const addresses = (ctx: NetworkContext) => readStatus(ctx.dataDir)?.bind_addresses?.filter(address => /^127\.0\.0\.1:[1-9]\d{0,4}$/.test(address)) ?? [];
    await wait(() => contexts.every(ctx => addresses(ctx).length === 1), 'loopback-bindings');
    contexts.forEach((ctx, i) => {
      const db = openNetworkStore(networkMetadataPath(ctx.dataDir));
      try { contexts.forEach((peer, j) => { if (i !== j) rememberPeer(db, ids[j].machineId, null, addresses(peer), Date.now()); }); }
      finally { close(db); }
    });
    const bridgePids = contexts.map(ctx => readStatus(ctx.dataDir)!.pid);
    expect(await run(a, ['leave'], 1)).toContain('Owner departure is not supported');
    expect(await run(b, ['remove', 'gamma'], 1)).toContain('Only the owner');
    const left = JSON.parse(await run(b, ['leave', '--json']));
    expect(left).toMatchObject({ action: 'leave', removed: ids[1].machineId, roster_version: 2 });
    await wait(async () => (await probeBridge(b.dataDir)).kind === 'not-running', 'leave-stop');
    expect(JSON.parse(await run(b, ['status', '--json']))).toEqual({ joined: false });
    expect(await bootstrapNetworkBridge(b, tree.cli)).toBe('not-joined');
    expect(await run(b, ['up'], 1)).toContain('not in a network');
    const removed = JSON.parse(await run(a, ['remove', 'gamma', '--json']));
    expect(removed).toMatchObject({ action: 'remove', removed: ids[2].machineId, roster_version: 3, unsynchronized: [] });
    await wait(async () => (await probeBridge(c.dataDir)).kind === 'not-running', 'signed-push-stop');
    expect(JSON.parse(await run(c, ['status', '--json']))).toEqual({ joined: false });
    const repeated = JSON.parse(await run(a, ['remove', ids[2].machineId, '--json']));
    expect(repeated).toMatchObject({ roster_version: 3, already_removed: true });
    // Simulate the retained stale disk state of an offline member, not a new join.
    const stale = openNetworkStore(networkMetadataPath(b.dataDir));
    try {
      insertConfig(stale, configs[1], Date.now());
      rememberPeer(stale, ids[0].machineId, null, addresses(a), Date.now());
    } finally { close(stale); }
    await run(b, ['up'], 'revoked-start');
    await wait(async () => (await probeBridge(b.dataDir)).kind === 'not-running', 'offline-return-self-status-stop');
    expect(JSON.parse(await run(b, ['status', '--json']))).toEqual({ joined: false });
    for (const [i, ctx] of contexts.entries()) {
      expect(hash(ctx.dbPath)).toBe(graphHashes[i]); expect(hash(identityPath(ctx.dataDir))).toBe(keyHashes[i]);
      const store = new ConversationMessages({ file: path.join(ctx.dataDir, 'messages.db'), machine: names[i] });
      try { expect(store.read(`local-${i}`, messageIds[i])?.body).toBe(`LOCAL HISTORY ${i}🙂`); }
      finally { close(store); }
      expect(JSON.parse(await run(ctx, ['read', '--message-id', messageIds[i]], 0, `local-${i}`)).message.body).toBe(`LOCAL HISTORY ${i}🙂`);
      expect(JSON.parse(await run(ctx, ['status', '--message-id', messageIds[i], '--json'], 0, `local-${i}`)).messages[0].id).toBe(messageIds[i]);
      if (i) {
        const db = openNetworkStore(networkMetadataPath(ctx.dataDir));
        try {
          for (const table of ['agent_network_config', 'agent_network_invites', 'agent_network_peers']) expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
        } finally { close(db); }
      }
    }
    const owner = openNetworkStore(networkMetadataPath(a.dataDir));
    try { expect(verifyRoster(signedRosterOf(readConfig(owner)!), ids[0].machineId, roster.network_id).members.map(m => m.machine_id)).toEqual([ids[0].machineId]); }
    finally { close(owner); }
    await run(a, ['down']);
    // Owner offline: an unconfirmed caller retains membership and the helper
    // restores the original stopped state, rather than falsely claiming leave.
    const pending = openNetworkStore(networkMetadataPath(b.dataDir));
    try {
      insertConfig(pending, configs[1], Date.now());
      rememberPeer(pending, ids[0].machineId, null, addresses(a), Date.now());
    } finally { close(pending); }
    expect(await run(b, ['leave', '--json'], 1)).toMatch(/membership|connect|timed out/i);
    expect((await probeBridge(b.dataDir)).kind).toBe('not-running');
    const retained = openNetworkStore(networkMetadataPath(b.dataDir));
    try { expect(readConfig(retained)).toEqual(configs[1]); }
    finally { close(retained); }
    expect(hash(b.dbPath)).toBe(graphHashes[1]);
    events.push({ bridgePids, graphHashes, keyHashes, historyPreserved: true });
  } catch (error) {
    errors.unshift(error);
  }
  const directories = contexts.map(ctx => ctx.dataDir);
  const hadFailure = errors.length > 0;
  if (hadFailure) reportBridgeFailure(directories);
  for (const [index, ctx] of contexts.entries()) {
    try { events.push({ context: index + 1, stop: await stopBridge(ctx) }); }
    catch (error) { errors.push(error); events.push({ context: index + 1, cleanupFailed: true }); }
  }
  if (hadFailure) {
    console.error('Membership bridge evidence after cleanup:');
    reportBridgeFailure(directories);
  }
  try {
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ root, events }, null, 2), { mode: 0o600, flag: 'wx' });
    console.log(`Membership synthetic evidence: ${root}/result.json`);
  } catch (error) {
    errors.push(error);
  }
  if (!hadFailure && errors.length) reportBridgeFailure(directories);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Membership CLI test and cleanup failures', { cause: errors[0] });
}, 120_000);
