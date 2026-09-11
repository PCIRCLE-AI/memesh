import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDoctor as runDoctorImpl, formatDoctorReport } from '../../src/core/doctor.js';
import { HOOK_OUTCOMES_FILENAME, type HookOutcomeRecord } from '../../src/core/capture-liveness.js';
import type { UpdateCheck } from '../../src/core/version-check.js';
import type { InstallChannel } from '../../src/core/install-channel.js';

/**
 * The three capture-liveness verdicts, pinned by fixtures (#327).
 *
 * `hook-activity` next door answers "did a hook run". This row answers "and
 * did it SAVE anything", and the two came apart for two days on the owner's
 * graph: post-commit ran on every Bash call and skipped every one of them
 * (`git commit -q` prints no line to match), with every heartbeat green
 * throughout. Each fixture below is one of the three states that gap can be
 * in — healthy, ran-and-never-wrote, never-ran.
 */

const tempRoots: string[] = [];
const savedEnv: Array<[string, string | undefined]> = [];

afterEach(() => {
  for (const [key, value] of savedEnv.splice(0)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function setEnv(key: string, value: string | undefined) {
  savedEnv.push([key, process.env[key]]);
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

function makeUpdateCheck(): UpdateCheck {
  return {
    currentVersion: '4.0.3', latestVersion: '4.0.3',
    checkedAt: '2026-04-25T00:00:00.000Z', lastAttemptAt: '2026-04-25T00:00:00.000Z',
    lastSuccessfulCheckAt: '2026-04-25T00:00:00.000Z', lastError: null,
    updateAvailable: false, checkSucceeded: true, source: 'cache', freshness: 'cached',
    currentVersionDeprecated: false,
  } as UpdateCheck;
}

/**
 * A memesh dir holding exactly the outcome records a case is about. The row
 * reads a real file — a stub reader would prove only that the parser parses.
 */
function memeshDirWith(records: HookOutcomeRecord[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-liveness-'));
  tempRoots.push(dir);
  if (records.length) {
    fs.writeFileSync(
      path.join(dir, HOOK_OUTCOMES_FILENAME),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
  }
  setEnv('MEMESH_DIR', dir);
  setEnv('MEMESH_DB_PATH', undefined);
  setEnv('MEMESH_AUTO_CAPTURE', undefined);
  return dir;
}

function skips(hook: string, n: number, reason: string): HookOutcomeRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    hook, at: `2026-09-0${(i % 9) + 1}T00:00:00.000Z`, host: 'claude-code' as const,
    outcome: 'skipped' as const, reason,
  }));
}

/** Only the queries capture-liveness itself issues need real answers. */
function makeDatabase(opts: {
  stampedHooks?: string[];
  typeTrends?: Array<{ type: string; last7: number; prev7: number }>;
  trackingSinceHours?: number;
  legacyCaptured?: number;
} = {}) {
  const stamped = opts.stampedHooks ?? ['session-summary', 'post-commit'];
  const sqliteTs = (hoursAgo: number) =>
    new Date(Date.now() - hoursAgo * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
  return {
    prepare(sql: string) {
      if (sql.includes('GROUP BY e.type')) return { all: () => opts.typeTrends ?? [] };
      if (sql.includes('sqlite_master')) return { get: () => ({ present: 1 }) };
      if (sql.includes('FROM hook_runs')) {
        return {
          all: () => stamped.map((hook) => ({ hook, last_run_at: sqliteTs(1) })),
        };
      }
      if (sql.startsWith('UPDATE memesh_metadata')) return { run: () => undefined };
      if (sql.includes('hook_runs_since')) {
        return { get: () => ({ value: sqliteTs(opts.trackingSinceHours ?? 720) }) };
      }
      if (sql.includes('t.tag = ? AND e.created_at > ?')) {
        // The legacy-hook hedge query in inspectCaptureLiveness.
        return { get: () => ({ c: opts.legacyCaptured ?? 0 }) };
      }
      return { get: () => ({ c: 0 }), all: () => [] };
    },
  };
}

function packageRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-liveness-root-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, 'dashboard', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'dist', 'index.html'), '<html></html>');
  return root;
}

async function run(dbOpts: Parameters<typeof makeDatabase>[0] = {}, installChannel: InstallChannel = 'npm-global') {
  return runDoctorImpl({
    pluginCacheDiscoveryImpl: () => [],
    packageRoot: packageRoot(),
    packageVersion: '4.0.3',
    openDatabaseImpl: () => makeDatabase(dbOpts) as never,
    closeDatabaseImpl: () => undefined,
    getConfigPathImpl: () => path.join(packageRoot(), 'config.json'),
    getUpdateCheckImpl: async () => makeUpdateCheck(),
    getCurrentInstallChannelImpl: () => installChannel,
    getInstallChannelSupportImpl: () => ({
      channel: installChannel, label: 'npm global', canSelfUpdate: true,
      recommendedCommand: 'memesh update',
      guidance: 'This installation can be updated directly from MeMesh.',
    }) as never,
    nativeBindingProbeImpl: () => ({ ok: true }),
    resolveShellMemeshImpl: () => null,
  });
}

describe('doctor: capture-liveness', () => {
  it('PASS — the hooks are writing', async () => {
    memeshDirWith([
      ...skips('post-commit', 4, 'no commit line in output'),
      { hook: 'post-commit', at: '2026-09-09T00:00:00.000Z', host: 'claude-code', outcome: 'wrote', entity: 'commit-abc1234' },
      { hook: 'session-summary', at: '2026-09-09T01:00:00.000Z', host: 'claude-code', outcome: 'wrote', entity: 'session-s1-summary' },
    ]);
    const result = await run({ typeTrends: [{ type: 'commit', last7: 12, prev7: 9 }] });
    const check = result.checks.find((c) => c.id === 'capture-liveness');
    expect(check, 'the capture-liveness row is missing from the report').toBeDefined();
    expect(check!.status).toBe('pass');
    expect(check!.summary).toContain('post-commit');
    expect(result.capture?.status).toBe('PASS');
  });

  it('PASS_WITH_CONCERNS — a hook that ran and never wrote, named with its dominant reason', async () => {
    // The #321 shape exactly: 48 runs, 0 writes, 'no commit line in output'.
    memeshDirWith(skips('post-commit', 48, 'no commit line in output'));
    const result = await run();
    const check = result.checks.find((c) => c.id === 'capture-liveness')!;
    expect(check.status).toBe('warn');
    expect(check.code).toBe('capture-liveness.silent-hook');
    expect(check.summary).toContain('no commit line in output');
    // The RUN COUNT is the whole diagnostic: without it "0 writes" is just
    // a quiet week. The window caps at 20 records, so that is what it reports.
    expect(check.params?.runs).toBe(20);
    expect(check.params?.hook).toBe('post-commit');
    expect(result.capture?.status).toBe('PASS_WITH_CONCERNS');
    expect(result.capture?.hooks[0].writes).toBe(0);
    // The figures ride --json, not only the sentence.
    expect(JSON.stringify(result)).toContain('"capture"');
  });

  it('PASS_WITH_CONCERNS — a type that was being written stopped being written', async () => {
    memeshDirWith([
      { hook: 'session-summary', at: '2026-09-09T01:00:00.000Z', host: 'claude-code', outcome: 'wrote', entity: 'session-s1-summary' },
    ]);
    const result = await run({
      typeTrends: [
        { type: 'session-insight', last7: 4, prev7: 6 },
        { type: 'commit', last7: 0, prev7: 31 },
      ],
    });
    const check = result.checks.find((c) => c.id === 'capture-liveness')!;
    expect(check.status).toBe('warn');
    expect(check.code).toBe('capture-liveness.type-stopped');
    expect(check.params?.type).toBe('commit');
    expect(check.params?.prev).toBe(31);
    // A type that merely slowed down is NOT a concern — only one that stopped.
    expect(check.summary).not.toContain('session-insight');
  });

  it('FAIL — session-summary has neither a record nor a heartbeat since tracking began', async () => {
    memeshDirWith(skips('post-commit', 6, 'no commit line in output'));
    // Wired via the plugin runtime, so captureWired is true — this is the
    // case where a silent session-summary really is a defect, not a config.
    const result = await run({ stampedHooks: ['post-commit'] }, 'plugin-marketplace');
    const check = result.checks.find((c) => c.id === 'capture-liveness')!;
    expect(check.status).toBe('fail');
    expect(check.code).toBe('capture-liveness.never-ran');
    expect(check.params?.hook).toBe('session-summary');
    expect(result.capture?.status).toBe('FAIL');
    expect(formatDoctorReport(result, '4.0.3').join('\n')).toContain('Capture liveness');
  });

  it('never-ran on an MCP-only install is not a failure — no capture hook is wired', async () => {
    // A Codex / Gemini / Cursor install wires no capture hook. Past the
    // grace, session-summary has never run — but there is nothing that
    // should be running, so a FAIL here would be a permanent unfixable red.
    memeshDirWith(skips('post-commit', 6, 'no commit line in output'));
    const result = await run({ stampedHooks: [] });
    const check = result.checks.find((c) => c.id === 'capture-liveness')!;
    expect(check.status).not.toBe('fail');
    expect(check.code).toBe('capture-liveness.not-wired');
    expect(result.capture?.status).not.toBe('FAIL');
  });

  it('never-ran with auto-capture entities landing is version skew, not death', async () => {
    // Legacy hooks write entities without a heartbeat or an outcome record.
    // The never-ran FAIL must not fire over a graph that is provably still
    // being captured — the same hedge hook-activity takes.
    memeshDirWith(skips('post-commit', 6, 'no commit line in output'));
    const result = await run({ stampedHooks: [], legacyCaptured: 5 }, 'plugin-marketplace');
    const check = result.checks.find((c) => c.id === 'capture-liveness')!;
    expect(check.status).toBe('warn');
    expect(check.code).toBe('capture-liveness.never-ran-legacy');
    expect(check.summary).toContain('5');
  });

  it('the never-ran FAIL waits out the grace — a fresh install is not a defect', async () => {
    memeshDirWith([]);
    const result = await run({ stampedHooks: [], trackingSinceHours: 2 });
    const check = result.checks.find((c) => c.id === 'capture-liveness')!;
    expect(check.status, 'a two-hour-old install has nothing to report yet').toBe('pass');
  });

  it('a hook whose trigger depends on the user can never FAIL, however long it is silent', async () => {
    // post-commit fires on a commit. A fortnight without one is a way of
    // working, not a broken install, and a permanent unfixable red would
    // teach the user to ignore this row.
    memeshDirWith([
      { hook: 'session-summary', at: '2026-09-09T01:00:00.000Z', host: 'claude-code', outcome: 'wrote', entity: 'session-s1-summary' },
    ]);
    const result = await run({ stampedHooks: ['session-summary'], trackingSinceHours: 5000 });
    const check = result.checks.find((c) => c.id === 'capture-liveness')!;
    expect(check.status).not.toBe('fail');
  });

  it('capture deliberately turned off is a configuration, not a failure', async () => {
    memeshDirWith(skips('post-commit', 40, 'auto-capture is turned off'));
    setEnv('MEMESH_AUTO_CAPTURE', 'false');
    const result = await run({ stampedHooks: [] });
    const check = result.checks.find((c) => c.id === 'capture-liveness')!;
    expect(check.status).toBe('pass');
    expect(check.summary).toContain('turned off');
  });
});
