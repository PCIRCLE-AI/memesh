/**
 * The update-status resolver the hooks read (SessionStart, UserPromptSubmit,
 * the Stop-hook updater). `memesh status` still renders version-check.ts
 * directly; wiring the CLI and the MCP first call to this resolver is the
 * follow-up PR for issue #308.
 *
 * Before this module the SessionStart hook, the Stop hook and `memesh status`
 * each derived "is there an update?" from the raw cache with their own rules,
 * and two states had no representation at all: a check that FAILED (silence
 * read as "up to date" — the exact failure gstack reports as a 45-release
 * silent-staleness incident) and an upgrade that JUST LANDED (the running
 * host still executes the old version until it restarts, and nothing said
 * so — issue #308 acceptance check 3).
 *
 * Runtime LEAF on purpose: imports only node builtins and `./paths.js`, so
 * `scripts/generate-hook-core.mjs` can copy the compiled module beside the
 * plugin hooks and the hooks call the same code the CLI does.
 */
import fs from 'fs';
import path from 'path';
import { redactUserPaths } from './paths.js';

/** Re-check an "up to date" answer after this long. */
export const UP_TO_DATE_REFRESH_MS = 60 * 60 * 1000;
/** An upgrade that is already known stays known; re-check after this long. */
export const UPGRADE_AVAILABLE_REFRESH_MS = 12 * 60 * 60 * 1000;
/** A successful answer older than this no longer proves anything. */
export const ANSWER_VALID_MS = 24 * 60 * 60 * 1000;
/** "Not now" — first 24 h, second 48 h, third and later 7 days. */
export const SNOOZE_LEVEL_MS = [24 * 60 * 60 * 1000, 48 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000] as const;

const SNOOZE_FILE = 'update-snooze.json';
const JUST_UPGRADED_FILE = 'just-upgraded.json';

/** The shape `update-check.<version>.json` is written in (see version-check.ts). */
export interface UpdateCheckCacheLike {
  currentVersion?: string | null;
  latestVersion?: string | null;
  lastSuccessfulCheckAt?: string | null;
  lastAttemptAt?: string | null;
  checkSucceeded?: boolean;
  lastError?: string | null;
}

export type UpdateNotice =
  | { kind: 'DISABLED'; currentVersion: string }
  | { kind: 'JUST_UPGRADED'; currentVersion: string; from: string; to: string }
  | { kind: 'CHECK_FAILED'; currentVersion: string; reason: string; /** false = no check has ever run for this version */ attempted: boolean }
  | { kind: 'SNOOZED'; currentVersion: string; latestVersion: string; until: string; level: number }
  | { kind: 'UPGRADE_AVAILABLE'; currentVersion: string; latestVersion: string }
  | { kind: 'UP_TO_DATE'; currentVersion: string; latestVersion: string };

export interface SnoozeState {
  target: string;
  level: number;
  since: string;
}

export interface JustUpgradedMarker {
  from: string;
  to: string;
  at: string;
}

/**
 * True iff `a` is strictly older than `b`. Numeric per dot-separated
 * component (4.2.9 < 4.2.10); a prerelease tag sorts before its release.
 */
export function isStrictlyOlder(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [main, ...rest] = String(v).split(/[-+]/);
    const nums = main.split('.').map((s) => Number.parseInt(s, 10));
    return { nums, tail: rest.join('-') };
  };
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const ai = Number.isFinite(pa.nums[i]) ? pa.nums[i] : 0;
    const bi = Number.isFinite(pb.nums[i]) ? pb.nums[i] : 0;
    if (ai !== bi) return ai < bi;
  }
  if (pa.tail && !pb.tail) return true;
  if (!pa.tail && pb.tail) return false;
  return pa.tail < pb.tail;
}

function parseIso(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function writePrivateJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  // `mode` applies only on create; an existing file (the snooze is rewritten
  // on every decline) keeps whatever mode it had.
  try { fs.chmodSync(file, 0o600); } catch { /* non-POSIX */ }
}

export function readSnooze(dir: string): SnoozeState | null {
  const raw = readJson(path.join(dir, SNOOZE_FILE));
  if (!raw) return null;
  const { target, level, since } = raw;
  if (typeof target !== 'string' || !target) return null;
  if (typeof level !== 'number' || !Number.isInteger(level) || level < 1) return null;
  if (parseIso(since) === null) return null;
  return { target, level, since: since as string };
}

/**
 * Record "Not now" for `target`. The level climbs on every repeat for the
 * same target and resets to 1 when a newer target appears, so a user who
 * keeps declining one release is asked less often, but a new release is
 * offered promptly.
 */
export function writeSnooze(dir: string, target: string, now: Date = new Date()): SnoozeState {
  const previous = readSnooze(dir);
  const level = previous && previous.target === target
    ? Math.min(previous.level + 1, SNOOZE_LEVEL_MS.length)
    : 1;
  const state: SnoozeState = { target, level, since: now.toISOString() };
  writePrivateJson(path.join(dir, SNOOZE_FILE), state);
  return state;
}

export function clearSnooze(dir: string): void {
  try { fs.unlinkSync(path.join(dir, SNOOZE_FILE)); } catch { /* absent is the goal */ }
}

export function snoozeExpiresAt(state: SnoozeState): number {
  const since = parseIso(state.since) ?? 0;
  const duration = SNOOZE_LEVEL_MS[Math.min(state.level, SNOOZE_LEVEL_MS.length) - 1];
  return since + duration;
}

export function readJustUpgradedMarker(dir: string): JustUpgradedMarker | null {
  const raw = readJson(path.join(dir, JUST_UPGRADED_FILE));
  if (!raw) return null;
  const { from, to, at } = raw;
  if (typeof from !== 'string' || !from || typeof to !== 'string' || !to) return null;
  return { from, to, at: typeof at === 'string' ? at : '' };
}

/** Written by the updater right after a readback-verified install. */
export function writeJustUpgradedMarker(dir: string, from: string, to: string, now: Date = new Date()): void {
  writePrivateJson(path.join(dir, JUST_UPGRADED_FILE), { from, to, at: now.toISOString() } satisfies JustUpgradedMarker);
}

/** Called by whoever announced the upgrade, so it is said exactly once. */
export function clearJustUpgradedMarker(dir: string): void {
  try { fs.unlinkSync(path.join(dir, JUST_UPGRADED_FILE)); } catch { /* absent is the goal */ }
}

/**
 * Take the receipt so that exactly ONE announcer gets it. Two host hooks
 * (Claude and Codex SessionStart) can start in the same second; a read-then-
 * unlink would let both print "upgraded". `rename` is atomic on every
 * platform Node supports — one caller's rename succeeds, the other's fails
 * with ENOENT and returns null. The renamed file is removed afterwards; if
 * that removal fails the marker is already out of the resolver's path, so
 * nothing is announced twice.
 */
export function claimJustUpgradedMarker(dir: string): JustUpgradedMarker | null {
  const file = path.join(dir, JUST_UPGRADED_FILE);
  const taken = `${file}.claimed-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.renameSync(file, taken);
  } catch {
    return null;
  }
  const raw = readJson(taken);
  try { fs.unlinkSync(taken); } catch { /* best-effort; already out of the way */ }
  if (!raw) return null;
  const { from, to, at } = raw;
  if (typeof from !== 'string' || !from || typeof to !== 'string' || !to) return null;
  return { from, to, at: typeof at === 'string' ? at : '' };
}

/**
 * `lastError` comes from npm's stderr and ends up inside a system message the
 * model reads. Keep it one line and short: no control characters, no room
 * for a multi-line payload to masquerade as instructions.
 */
function boundedReason(raw: string): string {
  // npm's stderr routinely names the user's home and cache directories;
  // the same redaction the doctor payload gets applies before the text goes
  // anywhere a model or a terminal will read it.
  // eslint-disable-next-line no-control-regex
  const oneLine = redactUserPaths(raw).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 157)}...` : oneLine;
}

function answerIsCurrent(currentVersion: string, cache: UpdateCheckCacheLike | null | undefined, now: Date): boolean {
  if (!cache || cache.currentVersion !== currentVersion) return false;
  if (typeof cache.latestVersion !== 'string' || !cache.latestVersion) return false;
  const successAt = parseIso(cache.lastSuccessfulCheckAt);
  if (successAt === null) return false;
  return now.getTime() - successAt <= ANSWER_VALID_MS;
}

/**
 * Should a caller spawn a fresh registry check now? Two TTLs: a current
 * answer is re-verified hourly so a new release is noticed quickly; a known
 * upgrade is not re-fetched for 12 h (the answer cannot get more available).
 * No cache, a failed check, or a cache for another version: yes.
 */
export function shouldRefreshUpdateCache(
  currentVersion: string,
  cache: UpdateCheckCacheLike | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!answerIsCurrent(currentVersion, cache, now)) return true;
  const successAt = parseIso(cache!.lastSuccessfulCheckAt) as number;
  const age = now.getTime() - successAt;
  const upgrade = isStrictlyOlder(currentVersion, cache!.latestVersion as string);
  return age > (upgrade ? UPGRADE_AVAILABLE_REFRESH_MS : UP_TO_DATE_REFRESH_MS);
}

export interface ResolveUpdateNoticeInput {
  /** `~/.memesh` (or the isolated MEMESH_DIR) — where snooze and marker files live. */
  dir: string;
  currentVersion: string;
  cache: UpdateCheckCacheLike | null | undefined;
  now?: Date;
  /** `config.updateCheck !== false`. Default true. */
  updateCheckEnabled?: boolean;
}

/**
 * One answer for "what should this entry point say about updates?".
 * Precedence: DISABLED > JUST_UPGRADED > CHECK_FAILED > SNOOZED > UPGRADE_AVAILABLE > UP_TO_DATE.
 * CHECK_FAILED sits above UP_TO_DATE deliberately: an unknown status must
 * never be rendered as current.
 */
export function resolveUpdateNotice(input: ResolveUpdateNoticeInput): UpdateNotice {
  const { dir, currentVersion, cache } = input;
  const now = input.now ?? new Date();
  if (input.updateCheckEnabled === false) return { kind: 'DISABLED', currentVersion };

  const marker = readJustUpgradedMarker(dir);
  if (marker) {
    if (marker.to === currentVersion) {
      return { kind: 'JUST_UPGRADED', currentVersion, from: marker.from, to: marker.to };
    }
    // A receipt for some other version (the user jumped versions by hand, or
    // a downgrade) would otherwise sit in ~/.memesh forever. Drop it.
    clearJustUpgradedMarker(dir);
  }

  if (!answerIsCurrent(currentVersion, cache, now)) {
    let reason = 'no update check has completed yet';
    let attempted = false;
    if (cache && cache.currentVersion === currentVersion) {
      // "Attempted" means a lookup COMPLETED — with an error, or with an
      // answer that has since gone stale. A bare lastAttemptAt (a check
      // still in flight, or one that was interrupted) would make the door
      // speak while the reason still says "no check has completed yet".
      attempted = parseIso(cache.lastSuccessfulCheckAt) !== null
        || (typeof cache.lastError === 'string' && cache.lastError.length > 0);
      if (typeof cache.lastError === 'string' && cache.lastError) reason = boundedReason(cache.lastError);
      else if (parseIso(cache.lastSuccessfulCheckAt) !== null) reason = 'the last successful check is more than a day old';
    }
    return { kind: 'CHECK_FAILED', currentVersion, reason, attempted };
  }

  const latestVersion = cache!.latestVersion as string;
  if (!isStrictlyOlder(currentVersion, latestVersion)) {
    return { kind: 'UP_TO_DATE', currentVersion, latestVersion };
  }

  const snooze = readSnooze(dir);
  if (snooze && snooze.target === latestVersion) {
    const until = snoozeExpiresAt(snooze);
    if (now.getTime() < until) {
      return { kind: 'SNOOZED', currentVersion, latestVersion, until: new Date(until).toISOString(), level: snooze.level };
    }
  }
  return { kind: 'UPGRADE_AVAILABLE', currentVersion, latestVersion };
}
