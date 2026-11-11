/**
 * The list of running hosts (agents that may have MeMesh files open): what registering and listing do when the directory
 * cannot be written, when a pid was reused, and what the MCP server does at start.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LIVE_HOSTS_DIR, LOG_FILE, liveHostPids, registerLiveHost } from '../../src/core/auto-update.js';
import { findPackageRoot } from '../../src/core/package-root.js';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-hosts-')));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { fs.chmodSync(d, 0o700); fs.chmodSync(path.join(d, LIVE_HOSTS_DIR), 0o700); } catch { /* not there */ }
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const posix = process.platform !== 'win32';
const log = (dir: string) => { try { return fs.readFileSync(path.join(dir, LOG_FILE), 'utf8'); } catch { return ''; } };

describe.skipIf(!posix || isRoot)('a live-hosts directory nobody could register in is unknown, never "nobody is running"', () => {
  it('a live-hosts directory that exists but cannot be written to: null', () => {
    const d = tmp();
    registerLiveHost(d, process.pid);
    expect(liveHostPids(d)).toEqual([process.pid]);
    fs.chmodSync(path.join(d, LIVE_HOSTS_DIR), 0o555);
    expect(liveHostPids(d) === null).toBe(true);
  });

  it('no live-hosts directory yet, and the data directory above it cannot be written to: null (a host could not have registered)', () => {
    const d = tmp();
    fs.chmodSync(d, 0o555);
    expect(liveHostPids(d) === null).toBe(true);
    fs.chmodSync(d, 0o700);
    expect(liveHostPids(d)).toEqual([]);
  });
});

describe('registering a host', () => {
  it('an unusable host pid is logged in the log directory given, not the shared one', () => {
    const shared = tmp();
    const own = tmp();
    registerLiveHost(shared, 1, own);
    expect(log(own)).toContain("host's process id (1) cannot be registered");
    expect(fs.existsSync(path.join(shared, LOG_FILE))).toBe(false);
  });

  it('by default the log goes to the directory the host is registered in', () => {
    const d = tmp();
    registerLiveHost(d, 0);
    expect(log(d)).toContain('cannot be registered');
  });
});

describe('a registration that is judged gone says why, and a failure to remove it is logged', () => {
  const write = (d: string, pid: number, started: string | null) => {
    fs.mkdirSync(path.join(d, LIVE_HOSTS_DIR), { recursive: true });
    fs.writeFileSync(path.join(d, LIVE_HOSTS_DIR, `${pid}.json`), JSON.stringify({ pid, at: new Date().toISOString(), started }));
  };

  it('a pid that is alive but is another program now is not called "no longer running"', () => {
    const d = tmp();
    write(d, process.pid, 'v2:Thu Jan  1 00:00:00 1970');
    expect(liveHostPids(d)).toEqual([]);
    const text = log(d);
    expect(text.length).toBeGreaterThan(0); // the log was really written: the absence below is of a word in it
    expect(text).toContain(`host pid ${process.pid} is now another program`);
    expect(text).not.toContain('no longer running');
    expect(fs.existsSync(path.join(d, LIVE_HOSTS_DIR, `${process.pid}.json`))).toBe(false);
  });

  it('a pid that is gone is "no longer running"', () => {
    const d = tmp();
    const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
    write(d, dead, null);
    expect(liveHostPids(d)).toEqual([]);
    expect(log(d)).toContain(`host pid ${dead} is no longer running`);
  });
});

describe.skipIf(!posix)('a registration written in another time zone and language is still read as the same process', () => {
  it.each([
    ['Asia/Tokyo', 'de_DE.UTF-8'],
    ['America/Los_Angeles', 'zh_TW.UTF-8'],
    ['UTC', 'C'],
  ])('written by a child with TZ=%s LC_ALL=%s, read here: the running host is kept and nothing is logged as removed', (tz, locale) => {
    const d = tmp();
    const script = path.join(tmp(), 'register.mjs');
    fs.writeFileSync(script, [
      `const { registerLiveHost } = await import(${JSON.stringify(pathToFileURL(path.resolve('dist/core/auto-update.js')).href)});`,
      `registerLiveHost(${JSON.stringify(d)}, Number(process.argv[2]));`,
    ].join('\n'));
    const child = spawnSync(process.execPath, [script, String(process.pid)], { env: { PATH: process.env.PATH ?? '', HOME: d, TZ: tz, LC_ALL: locale }, encoding: 'utf8', timeout: 30_000 });
    expect(child.status === 0, child.stderr).toBe(true);
    const record = JSON.parse(fs.readFileSync(path.join(d, LIVE_HOSTS_DIR, `${process.pid}.json`), 'utf8')) as { started: string | null };
    expect(record.started?.startsWith('v2:')).toBe(true); // the pinned form, not the child's locale's text
    expect(liveHostPids(d)).toEqual([process.pid]);
    expect(log(d)).not.toContain('removed');
  });
});

describe.skipIf(!posix)('the MCP server (the built one) starts the updater, like `memesh serve` does', () => {
  it('a started server leaves the updater\'s own line in the log (this source checkout cannot update itself, and says so)', async () => {
    const data = tmp();
    const home = tmp();
    const server = path.resolve('dist/mcp/server.js');
    const env = { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, MEMESH_DIR: data, MEMESH_DB_PATH: path.join(data, 'knowledge-graph.db'), MEMESH_AUTO_UPDATE: 'major' };
    const child = spawn(process.execPath, [server], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    try {
      const deadline = Date.now() + 20_000;
      let text = '';
      while (Date.now() < deadline) {
        text = log(data) + log(path.join(home, '.memesh'));
        if (text.includes('cannot update itself')) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(text).toContain('auto-update: no runner started');
    } finally { child.kill('SIGKILL'); }
  }, 30_000);

  it('every entry point finds the package root the same way: from a module of src/mcp, src/transports/cli or src/core to the repository root', () => {
    for (const rel of ['src/mcp/server.ts', 'src/transports/cli/cli.ts', 'src/core/update-entrypoint.ts']) {
      expect(findPackageRoot(pathToFileURL(path.resolve(rel)).href)).toBe(path.resolve('.'));
    }
    expect(() => findPackageRoot(pathToFileURL(path.join(path.parse(process.cwd()).root, 'no-such-dir', 'x.js')).href)).toThrow('no package.json above');
  });
});
