/**
 * The account home a test sees is the test's HOME, never the maintainer's real
 * one (see tests/setup/isolate-account-home.ts). Without that, the auto-update
 * policy and doctor read the real ~/.memesh/config.json from inside tests.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'node:url';
import { buildIsolatedSuiteEnv } from '../../scripts/lib/isolated-env.mjs';
import { currentPolicy, productionDeps, resolveUpdatePolicy, runAutoUpdate, safeAccountHome } from '../../src/core/auto-update.js';

describe('account home isolation', () => {
  it('runs policy against separate data and config directories while writing only to the fake HOME control', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-update-isolation-'));
    const home = path.join(root, 'home'); const config = path.join(root, 'config');
    const dataA = path.join(root, 'data-a'); const dataB = path.join(root, 'data-b');
    for (const dir of [home, config, dataA, dataB]) fs.mkdirSync(dir);
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, MEMESH_DIR: process.env.MEMESH_DIR,
      MEMESH_DB_PATH: process.env.MEMESH_DB_PATH, MEMESH_AUTO_UPDATE: process.env.MEMESH_AUTO_UPDATE, CI: process.env.CI };
    try {
      process.env.HOME = home; process.env.USERPROFILE = home;
      expect(safeAccountHome()).toBe(home);
      process.env.MEMESH_DIR = config; process.env.MEMESH_AUTO_UPDATE = 'major'; delete process.env.CI;
      fs.writeFileSync(path.join(config, 'config.json'), '{"autoUpdate":"off"}');
      process.env.MEMESH_DB_PATH = path.join(dataA, 'graph.db');
      const first = await runAutoUpdate(productionDeps(root, '4.13.0'));
      expect(first).toMatchObject({ outcome: 'skipped' });
      expect(first.reason).toContain('policy is off');
      fs.writeFileSync(path.join(config, 'config.json'), '{}');
      fs.writeFileSync(path.join(dataB, 'config.json'), '{"autoUpdate":"off"}');
      process.env.MEMESH_DB_PATH = path.join(dataB, 'graph.db');
      const second = await runAutoUpdate(productionDeps(root, '4.13.0'));
      expect(second).toMatchObject({ outcome: 'skipped' });
      expect(second.reason).toContain('policy is off');
      const control = path.join(home, '.memesh');
      expect(JSON.parse(fs.readFileSync(path.join(control, 'auto-update-state.json'), 'utf8')).outcome).toBe('skipped');
      expect(fs.readFileSync(path.join(control, 'auto-update.log'), 'utf8').match(/SKIPPED/g)).toHaveLength(2);
      for (const dir of [dataA, dataB, config]) expect(fs.existsSync(path.join(dir, 'auto-update-state.json'))).toBe(false);
      if (process.platform !== 'win32') {
        expect(fs.statSync(control).mode & 0o077).toBe(0);
        expect(fs.statSync(path.join(control, 'auto-update-state.json')).mode & 0o077).toBe(0);
      }
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('os.userInfo().homedir follows HOME, so the account is the throwaway one', () => {
    expect(process.env.HOME).toBeTruthy();
    expect(os.userInfo().homedir).toBe(process.env.HOME);
    expect(safeAccountHome()).toBe(process.env.HOME);
  });

  it('a node process started from the test (a hook, the runner, the CLI) gets the same answer, and the preload alone is what makes it so', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-preload-'));
    try {
      const probe = 'process.stdout.write(require("os").userInfo().homedir)';
      const preload = path.resolve('scripts/lib/account-home-preload.mjs');
      const without = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
      const withIt = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, '-e', probe], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
      expect(without.status === 0, without.stderr).toBe(true);
      expect(without.stdout).not.toBe(home); // the system account database, not HOME
      expect(withIt.status === 0, withIt.stderr).toBe(true);
      expect(withIt.stdout).toBe(home);
      // The runner's environment carries it into every child.
      const env = buildIsolatedSuiteEnv({ PATH: process.env.PATH }, { runtimeHome: home });
      expect(String(env.NODE_OPTIONS ?? '')).toContain('account-home-preload.mjs');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('a config written in the account\'s own ~/.memesh is what the policy reads — and it is the isolated one', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-acct-'));
    const saved = { HOME: process.env.HOME, MEMESH_DIR: process.env.MEMESH_DIR, MEMESH_DB_PATH: process.env.MEMESH_DB_PATH, MEMESH_AUTO_UPDATE: process.env.MEMESH_AUTO_UPDATE, CI: process.env.CI };
    try {
      fs.mkdirSync(path.join(home, '.memesh'));
      fs.writeFileSync(path.join(home, '.memesh', 'config.json'), '{"autoUpdate":"off"}');
      process.env.HOME = home;
      delete process.env.MEMESH_DIR;
      delete process.env.MEMESH_DB_PATH;
      delete process.env.MEMESH_AUTO_UPDATE;
      delete process.env.CI;
      expect(currentPolicy()).toMatchObject({ policy: 'off', source: 'config' });
      fs.writeFileSync(path.join(home, '.memesh', 'config.json'), '{"autoUpdate":"minor"}');
      expect(currentPolicy()).toMatchObject({ policy: 'minor' });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('the policy reads the setting from the data directory MEMESH_DB_PATH names when MEMESH_DIR is not set (not from the default ~/.memesh)', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-dbonly-'));
    const saved = { MEMESH_DIR: process.env.MEMESH_DIR, MEMESH_DB_PATH: process.env.MEMESH_DB_PATH, MEMESH_AUTO_UPDATE: process.env.MEMESH_AUTO_UPDATE, CI: process.env.CI };
    try {
      fs.writeFileSync(path.join(dataDir, 'config.json'), '{"autoUpdate":"minor"}');
      delete process.env.MEMESH_DIR;
      delete process.env.MEMESH_AUTO_UPDATE;
      delete process.env.CI;
      process.env.MEMESH_DB_PATH = path.join(dataDir, 'knowledge-graph.db');
      expect(currentPolicy()).toMatchObject({ policy: 'minor', source: 'config' });
      // Records use HOME control; the active policy still follows the DB directory.
      const deps = productionDeps(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-root-')), '4.13.0');
      expect(deps.dir).toBe(path.join(process.env.HOME!, '.memesh'));
      expect(path.dirname(deps.dbPath)).toBe(dataDir);
      expect(resolveUpdatePolicy({ env: process.env, activeDir: path.dirname(deps.dbPath), extraConfigDirs: [deps.configDir, deps.dir], accountHome: deps.accountHome })).toMatchObject({ policy: 'minor' });
      fs.writeFileSync(path.join(dataDir, 'config.json'), '{"autoUpdate":"off"}');
      expect(currentPolicy()).toMatchObject({ policy: 'off', source: 'config' });
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('an explicit off written by `memesh config set` is seen when the config directory and the data directory are apart (MEMESH_DIR and MEMESH_DB_PATH differ), by the policy and by the runner\'s own wiring', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cfgdir-'));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-datadir-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-root-'));
    const saved = { MEMESH_DIR: process.env.MEMESH_DIR, MEMESH_DB_PATH: process.env.MEMESH_DB_PATH, MEMESH_AUTO_UPDATE: process.env.MEMESH_AUTO_UPDATE, CI: process.env.CI };
    try {
      fs.writeFileSync(path.join(configDir, 'config.json'), '{"autoUpdate":"off"}');
      process.env.MEMESH_DIR = configDir;
      process.env.MEMESH_DB_PATH = path.join(dataDir, 'knowledge-graph.db');
      process.env.MEMESH_AUTO_UPDATE = 'major'; // explicit, so the "foreign directory" rule is not what answers
      delete process.env.CI;
      // What doctor and the session-start notice ask.
      expect(currentPolicy()).toMatchObject({ policy: 'off', source: 'config' });
      // What the runner uses: HOME for records, and both data and config directories for policy.
      const deps = productionDeps(root, '4.12.0');
      expect(deps.dir).toBe(path.join(process.env.HOME!, '.memesh'));
      expect(path.dirname(deps.dbPath)).toBe(dataDir);
      expect(deps.configDir).toBe(configDir);
      expect(resolveUpdatePolicy({ env: process.env, activeDir: path.dirname(deps.dbPath), extraConfigDirs: [deps.configDir, deps.dir], accountHome: deps.accountHome })).toMatchObject({ policy: 'off', source: 'config' });
      // The control: without the config directory the same environment would update.
      expect(resolveUpdatePolicy({ env: process.env, activeDir: path.dirname(deps.dbPath), accountHome: deps.accountHome })).toMatchObject({ policy: 'major' });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      for (const d of [configDir, dataDir, root]) fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
