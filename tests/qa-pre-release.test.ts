/**
 * The pre-release gate has to be honest about two things: what it ran, and
 * what it did not.
 *
 * The parity test is the load-bearing one. A step naming an npm script that
 * does not exist would make `npm run` print "Missing script" and exit non-zero
 * — a red gate for a reason that has nothing to do with the release — and a
 * step silently renamed away is worse: it reads as coverage that is gone.
 *
 * The two spawned runs use a throwaway package.json whose scripts are `node
 * -e`, so the exit-code plumbing is exercised for real (a spawned npm, a real
 * status, a real verdict) in about a second, instead of running the release
 * suite twice.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { NOT_CHECKED, STEPS, formatVerdict, unknownSteps, cacheableReceiptPath } from '../scripts/qa/pre-release.mjs';
import { LIVE_JOURNEY_SCHEMA_VERSION } from '../scripts/lib/live-journey-contract.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gate = path.join(repoRoot, 'scripts', 'qa', 'pre-release.mjs');

// Every fixture repository this file creates, removed when it is done. Three
// per run were being left in $TMPDIR; 42 of them had accumulated by the time
// a reviewer counted.
const fixtureDirs: string[] = [];
afterAll(() => {
  for (const dir of fixtureDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A package.json with the gate's own step names bound to trivial commands. */
function fixtureRepo(failing: string | null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-pre-release-fixture-'));
  fixtureDirs.push(dir);
  const scripts: Record<string, string> = {};
  for (const step of STEPS) {
    scripts[step.id] = step.id === failing ? 'node -e "process.exit(3)"' : 'node -e "0"';
  }
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.0', scripts }, null, 2));
  return dir;
}

function runGate(cwd: string) {
  return spawnSync(process.execPath, [gate], { cwd, encoding: 'utf8', timeout: 120_000 });
}

/**
 * Same shape as `fixtureRepo`, but a real git repo (so `treeHash` — the
 * caching decision — resolves instead of throwing) whose `verify:artifact`
 * script appends one line to a run log every time it ACTUALLY runs. A cache
 * hit must leave that log with exactly one line no matter how many times the
 * gate is invoked against the unchanged commit.
 *
 * The log lives OUTSIDE the repo directory on purpose: a script writing
 * inside the tree it is being measured against would change `treeHash` on
 * every real run, and a caching test built on a tree hash that moves under
 * it would not be testing what it claims to.
 */
function gitFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-pre-release-git-fixture-'));
  fixtureDirs.push(dir);
  const runsLog = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-pre-release-runs-')) + '/runs.log';
  fixtureDirs.push(path.dirname(runsLog));
  fs.writeFileSync(runsLog, '');
  const run = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  run(['init', '--quiet']);
  run(['config', 'user.email', 'test@example.invalid']);
  run(['config', 'user.name', 'test']);
  const scripts: Record<string, string> = {};
  for (const step of STEPS) {
    scripts[step.id] = step.id === 'verify:artifact'
      ? `node -e "require('fs').appendFileSync('${runsLog.replace(/'/g, "\\'")}', 'ran\\n')"`
      : 'node -e "0"';
  }
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.0', scripts }, null, 2));
  // `.qa/` is gitignored in the real repo (`.gitignore:129`), so `treeHash`'s
  // `git add -A` never sees the receipt this gate writes there — writing one
  // does not move the tree hash out from under the very check that reads it.
  // Without this the fixture would not reproduce the production behavior the
  // tests below actually rely on.
  fs.writeFileSync(path.join(dir, '.gitignore'), '.qa/\n');
  run(['add', '-A']);
  run(['commit', '--quiet', '-m', 'init']);
  return { dir, runsLog };
}

function countRuns(runsLog: string): number {
  return fs.readFileSync(runsLog, 'utf8').split('\n').filter((line) => line === 'ran').length;
}

describe('the plan', () => {
  it('names only npm scripts this repository actually has', () => {
    // The size pin comes first on purpose: `unknownSteps(...)` returning `[]`
    // is also what an empty plan returns, and a gate with no steps passes
    // every assertion in this file while checking nothing.
    expect(STEPS).toHaveLength(4);
    expect(STEPS.map((step) => step.id)).toEqual(['build', 'qa:ui-review', 'verify:artifact', 'audit:memory']);
    expect(unknownSteps(repoRoot)).toEqual([]);
  });

  it('goes through verify:artifact rather than repeating its sequence', () => {
    const scripts = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts;
    expect(STEPS.map((step) => step.id)).toContain('verify:artifact');
    expect(scripts.prepublishOnly).toContain('verify:artifact');
    expect(scripts.prepublishOnly).not.toContain('test:packaged:upgrade');
  });

  it('reaches the entry-point start gate transitively, through verify:release', () => {
    // `qa:pre-release` runs `verify:artifact`, which runs `verify:release`.
    // Pinned here, not just in verify:release's own test, because THIS is
    // the file whose NOT_CHECKED list claims the entry-point gate is covered
    // — if `verify:release` ever stopped calling it, this is where that
    // claim would go silently false.
    const scripts = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts;
    expect(scripts['verify:release']).toContain('check:entry-points-start');
    expect(scripts['check:entry-points-start']).toContain('check-entry-points-start.mjs');
  });

  it('reaches the plugin hook cache/artifact integrity gate transitively', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.files).toContain('scripts/check-plugin-hook-artifact.mjs');
    expect(pkg.scripts['verify:release']).toContain('check:plugin-hook-artifact');
    expect(pkg.scripts['check:plugin-hook-artifact']).toContain('check-plugin-hook-artifact.mjs');
  });

  it('covers the detached auto-update runner in the shipped integrity manifest', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'dist', 'skills-manifest.json'), 'utf8'));
    expect(manifest.entries.map((entry: { path: string }) => entry.path)).toContain(
      'scripts/hooks/auto-update-runner.mjs',
    );
  });

  it('says what it cannot check, including the one gate that still lives elsewhere', () => {
    // The entry-point start gate used to be named here too — it is not
    // anymore, because it is wired into `verify:release` (and therefore into
    // `verify:artifact`, one of the STEPS above) rather than merely
    // documented as missing. This test would go green again if that wiring
    // were ever quietly removed while this line was deleted along with it,
    // so the negative assertion matters as much as the positive ones.
    const text = NOT_CHECKED.join('\n');
    expect(text).toMatch(/live-journey/);
    expect(text).toContain('Both --host codex and --host claude receipts are required');
    expect(text).toContain(LIVE_JOURNEY_SCHEMA_VERSION);
    expect(text).not.toContain('--host codex or --host claude');
    expect(text).toMatch(/qa:post-release/);
    expect(text).not.toMatch(/entry-point/);
  });

  it('detects a step whose npm script has been renamed away', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-pre-release-missing-'));
    fixtureDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0', scripts: {} }));
    expect(unknownSteps(dir)).toEqual(STEPS.map((step) => step.id));
    const run = runGate(dir);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/npm scripts that do not exist/);
  });
});

describe('running it', () => {
  it('builds then blocks before the suite when UI review is missing or fails', () => {
    const run = runGate(fixtureRepo('qa:ui-review'));
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('FAIL  qa:ui-review (exit=3)');
    expect(run.stdout).toContain('PASS  build');
    expect(run.stdout).toContain('NOT RUN — stopped at the first failure: verify:artifact, audit:memory');
  });
  it('passes and reports every step when every step passes', () => {
    const run = runGate(fixtureRepo(null));
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/PASS — pre-release gate/);
    for (const step of STEPS) expect(run.stdout).toContain(`PASS  ${step.id}`);
    expect(run.stdout).toMatch(/not checked here/);
  });

  it('fails on a real non-zero exit code and names what it never ran', () => {
    const run = runGate(fixtureRepo('verify:artifact'));
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/FAIL {2}verify:artifact \(exit=3\)/);
    expect(run.stdout).toMatch(/NOT RUN — stopped at the first failure: audit:memory/);
    expect(run.stdout).toMatch(/FAIL — pre-release gate/);
    expect(run.stdout).not.toMatch(/PASS — pre-release gate/);
  });
});

describe('caching the slow step', () => {
  // KT 2026-09-23: `finish-release.mjs --dry-run` immediately followed by the
  // real run spent several extra minutes re-running the exact same
  // `verify:artifact` (full isolated suite + packaged-artifact runs) against
  // a tree that had not changed since the dry run. Not a safety concern —
  // nothing about that step's result depends on anything but the tree — just
  // pure waste. This is the fix: a tree-hash receipt, same trust model
  // `npm run verify` already uses.
  it('runs verify:artifact once, then reuses the pass for an unchanged tree', () => {
    const { dir, runsLog } = gitFixtureRepo();
    const first = runGate(dir);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('PASS  verify:artifact (exit=0)');
    expect(countRuns(runsLog)).toBe(1);
    expect(fs.existsSync(cacheableReceiptPath(dir, 'verify:artifact'))).toBe(true);

    const second = runGate(dir);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('PASS  verify:artifact (reused, not re-run');
    expect(second.stdout).not.toContain('verify:artifact (exit=0)');
    // The load-bearing assertion: the underlying script did not run again.
    expect(countRuns(runsLog)).toBe(1);
  });

  it('re-runs verify:artifact once the tree actually changes', () => {
    const { dir, runsLog } = gitFixtureRepo();
    expect(runGate(dir).status).toBe(0);
    expect(countRuns(runsLog)).toBe(1);

    fs.writeFileSync(path.join(dir, 'CHANGED.txt'), 'anything');
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['commit', '--quiet', '-m', 'change'], { cwd: dir });

    const second = runGate(dir);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('PASS  verify:artifact (exit=0)');
    expect(second.stdout).not.toContain('reused');
    expect(countRuns(runsLog)).toBe(2);
  });

  it('never reuses a failing run: a failure never writes the receipt', () => {
    const { dir } = gitFixtureRepo();
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    pkg.scripts['verify:artifact'] = 'node -e "process.exit(3)"';
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['commit', '--quiet', '-m', 'fail'], { cwd: dir });

    expect(runGate(dir).status).toBe(1);
    expect(fs.existsSync(cacheableReceiptPath(dir, 'verify:artifact'))).toBe(false);
    // A second run against the same (still-failing) tree must try again, not
    // read a receipt that was never written.
    const second = runGate(dir);
    expect(second.status).toBe(1);
    expect(second.stdout).toContain('FAIL  verify:artifact (exit=3)');
  });
});

describe('verdict', () => {
  it('is a pass only when every step exited zero, and never on an empty run', () => {
    expect(formatVerdict([{ id: 'a', status: 0, signal: null }]).ok).toBe(true);
    expect(formatVerdict([{ id: 'a', status: 1, signal: null }]).ok).toBe(false);
    expect(formatVerdict([]).ok).toBe(false);
  });

  it('reports a killed step as a failure that names the signal', () => {
    const { ok, lines } = formatVerdict([{ id: 'a', status: null, signal: 'SIGKILL' }]);
    expect(ok).toBe(false);
    expect(lines[0]).toMatch(/killed by SIGKILL/);
  });
});
