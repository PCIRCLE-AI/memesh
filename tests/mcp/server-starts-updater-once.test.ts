/**
 * Several MCP servers (one per session) start together on a machine whose plugin can update itself. Each asks the updater
 * to start; the updater's own throttle must let exactly one runner through. The built server runs from a copy placed where
 * Claude Code puts a plugin, under a throwaway HOME, with a runner stub that records every start.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) { try { c.kill('SIGKILL'); } catch { /* already gone */ } }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function plugin() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-mcp-once-')));
  dirs.push(home);
  const root = path.join(home, '.claude', 'plugins', 'cache', 'pcircle-memesh', 'memesh', '4.13.0');
  fs.mkdirSync(path.join(root, 'scripts', 'hooks'), { recursive: true });
  fs.cpSync(path.resolve('dist'), path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@pcircle/memesh', version: '4.13.0', type: 'module' }));
  fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'));
  const runs = path.join(home, 'runner-starts.log');
  // The stub is the runner: it only records that it was started, and stays a moment as a real one would.
  fs.writeFileSync(path.join(root, 'scripts', 'hooks', 'auto-update-runner.mjs'), `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(runs)}, process.pid + '\\n'); await new Promise((r) => setTimeout(r, 1500));\n`);
  return { home, root, runs, data: path.join(home, '.memesh') };
}

describe.skipIf(process.platform === 'win32')('the packaged MCP server starts the updater, and only one of several starts a runner', () => {
  /** Three servers started at the same moment on one data directory, in a plugin copy under a throwaway HOME. */
  async function round() {
    const p = plugin();
    const env = { PATH: process.env.PATH ?? '', HOME: p.home, USERPROFILE: p.home, MEMESH_DIR: p.data, MEMESH_DB_PATH: path.join(p.data, 'knowledge-graph.db'), MEMESH_AUTO_UPDATE: 'major', NODE_OPTIONS: process.env.NODE_OPTIONS ?? '' };
    const exited: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const child = spawn(process.execPath, [path.join(p.root, 'dist', 'mcp', 'server.js')], { env, stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      child.stderr?.on('data', (chunk) => { err += String(chunk); });
      child.once('exit', (code, signal) => { exited.push(`server ${i}: ${signal ?? code}: ${err.slice(0, 300)}`); });
      children.push(child);
    }
    const log = path.join(p.data, 'auto-update.log');
    const text = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
    const count = (re: RegExp) => (text().match(re) ?? []).length;
    const deadline = Date.now() + 30_000;
    // every server that is still running has answered the updater: one dispatched it, the others were throttled
    while (Date.now() < deadline && count(/auto-update DISPATCHED/g) + count(/auto-update THROTTLED/g) + exited.length < 3) await new Promise((r) => setTimeout(r, 200));
    await new Promise((r) => setTimeout(r, 2500)); // a second runner, if any, would have started by now
    for (const c of children.splice(0)) { try { c.kill('SIGKILL'); } catch { /* already gone */ } }
    return { dispatched: count(/auto-update DISPATCHED/g), throttled: count(/auto-update THROTTLED/g), exited, runs: fs.existsSync(p.runs) ? fs.readFileSync(p.runs, 'utf8').trim().split('\n') : [] };
  }

  it('servers started together in one HOME: the runner starts once, and the log says so once', async () => {
    const r = await round();
    // All three survive their start (none stopped, not even with "database is locked"): one dispatches the runner, two are throttled.
    expect(r.exited, 'a server stopped').toEqual([]);
    expect(r.dispatched).toBe(1);
    expect(r.runs).toHaveLength(1);
    expect(r.throttled).toBe(2);
  }, 300_000);
});
