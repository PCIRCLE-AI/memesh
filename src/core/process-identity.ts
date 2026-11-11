/**
 * A process id alone is not an identity: ids are reused, so "a process with
 * this id is running" can be a different program from the one that wrote the
 * record. The start time makes it one. Used by the registry of running hosts,
 * the update lock, the cleanup of leftovers an interrupted update left behind,
 * and (through the generated copy in scripts/hooks/_generated) the hooks.
 *
 * This is the ONE place `ps` is asked for a start time. It must answer the same
 * for the same process whoever asks: `lstart` is printed in the caller's locale
 * and time zone, and the program that wrote a record (a hook started by a desktop
 * app) and the one that reads it later (a `memesh update` in a terminal) rarely
 * share either. So both are pinned, and the record says in which form it is.
 */
import { execFileSync } from 'child_process';

const CACHE_TTL_MS = 30_000;
const cache = new Map<number, { tag: string | null; at: number }>();

/** A start time written in the pinned form starts with this; one without it was written by an older build, in whatever locale and zone that run had. */
export const START_TAG_PREFIX = 'v2:';

type PsExec = (file: string, args: string[], options: { env?: NodeJS.ProcessEnv } & Record<string, unknown>) => string;

/**
 * When `pid` started, as `ps -o lstart=` prints it, with the locale and the time zone pinned (C and UTC): the raw string,
 * not yet a tag. `exec` is a test seam. Throws when `ps` cannot be run (no `ps`, Windows) or the process is gone.
 */
export function runRealPsStart(pid: number, exec: PsExec = execFileSync as unknown as PsExec): string {
  return exec('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
  });
}

/** Forget what was read (tests; and a process whose pid was just reused would otherwise be remembered for half a minute). */
export function clearStartTagCache(): void {
  cache.clear();
}

/**
 * The platform's start-time tag for `pid` (`v2:` and what `ps -o lstart=` prints under the pinned locale and zone), or null
 * when it cannot be read (no such process, no `ps`, Windows: nothing but the pid can be compared there). The value is only
 * ever compared with an earlier reading of the same kind.
 */
export function processStartTag(pid: number, read: (pid: number) => string = runRealPsStart, now: () => number = Date.now): string | null {
  if (process.platform === 'win32' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  // A running process keeps its start time for as long as it runs, and the wait for running sessions asks
  // about the same few pids on every poll: one `ps` per pid per half minute is enough.
  const hit = cache.get(pid);
  if (hit && now() - hit.at < CACHE_TTL_MS) return hit.tag;
  let tag: string | null = null;
  try {
    const out = read(pid).trim();
    tag = out === '' ? null : `${START_TAG_PREFIX}${out}`;
  } catch { /* no such process, or no ps */ }
  cache.set(pid, { tag, at: now() });
  return tag;
}

/**
 * A recorded start time that can be compared with what `processStartTag` reads now: it carries the pinned form. One from an
 * older build was printed in another locale or zone, so it says nothing about whether this is the same process: only the
 * pid can be compared then.
 */
export function startTagComparable(started: string | null | undefined): started is string {
  return typeof started === 'string' && started.startsWith(START_TAG_PREFIX);
}

/**
 * Is the process that wrote `{ pid, started }` still running? A reused pid
 * (alive, but started at another time) is not. When either start time is
 * unknown, or the record is in an older form, the answer falls back to "a process
 * with that id exists", which errs on the side of "still running".
 */
export function sameProcessAlive(pid: number, started: string | null | undefined, pidAlive: (pid: number) => boolean, read: (pid: number) => string | null = processStartTag): boolean {
  if (!pidAlive(pid)) return false;
  if (!startTagComparable(started)) return true;
  const now = read(pid);
  return now === null ? true : now === started;
}
