/**
 * The update notice for entry points that are NOT the SessionStart hook:
 * the MCP server's first tool call in a process and any CLI command.
 *
 * Issue #308 asks that "first use" mean the first time MeMesh is used in a
 * session, whatever the door. The hooks already had the notice; a host that
 * only wires the MCP server, or a human at the terminal, never saw it. Both
 * now read the same resolver (update-notice.ts) and the same receipt
 * and "updates off" state as the hooks, so the four doors agree.
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
import { bumpKind, currentPolicy, policyPermits } from './auto-update.js';
import { findPackageRoot } from './package-root.js';
import { getCurrentInstallChannel, getInstallChannelSupport } from './install-channel.js';
import { getLastUpdateCheck } from './version-check.js';
import { claimJustUpgradedMarker, resolveUpdateNotice, shouldRefreshUpdateCache, type UpdateNotice } from './update-notice.js';

export const RECENT_HOOK_NOTICE_MS = 10 * 60 * 1000;
export const CLI_NOTICE_THROTTLE_MS = 24 * 60 * 60 * 1000;
/** Same marker and window the SessionStart hook uses for its detached refresh. */
export const FRESH_CHECK_THROTTLE_MS = 5 * 60 * 1000;

export type EntryPoint = 'mcp' | 'cli';

/**
 * What the notice may say about an available upgrade depends on three things, and a line that ignores them says
 * something false: whether automatic updates are on, whether this install can update itself at all, and who reads
 * the line. A person at a terminal may be told the command; a model reading a tool result must not be told to run
 * it (it would, and update when the owner said off, and without waiting for sessions to end). When automatic updates
 * are on, the line says the update installs by itself once the running sessions end.
 */
export type UpgradeNoticeMode =
  | { updates: 'on'; door: 'cli' | 'mcp' }
  /** The owner said off; `unsupported` is set too when this install could not update itself anyway. */
  | { updates: 'off'; door: 'cli' | 'mcp'; unsupported?: string }
  /** Automatic updates are on, but the setting (`patch`, `minor`) does not take this release by itself. */
  | { updates: 'held'; door: 'cli' | 'mcp'; setting: string }
  | { updates: 'unsupported'; guidance: string; door?: 'cli' | 'mcp' };

export function formatUpdateNoticeLine(notice: UpdateNotice, mode: UpgradeNoticeMode = { updates: 'on', door: 'cli' }): string | null {
  switch (notice.kind) {
    case 'UPGRADE_AVAILABLE': {
      const head = `[memesh update] ${notice.latestVersion} is available (you are on ${notice.currentVersion}).`;
      if (mode.updates === 'off') {
        // The model door never gets the command: a model told how to install it may, and the owner said off.
        if (mode.door === 'mcp') return `${head} Automatic updates are off, so it is not being installed. Do not update on your own.`;
        // `memesh update` cannot do it on an install that cannot update itself: say that, not a command that would refuse.
        if (mode.unsupported) return `${head} Automatic updates are off, and MeMesh cannot install it for this install method: ${mode.unsupported}`;
        return `${head} Automatic updates are off, so it is not being installed; \`memesh update\` installs it when you choose to.`;
      }
      if (mode.updates === 'held') {
        if (mode.door === 'mcp') return `${head} The setting autoUpdate: ${mode.setting} does not install this release by itself, so it is not being installed. Do not update on your own.`;
        return `${head} The setting autoUpdate: ${mode.setting} does not install this release by itself; \`memesh update\` installs it when you choose to.`;
      }
      if (mode.updates === 'unsupported') {
        // The model door gets no command either: the install method has no safe one, and it must not improvise.
        if (mode.door === 'mcp') return `${head} MeMesh cannot install it for this install method. Do not update on your own; tell the person.`;
        return `${head} MeMesh cannot install it for this install method: ${mode.guidance}`;
      }
      if (mode.door === 'mcp') return `${head} Automatic updates are on: it is installed by itself after the running sessions end. No action is needed.`;
      return `${head} Run \`memesh update\` to install it now.`;
    }
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
      // A reservation can outlive a hook that failed before printing its notice.
      if (value.decision === 'emitted' && value.currentVersion === currentVersion && (latestVersion === null || value.latestVersion === latestVersion)) return true;
    } catch {
      /* one unreadable claim is not evidence either way */
    } finally {
      if (fd !== null) try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
  return false;
}

export function updateCheckEnabledIn(dir: string): boolean {
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
        // ~/.memesh, another uid's file). A marker we cannot refresh would
        // turn "once a day" into "every command" the moment it expires, so
        // it throttles for good: the hook and MCP doors still speak.
        return true;
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
 * hook. A detached invocation of the existing version-check helper runs
 * from here when the answer is missing or stale — throttled through the
 * hook's own marker so the two never race. Nothing is awaited: the notice
 * for THIS call comes from the cache as it is; the next call reads the
 * refreshed answer.
 */
function spawnCacheRefresh(dir: string, currentVersion: string, now: Date): boolean {
  let marker: string | undefined;
  const claim = `${process.pid}-${now.getTime()}`;
  const failed = (error: unknown): void => {
    // Only release this process's claim; a newer owner must keep its throttle.
    try {
      if (marker && fs.readFileSync(marker, 'utf8') === claim) fs.unlinkSync(marker);
    } catch { /* absent or no longer ours */ }
    const code = (error as NodeJS.ErrnoException)?.code;
    const reason = typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'UNKNOWN';
    console.error(`[memesh update] Could not start update cache refresh (${reason}). Status remains unknown; a later call can retry.`);
  };
  try {
    const modulePath = fileURLToPath(import.meta.url);
    // Resolve the existing compiled helper from every shipped layout. Do not
    // invoke `status`: its graph health check would migrate/lock the caller's
    // database even when the calling command was refused before opening it.
    const bundledCli = path.basename(modulePath) === 'cli.js'
      && path.basename(path.dirname(modulePath)) === 'cli'
      && path.basename(path.dirname(path.dirname(modulePath))) === 'transports';
    const helperUrl = new URL(bundledCli ? '../../core/version-check.js' : '../core/version-check.js', import.meta.url);
    if (!fs.existsSync(fileURLToPath(helperUrl))) return false;
    const tag = /^[0-9A-Za-z.+-]+$/.test(currentVersion) ? currentVersion : 'unknown';
    marker = path.join(dir, `last-fresh-refresh.${tag}.lock`);
    try {
      if (now.getTime() - fs.statSync(marker).mtimeMs < FRESH_CHECK_THROTTLE_MS) return false;
      fs.unlinkSync(marker);
    } catch { /* absent or already reclaimed */ }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      const fd = fs.openSync(marker, 'wx', 0o600);
      try { fs.writeSync(fd, claim); } finally { fs.closeSync(fd); }
    } catch {
      return false; // a sibling won the claim
    }
    const refresh = 'const { getUpdateCheck } = await import(process.argv[1]); await getUpdateCheck(process.argv[2], { preferFresh: true });';
    const child = spawn(process.execPath, ['--input-type=module', '--eval', refresh, helperUrl.href, currentVersion], {
      detached: true, stdio: 'ignore', env: { ...process.env }, windowsHide: true,
    });
    child.once('error', failed);
    child.unref();
    return true;
  } catch (error) {
    failed(error);
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
  /** Tests: what the install method can do (default: looked up from where this package is installed). null = unknown. */
  installSupport?: { canSelfUpdate: boolean; guidance: string } | null;
}

/** How long the MCP door waits before re-reading a cache that had no answer. */
export const MCP_PENDING_RETRY_MS = 60 * 1000;

/**
 * The MCP door's per-process memory, kept in the caller-owned Set so a
 * test can hold several "processes" at once. Two shapes of entry:
 * `<version>` — decided, silent for the rest of the process;
 * `<version>#retry:<epoch ms>` — no answer yet, look again after that time.
 */
class ProcessMemo {
  private readonly retryPrefix: string;
  constructor(private readonly set: Set<string> | undefined, private readonly key: string, private readonly now: Date) {
    this.retryPrefix = `${key}#retry:`;
  }
  decided(): boolean {
    if (!this.set) return false;
    if (this.set.has(this.key)) return true;
    for (const entry of this.set) {
      if (entry.startsWith(this.retryPrefix) && this.now.getTime() < Number(entry.slice(this.retryPrefix.length))) return true;
    }
    return false;
  }
  decide(): void { this.clearRetry(); this.set?.add(this.key); }
  retryLater(): void { this.clearRetry(); this.set?.add(`${this.retryPrefix}${this.now.getTime() + MCP_PENDING_RETRY_MS}`); }
  private clearRetry(): void {
    if (!this.set) return;
    for (const entry of [...this.set]) if (entry.startsWith(this.retryPrefix)) this.set.delete(entry);
  }
}

/** Which kind of upgrade line this process may print: see UpgradeNoticeMode. */
function upgradeNoticeMode(input: EntryPointNoticeInput, latestVersion: string | null): UpgradeNoticeMode {
  // An unreadable setting is off here too (resolveUpdatePolicy says so).
  let policy: ReturnType<typeof currentPolicy>['policy'];
  try { policy = currentPolicy().policy; } catch { policy = 'off'; }
  let support = input.installSupport;
  if (support === undefined) {
    try {
      const packageRoot = findPackageRoot(import.meta.url);
      support = getInstallChannelSupport(getCurrentInstallChannel({ packageRoot }), packageRoot);
    } catch { support = null; } // unknown is not "cannot": the notice goes on without that claim
  }
  const cannot = support && !support.canSelfUpdate ? support.guidance : undefined;
  if (policy === 'off') return { updates: 'off', door: input.entryPoint, ...(cannot ? { unsupported: cannot } : {}) };
  // Unknown is not "cannot": only an install that is known to be unable to update itself gets that sentence.
  if (cannot) return { updates: 'unsupported', guidance: cannot, door: input.entryPoint };
  // The setting decides which releases install by themselves: say so when this one is not among them.
  if (latestVersion && !policyPermits(policy, bumpKind(input.currentVersion, latestVersion))) return { updates: 'held', door: input.entryPoint, setting: policy };
  return { updates: 'on', door: input.entryPoint };
}

/**
 * One line to show, or null. Never throws: an update notice must not break
 * a tool call or a CLI command.
 */
export function updateNoticeForEntryPoint(input: EntryPointNoticeInput): string | null {
  try {
    const now = input.now ?? new Date();
    // The MCP door decides once per process. The memo is checked BEFORE any
    // file is read, so a steady-state server does not re-read four files on
    // every tool call — but it is only TAKEN once there is a decision. A
    // first call that found no answer yet (fresh install, refresh in flight)
    // must not spend the process's one notice on silence; it re-reads after
    // a minute, so the process that started the refresh is the one that
    // reports its result.
    const memo = input.entryPoint === 'mcp' ? new ProcessMemo(input.processOnce, input.currentVersion, now) : null;
    if (memo?.decided()) return null;
    const dir = input.dir ?? memeshDir();
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
    // Never checked yet (fresh install, or the refresh above has not landed):
    // nothing to say YET. Saying "could not confirm" here would put a
    // permanent false alarm in front of exactly the hosts this door exists
    // for. The failed-attempt case (a lastError from a real lookup) IS said.
    if (notice.kind === 'CHECK_FAILED' && !notice.attempted) {
      memo?.retryLater();
      return null;
    }
    memo?.decide();
    if (notice.kind === 'DISABLED' || notice.kind === 'UP_TO_DATE') return null;

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
    return formatUpdateNoticeLine(notice, upgradeNoticeMode(input, notice.kind === 'UPGRADE_AVAILABLE' ? notice.latestVersion : null));
  } catch {
    return null;
  }
}
