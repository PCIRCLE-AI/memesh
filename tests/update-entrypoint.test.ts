import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLI_NOTICE_THROTTLE_MS,
  MCP_PENDING_RETRY_MS,
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
      .toBe('[memesh update] 4.10.0 is available (you are on 4.9.4). Run `memesh update` to install it now.');
    expect(formatUpdateNoticeLine({ kind: 'JUST_UPGRADED', currentVersion: '4.9.4', from: '4.9.3', to: '4.9.4' }))
      .toBe('[memesh update] Upgraded 4.9.3 → 4.9.4. Processes started before the upgrade keep running 4.9.3 until they restart.');
    expect(formatUpdateNoticeLine({ kind: 'CHECK_FAILED', currentVersion: '4.9.4', reason: 'ENOTFOUND', attempted: true }))
      .toBe('[memesh update] Could not confirm whether an update exists (ENOTFOUND). Status is unknown, not current — `memesh status` retries.');
    expect(formatUpdateNoticeLine({ kind: 'UP_TO_DATE', currentVersion: '4.9.4', latestVersion: '4.9.4' })).toBeNull();
    expect(formatUpdateNoticeLine({ kind: 'DISABLED', currentVersion: '4.9.4' })).toBeNull();
  });
});

describe('the upgrade line says what is true for this setting, this install method and this reader', () => {
  const up = { kind: 'UPGRADE_AVAILABLE', currentVersion: '4.9.4', latestVersion: '4.10.0' } as const;

  it('off: it is available and is not being installed; nobody is told to run the update', () => {
    const forModel = formatUpdateNoticeLine(up, { updates: 'off', door: 'mcp' })!;
    expect(forModel).toContain('4.10.0 is available');
    expect(forModel).toContain('Automatic updates are off');
    expect(forModel).toContain('Do not update on your own');
    expect(forModel).not.toContain('`memesh update`');
    // A person may be told how to install it when they choose to; it is not an order.
    const forPerson = formatUpdateNoticeLine(up, { updates: 'off', door: 'cli' })!;
    expect(forPerson).toContain('Automatic updates are off');
    expect(forPerson).not.toContain('to install it now');
  });

  it('on, read by a model through the MCP tool result: no command to run, and it says the update comes by itself', () => {
    const line = formatUpdateNoticeLine(up, { updates: 'on', door: 'mcp' })!;
    expect(line).toContain('installed by itself after the running sessions end');
    expect(line).not.toContain('Run');
    expect(line).not.toContain('memesh update`');
  });

  it('on, read by a person at a terminal: the command may be given', () => {
    expect(formatUpdateNoticeLine(up, { updates: 'on', door: 'cli' })).toContain('Run `memesh update` to install it now.');
    expect(formatUpdateNoticeLine(up)).toContain('Run `memesh update` to install it now.');
  });

  it('an install method that cannot update itself: say so with its own guidance, and never the command that would fail', () => {
    const line = formatUpdateNoticeLine(up, { updates: 'unsupported', guidance: 'Update this source checkout from its repository and rebuild it.' })!;
    expect(line).toContain('MeMesh cannot install it for this install method');
    expect(line).toContain('rebuild it');
    expect(line).not.toContain('memesh update`');
  });

  it('the other kinds do not depend on any of it', () => {
    const failed = { kind: 'CHECK_FAILED', currentVersion: '4.9.4', reason: 'ENOTFOUND', attempted: true } as const;
    expect(formatUpdateNoticeLine(failed, { updates: 'off', door: 'cli' })).toBe(formatUpdateNoticeLine(failed));
  });

  it('the real entry point reads the setting and the install method', () => {
    const saved = process.env.MEMESH_AUTO_UPDATE;
    const run = (setting: string, entryPoint: 'mcp' | 'cli', installSupport?: { canSelfUpdate: boolean; guidance: string } | null) => {
      process.env.MEMESH_AUTO_UPDATE = setting;
      const dir = tmp();
      try {
        cache(dir, '4.10.0');
        return updateNoticeForEntryPoint({ dir, currentVersion: '4.9.4', now: NOW, entryPoint, processOnce: new Set<string>(), refresh: () => false, ...(installSupport !== undefined ? { installSupport } : {}) });
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    };
    try {
      const supported = { canSelfUpdate: true, guidance: '' };
      expect(run('off', 'mcp', supported)).toContain('Automatic updates are off');
      expect(run('off', 'mcp', supported)).not.toContain('memesh update`');
      expect(run('major', 'mcp', supported)).toContain('installed by itself');
      expect(run('major', 'mcp', supported)).not.toContain('Run `memesh update`');
      expect(run('major', 'cli', supported)).toContain('Run `memesh update` to install it now');
      expect(run('major', 'mcp', { canSelfUpdate: false, guidance: 'Update this source checkout from its repository and rebuild it.' })).toContain('cannot install it for this install method');
    } finally {
      if (saved === undefined) delete process.env.MEMESH_AUTO_UPDATE; else process.env.MEMESH_AUTO_UPDATE = saved;
    }
  });
});

describe('the notice follows the setting: a release the setting does not take is not announced as coming by itself', () => {
  const saved = process.env.MEMESH_AUTO_UPDATE;
  const supported = { canSelfUpdate: true, guidance: '' };
  const say = (setting: string, entryPoint: 'mcp' | 'cli', latest: string, installSupport: { canSelfUpdate: boolean; guidance: string } | null | undefined = supported) => {
    process.env.MEMESH_AUTO_UPDATE = setting;
    const dir = tmp();
    try {
      cache(dir, latest);
      return updateNoticeForEntryPoint({ dir, currentVersion: '4.9.4', now: NOW, entryPoint, processOnce: new Set<string>(), refresh: () => false, ...(installSupport !== undefined ? { installSupport } : {}) });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      if (saved === undefined) delete process.env.MEMESH_AUTO_UPDATE; else process.env.MEMESH_AUTO_UPDATE = saved;
    }
  };

  it('patch: 4.9.5 (patch) installs by itself; 4.10.0 (minor) and 5.0.0 (major) are held, and say which setting holds them', () => {
    expect(say('patch', 'mcp', '4.9.5')).toContain('installed by itself');
    const minor = say('patch', 'mcp', '4.10.0')!;
    expect(minor).toContain('autoUpdate: patch does not install this release by itself');
    expect(minor).not.toContain('installed by itself after');
    expect(minor).toContain('Do not update on your own');
    expect(say('patch', 'mcp', '5.0.0')).toContain('autoUpdate: patch does not install this release');
    expect(say('patch', 'cli', '4.10.0')).toContain('`memesh update` installs it when you choose to');
  });

  it('minor: 4.10.0 installs by itself, 5.0.0 is held', () => {
    expect(say('minor', 'mcp', '4.10.0')).toContain('installed by itself');
    expect(say('minor', 'mcp', '5.0.0')).toContain('autoUpdate: minor does not install this release');
  });

  it('off on an install that cannot update itself says both, and does not offer the command that would refuse', () => {
    const line = say('off', 'cli', '4.10.0', { canSelfUpdate: false, guidance: 'Update this source checkout and rebuild it.' })!;
    expect(line).toContain('Automatic updates are off');
    expect(line).toContain('cannot install it for this install method');
    expect(line).toContain('rebuild it');
    expect(line).not.toContain('`memesh update`');
  });

  it('an install that cannot update itself, read by a model: no command and no guidance to follow; the person is to be told', () => {
    const line = say('major', 'mcp', '4.10.0', { canSelfUpdate: false, guidance: 'Run `npm i -g memesh` yourself.' })!;
    expect(line).toContain('Do not update on your own');
    expect(line).not.toContain('npm i -g');
  });

  it('a setting that cannot be read counts as off (the owner may have said off in a file nobody can read)', () => {
    const savedDb = process.env.MEMESH_DB_PATH;
    const data = tmp();
    fs.mkdirSync(path.join(data, 'config.json')); // a directory where the config belongs: unreadable
    process.env.MEMESH_DB_PATH = path.join(data, 'knowledge-graph.db');
    delete process.env.MEMESH_AUTO_UPDATE;
    const dir = tmp();
    try {
      cache(dir, '4.10.0');
      const line = updateNoticeForEntryPoint({ dir, currentVersion: '4.9.4', now: NOW, entryPoint: 'mcp', processOnce: new Set<string>(), refresh: () => false, installSupport: supported });
      expect(line).toContain('Automatic updates are off');
      expect(line).not.toContain('installed by itself');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(data, { recursive: true, force: true });
      if (savedDb === undefined) delete process.env.MEMESH_DB_PATH; else process.env.MEMESH_DB_PATH = savedDb;
      if (saved === undefined) delete process.env.MEMESH_AUTO_UPDATE; else process.env.MEMESH_AUTO_UPDATE = saved;
    }
  });

  it('with no installSupport given, the package root is looked up the same way as the CLI does and the notice still comes out', () => {
    const line = say('major', 'cli', '4.10.0', undefined);
    expect(line).toContain('4.10.0 is available');
  });
});

describe('recentHookNoticeExists', () => {
  it.each(['pending', 'failed', undefined, null, 7])('does not treat an unannounced claim (%s) as a delivered MCP notice', decision => {
    const dir = tmp();
    try {
      cache(dir, '4.10.0');
      const claims = path.join(dir, 'update-prompt-claims');
      fs.mkdirSync(claims);
      const file = path.join(claims, 'unannounced.json');
      fs.writeFileSync(file, JSON.stringify({ currentVersion: '4.9.4', latestVersion: '4.10.0', decision }));
      fs.utimesSync(file, NOW, NOW);
      const before = fs.readFileSync(file);
      expect(recentHookNoticeExists(dir, '4.9.4', '4.10.0', NOW)).toBe(false);
      const opts = { dir, currentVersion: '4.9.4', now: NOW, entryPoint: 'mcp' as const, processOnce: new Set<string>(), refresh: () => false };
      expect(updateNoticeForEntryPoint(opts)).toContain('4.10.0 is available');
      expect(updateNoticeForEntryPoint(opts)).toBeNull();
      expect(fs.readFileSync(file)).toEqual(before);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

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
    // null = "any notice for this installed version" (used for CHECK_FAILED).
    expect(recentHookNoticeExists(dir, '4.9.4', null, NOW)).toBe(true);
    expect(recentHookNoticeExists(dir, '4.9.3', null, NOW)).toBe(false);
    write('a.json', '4.9.4', '4.10.0', RECENT_HOOK_NOTICE_MS + 1);
    expect(recentHookNoticeExists(dir, '4.9.4', '4.10.0', NOW)).toBe(false);
    expect(recentHookNoticeExists(tmp(), '4.9.4', '4.10.0', NOW)).toBe(false);
  });
});

describe('updateNoticeForEntryPoint', () => {
  it('mcp: says it once per process, not when a hook just said it, never when updates are off', () => {
    const dir = tmp();
    cache(dir, '4.10.0');
    const once = new Set<string>();
    const opts = { dir, currentVersion: '4.9.4', now: NOW, entryPoint: 'mcp' as const, processOnce: once, refresh: () => false };
    expect(updateNoticeForEntryPoint(opts)).toContain('4.10.0 is available');
    expect(updateNoticeForEntryPoint(opts)).toBeNull(); // same process
    // A hook announced it a minute ago: a second process stays quiet.
    const claims = path.join(dir, 'update-prompt-claims'); fs.mkdirSync(claims, { recursive: true });
    fs.writeFileSync(path.join(claims, 'c.json'), JSON.stringify({ currentVersion: '4.9.4', latestVersion: '4.10.0', decision: 'emitted' }));
    const aMinuteAgo = new Date(NOW.getTime() - 60_000);
    fs.utimesSync(path.join(claims, 'c.json'), aMinuteAgo, aMinuteAgo);
    expect(updateNoticeForEntryPoint({ ...opts, processOnce: new Set() })).toBeNull();
    fs.rmSync(claims, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ updateCheck: false }));
    expect(updateNoticeForEntryPoint({ ...opts, processOnce: new Set() })).toBeNull();
  });

  it('cli: once a day per version, via a private marker', () => {
    const dir = tmp();
    cache(dir, '4.10.0');
    const opts = { dir, currentVersion: '4.9.4', now: NOW, entryPoint: 'cli' as const, refresh: () => false };
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
    const line = updateNoticeForEntryPoint({ dir, currentVersion: '4.9.4', now: NOW, entryPoint: 'mcp', processOnce: new Set(), refresh: () => false });
    expect(line).toContain('Upgraded 4.9.3 → 4.9.4');
    expect(fs.existsSync(path.join(dir, 'just-upgraded.json'))).toBe(false);
  });

  it('a failed check is said out loud — but a check that never ran is not', () => {
    const dir = tmp();
    cache(dir, null, { lastError: 'ENOTFOUND registry.npmjs.org' });
    expect(updateNoticeForEntryPoint({ dir, currentVersion: '4.9.4', now: NOW, entryPoint: 'mcp', processOnce: new Set(), refresh: () => false }))
      .toContain('Could not confirm whether an update exists (ENOTFOUND registry.npmjs.org)');
    // Fresh install, hook-less host: no cache at all. Saying "could not
    // confirm" here would be a permanent false alarm; instead stay quiet and
    // start the refresh so the NEXT call has an answer.
    const fresh = tmp();
    const refreshed: string[] = [];
    expect(updateNoticeForEntryPoint({ dir: fresh, currentVersion: '4.9.4', now: NOW, entryPoint: 'mcp', processOnce: new Set(), refresh: (d) => { refreshed.push(d); return true; } }))
      .toBeNull();
    expect(refreshed).toEqual([fresh]);
  });

  it('a stale answer triggers the refresh; a fresh one does not', () => {
    const dir = tmp();
    const calls: number[] = [];
    const refresh = () => { calls.push(1); return true; };
    cache(dir, '4.9.4'); // 1h old: within the 1h up-to-date TTL? exactly at the edge → treat as fresh
    updateNoticeForEntryPoint({ dir, currentVersion: '4.9.4', now: new Date(NOW.getTime() - 30 * 60 * 1000), entryPoint: 'cli', refresh });
    expect(calls).toHaveLength(0);
    updateNoticeForEntryPoint({ dir, currentVersion: '4.9.4', now: new Date(NOW.getTime() + 2 * HOUR), entryPoint: 'cli', refresh });
    expect(calls).toHaveLength(1);
  });

  it('a CHECK_FAILED that a hook just announced is not repeated by the MCP door', () => {
    const dir = tmp();
    cache(dir, null, { lastError: 'ETIMEDOUT' });
    const claims = path.join(dir, 'update-prompt-claims'); fs.mkdirSync(claims, { recursive: true });
    const claim = path.join(claims, 'c.json');
    fs.writeFileSync(claim, JSON.stringify({ currentVersion: '4.9.4', latestVersion: null, decision: 'emitted' }));
    const aMinuteAgo = new Date(NOW.getTime() - 60_000);
    fs.utimesSync(claim, aMinuteAgo, aMinuteAgo);
    expect(updateNoticeForEntryPoint({ dir, currentVersion: '4.9.4', now: NOW, entryPoint: 'mcp', processOnce: new Set(), refresh: () => false })).toBeNull();
  });

  it('mcp: a first call with no answer yet does not spend the notice; the same process reports the refresh result after a minute', () => {
    const fresh = tmp();
    const once = new Set<string>();
    const refreshed: number[] = [];
    const opts = { dir: fresh, currentVersion: '4.9.4', entryPoint: 'mcp' as const, processOnce: once, refresh: () => { refreshed.push(1); return true; } };
    expect(updateNoticeForEntryPoint({ ...opts, now: NOW })).toBeNull();
    expect(once.has('4.9.4')).toBe(false); // undecided, not spent
    // Within the minute: no file reads, no second spawn, still quiet.
    cache(fresh, '4.10.0');
    expect(updateNoticeForEntryPoint({ ...opts, now: new Date(NOW.getTime() + MCP_PENDING_RETRY_MS - 1) })).toBeNull();
    expect(refreshed).toHaveLength(1);
    // After the minute the refreshed answer is read and said — by THIS process.
    expect(updateNoticeForEntryPoint({ ...opts, now: new Date(NOW.getTime() + MCP_PENDING_RETRY_MS) })).toContain('4.10.0 is available');
    expect(once.has('4.9.4')).toBe(true);
    expect(updateNoticeForEntryPoint({ ...opts, now: new Date(NOW.getTime() + MCP_PENDING_RETRY_MS + 1) })).toBeNull();
  });

  it('mcp: the per-process memo is taken as soon as there is a decision, even when up to date', () => {
    const dir = tmp();
    cache(dir, '4.9.4');
    const once = new Set<string>();
    expect(updateNoticeForEntryPoint({ dir, currentVersion: '4.9.4', now: NOW, entryPoint: 'mcp', processOnce: once, refresh: () => false })).toBeNull();
    expect(once.has('4.9.4')).toBe(true);
    // State changes later in the same process: still silent — the door speaks once per process.
    cache(dir, '4.10.0');
    expect(updateNoticeForEntryPoint({ dir, currentVersion: '4.9.4', now: NOW, entryPoint: 'mcp', processOnce: once, refresh: () => false })).toBeNull();
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('cli: a marker that cannot be rewritten throttles for good, even once it has expired', () => {
    const dir = tmp();
    cache(dir, '4.10.0');
    const opts = { dir, currentVersion: '4.9.4', now: NOW, entryPoint: 'cli' as const, refresh: () => false };
    expect(updateNoticeForEntryPoint(opts)).toContain('4.10.0 is available');
    const marker = path.join(dir, 'last-cli-update-notice.4.9.4.lock');
    fs.utimesSync(marker, NOW, NOW);
    fs.chmodSync(marker, 0o444);
    expect(updateNoticeForEntryPoint(opts)).toBeNull();
    expect(updateNoticeForEntryPoint(opts)).toBeNull();
    // Expired but unwritable: printing would repeat on every command.
    expect(updateNoticeForEntryPoint({ ...opts, now: new Date(NOW.getTime() + CLI_NOTICE_THROTTLE_MS + HOUR) })).toBeNull();
    fs.chmodSync(marker, 0o600);
  });
});
