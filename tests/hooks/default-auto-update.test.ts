/**
 * #533: the session no longer asks "reply Upgrade" and then installs nothing.
 * There is no consent step and no consent state; the SessionStart hook only
 * registers its host and starts the runner, and every attempt leaves a record.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { removeTempDir } from '../helpers/temp-dir.js';

const require = createRequire(import.meta.url);
const repoVersion = (require(path.resolve('package.json')) as { version: string }).version;

const dirs: string[] = [];
afterEach(() => { removeTempDir(...dirs.splice(0)); });

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-default-au-'));
  dirs.push(dir);
  const dbPath = path.join(dir, 'test.db');
  const cachePath = path.join(dir, 'update-check.json');
  fs.writeFileSync(cachePath, JSON.stringify({
    currentVersion: repoVersion,
    latestVersion: '99.0.0',
    checkedAt: new Date().toISOString(),
    lastAttemptAt: new Date().toISOString(),
    lastSuccessfulCheckAt: new Date().toISOString(),
    lastError: null,
    updateAvailable: true,
    checkSucceeded: true,
    source: 'fresh',
    currentVersionDeprecation: null,
  }));
  return { dir, dbPath, cachePath };
}

function runSessionStart(env: Record<string, string>): string {
  return execFileSync('node', [path.resolve('scripts/hooks/session-start.js')], {
    input: JSON.stringify({ cwd: '/tmp/default-au-project', session_id: 'default-au-session' }),
    env: { ...process.env, MEMESH_AUTO_UPDATE: undefined, MEMESH_DIR: undefined, ...env },
    encoding: 'utf8',
    timeout: 20_000,
  });
}

describe('#533: no reply-Upgrade flow', () => {
  it('shows no "reply Upgrade" prompt and writes no consent state when a newer version exists', () => {
    const s = sandbox();
    const out = runSessionStart({ MEMESH_DB_PATH: s.dbPath, MEMESH_UPDATE_CHECK_PATH: s.cachePath, HOME: s.dir });
    expect(out).not.toMatch(/Reply/i);
    expect(out).not.toMatch(/Upgrade”/);
    expect(out).not.toMatch(/consent/i);
    expect(fs.existsSync(path.join(s.dir, 'update-consent'))).toBe(false);
    expect(fs.existsSync(path.join(s.dir, '.memesh', 'update-consent'))).toBe(false);
  });

  it('registers the host process so the updater waits for it to exit', () => {
    const s = sandbox();
    runSessionStart({ MEMESH_DB_PATH: s.dbPath, MEMESH_UPDATE_CHECK_PATH: s.cachePath, HOME: s.dir });
    // Registered in the ACCOUNT's own directory (HOME/.memesh), where every data directory's update looks.
    expect(fs.existsSync(path.join(s.dir, '.memesh', 'live-hosts', `${process.pid}.json`))).toBe(true);
    expect(fs.existsSync(path.join(s.dir, 'live-hosts'))).toBe(false);
  });

  it('a session with no database yet says in the log that it started no update check, instead of returning in silence', async () => {
    const s = sandbox();
    runSessionStart({ MEMESH_DB_PATH: s.dbPath, MEMESH_UPDATE_CHECK_PATH: s.cachePath, HOME: s.dir, MEMESH_AUTO_UPDATE: 'major' });
    const logPath = path.join(s.dir, 'auto-update.log');
    for (let i = 0; i < 50 && !(fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').includes('no database yet')); i += 1) await new Promise((r) => setTimeout(r, 100));
    expect(fs.readFileSync(logPath, 'utf8')).toContain('there is no database yet, so neither the update check nor the updater starts in this session');
    expect(fs.existsSync(path.join(s.dir, 'auto-update-attempt'))).toBe(false);
  }, 30_000);

  it('a session whose installed version cannot be read (no package.json at the plugin root) says in the log that it started no updater', async () => {
    const s = sandbox();
    new MemeshDatabase(s.dbPath).close();
    // A plugin root of its own: the hooks copied beside a link to the built modules, and no package.json.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-no-pkg-'));
    dirs.push(root);
    fs.cpSync(path.resolve('scripts'), path.join(root, 'scripts'), { recursive: true });
    fs.symlinkSync(path.resolve('dist'), path.join(root, 'dist'));
    fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'));
    execFileSync('node', [path.join(root, 'scripts', 'hooks', 'session-start.js')], {
      input: JSON.stringify({ cwd: '/tmp/default-au-project', session_id: 'no-package-json' }),
      env: { ...process.env, MEMESH_DIR: undefined, MEMESH_DB_PATH: s.dbPath, MEMESH_UPDATE_CHECK_PATH: s.cachePath, HOME: s.dir, MEMESH_AUTO_UPDATE: 'major' },
      encoding: 'utf8', timeout: 20_000,
    });
    const logPath = path.join(s.dir, 'auto-update.log');
    for (let i = 0; i < 50 && !(fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').includes('installed version could not be read')); i += 1) await new Promise((r) => setTimeout(r, 100));
    expect(fs.readFileSync(logPath, 'utf8')).toContain('the installed version could not be read from package.json, so neither the update check nor the updater starts');
    expect(fs.existsSync(path.join(s.dir, 'auto-update-attempt'))).toBe(false);
  }, 30_000);

  it('with automatic updates ON the hook asks the dispatch, which says why it starts nothing from a source checkout (it cannot update itself) and takes no attempt slot', async () => {
    const s = sandbox();
    new MemeshDatabase(s.dbPath).close();
    // Explicitly on (the data directory here is not the account's own, so the default would not apply). The hook runs from this
    // source checkout, which is not an install that can update itself: that is the dispatch's own answer, and it is logged.
    runSessionStart({ MEMESH_DB_PATH: s.dbPath, MEMESH_UPDATE_CHECK_PATH: s.cachePath, HOME: s.dir, MEMESH_AUTO_UPDATE: 'major' });
    const logPath = path.join(s.dir, 'auto-update.log');
    for (let i = 0; i < 100 && !(fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').includes('cannot update itself')); i += 1) await new Promise((r) => setTimeout(r, 100));
    expect(fs.readFileSync(logPath, 'utf8')).toContain('no runner started: source checkout cannot update itself');
    expect(fs.readFileSync(logPath, 'utf8')).not.toContain('DISPATCHED');
    expect(fs.existsSync(path.join(s.dir, 'auto-update-attempt'))).toBe(false);
    expect(fs.existsSync(path.join(s.dir, 'auto-update-state.json'))).toBe(false);
  }, 30_000);

  it('with automatic updates OFF it starts nothing: no runner, no attempt record, only a line saying why (and none of the work the runner does first)', async () => {
    const s = sandbox();
    new MemeshDatabase(s.dbPath).close();
    runSessionStart({ MEMESH_DB_PATH: s.dbPath, MEMESH_UPDATE_CHECK_PATH: s.cachePath, HOME: s.dir, MEMESH_AUTO_UPDATE: 'off' });
    const noteLog = path.join(s.dir, 'auto-update.log');
    for (let i = 0; i < 50 && !(fs.existsSync(noteLog) && fs.readFileSync(noteLog, 'utf8').includes('automatic updates are off')); i += 1) await new Promise((r) => setTimeout(r, 100));
    expect(fs.readFileSync(noteLog, 'utf8')).toContain('automatic updates are off, so the updater does not start in this session');
    await new Promise((r) => setTimeout(r, 1500)); // a runner started by mistake would have written its record by now
    expect(fs.existsSync(path.join(s.dir, 'auto-update-state.json'))).toBe(false);
    expect(fs.existsSync(path.join(s.dir, 'auto-update-attempt'))).toBe(false);
    expect(fs.existsSync(path.join(s.dir, 'auto-update.lock'))).toBe(false);
    const log = path.join(s.dir, 'auto-update.log');
    expect(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').not.toContain('DISPATCHED');
  }, 30_000);
});
