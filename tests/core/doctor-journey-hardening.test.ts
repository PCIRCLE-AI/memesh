/**
 * The install journey's edges: what it promises about `~/.memesh`, an unusable
 * temp folder, a step that will not die, Ctrl-C, Windows' environment, and when
 * `setup` runs it. The happy path and the per-step failures are in
 * doctor-journey.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import * as journey from '../../src/core/doctor-journey.js';
import { CITATION_RULE_BODY } from '../../src/core/citation-rule.js';
import { buildIsolatedSuiteEnv } from '../../scripts/lib/isolated-env.mjs';
import crypto from 'crypto';

const PACKAGE_ROOT = path.resolve('.');
const REAL_CLI = path.join(PACKAGE_ROOT, 'dist/transports/cli/cli.js');
const POSIX = process.platform !== 'win32';
const NOT_ROOT = POSIX && typeof process.getuid === 'function' && process.getuid() !== 0;

let work: string;
let privateTmp: string;
let savedEnv: Record<string, string | undefined>;
let hostConfig: { claude: string; codex: string };
const SKIP_VAR = 'MEMESH_SKIP_POST_INSTALL_JOURNEY';
const cleanups: Array<() => void> = [];

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-journey-test-'));
  privateTmp = path.join(work, 'tmp');
  fs.mkdirSync(privateTmp);
  // Host config folders set to empty folders: a child that writes a host's hooks into them has leaked.
  hostConfig = { claude: path.join(work, 'host-claude'), codex: path.join(work, 'host-codex') };
  fs.mkdirSync(hostConfig.claude);
  fs.mkdirSync(hostConfig.codex);
  savedEnv = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP, MEMESH_DIR: process.env.MEMESH_DIR, MEMESH_DB_PATH: process.env.MEMESH_DB_PATH, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME, [SKIP_VAR]: process.env[SKIP_VAR] };
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = privateTmp;
  process.env.CLAUDE_CONFIG_DIR = hostConfig.claude;
  process.env.CODEX_HOME = hostConfig.codex;
  delete process.env[SKIP_VAR];
  // An outside MEMESH_DB_PATH/MEMESH_DIR would send record reads and writes at someone's real data.
  delete process.env.MEMESH_DIR;
  delete process.env.MEMESH_DB_PATH;
});
afterEach(() => {
  // Each cleanup on its own: one that throws must not stop the ones after it (environment restore, folder removal, the leak check).
  const cleanupFailures: unknown[] = [];
  while (cleanups.length) {
    try { cleanups.pop()!(); } catch (error) { cleanupFailures.push(error); }
  }
  const leaked = [...fs.readdirSync(hostConfig.claude), ...fs.readdirSync(hostConfig.codex)];
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  vi.restoreAllMocks();
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  expect(leaked, 'a test wrote into a host config folder').toEqual([]);
  expect(cleanupFailures, 'a cleanup failed').toEqual([]);
});

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
};
const waitFor = async (check: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return check();
};
/** undefined = not written yet. An empty file is an error, never a pid of 0 (kill(0) would signal our own group). */
const readPid = (file: string): number | undefined => {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return undefined; }
  if (text.trim() === '') throw new Error(`${file} is empty`);
  return Number(text);
};
/** Kill the process whose pid a step wrote down; an absent, empty or stale file is not an error. */
const killPidFile = (file: string): void => {
  try { const pid = readPid(file); if (pid) process.kill(pid, 'SIGKILL'); } catch { /* absent, empty or already gone */ }
};
const pidWritten = (file: string): boolean => fs.existsSync(file) && fs.statSync(file).size > 0;

/** A CLI entry that runs `behaviour` for one subcommand and is the real CLI otherwise. */
function entryFor(match: string[], behaviour: string): string {
  const file = path.join(work, `entry-${match.join('-')}-${Math.random().toString(36).slice(2, 6)}.mjs`);
  fs.writeFileSync(file, `
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const argv = process.argv.slice(2);
if (${JSON.stringify(match)}.every((word, i) => argv[i] === word)) { ${behaviour} }
const { spawnSync } = await import('node:child_process');
const r = spawnSync(process.execPath, [${JSON.stringify(REAL_CLI)}, ...argv], { stdio: 'inherit', env: process.env });
process.exit(r.status ?? 1);
`);
  return file;
}
const HANG = `await new Promise(() => setInterval(() => {}, 1000));`;

/** The environment of a CLI child: the throwaway HOME, and nothing that relocates data or a host's config unless `extra` says so. */
const cliEnv = (home: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of ['MEMESH_DIR', 'MEMESH_DB_PATH', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', SKIP_VAR]) delete env[key];
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k]; else env[k] = v;
  return env;
};

/** A folder whose only program is node: on an nvm machine node's own folder also holds codex and claude. */
const nodeOnlyPath = (): string => {
  const bin = path.join(work, 'node-only-bin');
  fs.mkdirSync(bin, { recursive: true });
  const link = path.join(bin, 'node');
  if (!fs.existsSync(link)) fs.symlinkSync(process.execPath, link);
  return bin;
};

/** The part of the changelog that holds the journey entry, whichever heading it is under (Unreleased now, a version after the release). */
function journeySection(changelog: string): string {
  const sections = changelog.split(/^## \[/m);
  return sections.find((section) => section.includes('`memesh doctor --journey`')) ?? '';
}
const flat = (text: string): string => text.replace(/\s+/g, ' ');

describe('what the journey says about ~/.memesh and about itself is true', () => {
  const read = (file: string) => fs.readFileSync(path.join(PACKAGE_ROOT, file), 'utf8');
  const apiSection = () => {
    const api = read('docs/api/API_REFERENCE.md');
    return api.slice(api.indexOf('### memesh doctor --journey'), api.indexOf('### memesh config'));
  };

  it('the screen says the memory database is untouched and that live delivery is not checked', () => {
    const passed: journey.JourneyResult = {
      ok: true, timedOut: false, elapsedMs: 500, scratchDir: '', cleaned: true,
      steps: (['remember', 'recall', 'send', 'fetch'] as const).map((id) => ({ id, did: id, ok: true, result: 'ok', ms: 1 })),
    };
    const text = journey.formatJourney(passed).join('\n');
    expect(text).not.toMatch(/~\/\.memesh is not touched/);
    expect(text).toContain('memory database is not touched');
    expect(text).toMatch(/Live delivery to a running agent is not checked/);
  });

  it('the help says it reads the saved result and never opens the memory database', () => {
    const help = flat(spawnSync(process.execPath, [REAL_CLI, 'doctor', '--help'], { encoding: 'utf8', timeout: 60_000 }).stdout);
    expect(help).not.toContain('Never opens ~/.memesh');
    expect(help).toContain('Never opens your memory database');
    expect(help).toContain('reads the saved journey result');
    expect(help).not.toContain('the only file in ~/.memesh it touches');
  });

  it('the changelog entry says so, under whichever heading it sits', () => {
    const changelog = read('CHANGELOG.md');
    const section = journeySection(changelog);
    expect(section).not.toBe('');
    expect(section).not.toContain('Your `~/.memesh` is never opened');
    expect(section).toContain('memory database is never opened');
    expect(section).toContain('reads');
    expect(section).not.toContain('the installed `memesh` command');
    // After a release the Unreleased heading becomes a version: the test must still find the entry.
    expect(journeySection(changelog.replace('## [Unreleased]', '## [4.14.0] — 2026-11-10'))).toContain('memory database is never opened');
  });

  it('the API reference agrees: reads first, writes only a valid existing record, stops what it can reach, says what it cannot', () => {
    const section = flat(apiSection());
    expect(section).toContain('Your memory database is never opened');
    // Only a manual run reads the record first; an automatic run just writes it.
    expect(section).toMatch(/manual `memesh doctor --journey` always reads/);
    expect(section).not.toMatch(/The journey always reads/);
    expect(section).toContain('an automatic run does not read it');
    expect(section).toContain('SIGHUP');
    expect(section).not.toContain('Ctrl-C or `SIGTERM`');
    // The limits of stopping a step, stated: a process whose parent already exited cannot be found.
    expect(section).toContain('already exited');
    expect(section).not.toContain('stopped with everything it started');
    expect(section).not.toContain('(killed with `taskkill /T` on Windows)');
    // Environment: passed when set, on every platform, and what the journey sets itself.
    expect(section).toContain('when set');
    expect(section).not.toContain('and nothing else');
    expect(section).not.toContain('the installed `memesh` command');
    expect(section).toContain('own CLI entry');
  });

  it('the changelog says what setup did before and that setup --check changes with it', () => {
    const section = journeySection(read('CHANGELOG.md'));
    // Before: with CLAUDE_CONFIG_DIR set, setup either found nothing (exit 0) or wired the relocated folder and called it unwired (exit 1).
    expect(section).toContain('CLAUDE_CONFIG_DIR');
    expect(section).not.toContain('It used to look in `~/.claude`, report the host as not found, and exit 1.');
    expect(section).toMatch(/setup --check/);
  });
});

describe('a manual doctor --journey writes only over a record it could read', () => {
  const run = (home: string) => spawnSync(process.execPath, [REAL_CLI, 'doctor', '--journey'], { encoding: 'utf8', env: cliEnv(home), timeout: 90_000 });

  it.skipIf(!NOT_ROOT)('a home folder with no access: still passes and the data folder is left as it was', () => {
    const home = path.join(work, 'h-home000');
    fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
    fs.chmodSync(home, 0o000);
    cleanups.push(() => fs.chmodSync(home, 0o700));
    const r = run(home);
    fs.chmodSync(home, 0o700);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Journey PASSED');
    expect(r.stderr).not.toContain('Could not update');
    expect(r.stderr).not.toContain('EACCES');
    expect(fs.readdirSync(path.join(home, '.memesh'))).toEqual([]);
  }, 100_000);

  it.skipIf(!NOT_ROOT)('a data folder with no access: still passes and is left as it was', () => {
    const home = path.join(work, 'h-data000');
    const data = path.join(home, '.memesh');
    fs.mkdirSync(data, { recursive: true });
    fs.chmodSync(data, 0o000);
    cleanups.push(() => fs.chmodSync(data, 0o700));
    const r = run(home);
    fs.chmodSync(data, 0o700);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Journey PASSED');
    expect(r.stderr).not.toContain('Could not update');
    expect(r.stderr).not.toContain('EACCES');
    expect(fs.readdirSync(data)).toEqual([]);
  }, 100_000);

  it('a home folder with no .memesh in it: nothing is created', () => {
    const home = path.join(work, 'h-absent');
    fs.mkdirSync(home);
    const r = run(home);
    expect(r.status).toBe(0);
    expect(fs.readdirSync(home)).toEqual([]);
  }, 100_000);

  it('a record that is not a journey record is left exactly as it is', () => {
    const home = path.join(work, 'h-corrupt');
    const data = path.join(home, '.memesh');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'post-install-journey.json'), 'not json at all');
    const r = run(home);
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(data, 'post-install-journey.json'), 'utf8')).toBe('not json at all');
  }, 100_000);

  it('a valid record is replaced', () => {
    const home = path.join(work, 'h-valid');
    const data = path.join(home, '.memesh');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'post-install-journey.json'), JSON.stringify({ ok: false, at: '2020-01-01T00:00:00.000Z', version: '0.0.1', trigger: 'setup', failedStep: 'send', reason: 'old failure' }));
    const r = run(home);
    expect(r.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(data, 'post-install-journey.json'), 'utf8'))).toMatchObject({ ok: true, trigger: 'doctor' });
  }, 100_000);
});

describe('refreshExistingJourneyRecord (the same rule, in process)', () => {
  const passed: journey.JourneyResult = {
    ok: true, timedOut: false, elapsedMs: 1, scratchDir: '', cleaned: true,
    steps: (['remember', 'recall', 'send', 'fetch'] as const).map((id) => ({ id, did: id, ok: true, result: 'ok', ms: 1 })),
  };
  const valid = { ok: false, at: '2020-01-01T00:00:00.000Z', version: '0.0.1', trigger: 'setup', failedStep: 'send', reason: 'old failure' };

  it('no data folder: nothing is created', () => {
    process.env.MEMESH_DIR = path.join(work, 'absent', '.memesh');
    journey.refreshExistingJourneyRecord(passed, '1.0.0');
    expect(fs.existsSync(path.join(work, 'absent'))).toBe(false);
  });

  it('a record that is not a record, or not JSON: left byte for byte', () => {
    const dir = path.join(work, 'data');
    fs.mkdirSync(dir);
    process.env.MEMESH_DIR = dir;
    for (const body of ['not json', '{"ok":"yes"}']) {
      fs.writeFileSync(journey.journeyRecordPath(dir), body);
      journey.refreshExistingJourneyRecord(passed, '1.0.0');
      expect(fs.readFileSync(journey.journeyRecordPath(dir), 'utf8')).toBe(body);
    }
  });

  it('a valid record: replaced', () => {
    const dir = path.join(work, 'data2');
    fs.mkdirSync(dir);
    process.env.MEMESH_DIR = dir;
    fs.writeFileSync(journey.journeyRecordPath(dir), JSON.stringify(valid));
    journey.refreshExistingJourneyRecord(passed, '1.0.0');
    expect(JSON.parse(fs.readFileSync(journey.journeyRecordPath(dir), 'utf8'))).toMatchObject({ ok: true, version: '1.0.0', trigger: 'doctor' });
  });
});

describe('an unusable temp folder is a failed journey with a reason', () => {
  const breakTmp = () => { process.env.TMPDIR = process.env.TMP = process.env.TEMP = path.join(work, 'no-such-folder'); };

  it('runInstallJourney returns a result with Why and Fix instead of throwing', async () => {
    breakTmp();
    const result = await journey.runInstallJourney({ packageRoot: PACKAGE_ROOT });
    expect(result.ok).toBe(false);
    // The harness failed, not remember: it has its own step id and the screen does not blame the install.
    expect(result.failedStep).toBe('prepare');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].reason).toMatch(/mkdtemp|no-such-folder|ENOENT/);
    expect(result.steps[0].fix).toMatch(/temp folder/);
    expect(result.cleaned).toBe(true);
    const text = journey.formatJourney(result).join('\n');
    expect(text).toContain('Why: ');
    expect(text).toContain('Fix: ');
    expect(text).toContain("this machine's temp folder is not usable");
    expect(text).toContain('memesh itself was not checked');
    expect(text).not.toContain('core feature');
  });

  it('doctor --journey prints Why and Fix and exits 1, with no stack trace', () => {
    const home = path.join(work, 'h-tmp');
    fs.mkdirSync(home);
    const broken = path.join(work, 'no-such-folder');
    const r = spawnSync(process.execPath, [REAL_CLI, 'doctor', '--journey'], { encoding: 'utf8', env: cliEnv(home, { TMPDIR: broken, TMP: broken, TEMP: broken }) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Why: ');
    expect(r.stderr).toContain('Fix: ');
    expect(r.stderr).not.toMatch(/\n\s+at /);
  }, 60_000);

  it('install-hooks keeps its exit code and leaves a failed record for memesh doctor', () => {
    const home = path.join(work, 'h-tmp2');
    fs.mkdirSync(home);
    const broken = path.join(work, 'no-such-folder');
    const r = spawnSync(process.execPath, [REAL_CLI, 'install-hooks'], { encoding: 'utf8', env: cliEnv(home, { TMPDIR: broken, TMP: broken, TEMP: broken }) });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('Journey could not run');
    expect(r.stderr).not.toContain('Journey FAILED');
    expect(r.stderr).not.toContain('core feature');
    expect(JSON.parse(fs.readFileSync(path.join(home, '.memesh', 'post-install-journey.json'), 'utf8'))).toMatchObject({ ok: false, failedStep: 'prepare' });
    const doctor = spawnSync(process.execPath, [REAL_CLI, 'doctor', '--json'], { encoding: 'utf8', env: cliEnv(home) });
    const row = (JSON.parse(doctor.stdout.slice(doctor.stdout.indexOf('{\n'))) as { checks: Array<{ id: string; status: string; summary: string; fix?: string }> }).checks.find((c) => c.id === 'install-journey');
    expect(row?.status).toBe('warn');
    expect(row?.summary).toContain('could not run');
    expect(row?.summary).toContain('memesh itself was not checked');
    expect(row?.summary).not.toContain('failed at "remember"');
    // The fix names the re-check command once, not twice.
    expect((row?.fix ?? '').match(/memesh doctor --journey/g) ?? []).toHaveLength(1);
  }, 90_000);
});

describe('the saved record', () => {
  const failedRecord = { ok: false, at: '2026-01-01T00:00:00.000Z', version: '4.13.0', trigger: 'install-hooks' as const, failedStep: 'send' as const, reason: 'boom', fix: 'fix it' };

  it.skipIf(!POSIX)('replaces a symlink instead of writing through it', () => {
    const dir = path.join(work, 'data');
    fs.mkdirSync(dir);
    const victim = path.join(work, 'victim.txt');
    fs.writeFileSync(victim, 'victim-content');
    fs.symlinkSync(victim, journey.journeyRecordPath(dir));
    journey.writeJourneyRecord(failedRecord, dir);
    expect(fs.readFileSync(victim, 'utf8')).toBe('victim-content');
    expect(fs.lstatSync(journey.journeyRecordPath(dir)).isSymbolicLink()).toBe(false);
    expect(JSON.parse(fs.readFileSync(journey.journeyRecordPath(dir), 'utf8'))).toMatchObject({ failedStep: 'send' });
    // No half-written temporary file is left beside it.
    expect(fs.readdirSync(dir)).toEqual(['post-install-journey.json']);
  });

  it.skipIf(!POSIX)('is private to the owner (0600), also over an older, looser file', () => {
    const dir = path.join(work, 'data');
    fs.mkdirSync(dir);
    fs.writeFileSync(journey.journeyRecordPath(dir), '{}', { mode: 0o644 });
    journey.writeJourneyRecord(failedRecord, dir);
    expect(fs.statSync(journey.journeyRecordPath(dir)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!POSIX)('a record written by the automatic run is 0600', async () => {
    process.env.MEMESH_DIR = path.join(work, 'auto');
    delete process.env.MEMESH_DB_PATH;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await journey.runPostInstallJourney({ packageRoot: PACKAGE_ROOT, version: '1.0.0', trigger: 'setup' });
    expect(fs.statSync(journey.journeyRecordPath(process.env.MEMESH_DIR)).mode & 0o777).toBe(0o600);
  }, 60_000);

  it('a failed record without its step or reason is unreadable, not "undefined"', () => {
    const dir = path.join(work, 'data');
    fs.mkdirSync(dir);
    for (const partial of [{ ok: false, at: 'x', version: '4.13.0' }, { ok: false, at: 'x', version: '4.13.0', failedStep: 'send' }, { ok: false, at: 'x', version: '4.13.0', reason: 'r' }]) {
      fs.writeFileSync(journey.journeyRecordPath(dir), JSON.stringify(partial));
      expect(journey.readJourneyRecord(dir), JSON.stringify(partial)).toHaveProperty('unreadable');
    }
    fs.writeFileSync(journey.journeyRecordPath(dir), JSON.stringify({ ok: true, at: 'x', version: '4.13.0' }));
    expect(journey.readJourneyRecord(dir)).toMatchObject({ ok: true });
  });

  it('doctor says so for an incomplete failed record', () => {
    const home = path.join(work, 'h-partial');
    fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
    fs.writeFileSync(path.join(home, '.memesh', 'post-install-journey.json'), JSON.stringify({ ok: false, at: 'x', version: '4.13.0' }));
    const r = spawnSync(process.execPath, [REAL_CLI, 'doctor', '--json'], { encoding: 'utf8', env: cliEnv(home) });
    const row = (JSON.parse(r.stdout.slice(r.stdout.indexOf('{\n'))) as { checks: Array<{ id: string; status: string; summary: string; code?: string }> }).checks.find((c) => c.id === 'install-journey');
    expect(row).toMatchObject({ status: 'warn', code: 'install-journey.unreadable' });
    expect(row?.summary).not.toContain('undefined');
  }, 60_000);
});

describe('doctor and --journey', () => {
  const doctorRow = (home: string) => {
    const r = spawnSync(process.execPath, [REAL_CLI, 'doctor', '--json'], { encoding: 'utf8', env: cliEnv(home), timeout: 60_000 });
    return (JSON.parse(r.stdout.slice(r.stdout.indexOf('{\n'))) as { checks: Array<{ id: string; status: string; summary: string; informational?: boolean }> }).checks.find((c) => c.id === 'install-journey');
  };
  const withRecord = (name: string, record: object) => {
    const home = path.join(work, name);
    fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
    fs.writeFileSync(path.join(home, '.memesh', 'post-install-journey.json'), JSON.stringify(record));
    return home;
  };

  it('a success from another version is not shown as a pass for this one', () => {
    const row = doctorRow(withRecord('h-oldpass', { ok: true, at: '2026-01-01T00:00:00.000Z', version: '4.0.0', trigger: 'install-hooks' }));
    expect(row?.informational).toBe(true);
    expect(row?.summary).toContain('4.0.0');
    expect(row?.summary).toContain('memesh doctor --journey');
    expect(row?.summary).not.toMatch(/worked at/);
  }, 60_000);

  it('a success from this version is a pass', () => {
    const version = (JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
    const row = doctorRow(withRecord('h-curpass', { ok: true, at: '2026-01-01T00:00:00.000Z', version, trigger: 'install-hooks' }));
    expect(row).toMatchObject({ status: 'pass' });
    expect(row?.informational).toBeUndefined();
    expect(row?.summary).toMatch(/worked at/);
  }, 60_000);

  it('the fix for a failed step (not only a temp folder problem) names the re-check command once', async () => {
    const dir = path.join(work, 'rec-send');
    fs.mkdirSync(dir);
    process.env.MEMESH_DIR = dir;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const version = (JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
    await journey.runPostInstallJourney({ packageRoot: PACKAGE_ROOT, version, trigger: 'install-hooks' }, { cliEntry: entryFor(['message', 'send'], `console.log('{}'); process.exit(0);`) });
    const home = path.join(work, 'h-fixonce');
    fs.mkdirSync(home);
    const r = spawnSync(process.execPath, [REAL_CLI, 'doctor', '--json'], { encoding: 'utf8', env: cliEnv(home, { MEMESH_DIR: dir }), timeout: 60_000 });
    const row = (JSON.parse(r.stdout.slice(r.stdout.indexOf('{\n'))) as { checks: Array<{ id: string; status: string; fix?: string }> }).checks.find((c) => c.id === 'install-journey');
    expect(row?.status).toBe('warn');
    expect((row?.fix ?? '').match(/memesh doctor --journey/g) ?? []).toHaveLength(1);
  }, 90_000);

  for (const flag of ['--fix', '--probe-http', '--yes']) {
    it(`--journey with ${flag} is refused out loud instead of ignoring it`, () => {
      const home = path.join(work, `h-flag${flag}`);
      fs.mkdirSync(home);
      const r = spawnSync(process.execPath, [REAL_CLI, 'doctor', '--journey', flag], { encoding: 'utf8', env: cliEnv(home), timeout: 60_000 });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('--journey runs on its own');
      expect(r.stderr).toContain(flag);
      expect(r.stdout).not.toContain('Install journey');
    }, 60_000);
  }
});

describe('the test hooks are not part of the options', () => {
  it('a cliEntry smuggled into the options object is ignored', async () => {
    const result = await journey.runInstallJourney({ packageRoot: PACKAGE_ROOT, cliEntry: path.join(work, 'nope.js') } as unknown as journey.JourneyOptions);
    expect(result.ok, JSON.stringify(result.steps)).toBe(true);
  }, 60_000);

  it('the types do not offer them either', () => {
    const typeOnly = () => {
      // @ts-expect-error cliEntry is a test hook (second argument), not an option
      journey.runInstallJourney({ packageRoot: '', cliEntry: '' });
      // @ts-expect-error timeoutMs is a test hook (second argument), not an option
      journey.runInstallJourney({ packageRoot: '', timeoutMs: 1 });
      // @ts-expect-error nor an input of the automatic run
      journey.runPostInstallJourney({ packageRoot: '', version: '1', trigger: 'setup', cliEntry: '' });
    };
    expect(typeof typeOnly).toBe('function');
  });
});

describe('a journey leaves the process as it found it', () => {
  it('the signal listeners are back to what they were, after a pass and after a failure', async () => {
    const counts = () => (['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const).map((signal) => process.listenerCount(signal));
    const before = counts();
    expect((await journey.runInstallJourney({ packageRoot: PACKAGE_ROOT })).ok).toBe(true);
    expect(counts()).toEqual(before);
    process.env.TMPDIR = process.env.TMP = process.env.TEMP = path.join(work, 'no-such-folder');
    expect((await journey.runInstallJourney({ packageRoot: PACKAGE_ROOT })).ok).toBe(false);
    expect(counts()).toEqual(before);
  }, 60_000);

  it('says so when the throwaway folder could not be removed', () => {
    const result: journey.JourneyResult = {
      ok: true, timedOut: false, elapsedMs: 1, scratchDir: '/x/memesh-journey-abc', cleaned: false, cleanupError: 'EBUSY',
      steps: (['remember', 'recall', 'send', 'fetch'] as const).map((id) => ({ id, did: id, ok: true, result: 'ok', ms: 1 })),
    };
    const text = journey.formatJourney(result).join('\n');
    expect(text).toContain('/x/memesh-journey-abc could not be removed (EBUSY)');
    expect(text).toContain('safe to delete by hand');
    expect(journey.formatJourney({ ...result, cleaned: true }).join('\n')).not.toContain('could not be removed');
  });
});

describe.skipIf(!POSIX)('the 30-second budget is a hard limit', () => {
  const grandchild = (pidFile: string, detached: boolean) => `
    const gc = spawn(process.execPath, ['-e', ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`)}], { stdio: ['ignore', 'inherit', 'inherit'], detached: ${detached} });
    if (${detached}) gc.unref();
    await new Promise((r) => setTimeout(r, 200));
    ${HANG}`;

  it('a grandchild holding stdout does not stretch the wait, and dies with its step', async () => {
    const pidFile = path.join(work, 'gc.pid');
    // A failure of this test must not leave a process that never ends behind.
    cleanups.push(() => { try { const pid = readPid(pidFile); if (pid) process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
    const entry = entryFor(['remember'], grandchild(pidFile, false));
    const started = Date.now();
    const result = await journey.runInstallJourney({ packageRoot: PACKAGE_ROOT }, { cliEntry: entry, timeoutMs: 3_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.timedOut).toBe(true);
    expect(result.failedStep).toBe('remember');
    const pid = readPid(pidFile);
    expect(pid, 'the grandchild never started, so this test proved nothing').toBeGreaterThan(0);
    expect(await waitFor(() => !alive(pid!), 3_000), 'the grandchild survived its step').toBe(true);
  }, 30_000);

  it('a grandchild that left the process group still cannot hold the journey past its budget', async () => {
    const pidFile = path.join(work, 'gc2.pid');
    cleanups.push(() => killPidFile(pidFile));
    const entry = entryFor(['remember'], grandchild(pidFile, true));
    const started = Date.now();
    const result = await journey.runInstallJourney({ packageRoot: PACKAGE_ROOT }, { cliEntry: entry, timeoutMs: 3_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.timedOut).toBe(true);
    const pid = readPid(pidFile);
    expect(pid, 'the grandchild never started, so this test proved nothing').toBeGreaterThan(0);
    // It is in another process group but its parent (the step) was alive: found through its parent id, and stopped.
    expect(await waitFor(() => !alive(pid!), 3_000), 'a grandchild in another process group survived its step').toBe(true);
  }, 30_000);

  it('finds descendants through their parent ids', () => {
    const ps = (lines: string) => ((() => ({ status: 0, error: undefined, stdout: lines })) as unknown as typeof spawnSync);
    expect(journey.descendantPids(10, ps('  10 1\n  11 10\n  12 11\n  13 1\n  14 12\n  15 99\n'))).toEqual([11, 12, 14]);
    expect(journey.descendantPids(10, ((() => ({ status: 1, error: undefined, stdout: '' })) as unknown as typeof spawnSync))).toEqual([]);
  });

  it('a step that exits while a grandchild still holds stdout is not waited for', async () => {
    const pidFile = path.join(work, 'gc3.pid');
    cleanups.push(() => killPidFile(pidFile));
    const entry = entryFor(['remember'], `
      const gc = spawn(process.execPath, ['-e', ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`)}], { stdio: ['ignore', 'inherit', 'inherit'] });
      await new Promise((r) => setTimeout(r, 300));
      console.log('{"stored":false}');
      process.exit(0);`);
    const started = Date.now();
    const result = await journey.runInstallJourney({ packageRoot: PACKAGE_ROOT }, { cliEntry: entry, timeoutMs: 20_000 });
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(result.failedStep).toBe('remember');
    expect(result.steps[0].reason).toContain('did not report the note as stored');
  }, 30_000);

  it('formats a sub-second budget as milliseconds-worth of seconds, never "0 s"', async () => {
    expect(journey.formatBudget(100)).toBe('0.1 s');
    expect(journey.formatBudget(1_500)).toBe('1.5 s');
    expect(journey.formatBudget(30_000)).toBe('30 s');
    const result = await journey.runInstallJourney({ packageRoot: PACKAGE_ROOT }, { cliEntry: entryFor(['remember'], HANG), timeoutMs: 300 });
    expect(result.steps[0].reason).toContain('0.3 s');
    expect(result.steps[0].reason).not.toContain('0 s budget');
  }, 30_000);
});

describe('a relative TMPDIR and the step environment', () => {
  it('the step gets an absolute home with its config in place (update check off) and capture off', async () => {
    const cwd = path.join(work, 'cwd');
    fs.mkdirSync(path.join(cwd, 'reltmp'), { recursive: true });
    const report = path.join(work, 'child-report.json');
    const entry = entryFor(['remember'], `
      const dir = process.env.MEMESH_DIR;
      const cfg = dir + '/config.json';
      fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({
        home: process.env.HOME, dir, auto: process.env.MEMESH_AUTO_CAPTURE, cwd: process.cwd(),
        config: fs.existsSync(cfg) ? JSON.parse(fs.readFileSync(cfg, 'utf8')) : null,
      }));
      console.log('{"stored":false}');
      process.exit(0);`);
    const original = process.cwd();
    process.chdir(cwd);
    cleanups.push(() => process.chdir(original));
    process.env.TMPDIR = process.env.TMP = process.env.TEMP = 'reltmp';
    await journey.runInstallJourney({ packageRoot: PACKAGE_ROOT }, { cliEntry: entry });
    const seen = JSON.parse(fs.readFileSync(report, 'utf8')) as { home: string; dir: string; auto: string; cwd: string; config: unknown };
    expect(path.isAbsolute(seen.home), seen.home).toBe(true);
    expect(path.isAbsolute(seen.dir), seen.dir).toBe(true);
    // The config the journey wrote is where the step looks: the update check stays off.
    expect(seen.config).toEqual({ updateCheck: false });
    expect(seen.auto).toBe('false');
    // The step runs inside the throwaway folder, not wherever the user ran the command.
    expect(path.basename(seen.cwd)).toMatch(/^memesh-journey-/);
    expect(path.basename(path.dirname(seen.cwd))).not.toBe('cwd');
  }, 30_000);

  it('a relative TMPDIR leaves no background process and no nested folder behind', async () => {
    // Without the resolve, the step's data went to a nested path, its config was
    // not read, and the CLI started a detached update check that outlived the folder.
    const cwd = path.join(work, 'cwd2');
    fs.mkdirSync(path.join(cwd, 'reltmp'), { recursive: true });
    const original = process.cwd();
    process.chdir(cwd);
    cleanups.push(() => process.chdir(original));
    process.env.TMPDIR = process.env.TMP = process.env.TEMP = 'reltmp';
    const result = await journey.runInstallJourney({ packageRoot: PACKAGE_ROOT });
    expect(result.ok, JSON.stringify(result.steps)).toBe(true);
    expect(result.cleaned).toBe(true);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(fs.readdirSync(path.join(cwd, 'reltmp'))).toEqual([]);
    if (POSIX) {
      const ps = spawnSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8' }).stdout;
      expect(ps).not.toContain(path.join(cwd, 'reltmp'));
    }
  }, 60_000);

  it('an empty temp variable is left out, not turned into the current folder', () => {
    const env = journey.journeyEnv('/scratch', { PATH: '/bin', TMPDIR: '', TMP: '', TEMP: '', LANG: '' }, 'linux');
    expect(env).not.toHaveProperty('TMPDIR');
    expect(env).not.toHaveProperty('TMP');
    expect(env).not.toHaveProperty('TEMP');
    // Only the temp variables: an empty LANG is passed as it is.
    expect(env.LANG).toBe('');
    const win = journey.journeyEnv('C:\\scratch', { Path: 'C:\\bin', TEMP: '', Tmp: '' }, 'win32');
    expect(Object.keys(win).filter((key) => /^(TEMP|TMP)$/i.test(key))).toEqual([]);
  });

  it('a relative temp variable is made absolute for the step', () => {
    const env = journey.journeyEnv('/scratch', { PATH: '/bin', TMPDIR: 'reltmp' }, 'linux');
    expect(path.isAbsolute(env.TMPDIR as string)).toBe(true);
    expect(journey.journeyEnv('/scratch', { PATH: '/bin', TMPDIR: '/abs/tmp' }, 'linux').TMPDIR).toBe('/abs/tmp');
    expect(env.MEMESH_AUTO_CAPTURE).toBe('false');
  });
});

describe('killTree when taskkill does not work (the Windows branch; runs everywhere, simulated where it is not Windows)', () => {
  const hang = () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    cleanups.push(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
    return child;
  };
  const fakeRun = (result: object) => ((...args: unknown[]) => { calls.push(String(args[0])); return result; }) as unknown as typeof spawnSync;
  let calls: string[];
  beforeEach(() => { calls = []; });

  it('a taskkill that exits non-zero falls back to killing the step', async () => {
    const child = hang();
    expect(journey.killTree(child, 'win32', fakeRun({ status: 128, error: undefined }))).toBe(true);
    expect(calls[0]).toMatch(/taskkill\.exe$/);
    expect(await waitFor(() => !alive(child.pid!), 3_000), 'the step survived a failed taskkill').toBe(true);
  });

  it('a taskkill that cannot be found falls back too', async () => {
    const child = hang();
    const error = Object.assign(new Error('spawnSync taskkill ENOENT'), { code: 'ENOENT' });
    expect(journey.killTree(child, 'win32', fakeRun({ status: null, error }))).toBe(true);
    expect(await waitFor(() => !alive(child.pid!), 3_000), 'the step survived a missing taskkill').toBe(true);
  });

  it('a taskkill that works is not followed by a second kill', async () => {
    const child = hang();
    expect(journey.killTree(child, 'win32', fakeRun({ status: 0, error: undefined }))).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(child.pid!)).toBe(true);
  });

  it('on Windows a step that already exited is not taskkill-ed (its pid may belong to someone else by now)', () => {
    let killed = false;
    expect(journey.killTree({ pid: 4321, exitCode: 0, kill: () => { killed = true; return true; } }, 'win32', fakeRun({ status: 0, error: undefined }))).toBe(true);
    expect(calls).toEqual([]);
    expect(killed).toBe(false);
  });

  it('reports false when nothing could be stopped', () => {
    expect(journey.killTree({ pid: 2_000_000_000, kill: () => false }, 'win32', fakeRun({ status: 1, error: undefined }))).toBe(false);
    expect(journey.killTree({ pid: undefined, kill: () => true }, 'win32', fakeRun({ status: 0, error: undefined }))).toBe(false);
  });

  it('a step that could not be stopped is not reported as stopped', () => {
    expect(journey.timeoutReason(30_000)).toContain('and was stopped');
    const reason = journey.timeoutReason(30_000, 4321);
    expect(reason).toContain('could not be stopped');
    expect(reason).toContain('4321');
    expect(reason).not.toContain('and was stopped');
  });
});

describe('killTree and a step that has already exited', () => {
  const noPs = ((() => ({ status: 1, error: undefined, stdout: '' })) as unknown as typeof spawnSync);

  it('an exited step with its output closed is left alone; one with output still open, or one still running, is killed as a group', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const exited = { pid: 4242, exitCode: 0, kill: () => true };
    expect(journey.killTree(exited, 'linux', noPs, false)).toBe(true);
    expect(killSpy).not.toHaveBeenCalled();
    journey.killTree(exited, 'linux', noPs, true);
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
    killSpy.mockClear();
    journey.killTree({ pid: 4243, exitCode: null, signalCode: null, kill: () => true }, 'linux', noPs, false);
    expect(killSpy).toHaveBeenCalledWith(-4243, 'SIGKILL');
  });

  it('the descendants of an exited step are not looked up: its pid may belong to someone else by now', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    const lookups: string[] = [];
    const counting = ((command: string) => { lookups.push(command); return { status: 1, error: undefined, stdout: '' }; }) as unknown as typeof spawnSync;
    journey.killTree({ pid: 4242, exitCode: 0, kill: () => true }, 'linux', counting, true);
    expect(lookups).toEqual([]);
    journey.killTree({ pid: 4243, exitCode: null, signalCode: null, kill: () => true }, 'linux', counting, true);
    expect(lookups.length).toBeGreaterThan(0);
  });
});

describe('the suite environment is an allow-list', () => {
  const polluted = {
    PATH: '/bin', TZ: 'UTC', CI: 'true', TMPDIR: '/tmp/x', LANG: 'C',
    CLAUDE_CONFIG_DIR: '/real/claude', CODEX_HOME: '/real/codex', XDG_CONFIG_HOME: '/real/xdg', MEMESH_DIR: '/real/m', MEMESH_DB_PATH: '/real/db',
    CLAUDE_CODE_MESSAGING_SOCKET: '/real/s', CLAUDE_CODE_MESSAGING_TOKEN: 'tok', CLAUDE_CODE_USER_EMAIL: 'a@b', CLAUDE_CODE_ACCOUNT_UUID: 'u', CLAUDE_CODE_ORGANIZATION_UUID: 'o',
    CLAUDE_CODE_HOST_SESSION_ID: 'h', CLAUDE_PID: '1', CLAUDE_PROJECTS_DIR: '/real/projects',
    MEMESH_HOST_CONFIG: '/real/hc', MEMESH_ROUTER_SOCKET: '/real/r', MEMESH_ROUTER_TOKEN_FILE: '/real/t', MEMESH_UPDATE_CHECK_PATH: '/real/u',
    GITHUB_TOKEN: 'g', NPM_TOKEN: 'n', AWS_SECRET_ACCESS_KEY: 'a', NODE_OPTIONS: '--require /evil.js',
    // A shell inside Claude Code: the hooks resolve the recipient as `claude-code` when they see these.
    CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_ENTRYPOINT: 'cli', CODEX_THREAD_ID: 't', CODEX_SESSION_ID: 's',
  };

  it('only explicitly listed variables cross; host config, messaging, account and token variables do not', () => {
    const env = buildIsolatedSuiteEnv(polluted, { runtimeHome: '/throwaway' }) as Record<string, string | undefined>;
    for (const name of Object.keys(polluted)) {
      if (['PATH', 'TZ', 'CI', 'TMPDIR', 'LANG', 'NODE_OPTIONS'].includes(name)) continue;
      expect(env[name], name).toBeUndefined();
    }
    expect(env.PATH).toBe('/bin');
    expect(env.TZ).toBe('UTC');
    expect(env.CI).toBe('true');
    expect(env.HOME).toBe('/throwaway');
    expect(env.USERPROFILE).toBe('/throwaway');
    // A preload from the ambient NODE_OPTIONS is not inherited either; the only one is the runner's own account-home preload.
    expect(env.NODE_OPTIONS).not.toContain('/evil.js');
    expect(env.NODE_OPTIONS).toMatch(/^--import=file:\/\/.*account-home-preload\.mjs$/);
  });
});

describe.skipIf(!NOT_ROOT)('install-hooks that cannot write its marker leaves settings as they were', () => {
  const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

  it('exits 1 and the settings.json is byte-identical', () => {
    const home = path.join(work, 'h-nomarker');
    const claude = path.join(home, '.claude');
    fs.mkdirSync(claude, { recursive: true });
    fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ theme: 'dark', hooks: {} }, null, 2) + '\n');
    const before = sha(path.join(claude, 'settings.json'));
    // Control: the same install with a writable .memesh really does change THIS settings.json,
    // so the byte-identical check below is about a file the install targets, not a bystander.
    const controlHome = path.join(work, 'h-control');
    fs.mkdirSync(path.join(controlHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(controlHome, '.claude', 'settings.json'), fs.readFileSync(path.join(claude, 'settings.json')));
    const control = spawnSync(process.execPath, [REAL_CLI, 'install-hooks', '--no-journey'], { encoding: 'utf8', env: cliEnv(controlHome), timeout: 60_000 });
    expect(control.status, control.stdout + control.stderr).toBe(0);
    expect(sha(path.join(controlHome, '.claude', 'settings.json'))).not.toBe(before);
    fs.mkdirSync(path.join(home, '.memesh'));
    fs.chmodSync(path.join(home, '.memesh'), 0o000);
    cleanups.push(() => fs.chmodSync(path.join(home, '.memesh'), 0o700));
    const r = spawnSync(process.execPath, [REAL_CLI, 'install-hooks'], { encoding: 'utf8', env: cliEnv(home), timeout: 60_000 });
    fs.chmodSync(path.join(home, '.memesh'), 0o700);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain('install-hooks failed');
    expect(sha(path.join(claude, 'settings.json'))).toBe(before);
  }, 90_000);

  it('the citation rule file written first is put back too: removed when it was new, byte-identical when it existed', () => {
    const marker = '<!-- managed-by: memesh -->';
    for (const existed of [false, true]) {
      const home = path.join(work, `h-rule-${existed}`);
      const rules = path.join(home, '.claude', 'rules');
      const rule = path.join(rules, 'memesh-citations.md');
      fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
      if (existed) {
        fs.mkdirSync(rules, { recursive: true });
        // An older copy memesh wrote itself: install would rewrite it.
        fs.writeFileSync(rule, `${marker}\n# an older version of the rule\n`);
      }
      const before = existed ? sha(rule) : null;
      fs.chmodSync(path.join(home, '.memesh'), 0o000);
      cleanups.push(() => fs.chmodSync(path.join(home, '.memesh'), 0o700));
      const r = spawnSync(process.execPath, [REAL_CLI, 'install-hooks'], { encoding: 'utf8', env: cliEnv(home), timeout: 60_000 });
      fs.chmodSync(path.join(home, '.memesh'), 0o700);
      expect(r.status, `${existed}: ${r.stdout}${r.stderr}`).toBe(1);
      if (existed) expect(sha(rule), 'the rule file differs from before the failed install').toBe(before);
      else {
        expect(fs.existsSync(rule), 'a rule file written by the failed install was left behind').toBe(false);
        expect(fs.existsSync(rules), 'the folder created for it was left behind').toBe(false);
      }
    }
  }, 120_000);

  it('a rule file memesh would not even change, and cannot, does not turn the real error into a permission error', () => {
    const home = path.join(work, 'h-readonly-rule');
    const rules = path.join(home, '.claude', 'rules');
    const rule = path.join(rules, 'memesh-citations.md');
    fs.mkdirSync(rules, { recursive: true });
    fs.writeFileSync(rule, CITATION_RULE_BODY, { mode: 0o444 });
    const before = sha(rule);
    fs.mkdirSync(path.join(home, '.memesh'));
    fs.chmodSync(path.join(home, '.memesh'), 0o000);
    cleanups.push(() => fs.chmodSync(path.join(home, '.memesh'), 0o700));
    const r = spawnSync(process.execPath, [REAL_CLI, 'install-hooks'], { encoding: 'utf8', env: cliEnv(home), timeout: 60_000 });
    fs.chmodSync(path.join(home, '.memesh'), 0o700);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    // The error is the one that happened (the marker under .memesh), not a failed attempt to put the unchanged rule back.
    expect(r.stderr).toContain('install-hooks failed');
    expect(r.stderr).toContain(path.join(home, '.memesh'));
    expect(r.stderr).not.toContain('memesh-citations.md');
    expect(sha(rule)).toBe(before);
  }, 90_000);

  it('a rule file the run did not change is not rewritten when the run fails (its modification time stays)', () => {
    const home = path.join(work, 'h-unchanged-rule');
    const rules = path.join(home, '.claude', 'rules');
    const rule = path.join(rules, 'memesh-citations.md');
    fs.mkdirSync(rules, { recursive: true });
    fs.writeFileSync(rule, CITATION_RULE_BODY);
    const long = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(rule, long, long);
    fs.mkdirSync(path.join(home, '.memesh'));
    fs.chmodSync(path.join(home, '.memesh'), 0o000);
    cleanups.push(() => fs.chmodSync(path.join(home, '.memesh'), 0o700));
    const r = spawnSync(process.execPath, [REAL_CLI, 'install-hooks'], { encoding: 'utf8', env: cliEnv(home), timeout: 60_000 });
    fs.chmodSync(path.join(home, '.memesh'), 0o700);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(fs.statSync(rule).mtimeMs).toBe(long.getTime());
  }, 90_000);

  it('folders this run created are removed again, for both scopes', () => {
    const home = path.join(work, 'h-leftover');
    fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
    fs.chmodSync(path.join(home, '.memesh'), 0o000);
    cleanups.push(() => fs.chmodSync(path.join(home, '.memesh'), 0o700));
    const user = spawnSync(process.execPath, [REAL_CLI, 'install-hooks'], { encoding: 'utf8', env: cliEnv(home), timeout: 60_000 });
    expect(user.status, user.stdout + user.stderr).toBe(1);
    // An empty ~/.claude would make `memesh setup` believe Claude Code is installed.
    expect(fs.existsSync(path.join(home, '.claude')), 'an empty ~/.claude was left behind').toBe(false);

    const project = path.join(work, 'project');
    fs.mkdirSync(project);
    const scoped = spawnSync(process.execPath, [REAL_CLI, 'install-hooks', '--scope', 'project'], { encoding: 'utf8', env: cliEnv(home), cwd: project, timeout: 60_000 });
    fs.chmodSync(path.join(home, '.memesh'), 0o700);
    expect(scoped.status, scoped.stdout + scoped.stderr).toBe(1);
    expect(fs.readdirSync(project), 'the project folder was left changed').toEqual([]);

    // A folder that was already there stays.
    const existing = path.join(work, 'h-existing');
    fs.mkdirSync(path.join(existing, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(existing, '.memesh'));
    fs.chmodSync(path.join(existing, '.memesh'), 0o000);
    cleanups.push(() => fs.chmodSync(path.join(existing, '.memesh'), 0o700));
    spawnSync(process.execPath, [REAL_CLI, 'install-hooks'], { encoding: 'utf8', env: cliEnv(existing), timeout: 60_000 });
    fs.chmodSync(path.join(existing, '.memesh'), 0o700);
    expect(fs.existsSync(path.join(existing, '.claude'))).toBe(true);
    expect(fs.readdirSync(path.join(existing, '.claude'))).toEqual([]);
  }, 150_000);

  it('a settings.json that did not exist is not left behind either', () => {
    const home = path.join(work, 'h-nomarker2');
    fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
    fs.chmodSync(path.join(home, '.memesh'), 0o000);
    cleanups.push(() => fs.chmodSync(path.join(home, '.memesh'), 0o700));
    const r = spawnSync(process.execPath, [REAL_CLI, 'install-hooks'], { encoding: 'utf8', env: cliEnv(home), timeout: 60_000 });
    fs.chmodSync(path.join(home, '.memesh'), 0o700);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(fs.existsSync(path.join(home, '.claude', 'settings.json'))).toBe(false);
  }, 90_000);
});

describe.skipIf(!POSIX)('timing at the edges of the budget', () => {
  const distUrl = pathToFileURL(path.join(PACKAGE_ROOT, 'dist/core/doctor-journey.js')).href;
  const gcSleeper = (pidFile: string, detached: boolean, seconds: number) => `
    const gc = spawn(process.execPath, ['-e', ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, ${seconds * 1000});`)}], { stdio: ['ignore', 'inherit', 'inherit'], detached: ${detached} });
    if (${detached}) gc.unref();`;
  const killAfter = (pidFile: string) => cleanups.push(() => killPidFile(pidFile));

  /** Runs a journey in its own process and reports when the verdict arrived and when the process was gone. */
  const inRunner = (name: string, entry: string, timeoutMs: number) => {
    const runner = path.join(work, `${name}.mjs`);
    fs.writeFileSync(runner, `
      const { runInstallJourney } = await import(${JSON.stringify(distUrl)});
      const t0 = Date.now();
      const result = await runInstallJourney({ packageRoot: ${JSON.stringify(PACKAGE_ROOT)} }, { cliEntry: ${JSON.stringify(entry)}, timeoutMs: ${timeoutMs} });
      console.log('R:' + (Date.now() - t0) + ':' + JSON.stringify({ timedOut: result.timedOut }));
      process.on('exit', () => console.log('E:' + (Date.now() - t0)));
    `);
    const r = spawnSync(process.execPath, [runner], { encoding: 'utf8', env: process.env, timeout: 60_000 });
    const resolved = Number(/R:(\d+):/.exec(r.stdout)?.[1]);
    const exited = Number(/E:(\d+)/.exec(r.stdout)?.[1]);
    return { resolved, exited, stdout: r.stdout, stderr: r.stderr };
  };

  it('the process is gone right after the verdict even when an orphaned process holds the step output', () => {
    const pidFile = path.join(work, 'gc-destroy.pid');
    killAfter(pidFile);
    // A process whose parent has already exited cannot be found through parent ids, so it
    // is the one thing still holding the output: only closing our end lets the process go.
    const holder = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 14000);`;
    const middle = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(holder)}], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref();`;
    const entry = entryFor(['remember'], `spawn(process.execPath, ['-e', ${JSON.stringify(middle)}], { stdio: ['ignore', 'inherit', 'inherit'] });
      await new Promise((r) => setTimeout(r, 500));
      ${HANG}`);
    const r = inRunner('destroy', entry, 2_000);
    expect(r.resolved, r.stderr).toBeGreaterThan(1_500);
    expect(r.exited - r.resolved, `verdict at ${r.resolved} ms, process gone at ${r.exited} ms`).toBeLessThan(1_500);
  }, 90_000);

  it('a timed-out step does not keep the process alive for a second grace period', () => {
    const r = inRunner('nograce', entryFor(['remember'], HANG), 1_500);
    expect(r.resolved, r.stderr).toBeGreaterThan(1_200);
    expect(r.exited - r.resolved, `verdict at ${r.resolved} ms, process gone at ${r.exited} ms`).toBeLessThan(250);
  }, 60_000);

  it('a step that exits 0 just before the budget ends is not called timed out', async () => {
    const pidFile = path.join(work, 'gc-late.pid');
    killAfter(pidFile);
    // The step ends at an absolute time 250 ms before the budget, however long node took to start:
    // late enough that only the exit status, not the clock, can save it; early enough not to flake on a slow machine.
    const budget = 3_000;
    const deadline = Date.now() + budget - 250;
    const entry = entryFor(['remember'], `${gcSleeper(pidFile, false, 14)}
      await new Promise((r) => setTimeout(r, Math.max(0, ${deadline} - Date.now())));
      console.log('{"stored":true,"name":"x"}');
      process.exit(0);`);
    const result = await journey.runInstallJourney({ packageRoot: PACKAGE_ROOT }, { cliEntry: entry, timeoutMs: budget });
    expect(result.steps[0].ok, JSON.stringify(result.steps[0])).toBe(true);
    expect(result.steps[0].result).toBe('stored as "x"');
    // The budget ended while the step's output was being collected: the next step is not started.
    expect(result.steps[1]).toMatchObject({ id: 'recall', ok: false, result: 'not run' });
    expect(result.steps[1].reason).toContain('ran out of its');
    expect(result.timedOut).toBe(true);
    // A process the exited step left holding its output is stopped when the grace period ends.
    const left = readPid(pidFile);
    expect(left, 'the holder never started, so this test proved nothing').toBeGreaterThan(0);
    expect(await waitFor(() => !alive(left!), 3_000), 'the process holding the exited step\'s output survived').toBe(true);
  }, 30_000);

  it('a step that cannot be stopped does not keep the process alive (a real step, a kill that does nothing)', () => {
    const pidFile = path.join(work, 'unstoppable.pid');
    killAfter(pidFile);
    const entry = entryFor(['remember'], `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); ${HANG}`);
    const runner = path.join(work, 'unstoppable.mjs');
    fs.writeFileSync(runner, `
      import cp from 'node:child_process';
      // taskkill failing, then the fallback kill doing nothing: the situation on Windows when a process cannot be ended.
      cp.ChildProcess.prototype.kill = function () { return false; };
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const { runInstallJourney } = await import(${JSON.stringify(distUrl)});
      const t0 = Date.now();
      const result = await runInstallJourney({ packageRoot: ${JSON.stringify(PACKAGE_ROOT)} }, { cliEntry: ${JSON.stringify(entry)}, timeoutMs: 1500 });
      console.log('R:' + (Date.now() - t0) + ':' + JSON.stringify({ reason: result.steps[0].reason }));
      process.on('exit', () => console.log('E:' + (Date.now() - t0)));
    `);
    const r = spawnSync(process.execPath, [runner], { encoding: 'utf8', env: process.env, timeout: 25_000 });
    const resolved = Number(/R:(\d+):/.exec(r.stdout)?.[1]);
    const exited = Number(/E:(\d+)/.exec(r.stdout)?.[1]);
    expect(r.stdout, r.stderr).toContain('could not be stopped');
    expect(exited - resolved, `verdict at ${resolved} ms, process gone at ${exited} ms (NaN: it never exited by itself)`).toBeLessThan(1_500);
  }, 60_000);

  it('output split inside a multi-byte character is read whole', async () => {
    const entry = entryFor(['remember'], `
      const bytes = Buffer.from('{"stored":true,"name":"\u00e9"}');
      const cut = bytes.indexOf(0xc3) + 1;
      process.stdout.write(bytes.subarray(0, cut));
      await new Promise((r) => setTimeout(r, 150));
      process.stdout.write(bytes.subarray(cut));
      await new Promise((r) => setTimeout(r, 100));
      process.exit(0);`);
    const result = await journey.runInstallJourney({ packageRoot: PACKAGE_ROOT }, { cliEntry: entry });
    expect(result.steps[0].result).toBe('stored as "\u00e9"');
  }, 30_000);
});

describe.skipIf(!POSIX)('Ctrl-C, hang-up and kill leave nothing behind', () => {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const) {
    it(`${signal} removes the throwaway folder and stops the running step`, async () => {
      const pidFile = path.join(work, `hang-${signal}.pid`);
      const gcFile = path.join(work, `gc-${signal}.pid`);
      // The step starts a process of its own, as the CLI's detached helpers do.
      const entry = entryFor(['remember'], `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
        spawn(process.execPath, ['-e', ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(gcFile)}, String(process.pid)); setInterval(() => {}, 1000);`)}], { stdio: 'ignore' });
        ${HANG}`);
      cleanups.push(() => { for (const f of [pidFile, gcFile]) killPidFile(f); });
      const runner = path.join(work, `runner-${signal}.mjs`);
      fs.writeFileSync(runner, `
        const { runInstallJourney } = await import(${JSON.stringify(pathToFileURL(path.join(PACKAGE_ROOT, 'dist/core/doctor-journey.js')).href)});
        await runInstallJourney({ packageRoot: ${JSON.stringify(PACKAGE_ROOT)} }, { cliEntry: ${JSON.stringify(entry)}, timeoutMs: 60000 });
      `);
      const child = spawn(process.execPath, [runner], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
      let childStderr = '';
      child.stderr!.on('data', (d: Buffer) => { childStderr += d.toString('utf8'); });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, sig) => resolve({ code, signal: sig })));
      const scratchDirs = () => fs.readdirSync(privateTmp).filter((n) => n.startsWith('memesh-journey-'));
      expect(await waitFor(() => scratchDirs().length > 0 && pidWritten(pidFile) && pidWritten(gcFile), 15_000), 'the journey never reached its first step').toBe(true);
      child.kill(signal);
      const done = await Promise.race([exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 10_000))]);
      expect(done).not.toBe('timeout');
      // The signal's own effect is kept: the runner still dies of it.
      expect((done as { signal: string | null }).signal).toBe(signal);
      expect(scratchDirs()).toEqual([]);
      // The person who pressed the key is told what happened.
      expect(childStderr).toContain('Interrupted: the install journey was stopped and its throwaway folder was removed.');
      const pid = readPid(pidFile)!;
      expect(await waitFor(() => !alive(pid), 3_000), 'the step process survived').toBe(true);
      const gc = readPid(gcFile)!;
      expect(await waitFor(() => !alive(gc), 3_000), 'a process the step had started survived').toBe(true);
    }, 40_000);
  }
});

describe.skipIf(!NOT_ROOT)('an interrupted journey that cannot remove its folder says so', () => {
  it('names the folder instead of claiming it was removed', async () => {
    const pidFile = path.join(work, 'hang-noremove.pid');
    const entry = entryFor(['remember'], `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); ${HANG}`);
    cleanups.push(() => killPidFile(pidFile));
    const runner = path.join(work, 'runner-noremove.mjs');
    fs.writeFileSync(runner, `
      const { runInstallJourney } = await import(${JSON.stringify(pathToFileURL(path.join(PACKAGE_ROOT, 'dist/core/doctor-journey.js')).href)});
      await runInstallJourney({ packageRoot: ${JSON.stringify(PACKAGE_ROOT)} }, { cliEntry: ${JSON.stringify(entry)}, timeoutMs: 60000 });
    `);
    const child = spawn(process.execPath, [runner], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let childStderr = '';
    child.stderr!.on('data', (d: Buffer) => { childStderr += d.toString('utf8'); });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const scratchDirs = () => fs.readdirSync(privateTmp).filter((n) => n.startsWith('memesh-journey-'));
    expect(await waitFor(() => scratchDirs().length > 0 && pidWritten(pidFile), 15_000)).toBe(true);
    const scratch = scratchDirs()[0];
    // The folder cannot be removed from a read-only parent.
    fs.chmodSync(privateTmp, 0o555);
    cleanups.push(() => fs.chmodSync(privateTmp, 0o700));
    child.kill('SIGINT');
    await exited;
    fs.chmodSync(privateTmp, 0o700);
    expect(childStderr).toContain('could not be removed');
    expect(childStderr).toContain(scratch);
    expect(childStderr).not.toContain('its throwaway folder was removed');
  }, 40_000);
});

describe('re-raising the signal can fail (on Windows, ENOSYS)', () => {
  it('exits with 128 + the signal number instead', async () => {
    const pidFile = path.join(work, 'hang-enosys.pid');
    const entry = entryFor(['remember'], `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); ${HANG}`);
    cleanups.push(() => killPidFile(pidFile));
    const realKill = process.kill.bind(process);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid === process.pid && signal === 'SIGHUP') throw Object.assign(new Error('ENOSYS: function not implemented, kill'), { code: 'ENOSYS' });
      return realKill(pid, signal as never);
    }) as never);
    const running = journey.runInstallJourney({ packageRoot: PACKAGE_ROOT }, { cliEntry: entry, timeoutMs: 20_000 });
    expect(await waitFor(() => pidWritten(pidFile), 15_000), 'the step never started').toBe(true);
    (process as NodeJS.EventEmitter).emit('SIGHUP', 'SIGHUP');
    await running;
    expect(exitSpy).toHaveBeenCalledWith(128 + os.constants.signals.SIGHUP);
  }, 40_000);
});

describe('Windows gets what Node needs and nothing that points at real folders', () => {
  const winBase = {
    Path: 'C:\\bin', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe', PATHEXT: '.COM;.EXE',
    TEMP: 'C:\\t', TMP: 'C:\\t', APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
    USERPROFILE: 'C:\\Users\\u', HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\u', MEMESH_DB_PATH: 'C:\\real\\db',
  };

  it('the env shape on win32', () => {
    const scratch = 'C:\\scratch';
    const env = journey.journeyEnv(scratch, winBase, 'win32');
    const get = (name: string) => Object.entries(env).filter(([k]) => k.toUpperCase() === name.toUpperCase());
    for (const name of ['PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP']) {
      expect(get(name), name).toHaveLength(1);
    }
    expect(get('PATH')[0][1]).toBe('C:\\bin');
    expect(get('SystemRoot')[0][1]).toBe('C:\\Windows');
    expect(get('USERPROFILE')[0][1]).toBe(scratch);
    expect(get('HOME')[0][1]).toBe(scratch);
    for (const name of ['APPDATA', 'LOCALAPPDATA']) {
      expect(get(name)).toHaveLength(1);
      expect(get(name)[0][1]).toMatch(/^C:\\scratch\\/);
    }
    expect(get('HOMEDRIVE')).toHaveLength(0);
    expect(get('HOMEPATH')).toHaveLength(0);
    expect(get('MEMESH_DB_PATH')[0][1]).toBe('C:\\scratch\\.memesh\\knowledge-graph.db');
  });

  it('PATH spelled two ways in the parent environment arrives once', () => {
    const env = journey.journeyEnv('C:\\scratch', { PATH: 'C:\\a', Path: 'C:\\a' }, 'win32');
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')).toHaveLength(1);
  });

  it('non-Windows machines get no APPDATA', () => {
    const env = journey.journeyEnv('/scratch', { PATH: '/bin', APPDATA: '/x' }, 'linux');
    expect(env.APPDATA).toBeUndefined();
    expect(env.LOCALAPPDATA).toBeUndefined();
  });

  it('a timed-out step is stopped with taskkill on Windows and the process group elsewhere', () => {
    // By full path under SystemRoot: a bare name is looked up in PATH (and maybe the current folder).
    expect(journey.killCommandFor('win32', 4321, 'C:\\Windows')).toEqual({ kind: 'taskkill', command: 'C:\\Windows\\System32\\taskkill.exe', args: ['/pid', '4321', '/T', '/F'] });
    expect(journey.killCommandFor('linux', 4321)).toEqual({ kind: 'group', pid: 4321 });
    expect(journey.killCommandFor('darwin', 4321)).toEqual({ kind: 'group', pid: 4321 });
  });
});

describe.skipIf(!POSIX)('setup runs the journey only when a supported host is present (set up now, or already wired)', () => {
  const run = (args: string[], home: string, extra: Record<string, string | undefined> = {}) => spawnSync(process.execPath, [REAL_CLI, ...args], {
    encoding: 'utf8', env: cliEnv(home, { PATH: nodeOnlyPath(), ...extra }), timeout: 90_000,
  });

  it('a host that is already wired and has nothing to do: still runs it', () => {
    const home = path.join(work, 'h-already');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    expect(run(['setup', '--yes'], home).status).toBe(0);
    fs.rmSync(path.join(home, '.memesh'), { recursive: true, force: true });
    const again = run(['setup'], home);
    expect(again.status).toBe(0);
    // No `claude` command on this PATH, so the MCP half cannot be probed: setup says what it could check and what it could not.
    expect(again.stdout).toContain('Everything that could be checked is wired.');
    expect(again.stdout).toContain('Journey PASSED');
    expect(JSON.parse(fs.readFileSync(path.join(home, '.memesh', 'post-install-journey.json'), 'utf8'))).toMatchObject({ ok: true, trigger: 'setup' });
  }, 200_000);

  it('a relocated Claude config folder (CLAUDE_CONFIG_DIR): setup --yes wires it there, exits 0 and runs the journey', () => {
    const home = path.join(work, 'h-relocated');
    const cfg = path.join(work, 'relocated-claude');
    fs.mkdirSync(home);
    fs.mkdirSync(cfg);
    const r = run(['setup', '--yes'], home, { CLAUDE_CONFIG_DIR: cfg });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Journey PASSED');
    expect(fs.existsSync(path.join(cfg, 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
  }, 100_000);

  it('the host CLIs setup asks never see a relocated Codex folder', () => {
    const home = path.join(work, 'h-codex');
    fs.mkdirSync(home);
    const bin = path.join(work, 'fake-bin');
    fs.mkdirSync(bin);
    const record = path.join(work, 'codex-saw.txt');
    fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nprintf '%s' "\${CODEX_HOME-UNSET}" > ${JSON.stringify(record)}\nexit 1\n`, { mode: 0o755 });
    const r = run(['setup', '--check'], home, { PATH: `${bin}${path.delimiter}${nodeOnlyPath()}` });
    expect(r.stdout, r.stderr).toContain('Codex CLI');
    expect(fs.readFileSync(record, 'utf8'), 'the fake codex was never asked').toBe('UNSET');
    expect(fs.readdirSync(hostConfig.codex)).toEqual([]);
  }, 60_000);

  it('the plan names the settings file that will really be written', () => {
    const home = path.join(work, 'h-label');
    const cfg = path.join(work, 'label-claude');
    fs.mkdirSync(home);
    fs.mkdirSync(cfg);
    const relocated = run(['setup', '--yes'], home, { CLAUDE_CONFIG_DIR: cfg });
    expect(relocated.stdout).toContain(`Wire the session hooks into ${path.join(cfg, 'settings.json')}`);
    expect(relocated.stdout).not.toContain('~/.claude/settings.json');
    const plain = path.join(work, 'h-label2');
    fs.mkdirSync(path.join(plain, '.claude'), { recursive: true });
    expect(run(['setup', '--yes'], plain).stdout).toContain(`Wire the session hooks into ${path.join(plain, '.claude', 'settings.json')}`);
  }, 120_000);

  it('install-hooks on a machine where the Claude Code plugin already wires the hooks: still runs it', () => {
    const home = path.join(work, 'h-plugin');
    const plugins = path.join(home, '.claude', 'plugins');
    fs.mkdirSync(plugins, { recursive: true });
    fs.writeFileSync(path.join(plugins, 'installed_plugins.json'), JSON.stringify({ plugins: { 'memesh@pcircle-memesh': [{ installPath: '/plugin/cache/memesh', version: '9.9.9' }] } }));
    const r = run(['install-hooks'], home);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('already wired via the Claude Code plugin runtime');
    expect(r.stdout).toContain('Journey PASSED');
    expect(JSON.parse(fs.readFileSync(path.join(home, '.memesh', 'post-install-journey.json'), 'utf8'))).toMatchObject({ ok: true, trigger: 'install-hooks' });
  }, 100_000);

  it('no host on this machine: says so, runs nothing, leaves no record', () => {
    const home = path.join(work, 'h-nohost');
    fs.mkdirSync(home);
    const r = run(['setup'], home);
    // A machine with no host is not a machine that is set up: it exits 1 (#528).
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain('Journey PASSED');
    expect(`${r.stdout}${r.stderr}`).toMatch(/No supported agent host was found/);
    expect(r.stdout).toContain('memesh doctor --journey');
    // One consistent story: nothing was set up, so it must not also say there is nothing to do because everything is wired.
    expect(r.stdout).not.toContain('Everything present is wired');
    expect(r.stdout).not.toContain('Nothing to do');
    expect(fs.existsSync(path.join(home, '.memesh', 'post-install-journey.json'))).toBe(false);
  }, 100_000);

  it('a host that setup wired: runs it', () => {
    const home = path.join(work, 'h-wired');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const r = run(['setup', '--yes'], home);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Journey PASSED');
    // Hooks were just written: an open Claude Code session does not have them yet.
    expect(r.stdout).toContain('Restart Claude Code (or open a new session) for hooks to take effect.');
    expect(r.stdout.indexOf('Restart Claude Code')).toBeLessThan(r.stdout.indexOf('Install journey'));
    expect(JSON.parse(fs.readFileSync(path.join(home, '.memesh', 'post-install-journey.json'), 'utf8'))).toMatchObject({ ok: true, trigger: 'setup' });
  }, 100_000);
});
