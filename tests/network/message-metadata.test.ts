import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { ConversationMessages } from '../../src/core/conversation-messages.js';
import { openPublicNetworkDatabase, readPublicNetworkContext } from '../../src/core/public-network-context.js';
import { migrateNetworkMetadata } from '../../src/network/metadata.js';
import { networkMetadataPath } from '../../src/network/types.js';
import { ensureIdentity } from '../../src/network/identity.js';
import { createRoster, signRoster } from '../../src/network/roster.js';
import { openNetworkStore, insertConfig, saveRoster } from '../../src/network/store.js';
import { conversationPresenceFrames, FRAME_MAX_BYTES, parseConversationFrame } from '../../src/network/frames.js';
import { bootstrapNetworkBridge } from '../../src/network/auto-start.js';
import { bridgeUp } from '../../src/network/operations.js';
import { serve } from '../../src/network/bridge-serve.js';
import { stopBridge } from '../../src/network/bridge-control.js';
import { readStatus } from '../../src/network/bridge-state.js';
import { installRuntimeOnce, linkRuntime, type Tree } from './helpers.js';
import { buildIsolatedRuntimeEnv } from '../../scripts/lib/isolated-env.mjs';
import { expectPrivateFile, makeWindowsAclPublic, readWindowsAcl } from '../helpers/permissions.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(r => fs.rmSync(r, { recursive: true, force: true })); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nm-'))); roots.push(root);
  const ctx = { dataDir: root, dbPath: path.join(root, 'graph.db'), bridgeEntry: path.join(root, 'unused.js'), assetsDir: root };
  const owner = ensureIdentity(root), self = ensureIdentity(path.join(root, 'other'));
  const members = [owner, self].map((i, n) => ({ machine_id: i.machineId, name: n ? 'self' : 'owner', person: 'test', joined_at: new Date().toISOString() }));
  const roster = { ...createRoster('8'.repeat(32), members[0]), version: 2, members };
  const signed = signRoster(owner, roster);
  const db = openNetworkStore(ctx.dbPath);
  insertConfig(db, { network_id: roster.network_id, owner_id: owner.machineId, machine_id: self.machineId,
    machine_name: 'self', person: 'test', relay_url: 'off', roster_json: signed.roster_json, roster_signature: signed.signature }, Date.now());
  db.prepare('INSERT INTO agent_network_invites (hash,expires_at_ms,used_at) VALUES (?,?,?)').run('synthetic-hash', Date.now()+10000, null);
  db.prepare('INSERT INTO agent_network_peers VALUES (?,?,?,?)').run(owner.machineId, null, '[]', Date.now());
  db.exec("CREATE TABLE memory_canary (body TEXT); INSERT INTO memory_canary VALUES ('memory must remain local')");
  db.pragma('wal_checkpoint(TRUNCATE)'); db.close();
  return { root, ctx, owner, self, roster };
}
const hash = (p: string) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

it.each(['same-path', 'inode-alias'])('refuses graph/messages collision before up or serve writes: %s', async kind => {
  const f = fixture();
  const file = path.join(f.root, 'messages.db');
  if (kind === 'same-path') fs.renameSync(f.ctx.dbPath, file);
  else fs.linkSync(f.ctx.dbPath, file);
  const selected = kind === 'same-path' ? file : f.ctx.dbPath;
  const before = hash(selected);
  vi.stubEnv('MEMESH_DB_PATH', selected); vi.stubEnv('MEMESH_DIR', f.root);
  await expect(bridgeUp({ ...f.ctx, dbPath: selected })).rejects.toThrow();
  await expect(serve(f.root, networkMetadataPath(f.root))).rejects.toThrow();
  expect(hash(selected)).toBe(before);
  expect(fs.existsSync(networkMetadataPath(f.root))).toBe(false);
  const db = new (await import('../../src/storage/sqlite.js')).MemeshDatabase(selected, { readOnly: true });
  try {
    expect(db.prepare('SELECT body FROM memory_canary').get()).toEqual({ body: 'memory must remain local' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('messages','conversations','events')").all()).toEqual([]);
  } finally { db.close(); }
  expect(hash(selected)).toBe(before);
});

it('moves only three metadata tables atomically and reuses publication without changing source bytes', async () => {
  const f = fixture(), before = hash(f.ctx.dbPath);
  expect(readPublicNetworkContext(f.root)).toBeUndefined();
  expect(await migrateNetworkMetadata(f.ctx)).toBe(true);
  expect(await migrateNetworkMetadata(f.ctx)).toBe(true);
  expect(hash(f.ctx.dbPath)).toBe(before);
  const db = openPublicNetworkDatabase(networkMetadataPath(f.root))!;
  try {
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name))
      .toEqual(['agent_network_config','agent_network_invites','agent_network_peers']);
    expect(db.prepare('SELECT * FROM agent_network_invites').all()).toHaveLength(1);
    expect(db.prepare('SELECT * FROM agent_network_peers').all()).toHaveLength(1);
  } finally { db.close(); }
  expect(readPublicNetworkContext(f.root)?.self.id).toBe(f.self.machineId);
  expectPrivateFile(networkMetadataPath(f.root));
});

it('keeps local read/status after signed removal while remote authorization closes visibly', async () => {
  const f = fixture(); await migrateNetworkMetadata(f.ctx);
  vi.stubEnv('MEMESH_DB_PATH', f.ctx.dbPath); vi.stubEnv('MEMESH_DIR', f.root);
  const store = new ConversationMessages();
  store.register({ id: 'local', host: 'codex', machine: store.machine, pid: process.pid, wake: {} });
  const sent = store.send('local', { recipient: 'local', kind: 'task', body: 'local history' }); store.close();
  const metadata = openNetworkStore(networkMetadataPath(f.root));
  saveRoster(metadata, signRoster(f.owner, { ...f.roster, version: 3, members: [f.roster.members[0]] })); metadata.close();
  const removed = new ConversationMessages();
  try {
    expect(removed.networkIssue).toContain('no longer');
    expect(removed.read('local', sent.message.id).body).toBe('local history');
    expect(removed.status('local', sent.message.id)[0].state).toBe('read');
    expect(() => removed.upsertRemoteRegistrations(f.owner.machineId, [])).toThrow();
  } finally { removed.close(); }
});

it('does not trust tampered signatures or repair unsafe metadata permissions', async () => {
  const f = fixture(); await migrateNetworkMetadata(f.ctx);
  const file = networkMetadataPath(f.root);
  const db = openNetworkStore(file);
  db.prepare("UPDATE agent_network_config SET roster_signature='invalid'").run(); db.close();
  expect(() => readPublicNetworkContext(f.root)).toThrow();
  const unsafe = fixture(); await migrateNetworkMetadata(unsafe.ctx);
  const unsafeFile = networkMetadataPath(unsafe.root);
  const before = hash(unsafeFile);
  if (process.platform === 'win32') {
    const publicAcl = makeWindowsAclPublic(unsafeFile);
    expect(() => readPublicNetworkContext(unsafe.root)).toThrow(/Cannot verify private Windows permissions/);
    expect(readWindowsAcl(unsafeFile)).toEqual(publicAcl);
  } else {
    fs.chmodSync(unsafeFile, 0o644);
    expect(() => readPublicNetworkContext(unsafe.root)).toThrow(/Unsafe/);
    expect(fs.statSync(unsafeFile).mode & 0o777).toBe(0o644);
  }
  expect(hash(unsafeFile)).toBe(before);
});

it.skipIf(process.platform !== 'darwin')('accepts only the fixed macOS tmp/var aliases, not a task-owned directory link', async () => {
  const f = fixture(); await migrateNetworkMetadata(f.ctx);
  const alias = f.root.replace(/^\/private\/(var|tmp)\//, '/$1/');
  expect(alias).not.toBe(f.root);
  expect(readPublicNetworkContext(alias)?.self.id).toBe(f.self.machineId);
  const linked = path.join(f.root,'linked'); fs.symlinkSync(path.join(f.root,'network'),linked);
  expect(() => openPublicNetworkDatabase(path.join(linked,'metadata.db'))).toThrow(/Unsafe/);
});

it('no network means readonly absence and no bootstrap or new files', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nm-empty-'))); roots.push(root);
  expect(readPublicNetworkContext(root)).toBeUndefined();
  expect(await bootstrapNetworkBridge({ dataDir: root, dbPath: path.join(root,'graph.db'), bridgeEntry: 'unused', assetsDir: root }, 'unused')).toBe('not-joined');
  expect(fs.readdirSync(root)).toEqual([]);
});

it('generated hook without dist reads signed metadata and delivers full content without loading identity keys', async () => {
  const f = fixture(); await migrateNetworkMetadata(f.ctx);
  const plugin = path.join(f.root, 'plugin'); fs.mkdirSync(plugin, { mode:0o700 });
  fs.writeFileSync(path.join(plugin,'package.json'), '{"type":"module"}', { mode:0o600 });
  fs.cpSync(path.resolve('scripts/hooks'), path.join(plugin,'scripts/hooks'), {recursive:true});
  vi.stubEnv('MEMESH_DB_PATH', f.ctx.dbPath); vi.stubEnv('MEMESH_DIR',f.root);
  const s = new ConversationMessages();
  for (const id of ['a','b']) s.register({id,host:'codex',machine:s.machine,pid:process.pid,wake:{}});
  const id = s.send('a',{recipient:'b',kind:'task',body:'complete no-dist body🙂'}).message.id; s.close();
  // The public metadata reader must need no secret, even when it is absent.
  const identity = path.join(f.root,'network','identity.key');
  if (fs.existsSync(identity)) fs.renameSync(identity, `${identity}.held`);
  const env = buildIsolatedRuntimeEnv(process.env,{runtimeHome:f.root,memeshDir:f.root,dbPath:f.ctx.dbPath});
  const run = spawnSync(process.execPath,[path.join(plugin,'scripts/hooks/messages.js')], { env:{...env,CODEX_PLUGIN_ROOT:plugin,MEMESH_HOOK_HOST:'codex'},
    encoding:'utf8',timeout:3000,input:JSON.stringify({session_id:'b',hook_event_name:'UserPromptSubmit'}) });
  expect(run.status,run.stderr).toBe(0);
  expect(JSON.parse(JSON.parse(run.stdout).hookSpecificOutput.additionalContext.split('\n')[1]).body).toBe('complete no-dist body🙂');
  const after = new ConversationMessages(); try { expect(after.status('a',id)[0].state).toBe('delivered'); } finally { after.close(); }
});

it('ordinary SessionStart bootstraps joined legacy metadata in a short-lived public up process', async () => {
  const f = fixture();
  const repo = path.resolve('.');
  const tree: Tree = {root:repo,assetsDir:path.join(repo,'dist/network'),bridgeEntry:path.join(repo,'dist/network/bridge.js'),cli:path.join(repo,'dist/transports/cli/cli.js')};
  const runtime = installRuntimeOnce(tree);
  const db = openNetworkStore(f.ctx.dbPath); db.prepare('UPDATE agent_network_config SET machine_id=?,machine_name=?').run(f.owner.machineId,'owner'); db.close();
  const env = buildIsolatedRuntimeEnv(process.env,{runtimeHome:f.root,memeshDir:f.root,dbPath:f.ctx.dbPath});
  Object.assign(env,{MEMESH_AUTO_UPDATE:'off',MEMESH_SKIP_UPDATE_CHECK:'1',MEMESH_AUTO_CAPTURE:'false'});
  const ctx = {...f.ctx,bridgeEntry:tree.bridgeEntry,assetsDir:tree.assetsDir,env}; linkRuntime(ctx,runtime);
  try {
    const run = spawnSync(process.execPath,[path.join(repo,'scripts/hooks/messages.js')],{env:{...env,CODEX_PLUGIN_ROOT:repo,MEMESH_HOOK_HOST:'codex'},
      encoding:'utf8',timeout:3000,input:JSON.stringify({session_id:'auto',hook_event_name:'SessionStart'})});
    expect(run.status,run.stderr).toBe(0);
    await expect.poll(() => readStatus(f.root)?.state,{timeout:10000}).toBe('running');
    expect(readPublicNetworkContext(f.root)?.self.id).toBe(f.owner.machineId);
    expect(fs.readFileSync(path.join(f.root,'hook-outcomes.jsonl'),'utf8')).toContain('network-starting');
  } finally { await stopBridge(ctx); }
},60000);

it('presence is complete byte-bounded batches and does not delete earlier or offline registrations', () => {
  const f = fixture();
  const members = f.roster.members.map(m => ({ id: m.machine_id, name: m.name }));
  const store = new ConversationMessages({ file: path.join(f.root,'messages.db'), network: { network_id:f.roster.network_id, self:members[1], members } });
  try {
    store.register({ id:'same-id',host:'codex',machine:store.machine,pid:process.pid,wake:{} });
    const entries = Array.from({length:1200}, (_,n) => ({ id:`${n}-${'x'.repeat(150)}`,host:'codex' as const,online:n%2===0 }));
    entries.push({id:'same-id',host:'codex',online:false});
    const frames = conversationPresenceFrames(null,[],entries);
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) {
      const bytes = Buffer.from(JSON.stringify(frame)); expect(bytes.length).toBeLessThanOrEqual(FRAME_MAX_BYTES);
      const parsed = parseConversationFrame(bytes);
      if (parsed.kind !== 'conversations') throw new Error('Wrong kind');
      store.upsertRemoteRegistrations(f.owner.machineId, parsed.entries);
    }
    expect(store.discover()).toHaveLength(1202);
    expect(store.discover().filter(r => r.id==='same-id')).toHaveLength(2);
    expect(store.discover().find(r => r.machine==='owner' && r.id==='same-id')).toMatchObject({pid:0,wake:{},online:false});
    expect(store.exportRegistrations()).toHaveLength(1);
    expect(() => parseConversationFrame(Buffer.from(JSON.stringify({version:2,kind:'conversations',relay:null,addrs:[],entries:[{id:'x',host:'codex',online:true,project:'private'}]})))).toThrow();
  } finally { store.close(); }
});
