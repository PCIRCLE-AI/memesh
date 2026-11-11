/**
 * The one lock every writer of private-session state takes: the markers in
 * `private-sessions/` and the hold records in `note-ingest-holds/`. Several
 * processes write those files (a session's own hooks, other sessions' imports,
 * the CLI), and each write is read, change, write: without a lock, the slower
 * writer puts back what it read before the faster one wrote, and a hold the
 * faster one recorded is gone.
 *
 * Inside the lock only small JSON files are read and written (milliseconds):
 * transcripts are scanned and notes hashed before it is taken. There is one
 * lock, never nested and never held while waiting for anything else, so it
 * cannot deadlock. A lock left by a process that died is broken; one that is
 * not released before the caller's deadline is `MEMESH_PRIVATE_STATE_BUSY`,
 * and the caller fails closed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const PRIVATE_STATE_BUSY = 'MEMESH_PRIVATE_STATE_BUSY';
/** Older than any hook may live (10 s, the longest host limit) plus room for a slow disk. */
const STALE_MS = 15_000;
const LOCK_FILE = 'private-state.lock';

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The lock file, when it was left by a process that is gone (too old, or its pid is not running on this host); undefined otherwise. */
function deadLock(lock: string, now: number): fs.Stats | undefined {
  let st: fs.Stats;
  try { st = fs.statSync(lock); } catch { return undefined; }
  if (now - st.mtimeMs > STALE_MS) return st;
  try {
    const holder = JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid?: unknown; host?: unknown };
    if (holder.host !== os.hostname() || typeof holder.pid !== 'number') return undefined;
    try { process.kill(holder.pid, 0); return undefined; } catch (err) { return (err as NodeJS.ErrnoException).code === 'ESRCH' ? st : undefined; }
  } catch {
    return undefined;
  }
}

/** Runs `fn` holding the lock in `memeshDir`; throws `PRIVATE_STATE_BUSY` when it cannot be had by `deadlineAt`. */
export function withPrivateStateLock<T>(memeshDir: string, deadlineAt: number, fn: () => T): T {
  fs.mkdirSync(memeshDir, { recursive: true, mode: 0o700 });
  const lock = path.join(memeshDir, LOCK_FILE);
  for (;;) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    if (fd !== undefined) {
      const token = crypto.randomBytes(8).toString('hex');
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now(), token }));
      } finally {
        fs.closeSync(fd);
      }
      try {
        return fn();
      } finally {
        // Only this lock: one that was broken while this process ran (it outlived STALE_MS) and taken by another is that one's.
        try { if ((JSON.parse(fs.readFileSync(lock, 'utf8')) as { token?: unknown }).token === token) fs.rmSync(lock, { force: true }); } catch { /* gone already */ }
      }
    }
    const now = Date.now();
    const dead = deadLock(lock, now);
    if (dead) {
      // Moved aside, then checked: the file moved must be the one judged dead. If another process broke that one and took
      // the lock in between, its lock was moved instead, and it is put back (a link fails if yet another lock is there).
      const aside = `${lock}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      try {
        fs.renameSync(lock, aside);
        const moved = fs.statSync(aside);
        if (moved.ino !== dead.ino || moved.mtimeMs !== dead.mtimeMs || moved.size !== dead.size) { try { fs.linkSync(aside, lock); } catch { /* a newer lock is in place */ } }
        fs.rmSync(aside, { force: true });
      } catch { /* someone else broke it first */ }
      continue;
    }
    if (now >= deadlineAt) {
      throw Object.assign(new Error('the private-session state is locked by another process; nothing was changed'), { code: PRIVATE_STATE_BUSY });
    }
    sleepMs(10 + Math.floor(Math.random() * 15));
  }
}
