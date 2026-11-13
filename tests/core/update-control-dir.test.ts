import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { currentPolicy, dispatchAutoUpdate, productionDeps, propagateOff, registerLiveHost, updateControlDir } from '../../src/core/auto-update.js';

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-control-'));
  roots.push(root);
  const home = path.join(root, 'A'); const data = path.join(root, 'B'); const account = path.join(root, 'C');
  for (const directory of [home, data, account]) fs.mkdirSync(directory);
  return { root, home, data, account, control: path.join(home, '.memesh') };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('HOME owns update control records', () => {
  it('dispatch records and the runner lock argument use HOME despite a separate database', async () => {
    const f = fixture();
    vi.stubEnv('HOME', f.home); vi.stubEnv('MEMESH_DIR', f.data); vi.stubEnv('MEMESH_DB_PATH', path.join(f.data, 'kg.db'));
    vi.spyOn(os, 'userInfo').mockReturnValue({ homedir: f.account } as ReturnType<typeof os.userInfo>);
    const plugin = path.join(f.root, 'plugin'); const runner = path.join(plugin, 'scripts', 'hooks', 'auto-update-runner.mjs');
    fs.mkdirSync(path.dirname(runner), { recursive: true }); fs.writeFileSync(runner, '// fixture runner');
    const calls: string[][] = [];
    const spawnImpl = ((_command: string, args: string[]) => {
      calls.push(args);
      const child = Object.assign(new EventEmitter(), { pid: 4242, unref() {} });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    }) as typeof spawn;
    expect(await dispatchAutoUpdate(plugin, 1000000, { canSelfUpdate: () => ({ ok: true, label: 'fixture' }), spawnImpl })).toEqual({ state: 'dispatched' });
    expect(calls[0]).toContain(path.join(f.control, 'auto-update.lock'));
    expect(fs.readFileSync(path.join(f.control, 'auto-update-attempt'), 'utf8')).toBe('1000000');
    expect(fs.readFileSync(path.join(f.control, 'auto-update.log'), 'utf8')).toContain('DISPATCHED');
    expect(fs.readdirSync(f.data)).toEqual([]); expect(fs.readdirSync(f.account)).toEqual([]);
  });

  it('propagates off only to HOME and still reads account off without changing it', () => {
    const f = fixture();
    vi.stubEnv('HOME', f.home); vi.stubEnv('MEMESH_DIR', f.data); vi.stubEnv('MEMESH_DB_PATH', path.join(f.data, 'kg.db'));
    vi.stubEnv('MEMESH_AUTO_UPDATE', 'major');
    vi.spyOn(os, 'userInfo').mockReturnValue({ homedir: f.account } as ReturnType<typeof os.userInfo>);
    fs.writeFileSync(path.join(f.data, 'config.json'), JSON.stringify({ autoUpdate: 'major' }));
    expect(propagateOff(f.data)).toEqual({ path: path.join(f.control, 'config.json'), error: null });
    expect(currentPolicy().policy).toBe('off');
    expect(fs.readdirSync(f.account)).toEqual([]);
    fs.rmSync(path.join(f.control, 'config.json'));
    const accountConfig = path.join(f.account, '.memesh', 'config.json');
    fs.mkdirSync(path.dirname(accountConfig)); fs.writeFileSync(accountConfig, '{"autoUpdate":"off"}');
    const before = fs.readFileSync(accountConfig);
    expect(currentPolicy()).toMatchObject({ policy: 'off', source: 'account-config' });
    expect(fs.readFileSync(accountConfig)).toEqual(before);
    expect(updateControlDir()).toBe(f.control);
    expect(productionDeps(process.cwd(), '4.13.0')).toMatchObject({ dir: f.control, liveHostsDir: f.control, dbPath: path.join(f.data, 'kg.db') });
  });

  it('registration removes only clearly dead PID records and preserves active and unknown records', () => {
    const f = fixture(); const registry = path.join(f.control, 'live-hosts'); fs.mkdirSync(registry, { recursive: true });
    for (const pid of [2147483645, 2147483646, 2147483647]) fs.writeFileSync(path.join(registry, `${pid}.json`), `sentinel-${pid}`);
    const kill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal: Parameters<typeof process.kill>[1]) => {
      if (pid === 2147483645) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      if (pid === 2147483646) throw Object.assign(new Error('unknown'), { code: 'EPERM' });
      if (pid === 2147483647) return true;
      return kill(pid, signal);
    }) as typeof process.kill);
    registerLiveHost(f.control, process.pid);
    expect(fs.existsSync(path.join(registry, '2147483645.json'))).toBe(false);
    for (const pid of [2147483646, 2147483647]) expect(fs.readFileSync(path.join(registry, `${pid}.json`), 'utf8')).toBe(`sentinel-${pid}`);
  });

  it('a real MCP child without NODE_OPTIONS registers in HOME, not the distinct account or data directory', async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.data, 'config.json'), '{"autoUpdate":"off","updateCheck":false,"autoCapture":false}');
    const entry = pathToFileURL(path.resolve('dist/mcp/server.js')).href;
    const bootstrap = path.join(f.root, 'mcp-fixture.mjs');
    fs.writeFileSync(bootstrap, `import os from 'node:os'; import net from 'node:net'; import {syncBuiltinESMExports} from 'node:module';
      if ('NODE_OPTIONS' in process.env) throw new Error('unexpected preload');
      os.userInfo=()=>({homedir:${JSON.stringify(f.account)},username:'fixture',uid:501,gid:20,shell:null});
      syncBuiltinESMExports();
      net.Socket.prototype.connect=function(){throw new Error('fixture forbids outbound networking')};
      globalThis.fetch=async()=>{throw new Error('fixture forbids outbound networking')};
      await import(${JSON.stringify(entry)});`);
    const child = spawn(process.execPath, [bootstrap], { env: { HOME: f.home, USERPROFILE: f.home, MEMESH_DIR: f.data, MEMESH_DB_PATH: path.join(f.data, 'kg.db'), MEMESH_AUTO_UPDATE: 'off', PATH: f.root }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let errors = '';
    child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { errors += chunk; });
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'control-fixture', version: '1' } } }) + '\n');
      const deadline = Date.now() + 10000;
      while (!output.includes('"id":1') && child.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(output, errors).toContain('"id":1');
      const response = output.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((message) => message.id === 1);
      expect(response.error).toBeUndefined();
      expect(response.result.serverInfo.name).toBe('memesh');
      expect(response.result.capabilities.tools).toBeDefined();
      expect(fs.existsSync(path.join(f.control, 'live-hosts', `${process.pid}.json`))).toBe(true);
      expect(fs.existsSync(path.join(f.data, 'live-hosts'))).toBe(false);
      expect(fs.readdirSync(f.account)).toEqual([]);
      expect(fs.existsSync(path.join(f.data, 'kg.db'))).toBe(true);
    } finally { child.kill('SIGTERM'); await exited; }
    let exitError: NodeJS.ErrnoException | undefined;
    try { process.kill(child.pid!, 0); } catch (error) { exitError = error as NodeJS.ErrnoException; }
    expect(exitError?.code).toBe('ESRCH');
  }, 15000);
});
