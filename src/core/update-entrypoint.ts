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
 * Coordination with the hooks: a SessionStart hook that just emitted the
 * notice leaves an `update-prompt-claims/*.json` file; an MCP process that
 * starts within RECENT_HOOK_NOTICE_MS of such a claim for the same versions
 * stays quiet instead of saying it twice. The CLI throttles itself to once a
 * day per installed version with a private marker.
 */
import fs from 'fs';
import path from 'path';
import { memeshDir } from './paths.js';
import { getLastUpdateCheck } from './version-check.js';
import { claimJustUpgradedMarker, resolveUpdateNotice, type UpdateNotice } from './update-notice.js';

export const RECENT_HOOK_NOTICE_MS = 10 * 60 * 1000;
export const CLI_NOTICE_THROTTLE_MS = 24 * 60 * 60 * 1000;

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
export function recentHookNoticeExists(dir: string, currentVersion: string, latestVersion: string, now: Date = new Date()): boolean {
  const claims = path.join(dir, 'update-prompt-claims');
  let names: string[];
  try { names = fs.readdirSync(claims); } catch { return false; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(claims, name);
    try {
      const stat = fs.statSync(file);
      if (now.getTime() - stat.mtimeMs > RECENT_HOOK_NOTICE_MS) continue;
      const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      if (value.currentVersion === currentVersion && value.latestVersion === latestVersion) return true;
    } catch { /* one unreadable claim is not evidence either way */ }
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
  try {
    const stat = fs.statSync(marker);
    if (now.getTime() - stat.mtimeMs < CLI_NOTICE_THROTTLE_MS) return true;
  } catch { /* no marker: not throttled */ }
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker, String(now.getTime()), { mode: 0o600 });
    try { fs.chmodSync(marker, 0o600); } catch { /* non-POSIX */ }
  } catch { /* cannot record: better one extra line than a crash */ }
  return false;
}

export interface EntryPointNoticeInput {
  currentVersion: string;
  entryPoint: EntryPoint;
  dir?: string;
  now?: Date;
  /** Per-process memory for the MCP door; the caller owns the Set. */
  processOnce?: Set<string>;
  updateCheckEnabled?: boolean;
}

/**
 * One line to show, or null. Never throws: an update notice must not break
 * a tool call or a CLI command.
 */
export function updateNoticeForEntryPoint(input: EntryPointNoticeInput): string | null {
  try {
    const dir = input.dir ?? memeshDir();
    const now = input.now ?? new Date();
    // Everything is read from `dir` — the same directory the hooks use — not
    // from whatever the process environment happens to say, so an isolated
    // caller (and every test) sees one consistent state.
    const updateCheckEnabled = input.updateCheckEnabled ?? updateCheckEnabledIn(dir);
    const tag = /^[0-9A-Za-z.+-]+$/.test(input.currentVersion) ? input.currentVersion : 'unknown';
    const cache = getLastUpdateCheck(input.currentVersion, { now, updateCheckPath: path.join(dir, `update-check.${tag}.json`) });
    const notice = resolveUpdateNotice({ dir, currentVersion: input.currentVersion, cache, now, updateCheckEnabled });
    if (notice.kind === 'DISABLED' || notice.kind === 'SNOOZED' || notice.kind === 'UP_TO_DATE') return null;

    if (input.entryPoint === 'mcp') {
      const key = `${input.currentVersion}`;
      if (input.processOnce?.has(key)) return null;
      input.processOnce?.add(key);
      if (notice.kind === 'UPGRADE_AVAILABLE' && recentHookNoticeExists(dir, notice.currentVersion, notice.latestVersion, now)) return null;
    } else if (cliThrottled(dir, input.currentVersion, now)) {
      return null;
    }

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
