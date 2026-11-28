#!/usr/bin/env node

import {
  closeSync,
  existsSync,
  linkSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'fs';
import { createHash, randomBytes } from 'crypto';
import { pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
// The runner's lock is held by a process, and a process is told by its id AND its start time: the same module
// the host registry and the Hermes cleanup use. dist/ is always there (this file is the runner's own entry).
import { processStartTag, startTagComparable } from '../../dist/core/process-identity.js';

// Who holds the lock is decided by IDENTITY, not by how long ago the file was touched. The runner spends most of its
// time in synchronous steps (npm install, pack, audit: up to 8 minutes each, and a heartbeat cannot be sent from inside
// a blocking call), so "untouched for N minutes" cannot tell a busy runner from a dead one. A lock is therefore held
// for as long as the process that wrote it, identified by its pid AND its start time, is running. The heartbeat age is
// used only when that identity cannot be read (no `ps`, a lock written without a start time): then a lock untouched for
// the TTL is stale. A lock whose owner is gone (or whose pid now belongs to another program) is stale after a short
// grace, not at once, so that a process in another pid namespace that merely looks gone is not robbed of a fresh lock.
export const AUTO_UPDATE_LOCK_TTL_MS = 15 * 60 * 1000;
export const AUTO_UPDATE_LOCK_DEAD_GRACE_MS = 2 * 60 * 1000;
export const AUTO_UPDATE_RECOVERY_TTL_MS = 30 * 1000;
const MAX_RECOVERY_GENERATIONS = 64;
const FUTURE_TOLERANCE_MS = 60 * 1000;

function ownerToken() {
  return `${process.pid}-${Date.now()}-${randomBytes(8).toString('hex')}`;
}

function readLock(lockPath) {
  try {
    const [token, pidRaw, startedAtRaw, version, startTag] = readFileSync(lockPath, 'utf8').split('\n');
    const pid = Number(pidRaw);
    const startedAt = Number(startedAtRaw);
    if (!token || !Number.isSafeInteger(pid) || pid <= 0
      || !startedAtRaw || !Number.isSafeInteger(startedAt) || startedAt <= 0 || !version) return null;
    return { token, pid, startedAt, version, startTag: startTag ? startTag : null };
  } catch {
    return null;
  }
}

/** Milliseconds since the file was last touched; a time in the future is not trusted (it counts as infinitely old, like the wait and attempt records). */
function fileAge(lockPath) {
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    // A little ahead is file-system granularity; a minute or more ahead is a clock that cannot be trusted.
    return age < -FUTURE_TOLERANCE_MS ? Infinity : Math.max(age, 0);
  } catch {
    return Infinity;
  }
}

/** Show that the owner of `lockPath` is alive: only the file the owner created is touched. Returns false when the lock is no longer this owner's. */
export function touchAutoUpdateLock(lockPath, token) {
  const current = readLock(lockPath);
  if (!current || current.token !== token) return false;
  try {
    const now = new Date();
    utimesSync(lockPath, now, now);
    return true;
  } catch {
    return false;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process. EPERM: the id now belongs to another user's process; a runner of ours can always be signalled.
    return err?.code !== 'ESRCH' && err?.code !== 'EPERM';
  }
}

/**
 * Is the lock's owner still running? true / false, or null when it cannot be told (then the heartbeat age decides).
 * A pid that is alive but started at another time is a different program: the owner is gone.
 */
function ownerRunning(lock) {
  if (!processIsAlive(lock.pid)) return false;
  // A start time written by an older build is in another locale or zone: it says nothing about this process.
  if (!startTagComparable(lock.startTag)) return null;
  const now = processStartTag(lock.pid);
  if (now === null) return null;
  return now === lock.startTag;
}

/** Is this lock stale, i.e. may it be taken over? */
function lockIsStale(lockPath, lock) {
  const running = ownerRunning(lock);
  if (running === true) return false; // alive, however long its last step has taken
  if (running === false) return fileAge(lockPath) > AUTO_UPDATE_LOCK_DEAD_GRACE_MS;
  return fileAge(lockPath) > AUTO_UPDATE_LOCK_TTL_MS; // identity unknown: the heartbeat is all there is
}

function createOwnedFile(filePath, token, payload) {
  const fd = openSync(filePath, 'wx', 0o600);
  try {
    writeFileSync(fd, payload);
  } finally {
    closeSync(fd);
  }
  return token;
}

function tryCreateLock(lockPath, version) {
  const token = ownerToken();
  const startedAt = Date.now();
  const candidatePath = `${lockPath}.candidate.${token}`;
  try {
    createOwnedFile(
      candidatePath,
      token,
      `${token}\n${process.pid}\n${startedAt}\n${version}\n${processStartTag(process.pid) ?? ''}\n`,
    );
    // Publish a complete lock atomically, with the same O_EXCL link used by
    // recovery claims. A crash during the write cannot expose a partial lock.
    linkSync(candidatePath, lockPath);
    return { acquired: true, lockPath, ownerToken: token, recoveredStale: false };
  } catch (err) {
    if (err?.code === 'EEXIST') {
      return { acquired: false, lockPath, ownerToken: null, recoveredStale: false };
    }
    throw err;
  } finally {
    try { unlinkSync(candidatePath); } catch { /* crash-only candidate orphan */ }
  }
}

export function autoUpdateRecoveryClaimPath(lockPath, staleToken, generation = 0) {
  const tokenHash = createHash('sha256').update(staleToken).digest('hex').slice(0, 24);
  return `${lockPath}.recover.${tokenHash}.${generation}`;
}

function tryCreateRecoveryClaim(claimPath) {
  const token = ownerToken();
  const candidatePath = `${claimPath}.candidate.${token}`;
  createOwnedFile(
    candidatePath,
    token,
    `${token}\n${process.pid}\n${Date.now()}\nrecovery\n`,
  );
  try {
    // The candidate is complete before the fixed claim path appears. linkSync
    // gives the destination O_EXCL semantics, so a crash cannot leave a
    // partially written claim that blocks recovery forever.
    linkSync(candidatePath, claimPath);
    return { acquired: true, claimPath, ownerToken: token };
  } catch (err) {
    if (err?.code === 'EEXIST') {
      return { acquired: false, claimPath, ownerToken: null };
    }
    throw err;
  } finally {
    try { unlinkSync(candidatePath); } catch { /* crash-only candidate orphan */ }
  }
}

function tryAcquireRecoveryClaim(lockPath, staleToken) {
  for (let generation = 0; generation < MAX_RECOVERY_GENERATIONS; generation += 1) {
    const claimPath = autoUpdateRecoveryClaimPath(lockPath, staleToken, generation);
    const created = tryCreateRecoveryClaim(claimPath);
    if (created.acquired) return created;

    const existing = readLock(claimPath);
    if (!existing) return null;
    // A claim is held for a few seconds at most; one older than that is orphaned, whatever pid it names (a pid that
    // is "alive" may be a different program by now, and trusting it would block recovery for ever).
    if (Date.now() - existing.startedAt <= AUTO_UPDATE_RECOVERY_TTL_MS) return null;
    // An orphaned claim remains immutable. All contenders derive the same
    // successor generation, where O_EXCL elects one recovery owner without
    // deleting or replacing it.
  }
  return null;
}

export function releaseAutoUpdateLock(lockPath, token) {
  const current = readLock(lockPath);
  if (!current || current.token !== token) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

export function recoverObservedStaleAutoUpdateLock(lockPath, observed) {
  const recovery = tryAcquireRecoveryClaim(lockPath, observed.token);
  if (!recovery?.acquired) return false;

  try {
    const current = readLock(lockPath);
    if (!current || current.token !== observed.token) return false;
    // Judged again under the claim: the owner may have been alive after all, or the lock may be a new one.
    if (!lockIsStale(lockPath, current)) return false;
    try {
      unlinkSync(lockPath);
      return true;
    } catch (err) {
      if (err?.code === 'ENOENT') return false;
      throw err;
    }
  } finally {
    releaseAutoUpdateLock(recovery.claimPath, recovery.ownerToken);
  }
}

/**
 * A lock whose content cannot be read has no owner to ask. It is left alone while it is fresh (it may be half-written)
 * and removed once nobody has touched it for the TTL, under a recovery claim like any other lock: the claim is keyed by
 * what was observed (size and modification time), and under the claim the file is looked at once more, so a new owner
 * who published a good lock in between is not deleted.
 */
export function recoverDamagedAutoUpdateLock(lockPath, observed) {
  const recovery = tryAcquireRecoveryClaim(lockPath, `damaged:${observed.size}:${observed.mtimeMs}`);
  if (!recovery?.acquired) return false;
  try {
    let now;
    try { now = statSync(lockPath); } catch { return false; }
    if (now.size !== observed.size || now.mtimeMs !== observed.mtimeMs) return false; // somebody wrote it since
    if (readLock(lockPath) !== null) return false; // a good lock now
    try {
      unlinkSync(lockPath);
      return true;
    } catch (err) {
      if (err?.code === 'ENOENT') return false;
      throw err;
    }
  } finally {
    releaseAutoUpdateLock(recovery.claimPath, recovery.ownerToken);
  }
}

export function tryAcquireAutoUpdateLock(lockPath, version) {
  const created = tryCreateLock(lockPath, version);
  if (created.acquired) return created;

  const observed = readLock(lockPath);
  if (!observed) {
    if (!existsSync(lockPath)) return created;
    let seen;
    try { seen = statSync(lockPath); } catch { return created; }
    const age = Date.now() - seen.mtimeMs;
    if (age >= -FUTURE_TOLERANCE_MS && age <= AUTO_UPDATE_LOCK_TTL_MS) return created; // fresh: maybe half-written
    if (!recoverDamagedAutoUpdateLock(lockPath, { size: seen.size, mtimeMs: seen.mtimeMs })) return { ...created, recoveredStale: false };
    const retried = tryCreateLock(lockPath, version);
    return { ...retried, recoveredStale: true, recoveredReason: 'the update lock was damaged and untouched for over 15 minutes' };
  }
  if (!lockIsStale(lockPath, observed)) return created;

  // Recovery removes only the exact stale token observed, under a separate O_EXCL claim, and then tries once
  // to take the lock itself, so a stale lock costs one attempt, not a wait for the next trigger.
  const recoveredStale = recoverObservedStaleAutoUpdateLock(lockPath, observed);
  if (!recoveredStale) return { ...created, recoveredStale: false };
  const retried = tryCreateLock(lockPath, version);
  const why = ownerRunning(observed) === false
    ? 'the update lock belonged to a process that is no longer running'
    : 'the update lock had not been touched for over 15 minutes and its owner could not be identified';
  return { ...retried, recoveredStale: true, recoveredReason: why };
}

function writeLine(fd, line) {
  try {
    writeSync(fd, `[memesh auto-update] ${line}\n`);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(err) {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

/**
 * Run one update attempt under the single-flight lock. The decision itself
 * (policy, channel, source check, backup, waiting for running sessions, the
 * install) is `runAutoUpdate` in dist/core/auto-update.js: this file only
 * makes sure two runners never work at once. The lock stays held for as long as
 * this process runs (it is told by pid and start time, see lockIsStale): a long
 * synchronous step or a wait for running sessions does not make it takeable.
 * `label` is what the lock file says started it ('auto' or 'manual').
 */
export async function runLocked(lockPath, runUpdate, label = 'auto') {
  let lock;
  try {
    lock = tryAcquireAutoUpdateLock(lockPath, label);
  } catch (err) {
    writeLine(2, `FAILED stage=lock error=${errorMessage(err)}`);
    return 1;
  }
  if (!lock.acquired) {
    writeLine(1, `${lock.recoveredStale ? 'RECOVERED_STALE' : 'IN_PROGRESS'} lock=${lockPath}`);
    return 0;
  }
  if (lock.recoveredStale) writeLine(1, `RECOVERED_STALE lock=${lockPath}: ${lock.recoveredReason}`);
  let result;
  try {
    result = await runUpdate({
      heartbeat: () => touchAutoUpdateLock(lockPath, lock.ownerToken),
      notice: lock.recoveredStale ? lock.recoveredReason : null,
    });
  } catch (err) {
    writeLine(2, `FAILED stage=attempt error=${errorMessage(err)}`);
    releaseAutoUpdateLock(lockPath, lock.ownerToken);
    return 1;
  }
  const released = releaseAutoUpdateLock(lockPath, lock.ownerToken);
  writeLine(1, `${String(result.outcome).toUpperCase()} ${result.reason}`);
  if (!released) {
    writeLine(2, 'FAILED stage=lock-release');
    return 1;
  }
  return result.outcome === 'failed' ? 1 : 0;
}

/**
 * The exit code of a run started by hand (`--manual`, `--reinstall`): only "installed" and "already current" are success;
 * another update that was running, a refusal and a failure are not. (`memesh update` itself reads the record the run wrote, not
 * this code, except when no record was written: the code is what a person running the runner directly sees.)
 */
export function manualExitCode(attempt, upToDateReason) {
  return attempt !== null && (attempt.outcome === 'installed' || attempt.reason === upToDateReason) ? 0 : 1;
}

async function main() {
  const { AUTO_UPDATE_REASONS } = await import('../../dist/core/auto-update.js');
  const UP_TO_DATE = AUTO_UPDATE_REASONS.upToDate;
  const [lockPath, flag] = process.argv.slice(2);
  // `memesh update` runs this same entry in the foreground with --manual: the owner asked for the update
  // by hand, so the policy and the wait for running sessions do not apply; the checks and the backup do.
  const reinstall = flag === '--reinstall'; // `memesh update --reinstall`: this very version again, through the same checks
  const manual = flag === '--manual' || reinstall;
  if (!lockPath) {
    writeLine(2, 'FAILED stage=arguments error=expected the lock path');
    process.exitCode = 1;
    return;
  }
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const { runAutoUpdate, productionDeps } = await import('../../dist/core/auto-update.js');
  let version = 'unknown';
  try { version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version; } catch { /* the state file then says unknown */ }
  let attempt = null;
  const code = await runLocked(lockPath, async (context) => {
    attempt = await runAutoUpdate({ ...productionDeps(packageRoot, version), ...context, ...(manual ? { manual: true } : {}), ...(reinstall ? { reinstall: true } : {}) });
    return attempt;
  }, manual ? 'manual' : 'auto');
  // Manual: only "installed" and "already current" are success; "another update is running" is not.
  process.exitCode = manual ? manualExitCode(attempt, UP_TO_DATE) : code;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(realpathSync(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  await main();
}
