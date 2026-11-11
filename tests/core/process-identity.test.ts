/**
 * When a process started, asked of `ps`: the same answer for the same process whoever asks, in whatever locale and time zone.
 * A record written by a hook that a desktop app started is read by a `memesh update` in a terminal, and by the waiting
 * updater; `lstart` follows the locale and the zone of the caller, so unpinned it made a running session read as a different
 * (finished) one: its registration was deleted and the updater replaced the files under it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearStartTagCache, processStartTag, runRealPsStart, sameProcessAlive, startTagComparable, START_TAG_PREFIX } from '../../src/core/process-identity.js';
import { liveHostPids, registerLiveHost } from '../../src/core/auto-update.js';
import * as generated from '../../scripts/hooks/_generated/process-identity.js';
import { runRealPsStart as hookRunRealPsStart } from '../../scripts/hooks/_claude-channel.js';

const posix = process.platform !== 'win32';
const dirs: string[] = [];
afterEach(() => {
  clearStartTagCache();
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('runRealPsStart', () => {
  it('asks /bin/ps for one pid, in the C locale and UTC whatever the caller has', () => {
    const calls: Array<{ file: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const exec = (file: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => { calls.push({ file, args, env: options.env }); return 'Sun Nov  8 10:00:00 2026\n'; };
    const saved = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL };
    process.env.TZ = 'Asia/Taipei';
    process.env.LC_ALL = 'zh_TW.UTF-8';
    try {
      expect(runRealPsStart(4242, exec)).toBe('Sun Nov  8 10:00:00 2026\n');
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('/bin/ps');
    expect(calls[0].args).toEqual(['-o', 'lstart=', '-p', '4242']);
    expect(calls[0].env).toMatchObject({ TZ: 'UTC', LC_ALL: 'C' });
  });

  it('is the one implementation: the hooks use the generated copy of this module, not a second one', () => {
    expect(String(hookRunRealPsStart)).toBe(String(generated.runRealPsStart));
    expect(String(generated.runRealPsStart)).toContain("'/bin/ps'");
    expect(String(generated.runRealPsStart)).toContain("TZ: 'UTC'");
  });
});

describe('processStartTag', () => {
  it('is the pinned reading with its form written in front, and null when ps says nothing or cannot run (no ps, Windows, a process that is gone)', () => {
    if (!posix) return;
    expect(processStartTag(11, () => 'Sun Nov  8 10:00:00 2026\n')).toBe(`${START_TAG_PREFIX}Sun Nov  8 10:00:00 2026`);
    clearStartTagCache();
    expect(processStartTag(12, () => '  \n')).toBeNull();
    clearStartTagCache();
    expect(processStartTag(13, () => { throw new Error('spawn /bin/ps ENOENT'); })).toBeNull();
    expect(processStartTag(0, () => 'x')).toBeNull();
    expect(processStartTag(-5, () => 'x')).toBeNull();
    expect(processStartTag(1.5, () => 'x')).toBeNull();
  });

  it('is remembered for half a minute and read again after that', () => {
    if (!posix) return;
    let reads = 0;
    let clock = 1_000_000;
    const read = () => { reads += 1; return `read ${reads}`; };
    const first = processStartTag(21, read, () => clock);
    clock += 29_000;
    expect(processStartTag(21, read, () => clock)).toBe(first);
    expect(reads).toBe(1);
    clock += 2_000; // 31 s after the first reading
    expect(processStartTag(21, read, () => clock)).toBe(`${START_TAG_PREFIX}read 2`);
    expect(reads).toBe(2);
  });

  it('a failed reading is remembered too (ps is not asked again for every poll), and forgotten with the cache', () => {
    if (!posix) return;
    let reads = 0;
    const read = () => { reads += 1; throw new Error('no ps'); };
    expect(processStartTag(31, read)).toBeNull();
    expect(processStartTag(31, read)).toBeNull();
    expect(reads).toBe(1);
    clearStartTagCache();
    expect(processStartTag(31, read)).toBeNull();
    expect(reads).toBe(2);
  });

  it.skipIf(!posix)('reads this very process the same way under different locales and time zones (the real ps)', () => {
    const seen = new Set<string | null>();
    const saved = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL, LANG: process.env.LANG };
    try {
      for (const [tz, locale] of [['UTC', 'C'], ['Asia/Taipei', 'zh_TW.UTF-8'], ['America/Los_Angeles', 'de_DE.UTF-8'], ['Pacific/Auckland', 'ja_JP.UTF-8']]) {
        process.env.TZ = tz;
        process.env.LC_ALL = locale;
        process.env.LANG = locale;
        clearStartTagCache();
        seen.add(processStartTag(process.pid));
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    expect([...seen]).toHaveLength(1);
    expect([...seen][0]).toMatch(/^v2:/);
  });
});

describe('sameProcessAlive', () => {
  const alive = () => true;
  const dead = () => false;

  it('a process that is gone is not the host, whatever its start time says', () => {
    expect(sameProcessAlive(5, `${START_TAG_PREFIX}x`, dead)).toBe(false);
    expect(sameProcessAlive(5, null, dead)).toBe(false);
  });

  it('the same start time is the same process; another start time is a reused pid', () => {
    expect(sameProcessAlive(5, `${START_TAG_PREFIX}A`, alive, () => `${START_TAG_PREFIX}A`)).toBe(true);
    expect(sameProcessAlive(5, `${START_TAG_PREFIX}A`, alive, () => `${START_TAG_PREFIX}B`)).toBe(false);
  });

  it('a start time that cannot be read now (no ps) is not evidence that the process is gone', () => {
    expect(sameProcessAlive(5, `${START_TAG_PREFIX}A`, alive, () => null)).toBe(true);
  });

  it('a record from an older build (no pinned form) is judged by the pid alone: its text came from another locale or zone and cannot be compared', () => {
    expect(startTagComparable('Sun Nov  8 10:00:00 2026')).toBe(false);
    expect(startTagComparable('')).toBe(false);
    expect(startTagComparable(null)).toBe(false);
    expect(startTagComparable(`${START_TAG_PREFIX}x`)).toBe(true);
    // alive, and whatever ps reads now differs from the old text: still the host
    expect(sameProcessAlive(5, 'Sun Nov  8 10:00:00 2026', alive, () => `${START_TAG_PREFIX}Sun Nov  8 18:00:00 2026`)).toBe(true);
    // gone: gone
    expect(sameProcessAlive(5, 'Sun Nov  8 10:00:00 2026', dead, () => null)).toBe(false);
  });
});

describe.skipIf(!posix)('the registry of running hosts, written under one locale and zone and read under another', () => {
  function withEnv(tz: string, locale: string, fn: () => void) {
    const saved = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL, LANG: process.env.LANG };
    process.env.TZ = tz;
    process.env.LC_ALL = locale;
    process.env.LANG = locale;
    clearStartTagCache();
    try { fn(); } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      clearStartTagCache();
    }
  }

  it('a running session is still counted, its registration is kept, and nothing is logged as removed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-hosts-env-'));
    dirs.push(dir);
    withEnv('Asia/Taipei', 'zh_TW.UTF-8', () => registerLiveHost(dir, process.pid));
    withEnv('America/Los_Angeles', 'de_DE.UTF-8', () => {
      expect(liveHostPids(dir)).toEqual([process.pid]);
    });
    expect(fs.existsSync(path.join(dir, 'live-hosts', `${process.pid}.json`))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'auto-update.log'))).toBe(false);
  });

  it('a host that is judged gone is logged, with its pid, when its registration is removed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-hosts-gone-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'live-hosts'));
    fs.writeFileSync(path.join(dir, 'live-hosts', '2147483000.json'), JSON.stringify({ pid: 2147483000, started: `${START_TAG_PREFIX}Sun Nov  8 10:00:00 2026` }));
    expect(liveHostPids(dir)).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'live-hosts', '2147483000.json'))).toBe(false);
    const log = fs.readFileSync(path.join(dir, 'auto-update.log'), 'utf8');
    expect(log).toContain('host pid 2147483000 is no longer running');
    expect(log).toContain('registration was removed');
  });

  it('a registration written by an older build (no pinned form) of a running process is kept', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-hosts-legacy-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'live-hosts'));
    fs.writeFileSync(path.join(dir, 'live-hosts', `${process.pid}.json`), JSON.stringify({ pid: process.pid, started: 'Sat Jan  1 00:00:00 2000' }));
    expect(liveHostPids(dir)).toEqual([process.pid]);
    expect(fs.existsSync(path.join(dir, 'live-hosts', `${process.pid}.json`))).toBe(true);
  });
});
