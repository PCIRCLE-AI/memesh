/**
 * #540: the first session after an install must not open with an update
 * warning that describes something not yet tried.
 *
 * Two cases, both silent:
 *  - no database yet: this hook does not start the update check before a
 *    database exists, so as far as the hook knows nothing has been tried (the
 *    CLI and the MCP server do start a check without a database; when one has
 *    run, its cache exists and this case does not apply); the silence costs
 *    nothing (no marker);
 *  - the first session that has a database: it starts the check itself, and is
 *    silent once per installed version.
 * After that, with still no answer, the warning is true and is shown. If the
 * marker that records "silent once" cannot be written, the warning is shown
 * (hidden-for-no-visible-reason is the worse failure). Every withheld warning,
 * and every marker, cache or background-check problem the hook meets, leaves a
 * line in hook-outcomes.jsonl saying why (#360).
 *
 * The session-start hook takes a different route for a database with no tables
 * than for one that holds memories, and each route reads the update cache and
 * writes the markers on its own. Every case below that needs a database runs on
 * BOTH (`describe.each(DATABASES)`); only the one case about having no database
 * at all stands outside.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { removeTempDir } from '../helpers/temp-dir.js';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { canDenyReads } from '../helpers/permissions.js';
import { npmInvocation } from '../../src/core/npm-launch.js';

const require = createRequire(import.meta.url);
// _shared.js is plain JS with no type declarations.
const shared = require('../../scripts/hooks/_shared.js');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) { try { fs.chmodSync(d, 0o755); } catch { /* gone */ } }
  removeTempDir(...dirs.splice(0));
});

const VERSION = (JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as { version: string }).version;
const WARNING = 'could not confirm whether an update exists';
// A 0555 folder is no barrier to root, or on Windows: the cases that need an
// unwritable folder are skipped there, loudly, instead of passing untested.

function fresh(): { home: string; dbPath: string } {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-first-session-')));
  dirs.push(home);
  return { home, dbPath: path.join(home, 'test.db') };
}

function run(home: string, dbPath: string, cachePath = path.join(home, 'no-such-update-check.json'), extraEnv: NodeJS.ProcessEnv = {}, timeout = 20_000): string {
  return execFileSync('node', [path.resolve('scripts/hooks/session-start.js')], {
    input: JSON.stringify({ cwd: '/tmp/first-session-project', session_id: `first-session-${Date.now()}-${Math.random()}` }),
    env: {
      ...process.env,
      HOME: home,
      MEMESH_DIR: undefined,
      MEMESH_DB_PATH: dbPath,
      // No cache file at all: nothing has ever been checked on this install.
      MEMESH_UPDATE_CHECK_PATH: cachePath,
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout,
  });
}

// Where run() points the hook's update-check cache when no path is given.
const cachePathOf = (home: string) => path.join(home, 'no-such-update-check.json');
/** A database file with no tables at all. */
const createDatabase = (dbPath: string) => new MemeshDatabase(dbPath).close();
/** The full schema and one memory: the route a real install takes after its first capture. */
function createSeededDatabase(dbPath: string): void {
  const { db } = shared.openHookDb({ ...process.env, MEMESH_DB_PATH: dbPath }, { fts: true });
  try {
    shared.captureEntity(db, { name: 'seed-memory', type: 'note', observations: ['a seeded memory'], tags: [] });
  } finally {
    db.close();
  }
}
const DATABASES: Array<[string, (dbPath: string) => void]> = [
  ['a database with no tables', createDatabase],
  ['a database that holds memories', createSeededDatabase],
];
const names = (home: string) => { try { return fs.readdirSync(path.join(home, '.memesh')); } catch { return []; } };
const startedCheck = (home: string) => names(home).some((n) => n === `last-fresh-refresh.${VERSION}.lock`);
const outcomes = (home: string): Array<{ outcome: string; reason?: string }> => {
  try {
    return fs.readFileSync(path.join(home, 'hook-outcomes.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
};
const reasons = (home: string): string[] => outcomes(home).map((o) => o.reason ?? '');
const reasonMatching = (home: string, pattern: RegExp) => reasons(home).some((r) => pattern.test(r));
const usedSilence = (home: string) => names(home).some((n) => n === `update-check-first-session.${VERSION}.lock`);
const memeshDirOf = (home: string) => {
  const dir = path.join(home, '.memesh');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
/** A cache holding only an attempt time: a check was started and has not finished. */
const attemptOnlyCache = (home: string): string => {
  const cachePath = path.join(home, 'update-check.json');
  fs.writeFileSync(cachePath, JSON.stringify({ currentVersion: VERSION, lastAttemptAt: new Date().toISOString() }));
  return cachePath;
};

describe('#540: update warning on the first session', () => {
  it('with no database yet: silent in every session, nothing is recorded, and no check is started (none can have been tried)', () => {
    const { home, dbPath } = fresh();
    for (let i = 0; i < 3; i += 1) {
      const out = run(home, dbPath);
      expect(out).toContain('MeMesh');
      expect(out).not.toContain(WARNING);
    }
    expect(usedSilence(home), 'the one silent session was used up before any check could start').toBe(false);
    expect(startedCheck(home), 'a check was started while there is no database').toBe(false);
    expect(reasonMatching(home, /update warning withheld/), `no record of why the warning was withheld: ${JSON.stringify(reasons(home))}`).toBe(true);
    expect(reasonMatching(home, /update check not started: there is no database yet/), JSON.stringify(reasons(home))).toBe(true);
  });

  describe.each(DATABASES)('on %s', (_label, makeDatabase) => {
    it('the first session that has a database starts the check, is silent once, and the next session speaks if there is still no answer', async () => {
      const deadline = Date.now() + 55_000;
      const remaining = (cleanup = false) => Math.max(0, deadline - Date.now() - (cleanup ? 0 : 10_000));
      const { home, dbPath } = fresh();
      makeDatabase(dbPath);
      const preload = path.join(home, 'hold-registry.cjs');
      const ready = path.join(home, 'registry-ready.json');
      const owned = path.join(home, 'background-owned.json');
      const release = path.join(home, 'release-registry');
      const exited = path.join(home, 'background-exited.json');
      const cli = path.resolve('dist/transports/cli/cli.js');
      const lookups = [
        npmInvocation(['show', '@pcircle/memesh', 'version']),
        npmInvocation(['view', `@pcircle/memesh@${VERSION}`, 'deprecated']),
      ];
      expect(lookups.every(Boolean), 'npm must be available to the real background check').toBe(true);
      fs.writeFileSync(preload, `const fs = require('node:fs');
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const lookups = ${JSON.stringify(lookups)};
function publish(file, value) {
  const temp = file+'.'+process.pid+'.'+Math.random().toString(36).slice(2)+'.tmp';
  fs.writeFileSync(temp, JSON.stringify(value), { flag: 'wx' });
  fs.renameSync(temp, file);
}
const spawn = cp.spawn;
cp.spawn = function(command, args, options) {
  const child = spawn.apply(this, arguments);
  if (command === process.execPath && args[0] === ${JSON.stringify(cli)} && args[1] === 'status' && child.pid) {
    publish(${JSON.stringify(owned)}, { pid: child.pid, cli: args[0] });
  }
  return child;
};
if (process.argv[1] === ${JSON.stringify(cli)} && process.argv[2] === 'status') {
  process.once('exit', code => publish(${JSON.stringify(exited)}, { pid: process.pid, code }));
  const watchdog = setTimeout(() => process.exit(1), Math.max(1, ${deadline - 1_000} - Date.now()));
  watchdog.unref();
  const calls = [];
  cp.execFile = function(command, args, options, callback) {
    const index = lookups.findIndex(q => command === q.command && JSON.stringify(args) === JSON.stringify(q.args));
    if (index === -1) throw new Error('unexpected background execFile: '+command+' '+JSON.stringify(args));
    calls.push({ index, pid: process.pid });
    if (calls.length === 2) publish(${JSON.stringify(ready)}, calls);
    if (calls.length > 2) throw new Error('unexpected extra registry call');
    const timer = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(release)})) return;
      clearInterval(timer);
      callback(null, index === 0 ? ${JSON.stringify(VERSION)} : '', '');
    }, 25);
    return {};
  };
  syncBuiltinESMExports();
}
syncBuiltinESMExports();
`);
      const env = { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(preload)}`, MEMESH_AUTO_UPDATE: 'off' };
      const waitFor = async (done: () => boolean, cleanup = false) => {
        while (!done() && remaining(cleanup) > 0) await new Promise(r => setTimeout(r, Math.min(100, remaining(cleanup))));
        return done();
      };
      const calls = (): Array<{ index: number; pid: number }> => fs.existsSync(ready)
        ? JSON.parse(fs.readFileSync(ready, 'utf8')) : [];
      const runHook = () => {
        const budget = Math.min(20_000, remaining());
        if (budget === 0) throw new Error('first-session case deadline reached before hook');
        return run(home, dbPath, cachePathOf(home), env, budget);
      };
      let bodyError: unknown;
      try {
        const first = runHook();
        expect(first).not.toContain(WARNING);
        expect(usedSilence(home)).toBe(true);
        expect(reasonMatching(home, /update warning withheld: first session/), `no record of why the warning was withheld: ${JSON.stringify(reasons(home))}`).toBe(true);
        expect(await waitFor(() => startedCheck(home)), 'the session that stayed silent did not start the check').toBe(true);
        expect(await waitFor(() => calls().length === 2), 'both real background registry calls must reach the barrier').toBe(true);
        expect(fs.existsSync(owned), 'the hook must record its owned background PID').toBe(true);
        expect(calls().map(call => call.index).sort()).toEqual([0, 1]);
        expect(new Set(calls().map(call => call.pid)).size).toBe(1);
        // The check this session started is still running: the next session must not find its answer already there,
        // or the warning would be absent for the right reason and this test would be racing the network.
        expect(fs.existsSync(cachePathOf(home)), 'the background check finished before the next session ran').toBe(false);
        const next = runHook();
        expect(next).toContain(WARNING);
        expect(fs.existsSync(cachePathOf(home))).toBe(false);
        expect(calls()).toHaveLength(2);
      } catch (error) { bodyError = error; }
      try {
        fs.writeFileSync(release, 'release');
        if (fs.existsSync(owned)) {
          const owner = JSON.parse(fs.readFileSync(owned, 'utf8')) as { pid: number; cli: string };
          expect(owner.cli).toBe(cli);
          expect(Number.isSafeInteger(owner.pid) && owner.pid > 0).toBe(true);
          expect(await waitFor(() => fs.existsSync(exited), true), 'the owned background process did not finish after release').toBe(true);
          const result = JSON.parse(fs.readFileSync(exited, 'utf8')) as { pid: number; code: number };
          expect(result.pid).toBe(owner.pid);
          expect(await waitFor(() => {
            try { process.kill(result.pid, 0); return false; }
            catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
          }, true), 'the background process still exists after its exit record').toBe(true);
          expect(result.code).toBe(0);
          expect(calls().every(call => call.pid === result.pid)).toBe(true);
          const cache = JSON.parse(fs.readFileSync(cachePathOf(home), 'utf8')) as { checkSucceeded: boolean; latestVersion: string };
          expect(cache).toMatchObject({ checkSucceeded: true, latestVersion: VERSION });
        }
      } catch (cleanupError) {
        if (bodyError !== undefined) throw new AggregateError([bodyError, cleanupError], 'first-session assertion failed; background cleanup also failed', { cause: cleanupError });
        throw cleanupError;
      }
      if (bodyError !== undefined) throw bodyError;
    }, 60_000);

    it('a cache file that exists but holds no finished check is not "the first session": the warning speaks', () => {
      // A check that was started and has not finished (or was interrupted) leaves only an attempt time.
      const { home, dbPath } = fresh();
      makeDatabase(dbPath);
      const out = run(home, dbPath, attemptOnlyCache(home));
      expect(out).toContain(WARNING);
      expect(usedSilence(home)).toBe(false);
    });

    it.skipIf(!canDenyReads)('does not hide the warning when the marker for the one silent session cannot be written, and records the error CODE of the failure', () => {
      const { home, dbPath } = fresh();
      makeDatabase(dbPath);
      // The marker lives in ~/.memesh: the directory exists and cannot be written to.
      const memeshDir = memeshDirOf(home);
      dirs.push(memeshDir);
      fs.chmodSync(memeshDir, 0o555);
      // Not a silent return: if 0555 is no barrier here the test must fail, not pass untested.
      expect(() => fs.writeFileSync(path.join(memeshDir, 'probe'), 'x'), 'the folder is writable: this test would prove nothing').toThrow();
      const out = run(home, dbPath);
      expect(out).toContain(WARNING);
      expect(usedSilence(home)).toBe(false);
      // The bare code of a failure the hook handled itself: never prefixed "uncaught", which is the last-resort catch's word.
      expect(reasonMatching(home, /first-session marker cannot be written: EACCES$/), `the marker failure left no usable record: ${JSON.stringify(reasons(home))}`).toBe(true);
      expect(reasons(home).join(' ')).not.toMatch(/uncaught/);
    });

    it('an unreadable update-check cache is not "no cache": it is reported as unreadable, with the true reason, and recorded', () => {
      // A truncated cache used to count as "never checked": silent, one silent session spent, no trace of the corruption.
      const { home, dbPath } = fresh();
      makeDatabase(dbPath);
      const cachePath = path.join(home, 'update-check.json');
      fs.writeFileSync(cachePath, `{"currentVersion": "${VERSION}", "latestVe`);
      const out = run(home, dbPath, cachePath);
      expect(out).toContain(WARNING);
      expect(out).toMatch(/unreadable/);
      expect(out).not.toContain('no update check has completed yet');
      expect(usedSilence(home), 'a corrupt cache used up the one silent session').toBe(false);
      expect(reasonMatching(home, /update-check cache.*unreadable/), `the corrupt cache left no record: ${JSON.stringify(reasons(home))}`).toBe(true);
    });

    it('a cache that is not valid JSON is reported without quoting what the file holds, on the banner or in the record', () => {
      const { home, dbPath } = fresh();
      makeDatabase(dbPath);
      const cachePath = path.join(home, 'update-check.json');
      fs.writeFileSync(cachePath, `{"currentVersion": "${VERSION}", "latestVersion": PLANTED${'CONTENT'}`);
      const out = run(home, dbPath, cachePath);
      expect(out).toContain(WARNING);
      expect(out).toContain('not valid JSON');
      expect(out, 'the banner quotes the cache file').not.toContain('PLANTED');
      expect(reasons(home).join(' '), 'the record quotes the cache file').not.toContain('PLANTED');
    });

    it.each([['an array', '[]'], ['a number', '5'], ['null', 'null']])('a cache that is valid JSON but %s is unreadable too, not a cache', (_name, body) => {
      const { home, dbPath } = fresh();
      makeDatabase(dbPath);
      const cachePath = path.join(home, 'update-check.json');
      fs.writeFileSync(cachePath, body);
      const out = run(home, dbPath, cachePath);
      expect(out).toContain(WARNING);
      expect(out).toContain('does not hold a JSON object');
      expect(usedSilence(home)).toBe(false);
    });

    it('a warning already shown today stays quiet, and the record says it was withheld for that reason', () => {
      const { home, dbPath } = fresh();
      makeDatabase(dbPath);
      const cachePath = attemptOnlyCache(home);
      fs.mkdirSync(memeshDirOf(home), { recursive: true });
      fs.writeFileSync(path.join(memeshDirOf(home), `last-check-failed-banner.${VERSION}.lock`), String(Date.now()));
      const out = run(home, dbPath, cachePath);
      expect(out).not.toContain(WARNING);
      expect(reasonMatching(home, /update warning withheld: already shown within the last day/), `no record of why the warning was withheld: ${JSON.stringify(reasons(home))}`).toBe(true);
    });

    it('a throttle marker that is a folder is not a marker: the warning is not hidden for a day', () => {
      const { home, dbPath } = fresh();
      makeDatabase(dbPath);
      const cachePath = attemptOnlyCache(home);
      fs.mkdirSync(path.join(memeshDirOf(home), `last-check-failed-banner.${VERSION}.lock`));
      const out = run(home, dbPath, cachePath);
      expect(out).toContain(WARNING);
      expect(reasonMatching(home, /throttle marker/), `the failed marker write left no record: ${JSON.stringify(reasons(home))}`).toBe(true);
    });

    it.skipIf(process.platform === 'win32')('a first-session marker slot taken by a link is not claimed, and nothing is written through it', () => {
      // The claim must be atomic (wx): a name that already exists in any form, even a dangling link, is somebody
      // else's. A check-then-write would follow the link and create its target.
      const { home, dbPath } = fresh();
      makeDatabase(dbPath);
      const target = path.join(home, 'link-target');
      fs.symlinkSync(target, path.join(memeshDirOf(home), `update-check-first-session.${VERSION}.lock`));
      const out = run(home, dbPath);
      expect(fs.existsSync(target), 'the hook wrote through the link').toBe(false);
      expect(out).toContain(WARNING);
    });

    it('a cache path whose parent is a file is "no cache" (nothing there), not an unreadable cache', () => {
      const { home, dbPath } = fresh();
      makeDatabase(dbPath);
      const notAFolder = path.join(home, 'not-a-folder');
      fs.writeFileSync(notAFolder, 'x');
      const out = run(home, dbPath, path.join(notAFolder, 'update-check.json'));
      expect(out).not.toContain(WARNING);
      expect(usedSilence(home), 'the first session was not recognised').toBe(true);
    });

    it.skipIf(!canDenyReads)('a cache the hook may not read is reported by its error code, without the full local path', () => {
      const { home, dbPath } = fresh();
      makeDatabase(dbPath);
      const cachePath = path.join(home, 'update-check.json');
      fs.writeFileSync(cachePath, '{}');
      fs.chmodSync(cachePath, 0o000);
      expect(() => fs.readFileSync(cachePath), 'the file is readable: this test would prove nothing').toThrow();
      const out = run(home, dbPath, cachePath);
      expect(out).toContain(WARNING);
      expect(out).toContain('EACCES');
      expect(out, 'the banner carries the full local path').not.toContain(home);
    });

    it('a memesh folder that cannot even be created is recorded, and the warning still speaks', () => {
      // The folder step of the banner failed (its parent is a file): that is a reason someone has to be able to find.
      const { home, dbPath } = fresh();
      makeDatabase(dbPath);
      const notAFolder = path.join(home, 'not-a-folder');
      fs.writeFileSync(notAFolder, 'x');
      const out = run(home, dbPath, path.join(home, 'update-check.json'), { MEMESH_DIR: path.join(notAFolder, '.memesh') });
      expect(out).toContain(WARNING);
      expect(reasonMatching(home, /memesh folder/), `the folder failure left no record: ${JSON.stringify(reasons(home))}`).toBe(true);
    });

    describe('the once-per-version markers of other versions', () => {
      const seed = (home: string) => {
        const memeshDir = memeshDirOf(home);
        for (const name of [
          'update-check-first-session.0.0.1.lock', 'last-check-failed-banner.0.0.1.lock', 'last-check-failed-banner.0.0.2.lock',
          'update-check-first-session.999.0.0.lock', 'last-check-failed-banner.999.0.0.lock', 'unrelated.lock',
        ]) fs.writeFileSync(path.join(memeshDir, name), '1');
        return memeshDir;
      };

      it('writing the first-session marker removes the markers of OLDER versions, and keeps newer ones, this version\'s and unrelated files', () => {
        const { home, dbPath } = fresh();
        makeDatabase(dbPath);
        seed(home);
        run(home, dbPath); // first session: claims this version's marker
        const left = names(home);
        expect(left.length, 'the memesh folder holds nothing').toBeGreaterThan(0);
        expect(left).toContain(`update-check-first-session.${VERSION}.lock`);
        expect(left).toContain('unrelated.lock');
        expect(left.filter((n) => /\.0\.0\.[12]\.lock$/.test(n)), 'markers of older versions were left behind').toEqual([]);
        // A plugin and an npm global of different versions can share one ~/.memesh: each deleting the other's
        // once-a-day throttle would turn "once a day" into "every session".
        expect(left, 'a marker of a NEWER version was deleted').toContain('update-check-first-session.999.0.0.lock');
        expect(left).toContain('last-check-failed-banner.999.0.0.lock');
      });

      it('the daily-warning path removes older markers too, and keeps a newer one', () => {
        const { home, dbPath } = fresh();
        makeDatabase(dbPath);
        const cachePath = attemptOnlyCache(home);
        seed(home);
        expect(run(home, dbPath, cachePath)).toContain(WARNING);
        const left = names(home);
        expect(left).toContain(`last-check-failed-banner.${VERSION}.lock`);
        expect(left.filter((n) => /\.0\.0\.[12]\.lock$/.test(n)), 'markers of older versions were left behind').toEqual([]);
        expect(left, 'a marker of a NEWER version was deleted').toContain('last-check-failed-banner.999.0.0.lock');
      });

      it('an older marker that cannot be removed is recorded, with its error code', () => {
        const { home, dbPath } = fresh();
        makeDatabase(dbPath);
        const stuck = path.join(memeshDirOf(home), 'last-check-failed-banner.0.0.1.lock');
        fs.mkdirSync(stuck);
        run(home, dbPath);
        expect(fs.existsSync(stuck), 'a folder was removed with unlink: this test would prove nothing').toBe(true);
        expect(reasonMatching(home, /old version marker cannot be removed: (EISDIR|EPERM)$/), JSON.stringify(reasons(home))).toBe(true);
      });

      it.skipIf(!canDenyReads)('a memesh folder that cannot be listed is recorded when the old markers cannot be cleared', () => {
        const { home, dbPath } = fresh();
        makeDatabase(dbPath);
        const memeshDir = memeshDirOf(home);
        dirs.push(memeshDir);
        // Writable and searchable but not listable: the marker is written, the sweep after it cannot read the folder.
        fs.chmodSync(memeshDir, 0o300);
        expect(() => fs.readdirSync(memeshDir), 'the folder can be listed: this test would prove nothing').toThrow();
        run(home, dbPath);
        expect(reasonMatching(home, /old version markers cannot be listed: EACCES$/), JSON.stringify(reasons(home))).toBe(true);
      });
    });

    describe('the background update check says why it was not started (#360)', () => {
      it('the cached answer is still fresh', () => {
        const { home, dbPath } = fresh();
        makeDatabase(dbPath);
        const cachePath = path.join(home, 'update-check.json');
        const now = new Date().toISOString();
        fs.writeFileSync(cachePath, JSON.stringify({
          currentVersion: VERSION, latestVersion: VERSION, checkedAt: now, lastAttemptAt: now,
          lastSuccessfulCheckAt: now, checkSucceeded: true, lastError: null,
        }));
        run(home, dbPath, cachePath);
        expect(reasonMatching(home, /update check not started: the cached answer is still fresh/), JSON.stringify(reasons(home))).toBe(true);
        expect(startedCheck(home), 'a check was started although the answer is fresh').toBe(false);
      });

      it('update checks are turned off', () => {
        const { home, dbPath } = fresh();
        makeDatabase(dbPath);
        fs.writeFileSync(path.join(memeshDirOf(home), 'config.json'), JSON.stringify({ updateCheck: false }));
        run(home, dbPath);
        expect(reasonMatching(home, /update check not started: update checks are turned off/), JSON.stringify(reasons(home))).toBe(true);
        expect(startedCheck(home)).toBe(false);
      });
    });
  });
});
