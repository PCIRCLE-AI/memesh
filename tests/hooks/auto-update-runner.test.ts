import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AUTO_UPDATE_LOCK_DEAD_GRACE_MS,
  AUTO_UPDATE_LOCK_TTL_MS,
  AUTO_UPDATE_RECOVERY_TTL_MS,
  autoUpdateRecoveryClaimPath,
  manualExitCode,
  recoverDamagedAutoUpdateLock,
  recoverObservedStaleAutoUpdateLock,
  releaseAutoUpdateLock,
  runLocked,
  touchAutoUpdateLock,
  tryAcquireAutoUpdateLock,
} from '../../scripts/hooks/auto-update-runner.mjs';
import { dispatchAutoUpdate } from '../../scripts/hooks/_shared.js';
import { processStartTag } from '../../src/core/process-identity.js';
// The runner reads the start time through the built copy: its cache is the one to forget between environments.
import { clearStartTagCache as clearRunnerStartTagCache } from '../../dist/core/process-identity.js';

const runnerPath = path.resolve('scripts/hooks/auto-update-runner.mjs');
const DEAD_PID = 2147483000;
const MIN = 60 * 1000;

interface RunnerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

let tempDir: string;
let savedMemeshDir: string | undefined;

function runRunner(lockPath: string, env: NodeJS.ProcessEnv, runner = runnerPath, extraArgs: string[] = []): Promise<RunnerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, lockPath, ...extraArgs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-auto-update-'));
  savedMemeshDir = process.env.MEMESH_DIR;
  process.env.MEMESH_DIR = tempDir;
});

afterEach(() => {
  if (savedMemeshDir === undefined) delete process.env.MEMESH_DIR;
  else process.env.MEMESH_DIR = savedMemeshDir;
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const lockFile = () => path.join(tempDir, 'auto-update.lock');
const age = (file: string, ms: number) => { const t = new Date(Date.now() - ms); fs.utimesSync(file, t, t); };
/** A lock file as a runner writes it: token, pid, start time, label, and (when known) the owner's process start time. */
function writeLock(opts: { pid: number; startTag?: string | null; ageMs: number; startedAgoMs?: number; label?: string }) {
  const startedAt = Date.now() - (opts.startedAgoMs ?? opts.ageMs);
  fs.writeFileSync(lockFile(), `held-by-someone\n${opts.pid}\n${startedAt}\n${opts.label ?? 'auto'}\n${opts.startTag ?? ''}\n`, { mode: 0o600 });
  age(lockFile(), opts.ageMs);
}
const canTellProcesses = processStartTag(process.pid) !== null;

describe('auto-update runner lock: who holds it is told by identity, not by how long ago the file was touched', () => {
  it.skipIf(!canTellProcesses)('a runner that is alive keeps its lock through a step longer than the TTL (npm install, pack and audit block for minutes, and a blocked process cannot send a heartbeat)', async () => {
    writeLock({ pid: process.pid, startTag: processStartTag(process.pid), ageMs: 20 * MIN, startedAgoMs: 20 * MIN });
    expect(tryAcquireAutoUpdateLock(lockFile(), '4.13.0')).toMatchObject({ acquired: false, recoveredStale: false });
    let ran = false;
    expect(await runLocked(lockFile(), async () => { ran = true; return { outcome: 'installed', reason: 'x' }; })).toBe(0);
    expect(ran).toBe(false);
  });

  it.skipIf(!canTellProcesses)('and a second RUNNER PROCESS gets IN_PROGRESS too: this test process holds the lock, 20 minutes without a touch', async () => {
    writeLock({ pid: process.pid, startTag: processStartTag(process.pid), ageMs: 20 * MIN });
    const result = await runRunner(lockFile(), { ...process.env, MEMESH_AUTO_UPDATE: 'off' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('IN_PROGRESS');
    expect(result.stdout).not.toContain('RECOVERED_STALE');
  });

  it('a lock whose owner cannot be identified (no start time recorded) falls back to the heartbeat: untouched for the TTL is stale, touched is not', () => {
    writeLock({ pid: process.pid, startTag: null, ageMs: AUTO_UPDATE_LOCK_TTL_MS + MIN });
    expect(tryAcquireAutoUpdateLock(lockFile(), '4.13.0')).toMatchObject({ acquired: true, recoveredStale: true });
    fs.rmSync(lockFile());
    writeLock({ pid: process.pid, startTag: null, ageMs: AUTO_UPDATE_LOCK_TTL_MS + MIN, startedAgoMs: 20 * MIN });
    const stale = tryAcquireAutoUpdateLock(lockFile(), '4.13.0');
    expect(stale.acquired).toBe(true);
    releaseAutoUpdateLock(lockFile(), stale.ownerToken);
    // The heartbeat keeps it fresh: started 20 minutes ago, but touched just now.
    writeLock({ pid: process.pid, startTag: null, ageMs: 20 * MIN, startedAgoMs: 20 * MIN });
    const t = new Date(); fs.utimesSync(lockFile(), t, t);
    expect(tryAcquireAutoUpdateLock(lockFile(), '4.13.0')).toMatchObject({ acquired: false, recoveredStale: false });
  });

  it('an owner that is gone: its lock is stale after the short grace, not before (a process in another pid namespace may merely look gone)', () => {
    writeLock({ pid: DEAD_PID, ageMs: 10 * 1000 });
    expect(tryAcquireAutoUpdateLock(lockFile(), '4.13.0')).toMatchObject({ acquired: false, recoveredStale: false });
    writeLock({ pid: DEAD_PID, ageMs: AUTO_UPDATE_LOCK_DEAD_GRACE_MS + MIN });
    const lock = tryAcquireAutoUpdateLock(lockFile(), '4.13.0');
    expect(lock).toMatchObject({ acquired: true, recoveredStale: true });
    expect((lock as { recoveredReason?: string }).recoveredReason).toContain('no longer running');
    expect(releaseAutoUpdateLock(lockFile(), lock.ownerToken)).toBe(true);
  });

  it.skipIf(!canTellProcesses)('a reused pid (alive, but started at another time) is not the owner: the lock is stale after the grace', () => {
    writeLock({ pid: process.pid, startTag: 'v2:Thu Jan  1 00:00:00 1970', ageMs: 10 * 1000 });
    expect(tryAcquireAutoUpdateLock(lockFile(), '4.13.0')).toMatchObject({ acquired: false });
    writeLock({ pid: process.pid, startTag: 'v2:Thu Jan  1 00:00:00 1970', ageMs: AUTO_UPDATE_LOCK_DEAD_GRACE_MS + MIN });
    const lock = tryAcquireAutoUpdateLock(lockFile(), '4.13.0');
    expect(lock).toMatchObject({ acquired: true, recoveredStale: true });
    expect(releaseAutoUpdateLock(lockFile(), lock.ownerToken)).toBe(true);
  });

  it.skipIf(!canTellProcesses)('a lock written under one locale and time zone is still held by its running owner when read under another (the same process, however it is asked)', () => {
    const saved = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL, LANG: process.env.LANG };
    const as = (tz: string, locale: string) => { process.env.TZ = tz; process.env.LC_ALL = locale; process.env.LANG = locale; clearRunnerStartTagCache(); };
    try {
      as('Asia/Taipei', 'zh_TW.UTF-8');
      const held = tryAcquireAutoUpdateLock(lockFile(), '4.13.0');
      expect(held.acquired).toBe(true);
      // long after the last touch: only the identity of its owner can say it is still running
      age(lockFile(), AUTO_UPDATE_LOCK_DEAD_GRACE_MS + 10 * MIN);
      as('America/Los_Angeles', 'de_DE.UTF-8');
      expect(tryAcquireAutoUpdateLock(lockFile(), '4.13.0')).toMatchObject({ acquired: false, recoveredStale: false });
      as('UTC', 'C');
      expect(tryAcquireAutoUpdateLock(lockFile(), '4.13.0')).toMatchObject({ acquired: false, recoveredStale: false });
      expect(releaseAutoUpdateLock(lockFile(), held.ownerToken)).toBe(true);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      clearRunnerStartTagCache();
    }
  });

  it.skipIf(!canTellProcesses)('a lock written by an older build (its start time not in the pinned form) cannot be compared: its owner is "unknown", and the heartbeat age decides', () => {
    // fresh: not stale
    writeLock({ pid: process.pid, startTag: 'Thu Jan  1 00:00:00 1970', ageMs: AUTO_UPDATE_LOCK_DEAD_GRACE_MS + MIN });
    expect(tryAcquireAutoUpdateLock(lockFile(), '4.13.0')).toMatchObject({ acquired: false, recoveredStale: false });
    // untouched for longer than a heartbeat may be silent: stale
    writeLock({ pid: process.pid, startTag: 'Thu Jan  1 00:00:00 1970', ageMs: AUTO_UPDATE_LOCK_TTL_MS + MIN });
    const lock = tryAcquireAutoUpdateLock(lockFile(), '4.13.0');
    expect(lock).toMatchObject({ acquired: true, recoveredStale: true });
    expect(releaseAutoUpdateLock(lockFile(), lock.ownerToken)).toBe(true);
  });

  it('a lock whose owner answers EPERM (the pid now belongs to another user) is not held by a runner of ours', () => {
    // pid 1 is never ours: signalling it from a normal user answers EPERM; as root it answers success, so only the unprivileged case is exercised
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    writeLock({ pid: 1, startTag: null, ageMs: AUTO_UPDATE_LOCK_DEAD_GRACE_MS + MIN });
    const lock = tryAcquireAutoUpdateLock(lockFile(), '4.13.0');
    expect(lock).toMatchObject({ acquired: true, recoveredStale: true });
    expect(releaseAutoUpdateLock(lockFile(), lock.ownerToken)).toBe(true);
  });

  it('a lock time in the future is not trusted: it does not keep a dead or unidentifiable owner\'s lock for ever', () => {
    writeLock({ pid: DEAD_PID, ageMs: -365 * 24 * 60 * MIN }); // mtime a year ahead
    expect(tryAcquireAutoUpdateLock(lockFile(), '4.13.0')).toMatchObject({ acquired: true, recoveredStale: true });
    fs.rmSync(lockFile());
    writeLock({ pid: process.pid, startTag: null, ageMs: -365 * 24 * 60 * MIN });
    expect(tryAcquireAutoUpdateLock(lockFile(), '4.13.0')).toMatchObject({ acquired: true, recoveredStale: true });
  });

  it('the lock records its owner\'s start time, and what started it', async () => {
    let seen = '';
    await runLocked(lockFile(), async () => { seen = fs.readFileSync(lockFile(), 'utf8'); return { outcome: 'skipped', reason: 'x' }; }, 'manual');
    const [, pid, , label, startTag] = seen.split('\n');
    expect(Number(pid)).toBe(process.pid);
    expect(label).toBe('manual');
    expect(startTag).toBe(processStartTag(process.pid) ?? '');
  });
});

describe('auto-update runner lock: damaged locks, recovery claims, ownership', () => {
  const DAMAGED = ['', 'orphan-owner\n', `orphan-owner\n${process.pid}\n`, `orphan-owner\n${process.pid}\n123\n`];

  it.each(DAMAGED)('recovers a damaged lock nobody has touched, takes it, and says so (%j)', (contents) => {
    fs.writeFileSync(lockFile(), contents, { mode: 0o600 });
    age(lockFile(), AUTO_UPDATE_LOCK_TTL_MS + 1000);
    const lock = tryAcquireAutoUpdateLock(lockFile(), '4.13.0');
    expect(lock).toMatchObject({ acquired: true, recoveredStale: true });
    expect((lock as { recoveredReason?: string }).recoveredReason).toContain('damaged');
    expect(fs.readFileSync(lockFile(), 'utf8').split('\n')[0]).toBe(lock.ownerToken);
    expect(releaseAutoUpdateLock(lockFile(), lock.ownerToken)).toBe(true);
  });

  it.each(DAMAGED)('leaves a damaged lock alone while it is fresh, and does not throw (%j)', async (contents) => {
    fs.writeFileSync(lockFile(), contents, { mode: 0o600 });
    expect(tryAcquireAutoUpdateLock(lockFile(), '4.13.0')).toMatchObject({ acquired: false, recoveredStale: false });
    let ran = false;
    expect(await runLocked(lockFile(), async () => { ran = true; return { outcome: 'installed', reason: 'x' }; })).toBe(0);
    expect(ran).toBe(false);
    expect(fs.readFileSync(lockFile(), 'utf8')).toBe(contents);
  });

  it('a damaged lock is deleted under a recovery claim, and only if it is still the file that was seen: a new owner who published a good lock in between is not removed', () => {
    fs.writeFileSync(lockFile(), 'half a lo', { mode: 0o600 });
    age(lockFile(), AUTO_UPDATE_LOCK_TTL_MS + MIN);
    const seen = fs.statSync(lockFile());
    // Between "it is stale" and "delete it", somebody acquires properly (the file is replaced by a complete lock).
    fs.rmSync(lockFile());
    const fresh = tryAcquireAutoUpdateLock(lockFile(), '4.13.0');
    expect(fresh.acquired).toBe(true);
    expect(recoverDamagedAutoUpdateLock(lockFile(), { size: seen.size, mtimeMs: seen.mtimeMs })).toBe(false);
    expect(fs.readFileSync(lockFile(), 'utf8').split('\n')[0]).toBe(fresh.ownerToken);
    expect(releaseAutoUpdateLock(lockFile(), fresh.ownerToken)).toBe(true);
  });

  it('a damaged lock that was rewritten (still damaged, different content) after it was seen is not removed on the old observation', () => {
    fs.writeFileSync(lockFile(), 'half a lo', { mode: 0o600 });
    age(lockFile(), AUTO_UPDATE_LOCK_TTL_MS + MIN);
    const seen = fs.statSync(lockFile());
    // Somebody is writing it right now: still unreadable, but not the file that was judged stale.
    fs.writeFileSync(lockFile(), 'half a lock that is longer now', { mode: 0o600 });
    expect(recoverDamagedAutoUpdateLock(lockFile(), { size: seen.size, mtimeMs: seen.mtimeMs })).toBe(false);
    expect(fs.existsSync(lockFile())).toBe(true);
    // Same size, another time: also a different file.
    fs.writeFileSync(lockFile(), 'half a lo', { mode: 0o600 });
    expect(recoverDamagedAutoUpdateLock(lockFile(), { size: fs.statSync(lockFile()).size, mtimeMs: seen.mtimeMs - 5 * MIN })).toBe(false);
    expect(fs.existsSync(lockFile())).toBe(true);
  });

  it('two contenders for one damaged lock: exactly one of them removes it (they share one recovery claim)', () => {
    fs.writeFileSync(lockFile(), 'half a lo', { mode: 0o600 });
    age(lockFile(), AUTO_UPDATE_LOCK_TTL_MS + MIN);
    const seen = fs.statSync(lockFile());
    const observed = { size: seen.size, mtimeMs: seen.mtimeMs };
    const results = [recoverDamagedAutoUpdateLock(lockFile(), observed), recoverDamagedAutoUpdateLock(lockFile(), observed)];
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  /** A recovery claim as a runner writes it, started `agoMs` ago. */
  const claimFor = (key: string, agoMs: number, generation = 0) => {
    const claim = autoUpdateRecoveryClaimPath(lockFile(), key, generation);
    fs.writeFileSync(claim, `other-recoverer\n${process.pid}\n${Date.now() - agoMs}\nrecovery\n`, { mode: 0o600 });
    return claim;
  };

  it('a damaged lock is not removed while somebody else holds the recovery claim for exactly that file (the claim is what makes recovery one at a time)', () => {
    fs.writeFileSync(lockFile(), 'half a lo', { mode: 0o600 });
    age(lockFile(), AUTO_UPDATE_LOCK_TTL_MS + MIN);
    const seen = fs.statSync(lockFile());
    claimFor(`damaged:${seen.size}:${seen.mtimeMs}`, 1000); // a recoverer that started a second ago
    expect(tryAcquireAutoUpdateLock(lockFile(), '4.13.0')).toMatchObject({ acquired: false, recoveredStale: false });
    expect(recoverDamagedAutoUpdateLock(lockFile(), { size: seen.size, mtimeMs: seen.mtimeMs })).toBe(false);
    expect(fs.readFileSync(lockFile(), 'utf8')).toBe('half a lo'); // still there, untouched
  });

  it('a recovery claim for another observation of the damaged lock (another modification time) does not block this one', () => {
    fs.writeFileSync(lockFile(), 'half a lo', { mode: 0o600 });
    age(lockFile(), AUTO_UPDATE_LOCK_TTL_MS + MIN);
    const seen = fs.statSync(lockFile());
    claimFor(`damaged:${seen.size}:${seen.mtimeMs - 7 * MIN}`, 1000); // a claim about a file written at another time
    expect(tryAcquireAutoUpdateLock(lockFile(), '4.13.0')).toMatchObject({ acquired: true, recoveredStale: true });
  });

  it('a stale lock is not removed while a fresh recovery claim exists for it: the claim blocks the others instead of being skipped for the next one', () => {
    const observed = { token: 'stale-owner', pid: DEAD_PID, startedAt: Date.now() - AUTO_UPDATE_LOCK_TTL_MS - 1000, version: '4.7.9', startTag: null };
    fs.writeFileSync(lockFile(), `${observed.token}\n${observed.pid}\n${observed.startedAt}\n${observed.version}\n\n`, { mode: 0o600 });
    age(lockFile(), AUTO_UPDATE_LOCK_TTL_MS + 1000);
    claimFor(observed.token, 1000);
    expect(recoverObservedStaleAutoUpdateLock(lockFile(), observed)).toBe(false);
    expect(tryAcquireAutoUpdateLock(lockFile(), '4.8.0')).toMatchObject({ acquired: false });
    expect(fs.readFileSync(lockFile(), 'utf8').split('\n')[0]).toBe('stale-owner');
  });

  it.skipIf(!canTellProcesses)('under the claim the lock is judged again: one whose owner is alive after all (the observation was out of date) is not removed', () => {
    // The observer saw this token as stale; by the time it holds the claim the owner is a running process.
    const token = 'revived-owner';
    fs.writeFileSync(lockFile(), `${token}\n${process.pid}\n${Date.now()}\n4.13.0\n${processStartTag(process.pid) ?? ''}\n`, { mode: 0o600 });
    expect(recoverObservedStaleAutoUpdateLock(lockFile(), { token, pid: DEAD_PID, startedAt: Date.now() - AUTO_UPDATE_LOCK_TTL_MS - 1000, version: '4.13.0', startTag: null })).toBe(false);
    expect(fs.readFileSync(lockFile(), 'utf8').split('\n')[0]).toBe(token);
  });

  it('under the claim the token is compared: a stale lock of ANOTHER owner than the one observed is not removed on the old observation', () => {
    fs.writeFileSync(lockFile(), `a-different-dead-owner\n${DEAD_PID}\n${Date.now() - AUTO_UPDATE_LOCK_TTL_MS - 1000}\n4.7.9\n\n`, { mode: 0o600 });
    age(lockFile(), AUTO_UPDATE_LOCK_TTL_MS + 1000);
    expect(recoverObservedStaleAutoUpdateLock(lockFile(), { token: 'the-one-that-was-seen', pid: DEAD_PID, startedAt: 1, version: '4.7.9', startTag: null })).toBe(false);
    expect(fs.existsSync(lockFile())).toBe(true);
  });

  it('a damaged lock replaced by a good one of the same size and the same modification time is not removed (reading it, not only its stat, decides)', () => {
    const good = `real-owner\n${process.pid}\n${Date.now()}\n4.13.0\n\n`;
    fs.writeFileSync(lockFile(), 'x'.repeat(good.length), { mode: 0o600 }); // unreadable, as long as a real lock
    age(lockFile(), AUTO_UPDATE_LOCK_TTL_MS + MIN);
    const seen = fs.statSync(lockFile());
    fs.writeFileSync(lockFile(), good, { mode: 0o600 });
    fs.utimesSync(lockFile(), seen.atime, seen.mtime); // the stat now matches what was seen
    expect(fs.statSync(lockFile()).size).toBe(seen.size);
    expect(recoverDamagedAutoUpdateLock(lockFile(), { size: seen.size, mtimeMs: seen.mtimeMs })).toBe(false);
    expect(fs.readFileSync(lockFile(), 'utf8')).toBe(good);
  });

  it('only lets the recorded owner token release the lock', () => {
    const lock = tryAcquireAutoUpdateLock(lockFile(), '4.8.0');
    expect(lock.acquired).toBe(true);
    expect(releaseAutoUpdateLock(lockFile(), 'not-the-owner')).toBe(false);
    expect(fs.existsSync(lockFile())).toBe(true);
    expect(releaseAutoUpdateLock(lockFile(), lock.ownerToken)).toBe(true);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('does not let a delayed stale observation remove a fresh owner (ABA)', () => {
    const observed = { token: 'stale-owner', pid: DEAD_PID, startedAt: Date.now() - AUTO_UPDATE_LOCK_TTL_MS - 1000, version: '4.7.9', startTag: null };
    fs.writeFileSync(lockFile(), `${observed.token}\n${observed.pid}\n${observed.startedAt}\n${observed.version}\n\n`, { mode: 0o600 });
    age(lockFile(), AUTO_UPDATE_LOCK_TTL_MS + 1000);
    const fresh = tryAcquireAutoUpdateLock(lockFile(), '4.8.0');
    expect(fresh).toMatchObject({ acquired: true, recoveredStale: true });
    // The delayed observer of the OLD lock now arrives: it must not remove the new owner.
    expect(recoverObservedStaleAutoUpdateLock(lockFile(), observed)).toBe(false);
    expect(fs.readFileSync(lockFile(), 'utf8').split('\n')[0]).toBe(fresh.ownerToken);
    expect(releaseAutoUpdateLock(lockFile(), fresh.ownerToken)).toBe(true);
  });

  it('advances past an orphaned recovery claim by its age, without deleting it', () => {
    const staleToken = 'stale-owner';
    fs.writeFileSync(lockFile(), `${staleToken}\n${DEAD_PID}\n${Date.now() - AUTO_UPDATE_LOCK_TTL_MS - 1000}\n4.7.9\n\n`, { mode: 0o600 });
    age(lockFile(), AUTO_UPDATE_LOCK_TTL_MS + 1000);
    const orphanPath = autoUpdateRecoveryClaimPath(lockFile(), staleToken);
    fs.writeFileSync(orphanPath, `dead-recovery\n${DEAD_PID}\n${Date.now() - AUTO_UPDATE_RECOVERY_TTL_MS - 1000}\nrecovery\n`, { mode: 0o600 });
    const recovery = tryAcquireAutoUpdateLock(lockFile(), '4.8.0');
    expect(recovery).toMatchObject({ acquired: true, recoveredStale: true });
    expect(fs.existsSync(orphanPath)).toBe(true);
    expect(releaseAutoUpdateLock(lockFile(), recovery.ownerToken)).toBe(true);
  });

  it('a claim whose pid is alive (pid 1, or a reused pid) is orphaned all the same once it is older than a claim can be: it does not block recovery for ever', () => {
    const staleToken = 'stale-owner';
    fs.writeFileSync(lockFile(), `${staleToken}\n${DEAD_PID}\n${Date.now() - AUTO_UPDATE_LOCK_TTL_MS - 1000}\n4.7.9\n\n`, { mode: 0o600 });
    age(lockFile(), AUTO_UPDATE_LOCK_TTL_MS + 1000);
    fs.writeFileSync(autoUpdateRecoveryClaimPath(lockFile(), staleToken), `old-claim\n1\n${Date.now() - 20 * 24 * 60 * MIN}\nrecovery\n`, { mode: 0o600 });
    const recovery = tryAcquireAutoUpdateLock(lockFile(), '4.8.0');
    expect(recovery).toMatchObject({ acquired: true, recoveredStale: true });
    expect(releaseAutoUpdateLock(lockFile(), recovery.ownerToken)).toBe(true);
  });

  it('a heartbeat shows the lock fresh, and only its owner can give one', () => {
    const lock = tryAcquireAutoUpdateLock(lockFile(), '4.13.0');
    age(lockFile(), AUTO_UPDATE_LOCK_TTL_MS + 1000);
    expect(touchAutoUpdateLock(lockFile(), 'not-the-owner')).toBe(false);
    expect(touchAutoUpdateLock(lockFile(), lock.ownerToken)).toBe(true);
    expect(fs.statSync(lockFile()).mtimeMs).toBeGreaterThan(Date.now() - 5000);
    expect(releaseAutoUpdateLock(lockFile(), lock.ownerToken)).toBe(true);
  });
});

describe('the exit code of a run started by hand', () => {
  const UP = 'already current';
  it('installed and already current are 0; everything else, and no result at all, is 1', () => {
    expect(manualExitCode({ outcome: 'installed', reason: 'installed' }, UP)).toBe(0);
    expect(manualExitCode({ outcome: 'skipped', reason: UP }, UP)).toBe(0);
    expect(manualExitCode({ outcome: 'skipped', reason: 'policy is off' }, UP)).toBe(1);
    expect(manualExitCode({ outcome: 'failed', reason: UP }, UP)).toBe(0); // the reason alone decides "current"; a failure never carries it
    expect(manualExitCode({ outcome: 'failed', reason: 'x' }, UP)).toBe(1);
    expect(manualExitCode({ outcome: 'waiting', reason: 'x' }, UP)).toBe(1);
    expect(manualExitCode(null, UP)).toBe(1);
  });
});

const result = (outcome: string, reason = 'test') => async () => ({ outcome, reason });

describe('auto-update runner single flight', () => {
  it('releases the lock after a run and reports its outcome', async () => {
    expect(await runLocked(lockFile(), result('installed'))).toBe(0);
    expect(fs.existsSync(lockFile())).toBe(false);
    expect(await runLocked(lockFile(), result('failed'))).toBe(1);
    expect(fs.existsSync(lockFile())).toBe(false);
    expect(await runLocked(lockFile(), async () => { throw new Error('boom'); })).toBe(1);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('lets one attempt through under contention and releases for a later run', async () => {
    let runs = 0;
    const slow = async () => { runs += 1; await new Promise((r) => setTimeout(r, 200)); return { outcome: 'installed', reason: 'ok' }; };
    const codes = await Promise.all(Array.from({ length: 6 }, () => runLocked(lockFile(), slow)));
    expect(codes).toEqual([0, 0, 0, 0, 0, 0]);
    expect(runs).toBe(1);
    expect(fs.existsSync(lockFile())).toBe(false);
    await runLocked(lockFile(), slow);
    expect(runs).toBe(2);
  });

  it('does not take over a lock its owner keeps touching', async () => {
    const lock = tryAcquireAutoUpdateLock(lockFile(), '4.13.0');
    let ran = false;
    expect(await runLocked(lockFile(), async () => { ran = true; return { outcome: 'installed', reason: 'x' }; })).toBe(0);
    expect(ran).toBe(false);
    expect(fs.existsSync(lockFile())).toBe(true);
    expect(releaseAutoUpdateLock(lockFile(), lock.ownerToken)).toBe(true);
  });

  it('gives the update a heartbeat bound to its own lock, and passes along a recovery notice', async () => {
    fs.writeFileSync(lockFile(), '', { mode: 0o600 });
    age(lockFile(), AUTO_UPDATE_LOCK_TTL_MS + 1000);
    let notice: string | null | undefined;
    let beat: unknown;
    await runLocked(lockFile(), async (context: { heartbeat: () => boolean; notice: string | null }) => {
      notice = context.notice;
      age(lockFile(), AUTO_UPDATE_LOCK_TTL_MS + 1000);
      beat = context.heartbeat();
      return { outcome: 'installed', reason: 'ok' };
    });
    expect(notice).toContain('damaged');
    expect(beat).toBe(true);
  });

  it('the heartbeat says false once the lock is another runner\'s: the update must then stop, not install', async () => {
    let beat: unknown = 'not asked';
    await runLocked(lockFile(), async (context: { heartbeat: () => boolean }) => {
      fs.writeFileSync(lockFile(), `somebody-else\n${process.pid}\n${Date.now()}\nauto\n\n`, { mode: 0o600 }); // taken over
      beat = context.heartbeat();
      return { outcome: 'failed', reason: 'stopped' };
    });
    expect(beat).toBe(false);
  });

  it('the heartbeat a run is given is bound to ITS lock: it refreshes that file, and says true', async () => {
    let result: { before: number; after: number; beat: boolean | undefined } | null = null;
    await runLocked(lockFile(), async (context: { heartbeat: () => boolean }) => {
      age(lockFile(), AUTO_UPDATE_LOCK_TTL_MS * 3);
      const before = fs.statSync(lockFile()).mtimeMs;
      const beat = context.heartbeat();
      result = { before, after: fs.statSync(lockFile()).mtimeMs, beat };
      return { outcome: 'installed', reason: 'ok' };
    });
    expect(result).not.toBeNull();
    expect(result!.beat).toBe(true);
    expect(result!.after).toBeGreaterThan(result!.before + AUTO_UPDATE_LOCK_TTL_MS);
  });

  it('a lock that cannot be released is a failure of the run, not a success: exit 1', async () => {
    const code = await runLocked(lockFile(), async () => {
      fs.writeFileSync(lockFile(), `somebody-else\n${process.pid}\n${Date.now()}\nauto\n\n`, { mode: 0o600 });
      return { outcome: 'installed', reason: 'ok' };
    });
    expect(code).toBe(1);
  });
});

describe.skipIf(process.platform === 'win32')('auto-update runner process boundary', () => {
  it('records "policy is off" and exits 0 without touching npm', async () => {
    const result = await runRunner(lockFile(), { ...process.env, MEMESH_AUTO_UPDATE: 'off' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('SKIPPED policy is off');
    expect(fs.existsSync(lockFile())).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(tempDir, 'auto-update-state.json'), 'utf8'))).toMatchObject({ outcome: 'skipped', reason: 'policy is off' });
    expect(fs.readFileSync(path.join(tempDir, 'auto-update.log'), 'utf8')).toContain('SKIPPED: policy is off');
  });

  it('a damaged old lock does not block the run: it is recovered and a state file is written', async () => {
    fs.writeFileSync(lockFile(), 'half a lo', { mode: 0o600 });
    age(lockFile(), AUTO_UPDATE_LOCK_TTL_MS + 1000);
    const result = await runRunner(lockFile(), { ...process.env, MEMESH_AUTO_UPDATE: 'off' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('RECOVERED_STALE');
    expect(fs.existsSync(lockFile())).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(tempDir, 'auto-update-state.json'), 'utf8'))).toMatchObject({ outcome: 'skipped', notice: expect.stringContaining('damaged') });
  });

  it('--manual ignores "off" (the owner asked), but a source checkout still cannot update itself: exit 1 and a record that says why', async () => {
    const result = await runRunner(lockFile(), { ...process.env, MEMESH_AUTO_UPDATE: 'off' }, runnerPath, ['--manual']);
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('policy is off');
    expect(JSON.parse(fs.readFileSync(path.join(tempDir, 'auto-update-state.json'), 'utf8'))).toMatchObject({ outcome: 'skipped', reason: expect.stringContaining('cannot update itself') });
  });

  it('--reinstall means manual too (it ignores "off"): the record says why a source checkout cannot, not "policy is off"', async () => {
    const result = await runRunner(lockFile(), { ...process.env, MEMESH_AUTO_UPDATE: 'off' }, runnerPath, ['--reinstall']);
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('policy is off');
    expect(JSON.parse(fs.readFileSync(path.join(tempDir, 'auto-update-state.json'), 'utf8'))).toMatchObject({ outcome: 'skipped', reason: expect.stringContaining('cannot update itself') });
  });

  it('--manual reports another running update as a failure, not as success', async () => {
    const lock = tryAcquireAutoUpdateLock(lockFile(), '4.13.0');
    const result = await runRunner(lockFile(), { ...process.env }, runnerPath, ['--manual']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('IN_PROGRESS');
    expect(releaseAutoUpdateLock(lockFile(), lock.ownerToken)).toBe(true);
  });

  it('runs when its entry path reaches it through a symlink', async () => {
    const linkedHooks = path.join(tempDir, 'linked-hooks');
    fs.symlinkSync(path.dirname(runnerPath), linkedHooks, 'dir');
    const result = await runRunner(lockFile(), { ...process.env, MEMESH_AUTO_UPDATE: 'off' }, path.join(linkedHooks, 'auto-update-runner.mjs'));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('SKIPPED policy is off');
  });
});

describe('the hook-side dispatch only delegates to the core (the core is tested in tests/core/auto-update.test.ts)', () => {
  it('says so when the update module is missing', async () => {
    expect(await dispatchAutoUpdate(null)).toEqual({ state: 'failed' });
    expect(fs.readFileSync(path.join(tempDir, 'auto-update.log'), 'utf8')).toContain('dist/core/auto-update.js is missing');
  });

  it('hands the plugin root to the core dispatch and returns its answer', async () => {
    let root = '';
    const answer = await dispatchAutoUpdate({ dispatchAutoUpdate: async (r: string) => { root = r; return { state: 'throttled' as const }; } });
    expect(answer).toEqual({ state: 'throttled' });
    expect(root).toBe(path.resolve('.'));
  });

  it('logs and reports failure when the core dispatch throws', async () => {
    expect(await dispatchAutoUpdate({ dispatchAutoUpdate: async () => { throw new Error('boom'); } })).toEqual({ state: 'failed' });
    expect(fs.readFileSync(path.join(tempDir, 'auto-update.log'), 'utf8')).toContain('stage=dispatch error=boom');
  });
});
