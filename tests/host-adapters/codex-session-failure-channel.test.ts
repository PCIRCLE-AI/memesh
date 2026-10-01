// #518: an outdated router's reason reaches the SessionStart launcher through a
// private file the detached companion writes. These spawn the built launcher.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

const dirs: string[] = [];
const kids: ChildProcess[] = [];
const sockets = new Set<net.Socket>();
const servers: net.Server[] = [];
const thread = '01a041b4-5c67-75b3-9505-4e33d7942b8f';
async function wait(predicate: () => boolean, timeout = 5000) {
  const until = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('review harness timeout');
    await new Promise(r => setTimeout(r, 10));
  }
}
const SPAWNED = 'spawned.pids';
// Loaded into every process a test starts (through NODE_OPTIONS, which their
// children inherit): records each detached companion and each router it starts,
// neither of which is a child the test holds.
const TRACKER = `import fs from 'node:fs';import path from 'node:path';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const spawn=cp.spawn;cp.spawn=function(...args){const child=spawn.apply(this,args);
if(child.pid&&Array.isArray(args[1])&&args[1].some(a=>/router\\.js$/.test(a)||a==='--companion')){
try{fs.appendFileSync(path.join(process.env.MEMESH_DIR,'${SPAWNED}'),child.pid+'\\n')}catch(e){if(e.code!=='ENOENT')throw e}}
return child};syncBuiltinESMExports();`;
// Outside every test directory, so a process started after its directory is
// gone still loads it: no test's cleanup may depend on a preload failing to load.
const trackerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f518t-'));
const tracker = path.join(trackerDir, 'track-spawns.mjs');
fs.writeFileSync(tracker, TRACKER);
afterAll(() => fs.rmSync(trackerDir, { recursive: true, force: true }));
const DIST = path.resolve('dist/host-runtime');
/** Stop what a test's processes started in `dir`, checking each pid still runs this checkout's code. */
async function stopSpawned(dir: string) {
  let list: string;
  try { list = fs.readFileSync(path.join(dir, SPAWNED), 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const pids = [...new Set(list.split('\n').filter(Boolean).map(Number))].filter((pid) => {
    const command = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout;
    return command.includes(`${DIST}/router.js`) || command.includes(`${DIST}/codex-session.js`);
  });
  for (const pid of pids) process.kill(pid, 'SIGKILL');
  const until = Date.now() + 2000;
  while (pids.some(alive) && Date.now() < until) await new Promise(r => setTimeout(r, 10));
}
afterEach(async () => {
  for (const c of kids.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) {
      c.kill('SIGKILL'); await new Promise(r => c.once('close', r));
    }
  }
  for (const d of dirs) await stopSpawned(d);
  for (const s of sockets) s.destroy();
  sockets.clear();
  for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r()));
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
async function setup(code = 'unexpected_field') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'f518-')); dirs.push(d);
  fs.chmodSync(d, 0o700);
  const sock = path.join(d, 'agent-router-v2.sock');
  fs.writeFileSync(path.join(d, 'agent-router.token'), 'x'.repeat(64), { mode: 0o600 });
  let response: (() => void) | undefined;
  const server = net.createServer(s => {
    sockets.add(s); s.on('error', () => {}); s.once('close', () => sockets.delete(s));
    s.once('data', chunk => {
      const frame = JSON.parse(chunk.toString().trim().split('\n')[0]);
      if (code === 'accept') {
        s.write(JSON.stringify({ version: 2, request_id: frame.request_id, ok: true,
          result: { memesh_version: '0.0.0', connection_id: 'fixture', generation: 1, lease_ms: 60000 } }) + '\n');
        return;
      }
      response = () => s.write(JSON.stringify({ version: 2, request_id: code === 'unexpected_field' ? '' : frame.request_id,
        ok: false, error: { code, message: code === 'unexpected_field'
          ? 'Router frame contains unsupported field memesh_version.' : 'fixture invalid token' } }) + '\n');
    });
  });
  servers.push(server);
  await new Promise<void>(r => server.listen(sock, r)); fs.chmodSync(sock, 0o600);
  const life = path.join(d, 'runtime', 'codex-session');
  return { d, sock, life, response: () => response, env: {
    ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(tracker).href}`].filter(Boolean).join(' '), MEMESH_DIR: d, MEMESH_DB_PATH: path.join(d, 'db'), MEMESH_ROUTER_SOCKET: sock,
    MEMESH_ROUTER_TOKEN_FILE: path.join(d, 'agent-router.token'), PLUGIN_ROOT: process.cwd(),
  } };
}
function launch(f: Awaited<ReturnType<typeof setup>>, preload?: string) {
  const c = spawn(process.execPath, ['dist/host-runtime/codex-session.js'], {
    env: { ...f.env, ...(preload ? { NODE_OPTIONS: `${f.env.NODE_OPTIONS} --import=${pathToFileURL(preload).href}` } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  }); kids.push(c);
  let stderr = ''; c.stderr!.on('data', x => stderr += x);
  c.stdin!.end(JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: thread, cwd: f.d }));
  return { c, stderr: () => stderr };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
/** The SessionEnd hook for the test thread. */
function end(f: Fixture) {
  const c = spawn(process.execPath, ['dist/host-runtime/codex-session.js'], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  kids.push(c);
  let stderr = ''; c.stderr!.on('data', x => stderr += x);
  c.stdin!.end(JSON.stringify({ hook_event_name: 'SessionEnd', session_id: thread, cwd: f.d }));
  return { c, stderr: () => stderr };
}
/** Where a companion with no stdio records why it could not finish cleanly. */
function companionLog(f: Fixture) {
  try { return fs.readFileSync(path.join(f.d, 'codex-companion.log'), 'utf8'); } catch { return ''; }
}
/** A preload that makes `fs.<call>` throw EACCES for paths containing `match`, once `flag` exists. */
function faultAfterFlag(f: Fixture, call: string, match: string, flag: string, name: string) {
  const preload = path.join(f.d, name);
  fs.writeFileSync(preload, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const real=fs.${call};fs.${call}=function(p,...rest){if(String(p).includes(${JSON.stringify(match)})&&fs.existsSync(${JSON.stringify(flag)})){
    const e=new Error('injected EACCES: ${call} '+p);e.code='EACCES';throw e}return real.call(fs,p,...rest)};syncBuiltinESMExports();`);
  return preload;
}
function controlSocket(f: Fixture) {
  return path.join(f.d, `c-${createHash('sha256').update(`v2:${thread}`).digest('hex').slice(0, 8)}.sock`);
}
/** The name a companion from before #518 bound. */
function legacySocket(f: Fixture) {
  return path.join(f.d, `c-${createHash('sha256').update(thread).digest('hex').slice(0, 8)}.sock`);
}
function controls(f: Fixture) { return fs.readdirSync(f.d).filter(x => x.startsWith('c-')); }
/** A companion started the way the launcher starts one, with no launcher waiting for it. */
function direct(f: Fixture, name: string, preload?: string) {
  fs.mkdirSync(f.life, { recursive: true, mode: 0o700 });
  const input = path.join(f.life, `${name}.json`);
  fs.writeFileSync(input, JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: thread, cwd: f.d }), { mode: 0o600 });
  const c = spawn(process.execPath, [...(preload ? ['--import', pathToFileURL(preload).href] : []),
    'dist/host-runtime/codex-session.js', '--companion', input], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  kids.push(c);
  let stderr = ''; c.stderr!.on('data', x => stderr += x);
  return { c, stderr: () => stderr };
}
/** Another process listening on `socket`; it reads and drops whatever it is sent. */
async function holdSocket(socket: string) {
  const holder = spawn(process.execPath, ['-e', `require('net').createServer(s=>{s.on('error',()=>{});s.resume()}).listen(${JSON.stringify(socket)})`], { stdio: 'ignore' });
  kids.push(holder);
  await wait(() => fs.existsSync(socket));
  return holder;
}
function answers(socket: string) {
  return new Promise<boolean>((resolve) => {
    const s = net.connect(socket);
    s.once('connect', () => { s.end(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}
/** A lifecycle record naming `ino` as its socket (none: a record from before #518), by default for a process that is gone. */
function stageDeadOwner(f: Fixture, ino: string | undefined, pid = 2_147_483_647, socket = controlSocket(f)) {
  fs.mkdirSync(f.life, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(f.life, `${thread}.json`), `${JSON.stringify({
    version: 1, pid, thread_id: thread, workspace: fs.realpathSync(f.d),
    token: 'a'.repeat(32), control_socket: socket, control_socket_ino: ino,
    // A record with an inode is written by a current companion, registered once the router accepted it.
    ...(ino === undefined ? {} : { registered: true }),
  })}\n`, { mode: 0o600 });
}
describe.skipIf(process.platform === 'win32')('#518 companion failure channel', () => {
  it('ordinary refusal consumes the private failure record and cleans control state', async () => {
    const f = await setup(); const p = launch(f);
    await wait(() => !!f.response());
    // The control socket exists while the companion waits for the router.
    expect(fs.readdirSync(f.d).filter(x => x.startsWith('c-')).length).toBeGreaterThan(0);
    f.response()!();
    await wait(() => p.c.exitCode !== null);
    await wait(() => sockets.size === 0);
    expect(p.c.exitCode).toBe(1); expect(p.stderr()).toContain('router_outdated');
    expect(p.stderr()).toContain('pkill -f dist/host-runtime/router.js');
    expect(fs.statSync(f.life).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(f.life)).toEqual([]);
    expect(fs.readdirSync(f.d).filter(x => x.startsWith('c-'))).toEqual([]);
  });
  it('non-outdated authentication failure retains the prior generic launcher output', async () => {
    const f = await setup('authentication_failed'); const p = launch(f);
    await wait(() => !!f.response()); f.response()!();
    await wait(() => p.c.exitCode !== null);
    expect(p.c.exitCode).toBe(1);
    expect(p.stderr()).toBe('memesh-host-codex-session: session registration failed.\n');
    expect(fs.readdirSync(f.life)).toEqual([]);
  });
  it('interrupted launcher: orphan is never read by a later launch, and is swept once old', async () => {
    const f = await setup(); const p = launch(f);
    await wait(() => !!f.response()); p.c.kill('SIGKILL');
    await wait(() => p.c.signalCode !== null); f.response()!();
    await wait(() => fs.readdirSync(f.life).some(x => x.endsWith('.failed')));
    await wait(() => sockets.size === 0);
    await wait(() => !fs.readdirSync(f.d).some(x=>x.startsWith('c-')));
    const orphan = fs.readdirSync(f.life).find(x => x.endsWith('.failed'))!;
    const mode = fs.statSync(path.join(f.life, orphan)).mode & 0o777;
    fs.writeFileSync(path.join(f.life, orphan), JSON.stringify({code:'router_outdated',message:'ORPHAN from killed launch'}), {mode:0o600});
    const old = new Date(Date.now() - 120_000); fs.utimesSync(path.join(f.life, orphan), old, old);
    // A companion that died between writing and renaming leaves its temporary file.
    const tmp = path.join(f.life, `${orphan}.0123456789ab.tmp`);
    fs.writeFileSync(tmp, '{"code":"router_outdated"', { mode: 0o600 }); fs.utimesSync(tmp, old, old);
    const previousResponse=f.response();
    const q = launch(f); await wait(() => f.response() !== previousResponse);
    f.response()!();
    await wait(() => q.c.exitCode !== null);
    const remaining = fs.readdirSync(f.life);
    expect(mode).toBe(0o600);
    expect(q.stderr()).toContain('router_outdated');
    expect(q.stderr()).not.toContain('ORPHAN');
    expect(remaining).toEqual([]);
  });
  it('failure writer still cleans up when a record already exists at its path', async () => {
    const f = await setup(); fs.mkdirSync(f.life, { recursive: true, mode: 0o700 });
    const input = path.join(f.life, 'review-launch.json');
    fs.writeFileSync(input, JSON.stringify({hook_event_name:'SessionStart',source:'startup',session_id:thread,cwd:f.d}),{mode:0o600});
    const preload = path.join(f.d, 'collision.mjs');
    fs.writeFileSync(preload, `import fs from 'node:fs';import path from 'node:path';
      fs.writeFileSync(path.join(process.env.MEMESH_DIR,'runtime','codex-session','review-launch.json.failed'),JSON.stringify({code:'router_outdated',message:'previous incarnation'}),{mode:0o600});`);
    const c = spawn(process.execPath,['--import',pathToFileURL(preload).href,'dist/host-runtime/codex-session.js','--companion',input],{env:f.env,stdio:['ignore','pipe','pipe']}); kids.push(c);
    let stderr='';c.stderr!.on('data',x=>stderr+=x);
    await wait(()=>!!f.response());f.response()!();await wait(()=>c.exitCode!==null);
    const controlSockets=fs.readdirSync(f.d).filter(x=>x.startsWith('c-'));
    expect(c.exitCode).toBe(1);
    expect(controlSockets).toEqual([]);
    // The new reason replaced the one already there.
    const record = JSON.parse(fs.readFileSync(path.join(f.life, 'review-launch.json.failed'), 'utf8'));
    expect(record.code).toBe('router_outdated');
    expect(record.message).not.toBe('previous incarnation');
    expect(record.message).toContain('pkill -f dist/host-runtime/router.js');
  });
  it('failure publication cannot expose partial JSON to the launcher', async () => {
    const f = await setup(); const preload=path.join(f.d,'slow-write.mjs');
    fs.writeFileSync(preload, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
      if(process.argv[2]==='--companion') {
        const original=fs.writeFileSync;
        fs.writeFileSync=function(file,data,...rest) {
          if(typeof file==='number' && typeof data==='string' && data.includes('router_outdated'))
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);
          return original.call(fs,file,data,...rest);
        };
        syncBuiltinESMExports();
      }`);
    const p=launch(f,preload);await wait(()=>!!f.response());f.response()!();await wait(()=>p.c.exitCode!==null);
    expect(p.stderr()).toContain('router_outdated');
  });
  it('launcher observing failure does not kill the companion before socket cleanup',async()=>{
    const f=await setup();const preload=path.join(f.d,'slow-socket-cleanup.mjs');
    // Slow the companion's control-server close (which removes its socket): a
    // launcher that kills it as soon as it reads the reason leaves the socket behind.
    fs.writeFileSync(preload, `import net from 'node:net';
      if(process.argv[2]==='--companion') {
        const original=net.Server.prototype.close;
        net.Server.prototype.close=function(...args) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300);
          return original.apply(this,args);
        };
      }`);
    const p=launch(f,preload);await wait(()=>!!f.response());
    expect(fs.readdirSync(f.d).filter(x=>x.startsWith('c-')).length).toBeGreaterThan(0);
    f.response()!();await wait(()=>p.c.exitCode!==null);
    await wait(()=>sockets.size===0);
    const controlSockets=fs.readdirSync(f.d).filter(x=>x.startsWith('c-'));
    expect(p.stderr()).toContain('router_outdated');expect(controlSockets).toEqual([]);
  });
  it('a companion stopped at the launcher deadline still removes its control socket', async () => {
    // The router never answers, so the launcher gives up at its deadline and stops the companion.
    const f = await setup(); const p = launch(f);
    await wait(() => !!f.response());
    expect(fs.readdirSync(f.d).filter(x => x.startsWith('c-')).length).toBeGreaterThan(0);
    await wait(() => p.c.exitCode !== null, 8000);
    expect(p.c.exitCode).toBe(1);
    await wait(() => !fs.readdirSync(f.d).some(x => x.startsWith('c-')), 5000);
    expect(fs.readdirSync(f.d).filter(x => x.startsWith('c-'))).toEqual([]);
  });

  it('a socket whose recorded owner is dead does not block the next start', async () => {
    const f = await setup(); const stale = controlSocket(f);
    const holder = await holdSocket(stale);
    holder.kill('SIGKILL'); await new Promise(r => holder.once('close', r));
    stageDeadOwner(f, String(fs.lstatSync(stale, { bigint: true }).ino));
    const p = launch(f);
    await wait(() => !!f.response()); f.response()!();
    await wait(() => p.c.exitCode !== null);
    expect(p.stderr()).toContain('router_outdated');
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.readdirSync(f.life)).toEqual([]);
  });
  it('a socket no record owns is left in place, and the start says why without asking anyone to delete it', async () => {
    // Nothing proves its owner is gone: "nobody answers" is also what a live
    // companion between bind and listen looks like.
    const f = await setup(); const stale = controlSocket(f);
    const holder = await holdSocket(stale);
    holder.kill('SIGKILL'); await new Promise(r => holder.once('close', r));
    const ino = fs.lstatSync(stale).ino;
    const p = launch(f);
    await wait(() => p.c.exitCode !== null);
    expect(p.c.exitCode).toBe(1);
    expect(p.stderr()).toContain('companion_busy');
    expect(p.stderr()).toContain(stale);
    expect(p.stderr()).toContain('no record shows');
    // Nothing is known to hold it, and no check can prove it unused: no claim of a live owner, no deletion advice.
    expect(p.stderr()).not.toContain('still holds');
    expect(p.stderr()).not.toMatch(/delete|lsof|rm /);
    expect(p.stderr().trim().split('\n')).toHaveLength(1);
    expect(fs.lstatSync(stale).ino).toBe(ino);
    expect(fs.readdirSync(f.life)).toEqual([]);
  });
  it('a dead companion\'s record from before #518 no longer blocks the start, and its socket is left untouched', async () => {
    const f = await setup(); const legacy = legacySocket(f);
    const holder = await holdSocket(legacy);
    holder.kill('SIGKILL'); await new Promise(r => holder.once('close', r));
    stageDeadOwner(f, undefined, 2_147_483_647, legacy);
    const ino = fs.lstatSync(legacy).ino;
    const q = launch(f);
    await wait(() => !!f.response() || q.c.exitCode !== null);
    expect(q.c.exitCode).toBeNull();
    // The old record is retired; the new companion recorded its own socket, under the current name.
    const record = JSON.parse(fs.readFileSync(path.join(f.life, `${thread}.json`), 'utf8'));
    expect(record.token).not.toBe('a'.repeat(32));
    expect(record.control_socket).toBe(controlSocket(f));
    expect(fs.lstatSync(legacy).ino).toBe(ino);
    f.response()!();
    await wait(() => q.c.exitCode !== null);
    expect(q.stderr()).not.toMatch(/delete|lsof/);
    expect(fs.lstatSync(legacy).ino).toBe(ino);
    // What became of the old record is on record, with the reason.
    expect(companionLog(f)).toContain(`left ${legacy} in place: the record is from before #518`);
  });
  it('clearing a dead record from before #518 never touches a live socket at the current name', async () => {
    const f = await setup(); const legacy = legacySocket(f);
    const old = await holdSocket(legacy);
    old.kill('SIGKILL'); await new Promise(r => old.once('close', r));
    stageDeadOwner(f, undefined, 2_147_483_647, legacy);
    const live = await holdSocket(controlSocket(f));
    const liveIno = fs.lstatSync(controlSocket(f)).ino;
    const p = launch(f);
    await wait(() => p.c.exitCode !== null);
    expect(p.c.exitCode).toBe(1);
    expect(p.stderr()).toContain('companion_busy');
    expect(fs.lstatSync(controlSocket(f)).ino).toBe(liveIno);
    expect(await answers(controlSocket(f))).toBe(true);
    live.kill('SIGKILL');
  });
  it('a companion killed while it connects to the router leaves a record the next start clears', async () => {
    const f = await setup(); launch(f);
    await wait(() => !!f.response());
    // Recorded before the router answered, with its socket's inode, but not yet registered.
    const record = JSON.parse(fs.readFileSync(path.join(f.life, `${thread}.json`), 'utf8'));
    expect(record.control_socket_ino).toBe(String(fs.lstatSync(controlSocket(f), { bigint: true }).ino));
    expect(record.registered).toBeUndefined();
    const companion = record.pid as number;
    process.kill(companion, 'SIGKILL');
    await wait(() => { try { process.kill(companion, 0); return false; } catch { return true; } });
    expect(fs.existsSync(controlSocket(f))).toBe(true);
    const q = launch(f);
    const token = () => { try { return JSON.parse(fs.readFileSync(path.join(f.life, `${thread}.json`), 'utf8')).token; } catch { return undefined; } };
    await wait(() => (token() !== undefined && token() !== record.token) || q.c.exitCode !== null);
    expect(q.c.exitCode).toBeNull();
    // The dead companion's record was cleared and its socket removed (a new socket may reuse the inode number).
    expect(companionLog(f)).toContain(`cleared the record of companion ${companion}, which had exited; removed its socket ${controlSocket(f)}`);
  });
  it('SessionEnd with a dead companion\'s record from before #518 ends cleanly, leaves its socket and asks nothing', async () => {
    const f = await setup(); const legacy = legacySocket(f);
    const holder = await holdSocket(legacy);
    holder.kill('SIGKILL'); await new Promise(r => holder.once('close', r));
    stageDeadOwner(f, undefined, 2_147_483_647, legacy);
    const ino = fs.lstatSync(legacy).ino;
    const e = end(f);
    await wait(() => e.c.exitCode !== null);
    expect(e.c.exitCode).toBe(0);
    expect(e.stderr()).toBe('');
    expect(fs.lstatSync(legacy).ino).toBe(ino);
    expect(fs.existsSync(path.join(f.life, `${thread}.json`))).toBe(false);
    // Silent on the terminal, but what it did and why is recorded.
    expect(companionLog(f)).toContain('cleared the record of companion 2147483647, which had exited;');
    expect(companionLog(f)).toContain(`left ${legacy} in place: the record is from before #518`);
  });
  it('a SessionEnd failure is reported as a session end, not a registration', async () => {
    const f = await setup();
    stageDeadOwner(f, '1', process.pid);
    const e = end(f);
    await wait(() => e.c.exitCode !== null);
    expect(e.c.exitCode).toBe(1);
    expect(e.stderr()).toMatch(/^memesh-host-codex-session: session end failed\./);
    expect(e.stderr()).not.toContain('registration');
  });
  it('a companion that cannot check its socket while stopping records why', async () => {
    const f = await setup(); const flag = path.join(f.d, 'fault-now');
    const a = direct(f, 'check-fault', faultAfterFlag(f, 'lstatSync', '/c-', flag, 'socket-check-fault.mjs'));
    await wait(() => !!f.response());
    fs.writeFileSync(flag, '1'); a.c.kill('SIGTERM');
    await wait(() => a.c.exitCode !== null || a.c.signalCode !== null);
    expect(a.c.exitCode).toBe(1);
    expect(companionLog(f)).toContain('injected EACCES: lstatSync');
    expect(companionLog(f)).toContain(controlSocket(f));
  });
  it('a companion whose cleanup throws still exits, and records why', async () => {
    const f = await setup(); const flag = path.join(f.d, 'fault-now');
    const a = direct(f, 'cleanup-fault', faultAfterFlag(f, 'openSync', `${thread}.json`, flag, 'state-read-fault.mjs'));
    await wait(() => !!f.response());
    fs.writeFileSync(flag, '1'); a.c.kill('SIGTERM');
    await wait(() => a.c.exitCode !== null || a.c.signalCode !== null);
    expect(a.c.exitCode).toBe(1);
    expect(companionLog(f)).toContain('injected EACCES: openSync');
  });
  it('a running process named by the record whose socket does not answer gets its own reason', async () => {
    const f = await setup();
    stageDeadOwner(f, '1', process.pid);
    const p = launch(f);
    await wait(() => p.c.exitCode !== null);
    expect(p.c.exitCode).toBe(1);
    expect(p.stderr()).toContain('companion_busy');
    expect(p.stderr()).toContain(`process ${process.pid}`);
    expect(p.stderr()).toContain('does not answer');
    // The record is the only proof of which socket is the companion's: never advise deleting it.
    expect(p.stderr()).not.toContain('delete');
    expect(p.stderr().trim().split('\n')).toHaveLength(1);
    expect(fs.existsSync(path.join(f.life, `${thread}.json`))).toBe(true);
  });
  for (const how of ['is stopped', 'fails to start'] as const) {
    it(`a companion that ${how} leaves a live replacement at its path connectable`, async () => {
      // The pathname was taken over while the companion ran: closing its server
      // would unlink that pathname by name, whoever owns it now.
      const f = await setup(); const socket = controlSocket(f);
      const a = direct(f, `replaced-${how === 'is stopped' ? 'stop' : 'fail'}`);
      await wait(() => !!f.response());
      const old = fs.lstatSync(socket).ino;
      fs.unlinkSync(socket);
      const holder = await holdSocket(socket);
      const ino = fs.lstatSync(socket).ino;
      expect(ino).not.toBe(old);
      expect(await answers(socket)).toBe(true);
      if (how === 'is stopped') a.c.kill('SIGTERM'); else f.response()!();
      await wait(() => a.c.exitCode !== null);
      expect(a.c.exitCode).toBe(how === 'is stopped' ? 0 : 1);
      expect(holder.exitCode).toBeNull();
      expect(fs.lstatSync(socket).ino).toBe(ino);
      expect(await answers(socket)).toBe(true);
    });
  }
  it('clearing a dead companion\'s record never removes a live socket it did not create', async () => {
    const f = await setup(); const socket = controlSocket(f);
    await holdSocket(socket);
    const ino = fs.lstatSync(socket).ino;
    stageDeadOwner(f, String(ino + 1));
    const p = launch(f);
    await wait(() => p.c.exitCode !== null);
    expect(p.c.exitCode).toBe(1);
    expect(p.stderr()).toContain('companion_busy');
    expect(fs.lstatSync(socket).ino).toBe(ino);
    expect(await answers(socket)).toBe(true);
    // The dead owner's record itself is gone.
    expect(fs.readdirSync(f.life)).toEqual([]);
  });
  it('a dead companion\'s record replaced by a newer one is put back, and its socket is left alone', async () => {
    const f = await setup(); const socket = controlSocket(f);
    const holder = await holdSocket(socket);
    holder.kill('SIGKILL'); await new Promise(r => holder.once('close', r));
    const ino = String(fs.lstatSync(socket, { bigint: true }).ino);
    stageDeadOwner(f, ino);
    const record = path.join(f.life, `${thread}.json`);
    const newer = JSON.stringify({ version: 1, pid: process.pid, thread_id: thread, workspace: fs.realpathSync(f.d),
      token: 'b'.repeat(32), control_socket: socket, control_socket_ino: ino });
    // A newer companion rewrites the record between this cleaner's read and its take.
    const preload = path.join(f.d, 'replace-record.mjs');
    fs.writeFileSync(preload, `import fs from 'node:fs';
      if(process.argv[2]==='--companion'){const rename=fs.renameSync;let done=false;
      fs.renameSync=function(a,b){if(!done&&a===${JSON.stringify(record)}&&String(b).endsWith('.stale')){done=true;fs.writeFileSync(a,${JSON.stringify(newer)},{mode:0o600})}
      return rename.call(fs,a,b)}}`);
    const c = direct(f, 'cleaner', preload);
    await wait(() => c.c.exitCode !== null);
    expect(c.c.exitCode).toBe(1);
    expect(String(fs.lstatSync(socket, { bigint: true }).ino)).toBe(ino);
    expect(JSON.parse(fs.readFileSync(record, 'utf8')).token).toBe('b'.repeat(32));
    expect(fs.readdirSync(f.life).filter(x => x.endsWith('.stale'))).toEqual([]);
  });
  it('a stopping companion never removes a newer socket bound at its path after it closed', async () => {
    // Closing the control server frees the path; a newer companion may bind it
    // before this one finishes its cleanup.
    const f = await setup(); const socket = controlSocket(f);
    const closed = path.join(f.d, 'closed'); const release = path.join(f.d, 'finish-cleanup');
    const preload = path.join(f.d, 'pause-after-close.mjs');
    fs.writeFileSync(preload, `import fs from 'node:fs';import net from 'node:net';
      const close=net.Server.prototype.close;net.Server.prototype.close=function(cb){return close.call(this,(...a)=>{
      fs.writeFileSync(${JSON.stringify(closed)},'1');const until=Date.now()+3000;
      while(!fs.existsSync(${JSON.stringify(release)})&&Date.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);cb?.(...a)})};`);
    const a = direct(f, 'older', preload);
    await wait(() => !!f.response());
    a.c.kill('SIGTERM');
    await wait(() => fs.existsSync(closed));
    expect(fs.existsSync(socket)).toBe(false);
    await holdSocket(socket);
    const ino = fs.lstatSync(socket).ino;
    fs.writeFileSync(release, 'go');
    await wait(() => a.c.exitCode !== null);
    expect(a.c.exitCode).toBe(0);
    expect(fs.lstatSync(socket).ino).toBe(ino);
    expect(await answers(socket)).toBe(true);
  });
  it('a peer that hangs up without a request does not crash the companion', async () => {
    const f = await setup(); const socket = controlSocket(f);
    const a = direct(f, 'hangup');
    await wait(() => !!f.response());
    await new Promise<void>((resolve) => {
      const peer = net.connect(socket); peer.on('error', () => {});
      peer.once('connect', () => { peer.destroy(); resolve(); });
    });
    await new Promise(r => setTimeout(r, 300));
    expect(a.c.exitCode).toBeNull(); expect(a.stderr()).toBe('');
    expect(controls(f)).toHaveLength(1);
  });
  it('a bind that loses with EEXIST is refused like EADDRINUSE, in one line', async () => {
    // Two starts binding at once: macOS sometimes reports the loser as EEXIST.
    const f = await setup();
    const preload = path.join(f.d, 'eexist.mjs');
    fs.writeFileSync(preload, `import net from 'node:net';const real=net.Server.prototype.listen;
      net.Server.prototype.listen=function(p,...rest){if(typeof p==='string'&&p.includes('/c-')){process.nextTick(()=>{
      const e=new Error('listen EEXIST: file already exists '+p);e.code='EEXIST';this.emit('error',e)});return this}
      return real.call(this,p,...rest)};`);
    const p = launch(f, preload);
    await wait(() => p.c.exitCode !== null, 8000);
    expect(p.c.exitCode).toBe(1);
    expect(p.stderr()).toContain('companion_busy');
    expect(p.stderr()).toContain('no record shows');
    expect(p.stderr().trim().split('\n')).toHaveLength(1);
  });
  it('a start the router accepts exits 0 and leaves its companion running and registered', async () => {
    const f = await setup('accept');
    const p = launch(f);
    await wait(() => p.c.exitCode !== null, 8000);
    expect(p.c.exitCode).toBe(0); expect(p.stderr()).toBe('');
    const record = JSON.parse(fs.readFileSync(path.join(f.life, `${thread}.json`), 'utf8'));
    expect(record.registered).toBe(true);
    expect(() => process.kill(record.pid, 0)).not.toThrow();
    expect(fs.existsSync(controlSocket(f))).toBe(true);
  });
  it('a second start for the same session refuses, and the running companion keeps its socket', async () => {
    const f = await setup();
    const a = direct(f, 'live-a');
    await wait(() => !!f.response());
    const ino = fs.lstatSync(controlSocket(f)).ino;
    const b = direct(f, 'live-b');
    await wait(() => b.c.exitCode !== null);
    await new Promise(r => setTimeout(r, 150));
    expect(a.c.exitCode).toBeNull(); expect(a.stderr()).toBe('');
    expect(b.c.exitCode).toBe(1); expect(b.stderr()).toContain('companion_busy');
    expect(fs.lstatSync(controlSocket(f)).ino).toBe(ino);
  });
  it('a second start never removes a socket its owner has bound but not yet listened on', async () => {
    const f = await setup(); const socket = controlSocket(f);
    const marker = path.join(f.d, 'bound'); const release = path.join(f.d, 'listen-now');
    const preload = path.join(f.d, 'pause-bind.mjs');
    // Hold the first companion between bind() and listen(): a probe sees ECONNREFUSED there.
    fs.writeFileSync(preload, `import fs from 'node:fs';const Pipe=process.binding('pipe_wrap').Pipe;const listen=Pipe.prototype.listen;
      Pipe.prototype.listen=function(...a){fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));const until=Date.now()+3000;
      while(!fs.existsSync(${JSON.stringify(release)})&&Date.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);return listen.apply(this,a)};`);
    const a = direct(f, 'bind-a', preload);
    await wait(() => fs.existsSync(marker));
    const ino = fs.lstatSync(socket).ino;
    const b = direct(f, 'bind-b');
    await wait(() => !!f.response() || b.c.exitCode !== null);
    const secondReachedRouter = !!f.response();
    const afterIno = fs.lstatSync(socket).ino;
    fs.writeFileSync(release, 'go');
    await wait(() => !!f.response());
    expect(secondReachedRouter).toBe(false);
    expect(afterIno).toBe(ino);
    expect(b.c.exitCode).toBe(1);
    expect(a.c.exitCode).toBeNull();
  });
  it('an unowned socket is never probed: nobody answering does not prove its owner is gone', async () => {
    // A companion between bind() and listen() refuses connections exactly like a dead one.
    const f = await setup(); const socket = controlSocket(f);
    const holder = await holdSocket(socket);
    holder.kill('SIGKILL'); await new Promise(r => holder.once('close', r));
    const ino = fs.lstatSync(socket).ino;
    const probed = path.join(f.d, 'probed'); const preload = path.join(f.d, 'record-probe.mjs');
    fs.writeFileSync(preload, `import fs from 'node:fs';import net from 'node:net';
      const connect=net.connect;net.connect=net.createConnection=function(...args){
      if(String(args[0]).includes('/c-'))fs.appendFileSync(${JSON.stringify(probed)},String(args[0])+'\\n');return connect.apply(this,args)};`);
    const b = direct(f, 'unowned', preload);
    await wait(() => b.c.exitCode !== null);
    expect(b.c.exitCode).toBe(1); expect(b.stderr()).toContain('companion_busy');
    expect(fs.existsSync(probed)).toBe(false);
    expect(fs.lstatSync(socket).ino).toBe(ino);
  });
  it('a refusal whose cleanup runs past the launcher deadline is still reported, and leaves nothing behind', async () => {
    const f = await setup(); const preload = path.join(f.d, 'slow-close.mjs');
    fs.writeFileSync(preload, `import net from 'node:net';if(process.argv[2]==='--companion'){const close=net.Server.prototype.close;
      net.Server.prototype.close=function(...a){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1200);return close.apply(this,a)}}`);
    const p = launch(f, preload);
    await wait(() => !!f.response());
    // Answer late enough that the 1.2 s cleanup ends after the launcher's 2 s deadline.
    await new Promise(r => setTimeout(r, 1200));
    f.response()!();
    await wait(() => p.c.exitCode !== null, 8000);
    const atExit = controls(f);
    expect(p.c.exitCode).toBe(1); expect(p.stderr()).toContain('router_outdated');
    expect(atExit).toEqual([]);
    expect(fs.readdirSync(f.life)).toEqual([]);
    const before = f.response(); const q = launch(f);
    await wait(() => f.response() !== before || q.c.exitCode !== null);
    expect(f.response()).not.toBe(before);
  });
  it('when cleanup outlasts even the wait, the restart says why and no late record is left', async () => {
    const f = await setup(); const preload = path.join(f.d, 'slower-close.mjs');
    fs.writeFileSync(preload, `import net from 'node:net';if(process.argv[2]==='--companion'){const close=net.Server.prototype.close;
      net.Server.prototype.close=function(...a){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2500);return close.apply(this,a)}}`);
    const p = launch(f, preload);
    await wait(() => !!f.response()); f.response()!();
    await wait(() => p.c.exitCode !== null, 8000);
    expect(p.c.exitCode).toBe(1); expect(p.stderr()).toContain('router_outdated');
    const before = f.response(); const q = launch(f);
    await wait(() => f.response() !== before || q.c.exitCode !== null, 8000);
    // Either the first companion finished in time and the restart registers, or the restart says why.
    if (f.response() === before) { expect(q.c.exitCode).toBe(1); expect(q.stderr()).toContain('companion_busy'); }
    await wait(() => q.c.exitCode !== null, 8000);
    await wait(() => controls(f).length === 0, 8000);
    expect(fs.readdirSync(f.life)).toEqual([]);
  });
  it('a reason that arrives while a stop is already under way is still published', async () => {
    const f = await setup(); const preload = path.join(f.d, 'slow-stop.mjs'); const marker = path.join(f.d, 'stopping');
    fs.writeFileSync(preload, `import fs from 'node:fs';import net from 'node:net';
      const close=net.Server.prototype.close;net.Server.prototype.close=function(cb){fs.writeFileSync(${JSON.stringify(marker)},'1');
      setTimeout(()=>close.call(this,cb),400);return this};`);
    const c = direct(f, 'stop', preload);
    await wait(() => !!f.response());
    c.c.kill('SIGTERM');
    await wait(() => fs.existsSync(marker)); f.response()!();
    await wait(() => c.c.exitCode !== null || c.c.signalCode !== null);
    expect(c.c.exitCode).toBe(1);
    expect(fs.readdirSync(f.life)).toContain('stop.json.failed');
    expect(controls(f)).toEqual([]);
  });
  it('SIGTERM during refusal cleanup keeps the reason and the failure exit', async () => {
    const f = await setup(); const preload = path.join(f.d, 'overlap-close.mjs'); const marker = path.join(f.d, 'first-close');
    fs.writeFileSync(preload, `import fs from 'node:fs';import net from 'node:net';
      const close=net.Server.prototype.close;let n=0;net.Server.prototype.close=function(cb){n++;
      if(n===1){return close.call(this,(...a)=>{fs.writeFileSync(${JSON.stringify(marker)},'closed');setTimeout(()=>cb(...a),400)})}return close.call(this,cb)};`);
    const c = direct(f, 'signal', preload);
    await wait(() => !!f.response()); f.response()!();
    await wait(() => fs.existsSync(marker)); c.c.kill('SIGTERM');
    await wait(() => c.c.exitCode !== null || c.c.signalCode !== null);
    expect(c.c.exitCode).toBe(1);
    expect(fs.readdirSync(f.life)).toContain('signal.json.failed');
    expect(controls(f)).toEqual([]);
  });
  it('a reason published just before the deadline is still reported', async () => {
    // In the launcher only: the clock jumps past the deadline the moment the
    // reason file exists, so the launcher's next look at the clock says "too
    // late". It must still read the reason rather than give up without it.
    const f = await setup(); const preload = path.join(f.d, 'deadline-at-publish.mjs');
    fs.writeFileSync(preload, `import fs from 'node:fs';import path from 'node:path';
      if(process.argv[2]!=='--companion') {
        const life=path.join(process.env.MEMESH_DIR,'runtime','codex-session');
        const real=Date.now;
        Date.now=()=>{ let late=false; try { late=fs.readdirSync(life).some(n=>n.endsWith('.failed')); } catch {} return real()+(late?600000:0); };
      }`);
    const p = launch(f, preload);
    await wait(() => !!f.response()); f.response()!();
    await wait(() => p.c.exitCode !== null);
    expect(p.c.exitCode).toBe(1);
    expect(p.stderr()).toContain('router_outdated');
  });
});
