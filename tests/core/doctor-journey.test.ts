/**
 * The install journey (`memesh doctor --journey`, and the run after
 * `install-hooks` / `setup`). Every case goes through the real packaged CLI
 * (dist/transports/cli/cli.js) — the point of the journey is that it proves the
 * built bundle works, so a test that called remember() directly would prove
 * nothing it is meant to prove.
 *
 * Failures are injected with a wrapper entry that answers ONE subcommand
 * wrongly and hands everything else to the real CLI, so each step's checker is
 * driven by the shapes a broken install actually produces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import net from 'net';
import path from 'path';
import {
  formatJourney,
  journeyEnv,
  journeyRecordPath,
  journeySkipped,
  readJourneyRecord,
  runInstallJourney,
  runPostInstallJourney,
  toJourneyRecord,
  writeJourneyRecord,
  type JourneyStepId,
} from '../../src/core/doctor-journey.js';

const PACKAGE_ROOT = path.resolve('.');
const REAL_CLI = path.join(PACKAGE_ROOT, 'dist/transports/cli/cli.js');

let work: string;
/** The temp folder this file's journeys use: private, so another journey running on the machine cannot show up in a count. */
let privateTmp: string;
let savedTmpEnv: Record<string, string | undefined>;
/** Host config folders set to empty folders: any child that writes a host's hooks into them has leaked. */
let hostConfig: { claude: string; codex: string };
const SKIP_VAR = 'MEMESH_SKIP_POST_INSTALL_JOURNEY';
beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-journey-test-'));
  privateTmp = path.join(work, 'tmp');
  fs.mkdirSync(privateTmp);
  hostConfig = { claude: path.join(work, 'host-claude'), codex: path.join(work, 'host-codex') };
  fs.mkdirSync(hostConfig.claude);
  fs.mkdirSync(hostConfig.codex);
  savedTmpEnv = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME, [SKIP_VAR]: process.env[SKIP_VAR], MEMESH_DIR: process.env.MEMESH_DIR, MEMESH_DB_PATH: process.env.MEMESH_DB_PATH };
  // An outside MEMESH_DB_PATH/MEMESH_DIR would send record reads and writes at someone's real data.
  delete process.env.MEMESH_DIR;
  delete process.env.MEMESH_DB_PATH;
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = privateTmp;
  process.env.CLAUDE_CONFIG_DIR = hostConfig.claude;
  process.env.CODEX_HOME = hostConfig.codex;
  delete process.env[SKIP_VAR];
});
afterEach(() => {
  // Nothing in this file may have written into a host's config folder.
  const leaked = [...fs.readdirSync(hostConfig.claude), ...fs.readdirSync(hostConfig.codex)];
  for (const [key, value] of Object.entries(savedTmpEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  expect(leaked, 'a test wrote into a host config folder').toEqual([]);
});

/** A CLI entry that misbehaves on one subcommand and is the real CLI otherwise. */
function brokenCli(match: string[], behaviour: string): string {
  const file = path.join(work, `broken-${match.join('-')}.mjs`);
  fs.writeFileSync(file, `
const argv = process.argv.slice(2);
const hit = ${JSON.stringify(match)}.every((word, i) => argv[i] === word);
if (hit) { ${behaviour} }
const { spawnSync } = await import('node:child_process');
const r = spawnSync(process.execPath, [${JSON.stringify(REAL_CLI)}, ...argv], { stdio: 'inherit', env: process.env });
process.exit(r.status ?? 1);
`);
  return file;
}

const scratchDirs = () => fs.readdirSync(privateTmp).filter((n) => n.startsWith('memesh-journey-'));

/**
 * A stand-in for everything a journey must not reach, each reachable through an
 * environment variable the real programs consult: the data folder (HOME,
 * MEMESH_DIR, MEMESH_DB_PATH), a live router (MEMESH_ROUTER_SOCKET — a real
 * listening socket that counts connections), and the host config folders. The
 * variables are set on this process; the caller's journey inherits them unless
 * its environment is allow-listed.
 */
/** Async on purpose: while spawnSync blocks, this process cannot accept a connection on the sentinel router socket. */
function runAsync(command: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number }): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: options.env, cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out after ${options.timeoutMs ?? 60_000} ms: ${args.join(' ')}`)); }, options.timeoutMs ?? 60_000);
    child.once('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

function sentinelWorld() {
  const home = path.join(work, 'real-home');
  const data = path.join(home, '.memesh');
  const dirs = [home, path.join(work, 'xdg'), path.join(work, 'codex-home'), path.join(work, 'claude-config')];
  fs.mkdirSync(data, { recursive: true });
  for (const dir of dirs.slice(1)) fs.mkdirSync(dir);
  for (const dir of [data, ...dirs.slice(1)]) fs.writeFileSync(path.join(dir, 'sentinel.txt'), 'real user data');
  for (const f of ['knowledge-graph.db', 'knowledge-graph.db-wal', 'knowledge-graph.db-shm', 'config.json']) {
    fs.writeFileSync(path.join(data, f), 'real user data');
  }
  const snapshot = () => dirs.flatMap((root) => fs.readdirSync(root, { recursive: true }).map(String).sort().map((rel) => {
    const st = fs.statSync(path.join(root, rel));
    return `${root}|${rel}|${st.isFile() ? st.size : 'dir'}|${st.mtimeMs}`;
  }));
  const before = snapshot();
  const socketPath = path.join(work, 'r.sock');
  let connections = 0;
  const server = net.createServer((conn) => { connections += 1; conn.destroy(); });
  const listening = process.platform === 'win32'
    ? Promise.resolve()
    : new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const saved = { ...process.env };
  Object.assign(process.env, {
    HOME: home, USERPROFILE: home, MEMESH_DIR: data, MEMESH_DB_PATH: path.join(data, 'knowledge-graph.db'),
    MEMESH_ROUTER_SOCKET: socketPath, XDG_CONFIG_HOME: dirs[1], CODEX_HOME: dirs[2], CLAUDE_CONFIG_DIR: dirs[3],
    // Variables that name files or change behaviour. Only the 1-byte message quota
    // changes what these four steps do (it refuses every send); the others are
    // covered by the allow-list unit test below, since no step reads them today.
    MEMESH_UPDATE_CHECK_PATH: path.join(dirs[1], 'update-check.json'),
    MEMESH_ROUTER_TOKEN_FILE: path.join(dirs[1], 'router.token'),
    MEMESH_HOST_CONFIG: path.join(dirs[1], 'host.json'),
    CLAUDE_PROJECTS_DIR: path.join(dirs[3], 'projects'),
    MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES: '1',
  });
  return {
    home,
    ready: listening,
    routerConnections: () => connections,
    changed: () => connections > 0 || JSON.stringify(snapshot()) !== JSON.stringify(before),
    expectUntouched: () => {
      expect(snapshot()).toEqual(before);
      expect(fs.readFileSync(path.join(data, 'knowledge-graph.db'), 'utf8')).toBe('real user data');
      expect(connections).toBe(0);
    },
    close: async () => {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      await new Promise<void>((resolve) => { if (server.listening) server.close(() => resolve()); else resolve(); });
    },
  };
}

/** The environment of a CLI child: the throwaway HOME, and nothing that relocates data or a host's config. */
function childEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of ['MEMESH_DIR', 'MEMESH_DB_PATH', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', SKIP_VAR]) delete env[key];
  return { ...env, ...extra };
}

describe('journey through the real packaged CLI', () => {
  it('passes, takes seconds, and leaves nothing behind', async () => {
    const before = scratchDirs();
    const result = await runInstallJourney({ packageRoot: PACKAGE_ROOT });
    expect(result.steps.map((s) => [s.id, s.ok])).toEqual([['remember', true], ['recall', true], ['send', true], ['fetch', true]]);
    expect(result.ok).toBe(true);
    expect(result.elapsedMs).toBeLessThan(15_000);
    expect(result.cleaned).toBe(true);
    expect(fs.existsSync(result.scratchDir)).toBe(false);
    expect(scratchDirs()).toEqual(before);
    const text = formatJourney(result).join('\n');
    expect(text).toContain('Journey PASSED');
    expect(text).toContain('memesh message fetch');
  }, 60_000);

  it('does not touch the real data folder, the router or the host config folders, even when the environment points at them', async () => {
    const world = sentinelWorld();
    await world.ready;
    try {
      const result = await runInstallJourney({ packageRoot: PACKAGE_ROOT });
      expect(result.ok, JSON.stringify(result.steps)).toBe(true);
      world.expectUntouched();
    } finally {
      await world.close();
    }
  }, 60_000);

  it('the packaged bundle leaves the same sentinel world alone', async () => {
    const world = sentinelWorld();
    await world.ready;
    try {
      const r = await runAsync(process.execPath, [REAL_CLI, 'doctor', '--journey'], { env: process.env, cwd: world.home });
      expect(r.status, r.stderr).toBe(0);
      world.expectUntouched();
    } finally {
      await world.close();
    }
  }, 60_000);

  it('the sentinel world catches a bundle that inherits the whole environment', async () => {
    // Detector check: the same bundle with its allow-list widened to everything
    // must be seen reaching the router the environment names.
    const world = sentinelWorld();
    await world.ready;
    try {
      const bundle = fs.readFileSync(REAL_CLI, 'utf8');
      const needle = 'function journeyEnv(scratch, base = process.env, platform = process.platform) {';
      expect(bundle).toContain(needle);
      const pkg = path.join(work, 'inherit-pkg');
      fs.mkdirSync(path.join(pkg, 'dist/transports/cli'), { recursive: true });
      fs.copyFileSync(path.join(PACKAGE_ROOT, 'package.json'), path.join(pkg, 'package.json'));
      const cli = path.join(pkg, 'dist/transports/cli/cli.js');
      fs.writeFileSync(cli, bundle.replace(needle, `${needle}\n  PASSTHROUGH_ENV.push(...Object.keys(base));`));
      const r = await runAsync(process.execPath, [cli, 'doctor', '--journey'], { env: process.env, cwd: world.home });
      // The ambient variables reached the step: it either touched the sentinels or
      // failed on the sentinel's own 1-byte message quota. A journey that failed
      // for any other reason would not satisfy this.
      expect(world.changed() || /quota/i.test(r.stdout + r.stderr), `${r.status}\n${r.stdout}\n${r.stderr}`).toBe(true);
    } finally {
      await world.close();
    }
  }, 60_000);

  it('hands the child only an allow-listed environment', () => {
    const hostVariables = {
      CLAUDE_CONFIG_DIR: '/real/claude', CODEX_HOME: '/real/codex', XDG_CONFIG_HOME: '/real/xdg', MEMESH_UPDATE_CHECK_PATH: '/real/u',
      MEMESH_HOST_CONFIG: '/real/hc', CLAUDE_PROJECTS_DIR: '/real/projects', MEMESH_ROUTER_TOKEN_FILE: '/real/t',
    };
    const env = journeyEnv('/scratch', {
      PATH: '/bin', HOME: '/real', MEMESH_DB_PATH: '/real/db', MEMESH_DIR: '/real', MEMESH_ROUTER_SOCKET: '/real/s',
      CLAUDE_CODE_SESSION_ID: 'abc', ANTHROPIC_API_KEY: 'k', NODE_OPTIONS: '--require /evil.js', ...hostVariables,
    });
    expect(env.PATH).toBe('/bin');
    expect(env.HOME).toBe('/scratch');
    expect(env.MEMESH_DIR).toBe(path.join('/scratch', '.memesh'));
    expect(env.MEMESH_DB_PATH).toBe(path.join('/scratch', '.memesh', 'knowledge-graph.db'));
    for (const leaked of ['MEMESH_ROUTER_SOCKET', 'CLAUDE_CODE_SESSION_ID', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS', ...Object.keys(hostVariables)]) {
      expect(env[leaked]).toBeUndefined();
    }
    // The whole set, not four names: any variable added to the step is a decision to make here.
    expect(Object.keys(env).sort()).toEqual(['HOME', 'MEMESH_AUTO_CAPTURE', 'MEMESH_DB_PATH', 'MEMESH_DIR', 'PATH', 'USERPROFILE']);
  });
});

const cleanupsLocal: Array<() => void> = [];
afterEach(() => { while (cleanupsLocal.length) cleanupsLocal.pop()!(); });

describe('every step fails loudly with its own reason', () => {
  const cases: Array<{ step: JourneyStepId; match: string[]; behaviour: string; reason: RegExp; ran: JourneyStepId[] }> = [
    { step: 'remember', match: ['remember'], behaviour: `console.error('boom: cannot open database'); process.exit(3);`, reason: /command failed: boom: cannot open database/, ran: ['remember'] },
    { step: 'remember', match: ['remember'], behaviour: `console.log('{"stored":false}'); process.exit(0);`, reason: /did not report the note as stored/, ran: ['remember'] },
    { step: 'remember', match: ['remember'], behaviour: `console.log('{"stored":false,"name":"x"}'); process.exit(0);`, reason: /did not report the note as stored/, ran: ['remember'] },
    { step: 'recall', match: ['recall'], behaviour: `console.log('{"entities":[{"name":"other"}]}'); process.exit(0);`, reason: /found 1 other result\(s\)/, ran: ['remember', 'recall'] },
    { step: 'recall', match: ['recall'], behaviour: `console.log('{"entities":[]}'); process.exit(0);`, reason: /stored but a search for it found nothing/, ran: ['remember', 'recall'] },
    { step: 'recall', match: ['recall'], behaviour: `console.log('not json'); process.exit(0);`, reason: /not a result list/, ran: ['remember', 'recall'] },
    { step: 'send', match: ['message', 'send'], behaviour: `console.error('Error: router unavailable'); process.exit(1);`, reason: /command failed: Error: router unavailable/, ran: ['remember', 'recall', 'send'] },
    { step: 'send', match: ['message', 'send'], behaviour: `console.log('{}'); process.exit(0);`, reason: /did not return a message id/, ran: ['remember', 'recall', 'send'] },
    { step: 'fetch', match: ['message', 'fetch'], behaviour: `console.error('Error: not available'); process.exit(1);`, reason: /command failed: Error: not available/, ran: ['remember', 'recall', 'send', 'fetch'] },
    { step: 'fetch', match: ['message', 'fetch'], behaviour: `console.log('{"payload":"something else"}'); process.exit(0);`, reason: /came back with different content/, ran: ['remember', 'recall', 'send', 'fetch'] },
  ];

  for (const c of cases) {
    it(`${c.step}: ${c.reason.source}`, async () => {
      const result = await runInstallJourney({ packageRoot: PACKAGE_ROOT }, { cliEntry: brokenCli(c.match, c.behaviour) });
      expect(result.ok).toBe(false);
      expect(result.failedStep).toBe(c.step);
      expect(result.steps.map((s) => s.id)).toEqual(c.ran);
      const failed = result.steps[result.steps.length - 1];
      expect(failed.ok).toBe(false);
      expect(failed.reason).toMatch(c.reason);
      expect(failed.fix).toBeTruthy();
      // Every earlier step still shows as having worked.
      expect(result.steps.slice(0, -1).every((s) => s.ok)).toBe(true);
      const text = formatJourney(result).join('\n');
      expect(text).toContain(`Journey FAILED`);
      expect(text).toContain(`at "${c.step}"`);
      expect(text).toMatch(/Why: /);
      expect(text).toMatch(/Fix: /);
      // The throwaway folder is gone on failure too.
      expect(result.cleaned).toBe(true);
      expect(fs.existsSync(result.scratchDir)).toBe(false);
    }, 60_000);
  }

  it('a missing installed command is reported, not thrown', async () => {
    const result = await runInstallJourney({ packageRoot: PACKAGE_ROOT }, { cliEntry: path.join(work, 'nope.js') });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe('remember');
    expect(result.steps[0].reason).toContain('does not exist');
    expect(result.cleaned).toBe(true);
  });

  it('a hung step is stopped at the timeout and counted as a failure', async () => {
    const pidFile = path.join(work, 'hung-send.pid');
    cleanupsLocal.push(() => { try { const pid = Number(fs.readFileSync(pidFile, 'utf8')); if (pid) process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
    const hang = brokenCli(['message', 'send'], `(await import('node:fs')).writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); await new Promise(() => setInterval(() => {}, 1000));`);
    const started = Date.now();
    // A budget that a slow machine does not use up on the first steps; the total is still bounded.
    const result = await runInstallJourney({ packageRoot: PACKAGE_ROOT }, { cliEntry: hang, timeoutMs: 10_000 });
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.failedStep).toBe('send');
    expect(result.steps[result.steps.length - 1].result).toBe('timed out');
    expect(formatJourney(result).join('\n')).toContain('(timed out)');
    // "is stopped" means the process is gone, not just that the verdict came.
    const hungPid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(hungPid).toBeGreaterThan(0);
    const dead = async () => { for (let i = 0; i < 60; i += 1) { try { process.kill(hungPid, 0); } catch { return true; } await new Promise((r) => setTimeout(r, 50)); } return false; };
    expect(await dead(), 'the hung step is still running').toBe(true);
    expect(result.cleaned).toBe(true);
  }, 60_000);
});

describe('opt-out', () => {
  it('--no-journey (commander sets journey=false) and the environment variable both skip', () => {
    expect(journeySkipped(false, {})).toBe(true);
    expect(journeySkipped(true, {})).toBe(false);
    expect(journeySkipped(undefined, {})).toBe(false);
    expect(journeySkipped(undefined, { MEMESH_SKIP_POST_INSTALL_JOURNEY: '1' })).toBe(true);
    expect(journeySkipped(undefined, { MEMESH_SKIP_POST_INSTALL_JOURNEY: 'true' })).toBe(true);
    expect(journeySkipped(undefined, { MEMESH_SKIP_POST_INSTALL_JOURNEY: '0' })).toBe(false);
    expect(journeySkipped(undefined, { MEMESH_SKIP_POST_INSTALL_JOURNEY: 'false' })).toBe(false);
    expect(journeySkipped(undefined, { MEMESH_SKIP_POST_INSTALL_JOURNEY: 'FALSE' })).toBe(false);
    expect(journeySkipped(undefined, { MEMESH_SKIP_POST_INSTALL_JOURNEY: '' })).toBe(false);
  });
});

describe('the record memesh doctor reads', () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
    process.env.MEMESH_DIR = path.join(work, 'data');
    delete process.env.MEMESH_DB_PATH;
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    vi.restoreAllMocks();
  });

  it('a failed automatic run prints loudly, saves the reason, and the call resolves', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(runPostInstallJourney(
      { packageRoot: PACKAGE_ROOT, version: '9.9.9', trigger: 'install-hooks' },
      { cliEntry: brokenCli(['recall'], `console.log('{"entities":[]}'); process.exit(0);`) },
    )).resolves.toBeUndefined();
    expect(err.mock.calls.flat().join('\n')).toContain('Journey FAILED');
    expect(err.mock.calls.flat().join('\n')).toContain('does not undo it');
    const record = readJourneyRecord();
    expect(record).toMatchObject({ ok: false, version: '9.9.9', trigger: 'install-hooks', failedStep: 'recall' });
    expect((record as { reason: string }).reason).toMatch(/found nothing/);
  }, 60_000);

  it('a passing run saves ok=true; skipping saves nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runPostInstallJourney({ packageRoot: PACKAGE_ROOT, version: '9.9.9', trigger: 'setup' });
    expect(readJourneyRecord()).toMatchObject({ ok: true, trigger: 'setup' });
    fs.rmSync(journeyRecordPath());
    await runPostInstallJourney({ packageRoot: PACKAGE_ROOT, version: '9.9.9', trigger: 'setup', journeyFlag: false });
    expect(readJourneyRecord()).toBeUndefined();
    expect(log.mock.calls.flat().join('\n')).toContain('skipped (--no-journey)');
  }, 60_000);

  it('an unreadable record is reported as such, not as "never ran"', () => {
    fs.mkdirSync(process.env.MEMESH_DIR!, { recursive: true });
    fs.writeFileSync(journeyRecordPath(), '{"nope":1}');
    expect(readJourneyRecord()).toEqual({ unreadable: 'post-install-journey.json is not a journey record' });
  });

  it('write then read round-trips', () => {
    const rec = toJourneyRecord({ ok: true, steps: [], timedOut: false, elapsedMs: 1, scratchDir: '', cleaned: true }, '1.2.3', 'doctor');
    writeJourneyRecord(rec);
    expect(readJourneyRecord()).toEqual(rec);
  });
});

/** The `install-journey` row out of `memesh doctor --json`. */
function doctorRow(stdout: string): { id: string; status: string; code?: string; summary: string; informational?: boolean } | undefined {
  const start = stdout.indexOf('{\n');
  const parsed = JSON.parse(stdout.slice(start)) as { checks: Array<{ id: string; status: string; code?: string; summary: string; informational?: boolean }> };
  return parsed.checks.find((c) => c.id === 'install-journey');
}

describe('through the CLI commands', () => {
  const runCli = (args: string[], home: string, extra: Record<string, string> = {}) => {
    const env = childEnv(home, extra);
    return spawnSync(process.execPath, [REAL_CLI, ...args], { encoding: 'utf8', env, timeout: 90_000 });
  };

  it('doctor --journey: exit 0 and creates nothing under HOME', () => {
    const home = path.join(work, 'h1');
    fs.mkdirSync(home);
    const r = runCli(['doctor', '--journey'], home);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Journey PASSED');
    expect(fs.readdirSync(home)).toEqual([]);
    // No record yet: doctor says so, as information, not as a verdict.
    const doctor = runCli(['doctor', '--json'], home);
    expect(doctorRow(doctor.stdout)).toMatchObject({ informational: true, status: 'pass' });
    expect(doctorRow(doctor.stdout)?.summary).toContain('No install journey recorded yet');
  }, 100_000);

  it('install-hooks runs the journey and records it; --no-journey and the env var skip it', () => {
    const home = path.join(work, 'h2');
    fs.mkdirSync(home);
    const ran = runCli(['install-hooks'], home);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain('Journey PASSED');
    expect(JSON.parse(fs.readFileSync(path.join(home, '.memesh', 'post-install-journey.json'), 'utf8'))).toMatchObject({ ok: true, trigger: 'install-hooks' });

    const flagHome = path.join(work, 'h3');
    fs.mkdirSync(flagHome);
    const flagged = runCli(['install-hooks', '--no-journey'], flagHome);
    expect(flagged.status).toBe(0);
    expect(flagged.stdout).toContain('Install journey skipped (--no-journey)');
    expect(fs.existsSync(path.join(flagHome, '.memesh', 'post-install-journey.json'))).toBe(false);

    const envHome = path.join(work, 'h4');
    fs.mkdirSync(envHome);
    const envd = runCli(['install-hooks'], envHome, { MEMESH_SKIP_POST_INSTALL_JOURNEY: '1' });
    expect(envd.status).toBe(0);
    expect(envd.stdout).toContain('skipped (MEMESH_SKIP_POST_INSTALL_JOURNEY)');
    expect(fs.existsSync(path.join(envHome, '.memesh', 'post-install-journey.json'))).toBe(false);

    const dry = runCli(['install-hooks', '--dry-run'], path.join(work, 'h5-missing-ok'));
    expect(dry.status).toBe(0);
    expect(dry.stdout).not.toContain('Install journey');
  }, 200_000);

  it('a broken journey does not change the install exit code, is printed, and shows in memesh doctor', () => {
    // A copy of the packaged CLI whose journey asks `remember` for a flag that
    // does not exist: the same bundle, a genuinely failing first step.
    const pkgCopy = path.join(work, 'pkg');
    fs.mkdirSync(path.join(pkgCopy, 'dist/transports/cli'), { recursive: true });
    fs.cpSync(path.join(PACKAGE_ROOT, 'hooks'), path.join(pkgCopy, 'hooks'), { recursive: true });
    fs.cpSync(path.join(PACKAGE_ROOT, 'scripts/hooks'), path.join(pkgCopy, 'scripts/hooks'), { recursive: true });
    fs.copyFileSync(path.join(PACKAGE_ROOT, 'package.json'), path.join(pkgCopy, 'package.json'));
    const bundle = fs.readFileSync(REAL_CLI, 'utf8');
    const needle = 'args: () => ["remember", noteText, "--json"]';
    expect(bundle).toContain(needle);
    const copyCli = path.join(pkgCopy, 'dist/transports/cli/cli.js');
    fs.writeFileSync(copyCli, bundle.replace(needle, 'args: () => ["remember", noteText, "--no-such-flag"]'));

    const home = path.join(work, 'h6');
    fs.mkdirSync(home);
    const env = childEnv(home);
    const install = spawnSync(process.execPath, [copyCli, 'install-hooks'], { encoding: 'utf8', env, timeout: 90_000 });
    expect(install.status).toBe(0);
    expect(install.stderr).toContain('Journey FAILED');
    expect(install.stderr).toContain('unknown option');
    expect(JSON.parse(fs.readFileSync(path.join(home, '.memesh', 'post-install-journey.json'), 'utf8'))).toMatchObject({ ok: false, failedStep: 'remember' });

    const doctor = spawnSync(process.execPath, [REAL_CLI, 'doctor', '--json'], { encoding: 'utf8', env, timeout: 90_000 });
    expect(doctorRow(doctor.stdout)).toMatchObject({ status: 'warn', code: 'install-journey.failed' });
    expect(doctorRow(doctor.stdout)?.summary).toMatch(/journey failed at "remember"/);
    const human = spawnSync(process.execPath, [REAL_CLI, 'doctor'], { encoding: 'utf8', env, timeout: 90_000 });
    expect(human.stdout).toContain('Install journey');

    // Re-running the journey for real replaces the stale failure.
    const fixed = spawnSync(process.execPath, [REAL_CLI, 'doctor', '--journey'], { encoding: 'utf8', env, timeout: 90_000 });
    expect(fixed.status).toBe(0);
    const afterFix = spawnSync(process.execPath, [REAL_CLI, 'doctor', '--json'], { encoding: 'utf8', env, timeout: 90_000 });
    expect(doctorRow(afterFix.stdout)).toMatchObject({ status: 'pass' });
    expect(doctorRow(afterFix.stdout)?.informational).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(home, '.memesh', 'post-install-journey.json'), 'utf8'))).toMatchObject({ ok: true, trigger: 'doctor' });

    // And the copy's own doctor --journey fails with exit 1.
    const failing = spawnSync(process.execPath, [copyCli, 'doctor', '--journey'], { encoding: 'utf8', env, timeout: 90_000 });
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain('Journey FAILED');
  }, 300_000);
});
