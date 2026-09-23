import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCoreLiveJourneys } from '../../scripts/qa/core-live-journeys.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dirs: string[] = [];

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-core-live-journeys-'));
  dirs.push(dir);
  return dir;
}

// Mirrors the module's own defaultCli (not exported) so this test can run
// every call through the real built CLI except the one it deliberately
// intercepts.
function realCli({ args, env, cwd, input }: { args: string[]; env: NodeJS.ProcessEnv; cwd: string; input?: string }) {
  return spawnSync(process.execPath, [path.join(cwd, 'dist/transports/cli/cli.js'), ...args], {
    cwd, env, input, encoding: 'utf8', timeout: 20_000,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('core live journeys', () => {
  it('runs every core journey against isolated real CLI and hook processes', async () => {
    const runDir = fixture();
    const report = await runCoreLiveJourneys({ repoRoot, runDir });

    expect(report.schema).toBe('memesh-core-live-journeys/v1');
    expect(report.runDir).toBe(fs.realpathSync(runDir));
    expect(report.journeys.map((journey) => journey.id)).toEqual([
      'memory-round-trip', 'session-start-briefing', 'quiet-commit-capture', 'stop-session-insight',
    ]);
    expect(report.journeys.every((journey) => journey.status === 'PASS' && journey.boundary === 'isolated-process')).toBe(true);
    expect(report.journeys.every((journey) => journey.success.observed && journey.failure.observed && journey.effect_readback.observed)).toBe(true);
    expect(report.journeys[0].success.operations).toEqual(['remember', 'recall', 'replace', 'forget']);
    expect(report.journeys[0].failure.invalidRememberExit).toBeGreaterThan(0);
    expect(report.journeys[0].failure.missingForgetExit).toBeGreaterThan(0);
    expect(report.journeys[0].effect_readback).toMatchObject({
      replacementRecalled: true,
      archivedReadback: true,
    });
    expect(report.journeys[1].success.operations).toEqual(['task_state', 'briefing', 'SessionStart']);
    expect(report.journeys[1].effect_readback).toMatchObject({ taskStateReadback: true, cliBriefing: true });
    expect(report.journeys[2].failure.unchangedHeadSkip).toMatch(/HEAD did not change/);
    expect(report.journeys[3].failure.missingTranscriptSkip).toMatch(/transcript file named/);
    for (const journey of report.journeys) {
      expect(journey.cleanup).toMatchObject({ status: 'PASS', removed: true, scope: journey.id });
      expect(fs.existsSync(path.join(runDir, journey.id))).toBe(false);
    }
  });

  it('fails closed when its injected CLI dependency cannot execute', async () => {
    const runDir = fixture();
    await expect(runCoreLiveJourneys({
      repoRoot,
      runDir,
      cli: () => ({ status: 73, stdout: '', stderr: 'controlled CLI failure' }),
    })).rejects.toThrow(/remember failed \(exit 73\).*controlled CLI failure/);
    expect(fs.existsSync(path.join(runDir, 'memory-round-trip'))).toBe(false);
  });

  it('routes the standard-level briefing override through the injected CLI runner, not a hardcoded path', async () => {
    const runDir = fixture();
    const cli = (opts: { args: string[]; env: NodeJS.ProcessEnv; cwd: string; input?: string }) =>
      opts.env.MEMESH_BRIEFING === 'standard'
        ? { status: 73, stdout: '', stderr: 'controlled standard-env failure' }
        : realCli(opts);
    // If session-start-briefing ever regresses to spawning `dist/transports/cli/cli.js`
    // directly for the standard-override check (bypassing the `cli` parameter this
    // function is injected with), this wrapper never sees that call and the journey
    // wrongly succeeds instead of surfacing the controlled failure below.
    await expect(runCoreLiveJourneys({ repoRoot, runDir, cli }))
      .rejects.toThrow(/standard-level briefing readback failed \(exit 73\).*controlled standard-env failure/);
  });

  it('overrides an inherited database path so the caller graph remains untouched', async () => {
    const runDir = fixture();
    const callerDb = path.join(runDir, 'caller', 'knowledge-graph.db');
    await runCoreLiveJourneys({ repoRoot, runDir, env: { MEMESH_DB_PATH: callerDb } });
    expect(fs.existsSync(callerDb)).toBe(false);
  });

  it('does not pass ambient Git configuration or tracing to child processes', async () => {
    const callerDir = fixture();
    const trace = path.join(callerDir, 'git-trace');
    const marker = path.join(callerDir, 'hook-ran');
    const hooks = path.join(callerDir, 'hooks');
    fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, 'pre-commit'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
    const config = path.join(callerDir, 'gitconfig');
    fs.writeFileSync(config, `[core]\n hooksPath = ${hooks}\n`);
    vi.stubEnv('GIT_TRACE', trace);
    vi.stubEnv('GIT_CONFIG_GLOBAL', config);
    await runCoreLiveJourneys({ repoRoot, runDir: fixture() });
    expect(fs.existsSync(trace)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });
});
