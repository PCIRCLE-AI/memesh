import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { buildIsolatedRuntimeEnv } from '../../scripts/lib/isolated-env.mjs';
import { expectPrivateDir } from '../helpers/permissions.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const childProgram = `
  import { EventEmitter } from 'node:events';
  import { pathToFileURL } from 'node:url';
  const { createServer } = await import(pathToFileURL(process.argv[1] + '/node_modules/vite/dist/node/index.js').href);
  const server = await createServer({ root: process.argv[1], appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  try {
    const { dispatchAutoUpdate } = await server.ssrLoadModule('/src/core/auto-update.ts');
    const locks = [];
    const result = await dispatchAutoUpdate(process.argv[2], 1_000_000, {
      canSelfUpdate: () => ({ ok: true, label: 'synthetic install' }),
      spawnImpl: (_executable, args) => {
        locks.push(args[1]);
        const child = new EventEmitter();
        child.pid = 42;
        child.unref = () => undefined;
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
    });
    console.log(JSON.stringify({ state: result.state, lock: locks[0] }));
  } finally { await server.close(); }
`;

function dispatch(root: string, plugin: string, home: string, data: string): { state: string; lock: string } {
  const env = buildIsolatedRuntimeEnv({}, {
    runtimeHome: home,
    memeshDir: data,
    dbPath: path.join(data, 'knowledge-graph.db'),
  });
  const run = spawnSync(process.execPath, ['--input-type=module', '--eval', childProgram, root, plugin], {
    env, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout) as { state: string; lock: string };
}

const directRouteProgram = `
  import fs from 'node:fs';
  import os from 'node:os';
  import path from 'node:path';
  import { pathToFileURL } from 'node:url';
  const { createServer } = await import(pathToFileURL(process.argv[1] + '/node_modules/vite/dist/node/index.js').href);
  const server = await createServer({ root: process.argv[1], appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  try {
    const uidHome = process.argv[4];
    os.userInfo = () => ({ homedir: uidHome });
    const { accountMemeshDir, describeLockHolder, runManualUpdate, startReinstall } = await server.ssrLoadModule('/src/core/auto-update.ts');
    const plugin = process.argv[2];
    const data = process.argv[3];
    const manual = runManualUpdate(plugin, data);
    const reinstall = startReinstall(plugin, data);
    const reinstallRecord = path.join(data, 'reinstall-args.json');
    for (let attempt = 0; attempt < 50 && !fs.existsSync(reinstallRecord); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const uidLockDir = accountMemeshDir();
    if (uidLockDir === null) throw new Error('synthetic account home unavailable');
    fs.mkdirSync(uidLockDir, { recursive: true });
    fs.writeFileSync(path.join(uidLockDir, 'auto-update.lock'), 'token\\n' + process.pid + '\\n' + Date.now() + '\\nmanual\\n');
    const manualArgs = JSON.parse(fs.readFileSync(path.join(data, 'manual-args.json'), 'utf8'));
    console.log(JSON.stringify({
      manual,
      reinstall,
      manualArgs,
      reinstallArgs: JSON.parse(fs.readFileSync(reinstallRecord, 'utf8')),
      holder: describeLockHolder(uidLockDir),
      lockDir: path.dirname(manualArgs[0]),
      uidLockDir,
    }));
  } finally { await server.close(); }
`;

function directRoutes(root: string, plugin: string, home: string, data: string, uidHome: string) {
  const env = buildIsolatedRuntimeEnv({}, {
    runtimeHome: home,
    memeshDir: data,
    dbPath: path.join(data, 'knowledge-graph.db'),
  });
  const run = spawnSync(process.execPath, ['--input-type=module', '--eval', directRouteProgram, root, plugin, data, uidHome], {
    env, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout) as {
    manual: { code: number };
    reinstall: { started: boolean };
    manualArgs: string[];
    reinstallArgs: string[];
    holder: { label: string; pid: number; running: boolean } | null;
    lockDir: string;
    uidLockDir: string | null;
  };
}

describe('auto-update lock scope', () => {
  it('uses one owner-private account lock for separate data directories of the same install', () => {
    const root = path.resolve('.');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-update-lock-home-'));
    roots.push(home);
    const plugin = path.join(home, 'plugin');
    fs.mkdirSync(path.join(plugin, 'scripts', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(plugin, 'scripts', 'hooks', 'auto-update-runner.mjs'), 'process.exit(0)\n');
    const first = dispatch(root, plugin, home, path.join(home, 'data-a'));
    const second = dispatch(root, plugin, home, path.join(home, 'data-b'));

    const lock = path.join(home, '.memesh', 'auto-update.lock');
    expect(first).toMatchObject({ state: 'dispatched', lock });
    expect(second).toMatchObject({ state: 'throttled' });
    expect(second.lock).toBeUndefined();
    expectPrivateDir(path.dirname(lock));
    expect(fs.existsSync(path.join(home, 'data-a', 'auto-update-attempt'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'data-b', 'auto-update-attempt'))).toBe(false);
  });

  it('routes manual, reinstall, and lock-holder checks through the account lock without moving active state', () => {
    const root = path.resolve('.');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-update-routes-home-'));
    roots.push(home);
    const data = path.join(home, 'alternate-data');
    const uidHome = path.join(home, 'different-uid-home');
    fs.mkdirSync(uidHome);
    const plugin = path.join(home, 'plugin');
    fs.mkdirSync(path.join(plugin, 'scripts', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(plugin, 'scripts', 'hooks', 'auto-update-runner.mjs'), `
      import fs from 'node:fs';
      import path from 'node:path';
      const data = process.env.MEMESH_DIR;
      const args = process.argv.slice(2);
      const record = args[1] === '--manual' ? 'manual-args.json' : 'reinstall-args.json';
      fs.mkdirSync(data, { recursive: true });
      fs.writeFileSync(path.join(data, record), JSON.stringify(args));
      if (args[1] === '--manual') {
        fs.writeFileSync(path.join(data, 'auto-update-state.json'), JSON.stringify({
          at: new Date().toISOString(), from: '1.0.0', to: '1.0.1', channel: 'npm-global',
          backup: null, outcome: 'installed', reason: 'installed', waitingSince: null, hermes: null,
        }));
      }
    `);

    const result = directRoutes(root, plugin, home, data, uidHome);
    const lock = path.join(home, '.memesh', 'auto-update.lock');
    expect(result.manual.code).toBe(0);
    expect(result.reinstall.started).toBe(true);
    expect(result.manualArgs).toEqual([lock, '--manual']);
    expect(result.reinstallArgs).toEqual([lock, '--reinstall']);
    expect(result.lockDir).toBe(path.dirname(lock));
    expect(result.uidLockDir).toBe(path.join(uidHome, '.memesh'));
    expect(result.holder).toMatchObject({ label: 'manual', pid: expect.any(Number), running: true });
    expect(fs.existsSync(path.join(data, 'auto-update-state.json'))).toBe(true);
  });
});
