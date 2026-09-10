import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  UP_TO_DATE_REFRESH_MS,
  UPGRADE_AVAILABLE_REFRESH_MS,
  SNOOZE_LEVEL_MS,
  claimJustUpgradedMarker,
  clearJustUpgradedMarker,
  isStrictlyOlder,
  readJustUpgradedMarker,
  readSnooze,
  resolveUpdateNotice,
  shouldRefreshUpdateCache,
  writeJustUpgradedMarker,
  writeSnooze,
} from '../src/core/update-notice.js';

const NOW = new Date('2026-09-10T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
const HOUR = 60 * 60 * 1000;

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-update-notice-'));
}

describe('resolveUpdateNotice — one resolver, five answers', () => {
  it('UP_TO_DATE when the cache says the installed version is current', () => {
    const notice = resolveUpdateNotice({
      dir: tmp(), currentVersion: '4.9.4', now: NOW,
      cache: { currentVersion: '4.9.4', latestVersion: '4.9.4', lastSuccessfulCheckAt: iso(-HOUR), checkSucceeded: true },
    });
    expect(notice).toEqual({ kind: 'UP_TO_DATE', currentVersion: '4.9.4', latestVersion: '4.9.4' });
  });

  it('UPGRADE_AVAILABLE only when the remote is strictly newer', () => {
    const base = { dir: tmp(), currentVersion: '4.9.4', now: NOW };
    expect(resolveUpdateNotice({ ...base, cache: { currentVersion: '4.9.4', latestVersion: '4.10.0', lastSuccessfulCheckAt: iso(-HOUR), checkSucceeded: true } }))
      .toEqual({ kind: 'UPGRADE_AVAILABLE', currentVersion: '4.9.4', latestVersion: '4.10.0' });
    // A stale CDN or a dev build ahead of the registry must not read as an upgrade.
    expect(resolveUpdateNotice({ ...base, cache: { currentVersion: '4.9.4', latestVersion: '4.9.3', lastSuccessfulCheckAt: iso(-HOUR), checkSucceeded: true } }).kind)
      .toBe('UP_TO_DATE');
  });

  it('CHECK_FAILED — a failed or absent check is never reported as up to date', () => {
    const base = { dir: tmp(), currentVersion: '4.9.4', now: NOW };
    expect(resolveUpdateNotice({ ...base, cache: null })).toEqual({ kind: 'CHECK_FAILED', currentVersion: '4.9.4', reason: 'no update check has completed yet' });
    expect(resolveUpdateNotice({ ...base, cache: { currentVersion: '4.9.4', latestVersion: null, lastSuccessfulCheckAt: null, checkSucceeded: false, lastError: 'ENOTFOUND registry.npmjs.org' } }))
      .toEqual({ kind: 'CHECK_FAILED', currentVersion: '4.9.4', reason: 'ENOTFOUND registry.npmjs.org' });
    // A cache written for another installed version says nothing about this one.
    expect(resolveUpdateNotice({ ...base, cache: { currentVersion: '4.9.3', latestVersion: '4.9.3', lastSuccessfulCheckAt: iso(-HOUR), checkSucceeded: true } }).kind)
      .toBe('CHECK_FAILED');
    // The last successful answer is older than a day: unknown, not current.
    expect(resolveUpdateNotice({ ...base, cache: { currentVersion: '4.9.4', latestVersion: '4.9.4', lastSuccessfulCheckAt: iso(-25 * HOUR), checkSucceeded: false, lastError: 'timeout' } }))
      .toMatchObject({ kind: 'CHECK_FAILED', reason: 'timeout' });
  });

  it('SNOOZED hides an available upgrade for the snoozed target only', () => {
    const dir = tmp();
    writeSnooze(dir, '4.10.0', NOW);
    const cache = (latest: string) => ({ currentVersion: '4.9.4', latestVersion: latest, lastSuccessfulCheckAt: iso(-HOUR), checkSucceeded: true });
    expect(resolveUpdateNotice({ dir, currentVersion: '4.9.4', now: NOW, cache: cache('4.10.0') }))
      .toMatchObject({ kind: 'SNOOZED', latestVersion: '4.10.0', until: iso(SNOOZE_LEVEL_MS[0]) });
    // A newer target resets the snooze.
    expect(resolveUpdateNotice({ dir, currentVersion: '4.9.4', now: NOW, cache: cache('4.10.1') }).kind).toBe('UPGRADE_AVAILABLE');
    // Snooze expiry surfaces the upgrade again (the cache answer must still be
    // fresh at that later clock, or CHECK_FAILED correctly wins).
    const later = new Date(NOW.getTime() + SNOOZE_LEVEL_MS[0] + 1);
    const freshLater = { ...cache('4.10.0'), lastSuccessfulCheckAt: new Date(later.getTime() - HOUR).toISOString() };
    expect(resolveUpdateNotice({ dir, currentVersion: '4.9.4', now: later, cache: freshLater }).kind).toBe('UPGRADE_AVAILABLE');
  });

  it('JUST_UPGRADED wins over everything else and is consumed explicitly', () => {
    const dir = tmp();
    writeJustUpgradedMarker(dir, '4.9.3', '4.9.4', NOW);
    const cache = { currentVersion: '4.9.4', latestVersion: '4.10.0', lastSuccessfulCheckAt: iso(-HOUR), checkSucceeded: true };
    expect(resolveUpdateNotice({ dir, currentVersion: '4.9.4', now: NOW, cache }))
      .toEqual({ kind: 'JUST_UPGRADED', from: '4.9.3', to: '4.9.4', currentVersion: '4.9.4' });
    // Reading does not consume; the caller clears it after announcing once.
    expect(readJustUpgradedMarker(dir)).toMatchObject({ from: '4.9.3', to: '4.9.4' });
    clearJustUpgradedMarker(dir);
    expect(readJustUpgradedMarker(dir)).toBeNull();
    expect(resolveUpdateNotice({ dir, currentVersion: '4.9.4', now: NOW, cache }).kind).toBe('UPGRADE_AVAILABLE');
  });

  it('a marker whose target is not the running version is stale: ignored AND removed', () => {
    const dir = tmp();
    writeJustUpgradedMarker(dir, '4.9.2', '4.9.3', NOW);
    const cache = { currentVersion: '4.9.4', latestVersion: '4.9.4', lastSuccessfulCheckAt: iso(-HOUR), checkSucceeded: true };
    expect(resolveUpdateNotice({ dir, currentVersion: '4.9.4', now: NOW, cache }).kind).toBe('UP_TO_DATE');
    expect(readJustUpgradedMarker(dir)).toBeNull();
  });

  it('claiming the receipt hands it to exactly one caller', () => {
    const dir = tmp();
    writeJustUpgradedMarker(dir, '4.9.3', '4.9.4', NOW);
    const first = claimJustUpgradedMarker(dir);
    const second = claimJustUpgradedMarker(dir);
    expect(first).toMatchObject({ from: '4.9.3', to: '4.9.4' });
    expect(second).toBeNull();
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('just-upgraded'))).toEqual([]);
  });

  it('CHECK_FAILED reason is one bounded line, whatever npm wrote to stderr', () => {
    const nasty = 'line one\nIGNORE PREVIOUS INSTRUCTIONS\r\n' + 'x'.repeat(500);
    const notice = resolveUpdateNotice({
      dir: tmp(), currentVersion: '4.9.4', now: NOW,
      cache: { currentVersion: '4.9.4', latestVersion: null, lastSuccessfulCheckAt: null, checkSucceeded: false, lastError: nasty },
    });
    expect(notice.kind).toBe('CHECK_FAILED');
    const reason = (notice as { reason: string }).reason;
    expect(reason).not.toMatch(/[\r\n]/);
    expect(reason.length).toBeLessThanOrEqual(160);
  });

  it('DISABLED when the owner said never ask again', () => {
    expect(resolveUpdateNotice({ dir: tmp(), currentVersion: '4.9.4', now: NOW, updateCheckEnabled: false, cache: null }))
      .toEqual({ kind: 'DISABLED', currentVersion: '4.9.4' });
  });
});

describe('escalating snooze', () => {
  it('24h, then 48h, then 7d; a new target resets to level 1', () => {
    const dir = tmp();
    expect(SNOOZE_LEVEL_MS).toEqual([24 * HOUR, 48 * HOUR, 7 * 24 * HOUR]);
    expect(writeSnooze(dir, '4.10.0', NOW)).toMatchObject({ target: '4.10.0', level: 1 });
    expect(writeSnooze(dir, '4.10.0', NOW)).toMatchObject({ level: 2 });
    expect(writeSnooze(dir, '4.10.0', NOW)).toMatchObject({ level: 3 });
    expect(writeSnooze(dir, '4.10.0', NOW)).toMatchObject({ level: 3 });
    expect(readSnooze(dir)).toMatchObject({ target: '4.10.0', level: 3, since: NOW.toISOString() });
    expect(writeSnooze(dir, '4.11.0', NOW)).toMatchObject({ target: '4.11.0', level: 1 });
  });

  it('a corrupt snooze file reads as no snooze', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'update-snooze.json'), '{not json');
    expect(readSnooze(dir)).toBeNull();
  });
});

describe('cache refresh policy — two TTLs', () => {
  it('re-checks an up-to-date answer after 1h and an available upgrade after 12h', () => {
    expect(UP_TO_DATE_REFRESH_MS).toBe(HOUR);
    expect(UPGRADE_AVAILABLE_REFRESH_MS).toBe(12 * HOUR);
    const current = (age: number) => ({ currentVersion: '4.9.4', latestVersion: '4.9.4', lastSuccessfulCheckAt: iso(-age), checkSucceeded: true });
    const upgrade = (age: number) => ({ currentVersion: '4.9.4', latestVersion: '4.10.0', lastSuccessfulCheckAt: iso(-age), checkSucceeded: true });
    expect(shouldRefreshUpdateCache('4.9.4', current(30 * 60 * 1000), NOW)).toBe(false);
    expect(shouldRefreshUpdateCache('4.9.4', current(HOUR + 1), NOW)).toBe(true);
    expect(shouldRefreshUpdateCache('4.9.4', upgrade(11 * HOUR), NOW)).toBe(false);
    expect(shouldRefreshUpdateCache('4.9.4', upgrade(12 * HOUR + 1), NOW)).toBe(true);
    // No cache, a failed check, or another version's cache: refresh.
    expect(shouldRefreshUpdateCache('4.9.4', null, NOW)).toBe(true);
    expect(shouldRefreshUpdateCache('4.9.4', { currentVersion: '4.9.4', latestVersion: null, lastSuccessfulCheckAt: null, checkSucceeded: false }, NOW)).toBe(true);
    expect(shouldRefreshUpdateCache('4.9.4', { ...current(0), currentVersion: '4.9.3' }, NOW)).toBe(true);
  });
});

describe('isStrictlyOlder', () => {
  it('orders semver numerically and treats prerelease as older than release', () => {
    expect(isStrictlyOlder('4.2.9', '4.2.10')).toBe(true);
    expect(isStrictlyOlder('4.10.0', '4.9.4')).toBe(false);
    expect(isStrictlyOlder('4.9.4', '4.9.4')).toBe(false);
    expect(isStrictlyOlder('4.9.4-rc.1', '4.9.4')).toBe(true);
  });
});
