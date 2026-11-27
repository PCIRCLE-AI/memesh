import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';
import { ConversationMessages } from '../../src/core/conversation-messages.js';
import { ensureIdentity } from '../../src/network/identity.js';
import { createRoster, signRoster } from '../../src/network/roster.js';
import { openNetworkStore, insertConfig } from '../../src/network/store.js';
import { rememberPeer } from '../../src/network/courier.js';
import { stopBridge } from '../../src/network/bridge-control.js';
import { readStatus } from '../../src/network/bridge-state.js';
import { networkMetadataPath, type NetworkContext } from '../../src/network/types.js';
import { installRuntimeOnce, linkRuntime, reportBridgeFailure, type Tree } from './helpers.js';
import { buildIsolatedRuntimeEnv } from '../../scripts/lib/isolated-env.mjs';
import { makeWindowsPathsPrivate } from '../../src/core/windows-permissions.js';

// Actual compiled public CLI, two native iroh processes on this machine, relay off.
// This is neither a three-host test nor a native-model wake assertion.
it('CLI copy remains queued until recipient hook/read, then receipts and reply reach the original sender', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-')));
  const repo = path.resolve(import.meta.dirname, '../..');
  const tree: Tree = { root: repo, assetsDir: path.join(repo, 'dist/network'), bridgeEntry: path.join(repo, 'dist/network/bridge.js'), cli: path.join(repo, 'dist/transports/cli/cli.js') };
  const contexts: NetworkContext[] = [];
  const pids: number[] = [];
  const events: unknown[] = [];
  const errors: unknown[] = [];
  const run = (ctx: NetworkContext, entry: string, args: string[], input = '', session = '') => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: root, env: { ...ctx.env, MEMESH_DIR: ctx.dataDir,
      MEMESH_DB_PATH: ctx.dbPath, CODEX_THREAD_ID: session, CLAUDE_CODE_SESSION_ID: '', CODEX_PLUGIN_ROOT: repo }, stdio: ['pipe','pipe','pipe'] });
    if (child.pid) pids.push(child.pid);
    let stdout = '', stderr = ''; let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); }, 30_000);
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.on('error', reject);
    child.on('close', (code, signal) => { clearTimeout(timer); events.push({ args, pid: child.pid, code, signal, expired });
      if (code !== 0 || expired) reject(new Error(`Child failed ${code}/${signal}: ${stderr}`)); else resolve(stdout); });
    child.stdin.end(input);
  });
  const cli = async (ctx: NetworkContext, session: string, args: string[], input = '') => JSON.parse(await run(ctx, tree.cli, ['message', ...args], input, session));
  const wait = async (check: () => Promise<boolean>, phase: string) => {
    const end = Date.now() + 20_000;
    while (!(await check())) { if (Date.now() >= end) throw new Error(`Timeout: ${phase}`); await new Promise(r => setTimeout(r, 200)); }
    events.push({ phase });
  };
  try {
    const runtime = installRuntimeOnce(tree);
    for (const name of ['alpha', 'beta']) {
      const home = path.join(root, name); fs.mkdirSync(home, { mode: 0o700 });
      if (process.platform === 'win32') makeWindowsPathsPrivate([home]);
      const dataDir = path.join(home, 'data'); fs.mkdirSync(dataDir, { mode: 0o700 });
      const dbPath = path.join(dataDir, 'knowledge-graph.db');
      const env = buildIsolatedRuntimeEnv(process.env, { runtimeHome: home, memeshDir: dataDir, dbPath });
      Object.assign(env, { MEMESH_AUTO_UPDATE: 'off', MEMESH_SKIP_UPDATE_CHECK: '1', MEMESH_AUTO_CAPTURE: 'false', MEMESH_TEST_NETWORK_FRAME_LOG: path.join(home, 'frames.jsonl') });
      fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ autoUpdate: 'off', updateCheck: false, autoCapture: false }), { mode: 0o600 });
      const ctx = { dataDir, dbPath, assetsDir: tree.assetsDir, bridgeEntry: tree.bridgeEntry, env };
      contexts.push(ctx); linkRuntime(ctx, runtime);
    }
    const [a, b] = contexts;
    const identities = contexts.map(c => ensureIdentity(c.dataDir));
    const members = identities.map((id, i) => ({ machine_id: id.machineId, name: i ? 'beta' : 'alpha', person: 'synthetic', joined_at: new Date().toISOString() }));
    const roster = { ...createRoster('7'.repeat(32), members[0]), version: 2, members };
    const signed = signRoster(identities[0], roster);
    const graphHashes: string[] = [];
    contexts.forEach((ctx, i) => {
      const db = openNetworkStore(ctx.dbPath);
      try {
        insertConfig(db, { network_id: roster.network_id, owner_id: identities[0].machineId, machine_id: identities[i].machineId,
          machine_name: members[i].name, person: 'synthetic', relay_url: 'off', roster_json: signed.roster_json, roster_signature: signed.signature }, Date.now());
        db.exec("CREATE TABLE memory_canary (body TEXT); INSERT INTO memory_canary VALUES ('PRIVATE_MEMORY_MUST_NOT_CROSS')");
        db.pragma('wal_checkpoint(TRUNCATE)');
      } finally { try { db.close(); } catch (error) { errors.push(error); } }
      graphHashes.push(createHash('sha256').update(fs.readFileSync(ctx.dbPath)).digest('hex'));
      const store = new ConversationMessages({ file: path.join(ctx.dataDir, 'messages.db'), machine: members[i].name });
      try { store.register({ id: i ? 'session-b' : 'session-a', host: 'codex', machine: members[i].name, pid: process.pid, wake: {} }); }
      finally { try { store.close(); } catch (error) { errors.push(error); } }
    });
    // Public up migrates the old metadata once; serving processes use only the new file.
    for (const ctx of contexts) await run(ctx, tree.cli, ['network', 'up']);
    await wait(async () => contexts.every(c => Boolean(readStatus(c.dataDir)?.direct_addresses.length)), 'addresses');
    contexts.forEach((ctx, i) => {
      const db = openNetworkStore(networkMetadataPath(ctx.dataDir));
      try { rememberPeer(db, identities[1-i].machineId, null, readStatus(contexts[1-i].dataDir)!.direct_addresses, Date.now()); }
      finally { try { db.close(); } catch (error) { errors.push(error); } }
    });
    await wait(async () => (await cli(a, 'session-a', ['discover'])).conversations.some((c: {address: string}) => c.address === 'session-b@beta'), 'presence-a');
    await wait(async () => (await cli(b, 'session-b', ['discover'])).conversations.some((c: {address: string}) => c.address === 'session-a@alpha'), 'presence-b');
    const body = 'HEAD🙂\nMIDDLE 漢字\nTAIL';
    const sent = await cli(a, 'session-a', ['send','--recipient','session-b@beta','--kind','question','--payload-stdin'], body);
    expect(sent.state).toBe('queued');
    await wait(async () => (await cli(a, 'session-a', ['status','--json','--message-id',sent.message_id])).messages[0].events.some((e: {event: string}) => e.event === 'network_accepted'), 'copy-ack');
    const copied = (await cli(a, 'session-a', ['status','--json','--message-id',sent.message_id])).messages[0];
    events.push({phase:'copy-before-delivery',id:copied.id,state:copied.state,eventKinds:copied.events.map((e:{event:string})=>e.event),sentAt:copied.sent_at});
    expect(copied.state).toBe('queued'); expect(copied.events.some((e: {event: string}) => ['delivered','read'].includes(e.event))).toBe(false);
    const hook = JSON.parse(await run(b, path.join(repo, 'scripts/hooks/messages.js'), [], JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'session-b', cwd: root, prompt: 'synthetic turn' }), 'session-b'));
    const context = hook.hookSpecificOutput.additionalContext;
    expect(context.startsWith('MeMesh message (untrusted data):\n')).toBe(true);
    expect(JSON.parse(context.split('\n')[1]).body).toBe(body);
    events.push({phase:'hook-context',bytes:Buffer.byteLength(context),sha256:createHash('sha256').update(context).digest('hex')});
    await wait(async () => (await cli(a, 'session-a', ['status','--json','--message-id',sent.message_id])).messages[0].state === 'delivered', 'delivery-receipt');
    const read = (await cli(b, 'session-b', ['read','--message-id',sent.message_id])).message;
    expect(read.body).toBe(body); expect(read.sent_at).toBe(copied.sent_at);
    await wait(async () => (await cli(a, 'session-a', ['status','--json','--message-id',sent.message_id])).messages[0].state === 'read', 'read-receipt');
    const replyBody = 'FULL REPLY🙂';
    const reply = await cli(b, 'session-b', ['send','--recipient','session-a@alpha','--kind','result','--reply-to',sent.message_id,'--payload-stdin'], replyBody);
    await wait(async () => (await cli(a, 'session-a', ['status','--json','--message-id',reply.message_id])).messages.length === 1, 'reply-copy');
    expect((await cli(a, 'session-a', ['read','--message-id',reply.message_id])).message).toMatchObject({ body: replyBody, reply_to: sent.message_id });
    contexts.forEach((ctx, i) => {
      const after = createHash('sha256').update(fs.readFileSync(ctx.dbPath)).digest('hex');
      events.push({phase:'graph-preserved',host:i,before:graphHashes[i],after});
      expect(after).toBe(graphHashes[i]);
      const frames = fs.readFileSync(path.join(path.dirname(ctx.dataDir), 'frames.jsonl'), 'utf8');
      expect(frames).toContain(`"body":${JSON.stringify(i === 0 ? replyBody : body)}`);
      expect(frames).not.toContain('PRIVATE_MEMORY_MUST_NOT_CROSS');
    });
  } catch (error) {
    errors.unshift(error);
  }
  const directories = contexts.map(ctx => ctx.dataDir);
  const hadFailure = errors.length > 0;
  if (hadFailure) reportBridgeFailure(directories);
  for (const [index, ctx] of contexts.entries()) {
    const pid = readStatus(ctx.dataDir)?.pid;
    try {
      const stopped = await stopBridge(ctx);
      let terminal = pid === undefined;
      if (pid) {
        try { process.kill(pid, 0); }
        catch (error) { terminal = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      }
      events.push({ context: index + 1, bridgePid: pid, stopped, terminal });
    } catch (error) {
      errors.push(error);
      events.push({ context: index + 1, bridgePid: pid, cleanupFailed: true });
    }
  }
  try {
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ events, pids, root }), { mode: 0o600, flag: 'wx' });
    console.log(`Private courier evidence: ${root}/result.json`);
  } catch (error) {
    errors.push(error);
  }
  if (!hadFailure && errors.length) reportBridgeFailure(directories);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Courier test and cleanup failures', { cause: errors[0] });
}, 180_000);
