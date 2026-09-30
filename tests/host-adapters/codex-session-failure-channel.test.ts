// #518: an outdated router's reason reaches the SessionStart launcher through a
// private file the detached companion writes. These spawn the built launcher.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

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
afterEach(async () => {
  for (const c of kids.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) {
      c.kill('SIGKILL'); await new Promise(r => c.once('close', r));
    }
  }
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
      const frame = JSON.parse(chunk.toString().trim());
      response = () => s.write(JSON.stringify({ version: 2, request_id: code === 'unexpected_field' ? '' : frame.request_id,
        ok: false, error: { code, message: code === 'unexpected_field'
          ? 'Router frame contains unsupported field memesh_version.' : 'fixture invalid token' } }) + '\n');
    });
  });
  servers.push(server);
  await new Promise<void>(r => server.listen(sock, r)); fs.chmodSync(sock, 0o600);
  const life = path.join(d, 'runtime', 'codex-session');
  return { d, sock, life, response: () => response, env: {
    ...process.env, MEMESH_DIR: d, MEMESH_DB_PATH: path.join(d, 'db'), MEMESH_ROUTER_SOCKET: sock,
    MEMESH_ROUTER_TOKEN_FILE: path.join(d, 'agent-router.token'), PLUGIN_ROOT: process.cwd(),
  } };
}
function launch(f: Awaited<ReturnType<typeof setup>>, preload?: string) {
  const c = spawn(process.execPath, ['dist/host-runtime/codex-session.js'], {
    env: { ...f.env, ...(preload ? { NODE_OPTIONS: '--import=' + pathToFileURL(preload).href } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  }); kids.push(c);
  let stderr = ''; c.stderr!.on('data', x => stderr += x);
  c.stdin!.end(JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: thread, cwd: f.d }));
  return { c, stderr: () => stderr };
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
    await wait(()=>!!f.response());f.response()!();await new Promise(r=>setTimeout(r,500));
    const controlSockets=fs.readdirSync(f.d).filter(x=>x.startsWith('c-'));
    expect(c.exitCode).toBe(1);
    expect(controlSockets).toEqual([]);
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
    const q=launch(f);await wait(()=>q.c.exitCode!==null);
    expect(p.stderr()).toContain('router_outdated');expect(controlSockets).toEqual([]);
  });
});
