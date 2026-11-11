// Through the built CLI: `memesh message discover` starts the router when it
// is not running, never starts a second one, and says one sentence when it
// cannot. Spawns `dist` because the router it starts is dist/host-runtime/router.js.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { removeTempDir } from '../helpers/temp-dir.js';

const CLI_PATH = path.join(__dirname, '..', '..', 'dist', 'transports', 'cli', 'cli.js');

describe('memesh message discover starts the router', () => {
  let home: string;
  let socketDir: string;
  let socket: string;
  const env = (): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, MEMESH_DIR: path.join(home, '.memesh'), MEMESH_ROUTER_SOCKET: socket };
    for (const key of ['MEMESH_DB_PATH', 'MEMESH_PROJECT_ROOT']) delete e[key];
    return e;
  };
  const discoverArgs = [CLI_PATH, 'message', 'discover', '--project', 'demo'];
  const listeners = (): string[] => {
    const r = spawnSync('lsof', ['-t', socket], { encoding: 'utf8' });
    return [...new Set(r.stdout.split('\n').filter(Boolean))];
  };
  const discoverAsync = () => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn('node', discoverArgs, { env: env() });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-autostart-home-'));
    // A short path: a Unix socket path has a small length limit.
    socketDir = fs.mkdtempSync('/tmp/mr-');
    socket = path.join(socketDir, 'r.sock');
  });
  afterEach(() => {
    if (fs.existsSync(socket)) for (const pid of listeners()) { try { process.kill(Number(pid)); } catch { /* already gone */ } }
    removeTempDir(home, socketDir);
  });

  it('starts it when it is not running, then answers', () => {
    expect(fs.existsSync(socket)).toBe(false);
    const r = spawnSync('node', discoverArgs, { encoding: 'utf8', env: env(), timeout: 60000 });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toBeTypeOf('object');
    expect(listeners()).toHaveLength(1);
  }, 90_000);

  it('two commands at once end with one router, and a later one reuses it', async () => {
    const both = await Promise.all([discoverAsync(), discoverAsync()]);
    for (const r of both) expect(r.status, r.stderr).toBe(0);
    const before = listeners();
    expect(before).toHaveLength(1);
    const later = spawnSync('node', discoverArgs, { encoding: 'utf8', env: env(), timeout: 60000 });
    expect(later.status, later.stderr).toBe(0);
    expect(listeners()).toEqual(before);
  }, 120_000);

  it('says one sentence, exit 1, when the router cannot start', () => {
    const e = { ...env(), MEMESH_ROUTER_SOCKET: '/nonexistent-memesh-dir/r.sock' };
    const r = spawnSync('node', discoverArgs, { encoding: 'utf8', env: e, timeout: 60000 });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
    expect(r.stderr).toContain('router_unreachable: the MeMesh message router is not running and could not be started');
    expect(r.stderr).toContain('`memesh-router`');
  }, 90_000);
});
