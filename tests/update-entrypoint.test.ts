import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLI_NOTICE_THROTTLE_MS,
  RECENT_HOOK_NOTICE_MS,
  formatUpdateNoticeLine,
  recentHookNoticeExists,
  updateNoticeForEntryPoint,
} from '../src/core/update-entrypoint.js';

const NOW = new Date('2026-09-10T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-update-entry-'));
const cache = (dir: string, latest: string | null, extra: Record<string, unknown> = {}) => {
  const file = path.join(dir, 'update-check.4.9.4.json');
  fs.writeFileSync(file, JSON.stringify({
    currentVersion: '4.9.4', latestVersion: latest, checkSucceeded: latest !== null,
    lastSuccessfulCheckAt: latest ? new Date(NOW.getTime() - HOUR).toISOString() : null,
    lastAttemptAt: NOW.toISOString(), ...extra,
  }));
  return file;
};

describe('formatUpdateNoticeLine', () => {
  it('has one line for each state that deserves one, and nothing for the rest', () => {
    expect(formatUpdateNoticeLine({ kind: 'UPGRADE_AVAILABLE', currentVersion: '4.9.4', latestVersion: '4.10.0' }))
      .toBe('[memesh update] 4.10.0 is available (you are on 4.9.4). Run `memesh update`, or reply “Not now” / “Never ask again” in a hooked session.');
    expect(formatUpdateNoticeLine({ kind: 'JUST_UPGRADED', currentVersion: '4.9.4', from: '4.9.3', to: '4.9.4' }))
      .toBe('[memesh update] Upgraded 4.9.3 → 4.9.4. Processes started before the upgrade keep running 4.9.3 until they restart.');
    expect(formatUpdateNoticeLine({ kind: 'CHECK_FAILED', currentVersion: '4.9.4', reason: 'ENOTFOUND' }))
      .toBe('[memesh update] Could not confirm whether an update exists (ENOTFOUND). Status is unknown, not current — `memesh status` retries.');
    expect(formatUpdateNoticeLine({ kind: 'UP_TO_DATE', currentVersion: '4.9.4', latestVersion: '4.9.4' })).toBeNull();
    expect(formatUpdateNoticeLine({ kind: 'SNOOZED', currentVersion: '4.9.4', latestVersion: '4.10.0', until: NOW.toISOString(), level: 1 })).toBeNull();
    expect(formatUpdateNoticeLine({ kind: 'DISABLED', currentVersion: '4.9.4' })).toBeNull();
  });
});

describe('recentHookNoticeExists', () => {
  it('sees a fresh SessionStart claim for the same versions and ignores old or other-version claims', () => {
    const dir = tmp();
    const claims = path.join(dir, 'update-prompt-claims');
    fs.mkdirSync(claims);
    const write = (name: string, currentVersion: string, latestVersion: string, ageMs: number) => {
      const file = path.join(claims, name);
      fs.writeFileSync(file, JSON.stringify({ sessionId: 's', currentVersion, latestVersion, decision: 'emitted' }));
      const t = new Date(NOW.getTime() - ageMs);
      fs.utimesSync(file, t, t);
    };
    write('a.json', '4.9.4', '4.10.0', 60_000);
    expect(recentHookNoticeExists(dir, '4.9.4', '4.10.0', NOW)).toBe(true);
    expect(recentHookNoticeExists(dir, '4.9.4', '4.11.0', NOW)).toBe(false);
    write('a.json', '4.9.4', '4.10.0', RECENT_HOOK_NOTICE_MS + 1);
    expect(recentHookNoticeExists(dir, '4.9.4', '4.10.0', NOW)).toBe(false);
    expect(recentHookNoticeExists(tmp(), '4.9.4', '4.10.0', NOW)).toBe(false);
  });
});

describe('updateNoticeForEntryPoint', () => {
  it('mcp: says it once per process, not when a hook just said it, never when snoozed or disabled', () => {
    const dir = tmp();
    cache(dir, '4.10.0');
    const once = new Set<string>();
    const opts = { dir, currentVersion: '4.9.4', now: NOW, entryPoint: 'mcp' as const, processOnce: once };
    expect(updateNoticeForEntryPoint(opts)).toContain('4.10.0 is available');
    expect(updateNoticeForEntryPoint(opts)).toBeNull(); // same process
    // A hook announced it a minute ago: a second process stays quiet.
    const claims = path.join(dir, 'update-prompt-claims'); fs.mkdirSync(claims, { recursive: true });
    fs.writeFileSync(path.join(claims, 'c.json'), JSON.stringify({ currentVersion: '4.9.4', latestVersion: '4.10.0', decision: 'emitted' }));
    const aMinuteAgo = new Date(NOW.getTime() - 60_000);
    fs.utimesSync(path.join(claims, 'c.json'), aMinuteAgo, aMinuteAgo);
    expect(updateNoticeForEntryPoint({ ...opts, processOnce: new Set() })).toBeNull();
    fs.rmSync(claims, { recursive: true });
    fs.writeFileSync(path.join(dir, 'update-snooze.json'), JSON.stringify({ target: '4.10.0', level: 1, since: NOW.toISOString() }));
    expect(updateNoticeForEntryPoint({ ...opts, processOnce: new Set() })).toBeNull();
    fs.rmSync(path.join(dir, 'update-snooze.json'));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ updateCheck: false }));
    expect(updateNoticeForEntryPoint({ ...opts, processOnce: new Set() })).toBeNull();
  });

  it('cli: once a day per version, via a private marker', () => {
    const dir = tmp();
    cache(dir, '4.10.0');
    const opts = { dir, currentVersion: '4.9.4', now: NOW, entryPoint: 'cli' as const };
    expect(updateNoticeForEntryPoint(opts)).toContain('4.10.0 is available');
    expect(updateNoticeForEntryPoint(opts)).toBeNull();
    const marker = path.join(dir, 'last-cli-update-notice.4.9.4.lock');
    expect(fs.existsSync(marker)).toBe(true);
    expect(CLI_NOTICE_THROTTLE_MS).toBe(24 * HOUR);
    fs.rmSync(marker);
    expect(updateNoticeForEntryPoint(opts)).toContain('4.10.0 is available');
  });

  it('claims the just-upgraded receipt so a hook starting later does not repeat it', () => {
    const dir = tmp();
    cache(dir, '4.9.4');
    fs.writeFileSync(path.join(dir, 'just-upgraded.json'), JSON.stringify({ from: '4.9.3', to: '4.9.4', at: NOW.toISOString() }));
    const line = updateNoticeForEntryPoint({ dir, currentVersion: '4.9.4', now: NOW, entryPoint: 'mcp', processOnce: new Set() });
    expect(line).toContain('Upgraded 4.9.3 → 4.9.4');
    expect(fs.existsSync(path.join(dir, 'just-upgraded.json'))).toBe(false);
  });

  it('a failed check is said out loud', () => {
    const dir = tmp();
    cache(dir, null, { lastError: 'ENOTFOUND registry.npmjs.org' });
    expect(updateNoticeForEntryPoint({ dir, currentVersion: '4.9.4', now: NOW, entryPoint: 'mcp', processOnce: new Set() }))
      .toContain('Could not confirm whether an update exists (ENOTFOUND registry.npmjs.org)');
  });
});
