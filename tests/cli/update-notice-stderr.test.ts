import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(repoRoot, 'dist', 'transports', 'cli', 'cli.js');
const CURRENT_VERSION = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version as string;

describe('CLI first-use update notice (#308: any entry point)', () => {
  it('refreshes a missing cache from the actual bundled CLI without a hook or opening the graph', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-refresh-'));
    const preload = path.join(dir, 'offline.cjs');
    fs.writeFileSync(preload, `
      const cp = require('node:child_process');
      const fs = require('node:fs');
      const originalSpawn = cp.spawn;
      cp.spawn = (...args) => {
        fs.writeFileSync(process.env.REFRESH_TRACE, JSON.stringify(args.slice(0, 2)));
        return originalSpawn(...args);
      };
      const originalExecFile = cp.execFile;
      cp.execFile = (command, args, options, callback) => {
        if (command !== 'npm') return originalExecFile(command, args, options, callback);
        process.nextTick(() => callback(null, args.includes('version') ? '99.0.0\\n' : '', ''));
        return { kill() {} };
      };
      require('node:module').syncBuiltinESMExports();
      if (process.argv.includes('status') || process.argv[1]?.endsWith('/core/version-check.js')) process.on('exit', () => fs.writeFileSync(process.env.REFRESH_DONE, 'done'));
    `);
    const done = path.join(dir, 'done');
    const trace = path.join(dir, 'trace.json');
    const env = { ...process.env, HOME: dir, MEMESH_DIR: dir, MEMESH_DB_PATH: path.join(dir, 'memesh.db'), NODE_OPTIONS: `--require=${preload}`, REFRESH_TRACE: trace, REFRESH_DONE: done };
    try {
      const first = spawnSync(process.execPath, [CLI, 'remember', '--name', 'owned-blank', '--type', 'note', '--obs', '   '], { env, encoding: 'utf8', timeout: 10000 });
      expect(fs.existsSync(trace)).toBe(true);
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(done) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      expect(fs.existsSync(done)).toBe(true);
      expect(first.status, first.stderr).toBe(1);
      expect(first.stderr).toContain('--obs needs some text');
      const cache = JSON.parse(fs.readFileSync(path.join(dir, `update-check.${CURRENT_VERSION}.json`), 'utf8'));
      expect(cache.latestVersion).toBe('99.0.0');
      expect(cache.checkSucceeded).toBe(true);
      // A registry refresh must not migrate or lock the caller's graph.
      expect(fs.existsSync(path.join(dir, 'memesh.db'))).toBe(false);
      const [command, args] = JSON.parse(fs.readFileSync(trace, 'utf8')) as [string, string[]];
      expect(command).toBe(process.execPath);
      expect(args.slice(-2)).toEqual([pathToFileURL(path.join(repoRoot, 'dist/core/version-check.js')).href, CURRENT_VERSION]);
      fs.unlinkSync(trace);
      const second = spawnSync(process.execPath, [CLI, 'recall', 'anything', '--json'], { env, encoding: 'utf8', timeout: 10000 });
      expect(second.status, second.stderr).toBe(0);
      expect(fs.existsSync(trace)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a refresh spawn error from crashing the unbundled MCP resolver and releases its claim', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-refresh-error-'));
    const preload = path.join(dir, 'spawn-error.cjs');
    fs.writeFileSync(preload, `
      const cp = require('node:child_process');
      cp.spawn = () => {
        const child = new (require('node:events').EventEmitter)();
        child.unref = () => {};
        process.nextTick(() => child.emit('error', Object.assign(new Error('owned failure'), { code: 'ENOENT' })));
        return child;
      };
      require('node:module').syncBuiltinESMExports();
    `);
    const resolver = path.join(repoRoot, 'dist/core/update-entrypoint.js');
    const script = `import {updateNoticeForEntryPoint} from ${JSON.stringify(resolver)}; updateNoticeForEntryPoint({dir:process.env.MEMESH_DIR,currentVersion:${JSON.stringify(CURRENT_VERSION)},entryPoint:'mcp',processOnce:new Set()});`;
    try {
      const result = spawnSync(process.execPath, ['--require', preload, '--input-type=module', '-e', script], { env: { ...process.env, HOME: dir, MEMESH_DIR: dir }, encoding: 'utf8', timeout: 10000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain('Could not start update cache refresh (ENOENT)');
      expect(fs.existsSync(path.join(dir, `last-fresh-refresh.${CURRENT_VERSION}.lock`))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints one stderr line a day, keeps stdout clean, and skips the update commands themselves', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-notice-'));
    fs.writeFileSync(path.join(dir, `update-check.${CURRENT_VERSION}.json`), JSON.stringify({
      currentVersion: CURRENT_VERSION, latestVersion: '99.0.0', checkSucceeded: true,
      lastSuccessfulCheckAt: new Date().toISOString(), lastAttemptAt: new Date().toISOString(),
    }));
    const env = { ...process.env, MEMESH_DIR: dir, MEMESH_DB_PATH: path.join(dir, 'memesh.db') };
    const run = (...args: string[]) => spawnSync('node', [CLI, ...args], { env, encoding: 'utf8' });

    const first = run('recall', 'anything', '--json');
    expect(first.status, first.stderr).toBe(0);
    expect(first.stderr).toContain('[memesh update] 99.0.0 is available');
    expect(() => JSON.parse(first.stdout)).not.toThrow(); // stdout is still machine-readable
    const second = run('recall', 'anything', '--json');
    expect(second.stderr).not.toContain('[memesh update]'); // once a day
    fs.rmSync(path.join(dir, `last-cli-update-notice.${CURRENT_VERSION}.lock`));
    const status = run('status');
    expect(status.stderr).not.toContain('[memesh update]'); // status speaks for itself
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
