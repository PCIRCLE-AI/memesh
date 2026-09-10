/**
 * The update notice for entry points that are NOT the SessionStart hook:
 * the MCP server's first tool call in a process and any CLI command.
 *
 * Issue #308 asks that "first use" mean the first time MeMesh is used in a
 * session, whatever the door. The hooks already had the notice; a host that
 * only wires the MCP server, or a human at the terminal, never saw it. Both
 * now read the same resolver (update-notice.ts) and the same snooze, receipt
 * and "never ask again" state as the hooks, so the four doors agree.
 *
 * Coordination with the hooks: a SessionStart hook that just emitted a
 * notice leaves an `update-prompt-claims/*.json` file; an MCP process that
 * starts within RECENT_HOOK_NOTICE_MS of such a claim for this installed
 * version stays quiet instead of saying it twice. The CLI throttles itself to
 * once a day per installed version with a private marker. When the cached
 * answer is missing or stale, either door spawns the same detached refresh
 * the hook does, so a hook-less host eventually gets a real answer instead
 * of a permanent "could not confirm".
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { memeshDir } from './paths.js';
import { getLastUpdateCheck } from './version-check.js';
import { claimJustUpgradedMarker, resolveUpdateNotice, shouldRefreshUpdateCache, type UpdateNotice } from './update-notice.js';

export const RECENT_HOOK_NOTICE_MS = 10 * 60 * 1000;
export const CLI_NOTICE_THROTTLE_MS = 24 * 60 * 60 * 1000;
/** Same marker and window the SessionStart hook uses for its detached refresh. */
export const FRESH_CHECK_THROTTLE_MS = 5 * 60 * 1000;

export type EntryPoint = 'mcp' | 'cli';

export function formatUpdateNoticeLine(notice: UpdateNotice): string | null {
  switch (notice.kind) {
    case 'UPGRADE_AVAILABLE':
      return `[memesh update] ${notice.latestVersion} is available (you are on ${notice.currentVersion}). Run \`memesh update\`, or reply “Not now” / “Never ask again” in a hooked session.`;
    case 'JUST_UPGRADED':
      return `[memesh update] Upgraded ${notice.from} → ${notice.to}. Processes started before the upgrade keep running ${notice.from} until they restart.`;
    case 'CHECK_FAILED':
      return `[memesh update] Could not confirm whether an update exists (${notice.reason}). Status is unknown, not current — \`memesh status\` retries.`;
    default:
      return null;
  }
}

/**
 * Did a SessionStart hook announce this same upgrade moments ago? The claim
 * files are keyed by session, which this process does not know, so match on
 * versions and recency (file mtime — the hook rewrites the file on emission).
 */
export function recentHookNoticeExists(dir: string, currentVersion: string, latestVersion: string | null, now: Date = new Date()): boolean {
  const claims = path.join(dir, 'update-prompt-claims');
  let names: string[];
  try { names = fs.readdirSync(claims); } catch { return false; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(claims, name);
    // One descriptor for both the mtime and the bytes: a stat on the path
    // followed by a read of the path is a check-then-use race (the hook may
    // rewrite the claim in between). fstat + read on the same fd is not.
    let fd: number | null = null;
    try {
      fd = fs.openSync(file, 'r');
      const stat = fs.fstatSync(fd);
      if (now.getTime() - stat.mtimeMs > RECENT_HOOK_NOTICE_MS) continue;
      const value = JSON.parse(fs.readFileSync(fd, 'utf8')) as Record<string, unknown>;
      if (value.currentVersion === currentVersion && (latestVersion === null || value.latestVersion === latestVersion)) return true;
    } catch {
      /* one unreadable claim is not evidence either way */
    } finally {
      if (fd !== null) try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
  return false;
}

function updateCheckEnabledIn(dir: string): boolean {
  // Same file config.ts owns; read directly so `dir` wins over the env.
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
    return raw.updateCheck !== false;
  } catch {
    return true;
  }
}

function cliThrottled(dir: string, currentVersion: string, now: Date): boolean {
  const tag = /^[0-9A-Za-z.+-]+$/.test(currentVersion) ? currentVersion : 'unknown';
  const marker = path.join(dir, `last-cli-update-notice.${tag}.lock`);
  // Open first, decide on the descriptor, write through the same descriptor:
  // no stat-then-write window in which a concurrent CLI could slip a second
  // line through (or CodeQL a js/file-system-race).
  let fd: number | null = null;
  try {
    try {
      fd = fs.openSync(marker, 'r+');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // The marker exists but cannot be opened for writing (read-only
        // ~/.memesh, another uid's file). Its mtime still answers the only
        // question that matters; a marker we cannot refresh must not turn
        // "once a day" into "every command".
        try {
          return now.getTime() - fs.statSync(marker).mtimeMs < CLI_NOTICE_THROTTLE_MS;
        } catch {
          return true; // unreadable: stay quiet rather than nag
        }
      }
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        fd = fs.openSync(marker, 'wx', 0o600);
      } catch (raceErr) {
        // A sibling command created it between our open and ours: it is
        // printing the line right now, so this one is throttled.
        if ((raceErr as NodeJS.ErrnoException).code === 'EEXIST') return true;
        throw raceErr;
      }
      fs.writeSync(fd, String(now.getTime()));
      return false;
    }
    const stat = fs.fstatSync(fd);
    if (now.getTime() - stat.mtimeMs < CLI_NOTICE_THROTTLE_MS) return true;
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, String(now.getTime()), 0);
    try { fs.fchmodSync(fd, 0o600); } catch { /* non-POSIX */ }
    return false;
  } catch {
    return true; // cannot record and cannot tell: silence beats a daily promise broken
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * Entry points only READ the cache; the SessionStart hook is what used to
 * refresh it, and a host that wires only the MCP server never runs that
 * hook. So the same detached `memesh status` refresh the hook spawns runs
 * from here when the answer is missing or stale — throttled through the
 * hook's own marker so the two never race. Nothing is awaited: the notice
 * for THIS call comes from the cache as it is; the next call reads the
 * refreshed answer.
 */
function spawnCacheRefresh(dir: string, currentVersion: string, now: Date): boolean {
  try {
    const cliPath = fileURLToPath(new URL('../transports/cli/cli.js', import.meta.url));
    if (!fs.existsSync(cliPath)) return false;
    const tag = /^[0-9A-Za-z.+-]+$/.test(currentVersion) ? currentVersion : 'unknown';
    const marker = path.join(dir, `last-fresh-refresh.${tag}.lock`);
    try {
      if (now.getTime() - fs.statSync(marker).mtimeMs < FRESH_CHECK_THROTTLE_MS) return false;
      fs.unlinkSync(marker);
    } catch { /* absent or already reclaimed */ }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      const fd = fs.openSync(marker, 'wx', 0o600);
      try { fs.writeSync(fd, `${process.pid}-${now.getTime()}`); } finally { fs.closeSync(fd); }
    } catch {
      return false; // a sibling won the claim
    }
    const child = spawn(process.execPath, [cliPath, 'status'], {
      detached: true, stdio: 'ignore', env: { ...process.env }, windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export interface EntryPointNoticeInput {
  currentVersion: string;
  entryPoint: EntryPoint;
  dir?: string;
  now?: Date;
  /** Per-process memory for the MCP door; the caller owns the Set. */
  processOnce?: Set<string>;
  updateCheckEnabled?: boolean;
  /** Tests: observe the detached refresh instead of spawning `memesh status`. */
  refresh?: (dir: string, currentVersion: string, now: Date) => boolean;
}

/**
 * One line to show, or null. Never throws: an update notice must not break
 * a tool call or a CLI command.
 */
export function updateNoticeForEntryPoint(input: EntryPointNoticeInput): string | null {
  try {
    // The MCP door decides once per process, whatever the state: the memo is
    // taken BEFORE any file is read, so a steady-state server does not re-read
    // four files on every tool call.
    if (input.entryPoint === 'mcp') {
      const key = `${input.currentVersion}`;
      if (input.processOnce?.has(key)) return null;
      input.processOnce?.add(key);
    }
    const dir = input.dir ?? memeshDir();
    const now = input.now ?? new Date();
    // Everything is read from `dir` — the same directory the hooks use — not
    // from whatever the process environment happens to say, so an isolated
    // caller (and every test) sees one consistent state.
    const updateCheckEnabled = input.updateCheckEnabled ?? updateCheckEnabledIn(dir);
    const tag = /^[0-9A-Za-z.+-]+$/.test(input.currentVersion) ? input.currentVersion : 'unknown';
    const cache = getLastUpdateCheck(input.currentVersion, { now, updateCheckPath: path.join(dir, `update-check.${tag}.json`) });
    if (updateCheckEnabled && shouldRefreshUpdateCache(input.currentVersion, cache, now)) {
      (input.refresh ?? spawnCacheRefresh)(dir, input.currentVersion, now);
    }
    const notice = resolveUpdateNotice({ dir, currentVersion: input.currentVersion, cache, now, updateCheckEnabled });
    if (notice.kind === 'DISABLED' || notice.kind === 'SNOOZED' || notice.kind === 'UP_TO_DATE') return null;
    // Never checked yet (fresh install, or the refresh above has not landed):
    // nothing to say. Saying "could not confirm" here would put a permanent
    // false alarm in front of exactly the hosts this door exists for. The
    // failed-attempt case (a lastError from a real lookup) IS said.
    if (notice.kind === 'CHECK_FAILED' && !notice.attempted) return null;

    // A SessionStart hook said this a moment ago, whatever it said.
    if (input.entryPoint === 'mcp'
      && recentHookNoticeExists(dir, notice.currentVersion, notice.kind === 'UPGRADE_AVAILABLE' ? notice.latestVersion : null, now)) {
      return null;
    }
    if (input.entryPoint === 'cli' && cliThrottled(dir, input.currentVersion, now)) return null;

    if (notice.kind === 'JUST_UPGRADED') {
      // Same atomic hand-off as the hook: whoever claims the receipt says it.
      const claimed = claimJustUpgradedMarker(dir);
      if (!claimed) return null;
      return formatUpdateNoticeLine({ ...notice, from: claimed.from, to: claimed.to });
    }
    return formatUpdateNoticeLine(notice);
  } catch {
    return null;
  }
}
