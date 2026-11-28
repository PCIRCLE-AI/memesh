/**
 * The release scripts must not touch the maintainer's real data to do their job.
 *
 * A release check once rewrote `~/.memesh/config.json` and relied on an EXIT
 * trap to restore it. The suite now runs under a throwaway HOME instead.
 *
 * This is a shell script, so there is no unit to call. The assertions are
 * structural, and they are the ones that matter: the regression is not "the
 * output changed", it is "the script started writing to the real config again".
 * A test that ran the script for real would have to have a real config to
 * damage, which is the thing being prevented.
 *
 * Recorded as unpinned during the mutation sweep of this release, then pinned.
 */
import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { buildCredentialFreeBaseEnv, buildIsolatedRuntimeEnv, buildIsolatedSuiteEnv } from '../scripts/lib/isolated-env.mjs';
import { findOrphanedTypeScriptOutputs } from '../scripts/check-generated-mirror.mjs';
import { writeNodeShim } from '../scripts/lib/node-shim.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('Feature: release scripts never edit the real ~/.memesh', () => {
  const script = 'scripts/release-verify.sh';

  /** The script with full-line comments removed — assertions are about what it DOES. */
  function code(rel: string): string {
    return read(rel)
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
  }

  it('runs the suite under a throwaway HOME', () => {
    const text = code(script);
    expect(text).toMatch(/mktemp -d/);
    // The HOME override has to be ON the command. Creating a temp dir and then
    // not using it for the run is the shape this replaced.
    expect(text).toMatch(/HOME="\$\w+"[^\n]*"\$@"/);
    expect(text).toMatch(/with_throwaway_home npx vitest run/);
  });

  it('never names the real config or memesh dir at all', () => {
    // Keyed on WHAT IS TOUCHED, not on which verb touches it.
    //
    // The first version of this test listed the operations it imagined the old
    // script used — `cp`/`mv`/`rm`, a `jq del(.llm)`, a `>` redirect, a `trap`
    // on a line mentioning config.json. Checked against `git show
    // main:scripts/release-verify.sh`, ALL FIVE return false: the real
    // regression used a python3 heredoc and `open(p,'w')`, and its `trap
    // restore_llm EXIT` line never mentions config.json. The test forbade five
    // shapes the bug never had, and would have stayed green if the whole
    // strip/restore block were pasted back in. It was "mutation-verified"
    // against a hand-written imitation of the bug that matched its own regexes
    // — which is not verification.
    //
    // A script that never mentions `$HOME/.memesh` or `config.json` cannot
    // read, write, back up or restore them by any means, in any language it
    // shells out to. That is the property; the verbs are not.
    const text = code(script);
    expect(text).not.toMatch(/\$HOME\/\.memesh/);
    expect(text).not.toMatch(/~\/\.memesh/);
    expect(text).not.toMatch(/config\.json/);
    // `trap` existed only to undo the damage. No damage, no trap.
    expect(text).not.toMatch(/^\s*trap\s/m);
  });

  it('runs every gate that opens the database under the throwaway HOME', () => {
    // `doctor` calls openDatabase(), which runs schema and FTS migrations plus
    // lifecycle maintenance — so an unisolated gate MUTATES the
    // maintainer's real knowledge-graph.db as a side effect of verifying a
    // release. The commit that introduced the throwaway HOME isolated the test
    // suite and stopped one gate short, which is why this asserts the set
    // rather than a single call.
    const text = code(script);
    const mustBeIsolated = ['doctor --json', 'install-hooks --dry-run', 'npx vitest run'];
    for (const cmd of mustBeIsolated) {
      const line = text.split('\n').find((l) => l.includes(cmd) && !l.trim().startsWith('#'));
      expect(line, `no line invokes ${cmd}`).toBeDefined();
      expect(line, `${cmd} is not wrapped in with_throwaway_home`).toMatch(/with_throwaway_home/);
    }
  });

  it('clears MEMESH_DIR and MEMESH_DB_PATH, not just HOME', () => {
    // HOME alone is not isolation: paths.ts resolves both of these FIRST, so
    // either one exported in the maintainer's shell routes a "throwaway HOME"
    // run straight back at the real config and the real database.
    expect(code(script)).toMatch(/env -u MEMESH_DIR -u MEMESH_DB_PATH/);
  });

  it('the build-output gate builds before it diffs', () => {
    // Without this the gate has an unenforced precondition, and an unenforced
    // precondition is how it reports the exact defect it exists to catch as a
    // pass: `npm run verify:release` on its own printed "✓ committed build
    // output is current" having built nothing, which is true of ANY tree whose
    // dist/ matches HEAD — including one whose source was edited and never
    // rebuilt. Confirmed by hand: with a one-line edit to
    // `src/core/version-check.ts` and no build, `git diff -- dist` was empty
    // (old gate: green tick) and the current script exits 1 naming the two
    // stale files.
    const text = read('scripts/check-generated-mirror.mjs');
    const buildAt = text.search(/npmSync\(\s*\['run',\s*'build'\]/);
    const diffAt = text.search(/'diff',\s*'--stat'/);
    expect(buildAt, 'the gate does not run the build').toBeGreaterThan(-1);
    expect(diffAt, 'the gate does not diff the build outputs').toBeGreaterThan(-1);
    expect(buildAt, 'the gate diffs before it builds').toBeLessThan(diffAt);
    // A failed build must fail the gate. Reporting "output is current" because
    // the compiler crashed is the same class of lie one level up.
    //
    // Scoped to the BUILD catch, deliberately. This used to be
    // `expect(text).toMatch(/catch[\s\S]{0,200}process\.exit\(1\)/)`, and the
    // script has FOUR `process.exit(1)` calls each preceded by a catch — any
    // one of them satisfied an unanchored regex, so deleting the exit from the
    // build catch left this test green. Measured: with that one line removed,
    // this file passed and so did the whole suite.
    //
    // What that costs is not hypothetical. `npm run build` is an `&&` chain
    // (`check-schema-drift && tsc && generate-hook-core && …`), so a tsc
    // failure short-circuits it and `scripts/hooks/_generated/` is never
    // regenerated — the exact hook/core divergence this gate's own docblock
    // names as the class behind the P0 FTS omission. Falling through to
    // `git diff --stat` then finds nothing to report and prints a green tick.
    const buildCatchStart = text.indexOf('} catch (err) {', buildAt);
    expect(buildCatchStart, 'the build call has no catch').toBeGreaterThan(-1);
    const buildCatchEnd = text.indexOf('\n}\n', buildCatchStart);
    expect(buildCatchEnd, 'the build catch is unterminated').toBeGreaterThan(buildCatchStart);
    expect(
      text.slice(buildCatchStart, buildCatchEnd),
      'a failed build no longer fails the gate: it falls through to the diff, which is empty on any tree whose committed output already matches HEAD',
    ).toContain('process.exit(1)');
  });

  it('accepts staged rebuilt output but rejects stale staged and untracked output', () => {
    const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-staged-output-')));
    const run = (command: string, args: string[]) => spawnSync(command, args, {
      cwd: fixture, encoding: 'utf8', timeout: 20000,
    });
    try {
      fs.mkdirSync(path.join(fixture, 'scripts/lib'), { recursive: true });
      fs.mkdirSync(path.join(fixture, 'src/core'), { recursive: true });
      fs.mkdirSync(path.join(fixture, 'dist/core'), { recursive: true });
      for (const script of ['check-generated-mirror.mjs', 'lib/npm-bin.mjs', 'lib/verify-core.mjs']) {
        fs.copyFileSync(path.join(repoRoot, 'scripts', script), path.join(fixture, 'scripts', script));
      }
      fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({
        type: 'module', scripts: { build: 'node build.mjs' },
      }));
      fs.writeFileSync(path.join(fixture, 'build.mjs'), "import fs from 'node:fs'; for (const name of fs.readdirSync('src/core')) fs.copyFileSync('src/core/' + name, 'dist/core/' + name.replace(/\\.ts$/, '.js'));\n");
      fs.writeFileSync(path.join(fixture, 'src/core/kept.ts'), 'export const kept = true;\n');
      fs.writeFileSync(path.join(fixture, 'dist/core/kept.js'), 'export const kept = true;\n');
      expect(run('git', ['init']).status).toBe(0);
      expect(run('git', ['add', '--', 'src/core/kept.ts', 'dist/core/kept.js']).status).toBe(0);
      const check = () => run(process.execPath, [path.join(fixture, 'scripts/check-generated-mirror.mjs')]);
      const staged = check();
      expect(staged.status).toBe(0);
      expect(staged.stdout).toContain('build output');
      fs.writeFileSync(path.join(fixture, 'src/core/kept.ts'), 'export const kept = false;\n');
      const stale = check();
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain('build output is stale');
      expect(run('git', ['add', '--', 'src/core/kept.ts', 'dist/core/kept.js']).status).toBe(0);
      expect(check().status).toBe(0);
      fs.writeFileSync(path.join(fixture, 'src/core/new.ts'), 'export const added = true;\n');
      const untracked = check();
      expect(untracked.status).toBe(1);
      expect(untracked.stderr).toContain('untracked build output:');
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('the build-output gate detects compiler artifacts whose source module was deleted', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-generated-parity-'));
    try {
      fs.mkdirSync(path.join(fixture, 'src/core'), { recursive: true });
      fs.mkdirSync(path.join(fixture, 'dist/core'), { recursive: true });
      fs.writeFileSync(path.join(fixture, 'src/core/kept.ts'), 'export const kept = true;\n');
      for (const family of ['kept', 'deleted']) {
        for (const suffix of ['.js', '.js.map', '.d.ts', '.d.ts.map']) {
          fs.writeFileSync(path.join(fixture, 'dist/core', `${family}${suffix}`), 'generated');
        }
      }
      fs.writeFileSync(path.join(fixture, 'dist/skills-manifest.json'), '{}');

      expect(findOrphanedTypeScriptOutputs(fixture)).toEqual([{
        family: 'core/deleted',
        files: [
          'core/deleted.d.ts', 'core/deleted.d.ts.map',
          'core/deleted.js', 'core/deleted.js.map',
        ],
      }]);
      for (const file of fs.readdirSync(path.join(fixture, 'dist/core'))) {
        if (file.startsWith('deleted.')) fs.rmSync(path.join(fixture, 'dist/core', file));
      }
      expect(findOrphanedTypeScriptOutputs(fixture)).toEqual([]);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('the line-ending rule covers every text file, not a list of suffixes', () => {
    // Both Windows CI legs failed on this branch because `.gitattributes`
    // enumerated ten extensions and missed `.css` and `.html`. Windows checked
    // `dashboard/index.html` and `dashboard/src/styles/global.css` out with
    // CRLF, vite INLINED them into the bundle, and the carriage returns landed
    // mid-line inside a committed artifact — a real content difference that
    // line-ending normalisation cannot undo, so `dashboard/dist/index.html`
    // could never be reproduced there.
    const attrs = read('.gitattributes');
    expect(attrs).toMatch(/^\*\s+text=auto\s+eol=lf\s*$/m);
    // ...and binaries stay exempt, or the default corrupts them instead.
    expect(attrs).toMatch(/^\*\.png\s+binary\s*$/m);
  });

  it('the docs gate counts hooks, not build output that lives beside them', async () => {
    // `find scripts/hooks -name '*.js' ! -name '_shared.js'` recursed into
    // `scripts/hooks/_generated/`, so when the build mirror landed there the
    // count went 7 -> 9 and the gate reported FAIL on a correct tree. A gate
    // that fails on a healthy repo gets ignored, and then it is not a gate.
    //
    // Tested by RUNNING the rule against a fixture shaped like the incident,
    // not by regexing the gate's source for three implementation substrings —
    // that pinned the text, and text that is present proves nothing about
    // what executes. The rule lives in scripts/lib/hook-files.mjs and
    // check-doc-claims.mjs imports it (asserted below), so this fixture
    // exercises the code the gate runs.
    const { listHookFiles } = await import('../scripts/lib/hook-files.mjs');
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-fixture-'));
    try {
      fs.writeFileSync(path.join(fixture, 'session-start.js'), '');
      fs.writeFileSync(path.join(fixture, 'session-summary.js'), '');
      fs.writeFileSync(path.join(fixture, '_shared.js'), '');
      fs.writeFileSync(path.join(fixture, 'notes.md'), '');
      fs.mkdirSync(path.join(fixture, '_generated'));
      fs.writeFileSync(path.join(fixture, '_generated', 'session-start.js'), '');
      fs.writeFileSync(path.join(fixture, '_generated', 'extra-mirror.js'), '');
      expect(listHookFiles(fixture)).toEqual(['session-start.js', 'session-summary.js']);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
    // The one source-level fact still worth pinning: the gate uses this rule,
    // rather than a private copy that could drift back to `find`.
    expect(read('scripts/check-doc-claims.mjs')).toContain("import { listHookFiles } from './lib/hook-files.mjs'");
  });

  it('the docs gate is actually wired into the list both CI and publish run', () => {
    // The reason it moved. `verify-docs-sync.sh` had SIX checks and ZERO
    // callers: not CI, not verify:release, not release-verify.sh, not a
    // package.json script. Its only references were a line in CLAUDE.md telling
    // an assistant to run it by hand and a manual review skill. A gate that
    // never runs cannot fail, which is the same defect as a gate that cannot
    // fail when it runs — and this repository has now found four of those.
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['verify:release']).toContain('node scripts/check-doc-claims.mjs');
  });

  it('wires the deterministic message release/install sync gate', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['verify:release']).toContain('node scripts/check-agent-message-sync.mjs');
    const gate = read('scripts/check-agent-message-sync.mjs');
    expect(gate).toContain("['discover', 'send', 'read', 'status']");
    expect(gate).toContain('CLI command');
    expect(gate).toContain('mapped to action');
    expect(gate).toContain('dist/transports/conversation-messaging.js');
    expect(gate).toContain('dist/core/conversation-messages.js');
  });

  it('runs the installed four-action CLI without claiming synthetic registration proves native wake', () => {
    const smoke = read('scripts/smoke-packed-artifact.mjs');
    // Runtime assertions live in the packaged process. This only guards the
    // installed binary wiring and its evidence label, not message semantics.
    expect(smoke).toContain("spawnSync(process.execPath, [installedCliEntry, 'message', ...args]");
    expect(smoke).toContain("['send','--recipient',sessionB,'--kind','task','--payload-stdin']");
    expect(smoke).toContain('Synthetic registration only; native wake is not verified.');
    expect(smoke).not.toContain("installedBin('memesh-router')");
    expect(smoke).toContain('consumerInstallTimeoutMs');
    expect(smoke).toContain('timeout: consumerInstallTimeoutMs');
  });

  it('wires the isolated packaged upgrade acceptance into CI and npm publication', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['test:packaged:upgrade']).toBe('node scripts/smoke-packed-upgrade.mjs');
    // The publish path reaches the upgrade acceptance through `verify:artifact`
    // — one named sequence shared with `qa:pre-release` rather than two copies
    // of the same list. Following the indirection is the point: asserting only
    // that `prepublishOnly` mentions it would pass on a copy.
    expect(pkg.scripts.prepublishOnly).toContain('verify:artifact');
    expect(pkg.scripts['verify:artifact']).toContain('test:packaged:upgrade');
    const upgrade = read('scripts/smoke-packed-upgrade.mjs');
    expect(upgrade).toContain('auto-update-runner.mjs');
    expect(upgrade).toContain('runLocked(lockPath');
    expect(upgrade).toContain('await runAutoUpdate({ ...deps, ...context })');
    expect(upgrade).toContain('AUTO_UPDATE_REASONS.dependencyPinFailed');
    expect(upgrade).toContain('explicit off reached registry or install steps');
    expect(upgrade).toContain('real registry provenance and native dispatch remain unverified');
    expect(upgrade).toContain('MEMESH_UPGRADE_FORCE_FAILURE');
    expect(upgrade).toContain('fs.copyFileSync(candidateTarball, invalidCandidate)');
    expect(upgrade).toContain('fs.truncateSync(invalidCandidate');
    expect(upgrade).not.toContain('not-a-memesh-v${candidateVersion}-candidate.tgz');
    expect(read('.github/workflows/ci.yml')).toContain('run: npm run test:packaged:upgrade');
  });

  it('derives both ends of every upgrade path instead of pinning a version pair', () => {
    const upgrade = read('scripts/smoke-packed-upgrade.mjs');
    // The import list is asserted by what it must bring in, not as one exact
    // string: pinning the spelling made this guard go red for ADDING a
    // derivation helper, which is the opposite of what it is for.
    expect(upgrade).toContain("from './lib/upgrade-matrix.mjs'");
    expect(upgrade).toContain('candidatePackage.version');
    expect(upgrade).toContain('selectUpgradePaths(packument, candidateVersion)');
    // Deriving the paths is half of it; proving every one it derived is the
    // other half, and a matrix that silently shrinks passes every test in
    // this repository without it.
    expect(upgrade).toContain('assertEveryPathProven(upgradePaths, proven)');
    // The regression this guards is the one the file shipped with for four
    // releases: a hand-written version that goes on passing for an upgrade
    // nobody performs. Any X.Y.Z literal back in this script is that defect —
    // except the MCP client identity, which names this probe to the server it
    // connects to and is not a version of anything under test.
    const withoutProbeIdentity = upgrade.replace("version: '1.0.0'", "version: '<probe>'");
    expect(withoutProbeIdentity).not.toMatch(/\d+\.\d+\.\d+/);
  });

  it('gives the release verification job the proven degraded-runner budget', () => {
    const ci = read('.github/workflows/ci.yml');
    const releaseJob = ci.match(/\n {2}release-verify:\n[\s\S]*?(?=\n {2}[A-Za-z0-9_-]+:\n|$)/)?.[0] ?? '';
    expect(releaseJob).not.toBe('');
    expect(releaseJob).toMatch(/timeout-minutes:\s*40/);
    // --skip-suite drops only what every Build & Test leg already runs (typecheck
    // inside verify:release, the full suite); the smoke and install probes stay.
    expect(releaseJob).toContain('bash scripts/release-verify.sh --skip-suite');
    expect(releaseJob).not.toContain('--skip-llm-probe');
    expect(releaseJob).not.toContain('--quick');
  });

  // Coverage floors remain required; Dashboard UI checks are explicitly
  // skipped for this release while packaged verification remains mandatory.
  function ciJob(id: string): string {
    const ci = read('.github/workflows/ci.yml');
    return ci.match(new RegExp(`\\n {2}${id}:\\n[\\s\\S]*?(?=\\n {2}[A-Za-z0-9_-]+:\\n|$)`))?.[0] ?? '';
  }
  // The one step of a job whose `run:` line is exactly `run`. A step-level
  // `if:` or `continue-on-error` turns it into a green step that proved nothing.
  function unconditionalStep(job: string, run: string): string {
    const step = job.split(/\n {6}- /).find((s) => s.split('\n').some((line) => line.trim() === `run: ${run}`)) ?? '';
    expect(step, `no step runs exactly: ${run}`).not.toBe('');
    expect(step).not.toMatch(/\n\s+if:/);
    expect(step).not.toContain('continue-on-error');
    return step;
  }

  it('enforces the coverage floor in the ubuntu/Node 24 matrix leg, unconditionally', () => {
    const buildJob = ciJob('build-and-test');
    expect(buildJob).not.toBe('');
    // A job-level `if:` can skip the whole leg, and GitHub counts a skipped
    // job as a passing check.
    expect(buildJob).not.toMatch(/\n {4}if:/);
    expect(buildJob).not.toContain('continue-on-error');
    // Adds `coverage` to the existing ubuntu/24 combination; it is not a new leg.
    expect(buildJob).toMatch(/- os: ubuntu-latest\n\s+node: '24\.22\.3'\n\s+coverage: true\n/);
    unconditionalStep(buildJob, "${{ matrix.coverage && 'npm run test:coverage' || 'npm test -- --run' }}");
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:coverage']).toBe('node scripts/run-tests-isolated.mjs --coverage');
    // The leg itself must exist: an `exclude:` would drop it without an `if:`.
    expect(buildJob).not.toMatch(/\n\s+exclude:/);
    // The floor must not be lowered in passing (raising it is fine).
    const thresholds = read('vitest.config.ts').match(/thresholds:\s*\{([^}]*)\}/)?.[1] ?? '';
    for (const [metric, floor] of [['statements', 52], ['branches', 48], ['functions', 55], ['lines', 54]] as const) {
      expect(Number(thresholds.match(new RegExp(`${metric}:\\s*(\\d+)`))?.[1] ?? 0), metric).toBeGreaterThanOrEqual(floor);
    }
    // Lint runs inside verify:release; this step is its only home in the leg.
    unconditionalStep(buildJob, 'npm run verify:release');
    expect(pkg.scripts['verify:release']).toMatch(/^npm run lint && /);
    // Windows stays in the matrix: the legs the temp-disk step is for.
    expect(buildJob).toMatch(/\n\s+os: \[[^\]]*\bwindows-latest\b[^\]]*\]/);
  });

  it('puts the test temp folders on the runner temp disk, on every leg', () => {
    const step = ciJob('build-and-test').split(/\n {6}- /).find((s) => s.includes('npm test -- --run')) ?? '';
    expect(step, 'no test step').not.toBe('');
    expect(step).toMatch(/\n\s+TEMP: \$\{\{ runner\.temp \}\}\n/);
    expect(step).toMatch(/\n\s+TMP: \$\{\{ runner\.temp \}\}\n/);
  });

  it('retains packaged verification and explicitly skips UI under the KT release waiver', () => {
    const sdlcJob = ciJob('sdlc-verify');
    expect(sdlcJob).not.toBe('');
    expect(sdlcJob).not.toMatch(/\n {4}if:/);
    expect(sdlcJob).not.toMatch(/\n {4}continue-on-error/);
    expect(sdlcJob).not.toContain('npx playwright install');
    const publisher = read('.github/workflows/publish-npm.yml');
    expect(publisher).not.toContain('run: npm run test:e2e-dashboard');
    expect(publisher).not.toContain('npx playwright install');
    unconditionalStep(publisher.split('\n  promote:')[0], 'npm publish --access public --provenance --tag "$MEMESH_NPM_DIST_TAG"');
    expect(publisher).not.toContain('run: npm test -- --run');
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts.prepublishOnly).toBe('npm run build && npm run verify:artifact');
    expect(pkg.scripts['verify:artifact']).toBe('npm run verify:release && npm run test:isolated && npm run test:packaged && npm run test:packaged:upgrade');
    expect(publisher).not.toMatch(/--ignore-scripts|NPM_CONFIG_IGNORE_SCRIPTS|npm_config_ignore_scripts/);
    // npm publish runs prepublishOnly -> test:isolated without CLI excludes.
    // Journeys only: every Build & Test leg already runs the build, verify:release
    // and the full suite, so the full run here repeated them on the same OS and Node.
    unconditionalStep(sdlcJob, 'node scripts/verify.mjs --journeys');
    const config = JSON.parse(read('scripts/verify.config.json')) as {
      verify: { steps: Array<{ id: string; command: string; args?: string[]; journeys?: boolean }> };
    };
    // KT explicitly waived UI functional verification for this release.
    // Build and installed-artifact verification remain mandatory journeys.
    for (const id of ['build', 'packaged']) {
      expect(config.verify.steps.find((step) => step.id === id)?.journeys, id).toBe(true);
    }
    expect(config.verify.steps.map((step) => step.id)).toEqual(['build', 'release-gates', 'unit', 'packaged']);
    expect(config.verify.steps.find((step) => step.id === 'unit')?.args).toEqual([
      'scripts/run-tests-isolated.mjs',
    ]);
    const commands = config.verify.steps.map((step) => [step.command, ...(step.args ?? [])].join(' '));
    expect(commands).toEqual(
      expect.arrayContaining([
        'npm run build',
        'npm run verify:release',
        'node scripts/run-tests-isolated.mjs',
        'npm run test:packaged',
      ]),
    );
  });

  it('detects missing actions, incorrect wiring and safety regressions in the conversation gate', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'message-sync-fixture-'));
    const files = [
      'src/transports/conversation-messaging.ts', 'dist/transports/conversation-messaging.js',
      'src/transports/mcp/handlers.ts', 'dist/transports/mcp/handlers.js',
      'src/core/schema-export.ts', 'dist/core/schema-export.js',
      'src/transports/cli/cli.ts', 'dist/transports/cli/cli.js',
      'src/core/conversation-messages.ts', 'dist/core/conversation-messages.js',
      'docs/api/API_REFERENCE.md', 'dist/mcp/server.js', 'src/transports/http/server.ts', 'dist/transports/http/server.js', 'hooks/hooks.json',
      'src/transports/http/retired-routes.ts', 'dist/transports/http/retired-routes.js',
      '.claude-plugin/mcp.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json',
      '.codex-plugin/mcp.json', '.codex-plugin/plugin.json', 'package.json',
    ];
    try {
      for (const file of files) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, file), path.join(root, file));
      }
      const run = () => spawnSync(process.execPath, ['scripts/check-agent-message-sync.mjs', '--root', root], { cwd: repoRoot, encoding: 'utf8' });
      const baseline = run();
      expect(baseline.status, baseline.stderr).toBe(0);
      const mutate = (file: string, from: string, to: string, expected: string) => {
        const target = path.join(root, file);
        const original = fs.readFileSync(target, 'utf8');
        expect(original).toContain(from);
        fs.writeFileSync(target, original.replace(from, to));
        const result = run();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain(expected);
        fs.writeFileSync(target, original);
      };
      for (const file of ['src/transports/conversation-messaging.ts', 'dist/transports/conversation-messaging.js']) {
        mutate(file, "action: z.literal('status')", "action: z.literal('other')", 'conversation actions must be exactly');
      }
      mutate('src/transports/cli/cli.ts', 'action: "read", message_id: opts.messageId', 'action: "send", message_id: opts.messageId', 'CLI command "read" mapped to action "read"');
      mutate('dist/transports/cli/cli.js', 'action: "read", message_id: opts.messageId', 'action: "send", message_id: opts.messageId', 'CLI command "read" mapped to action "read"');
      for (const file of ['src/transports/cli/cli.ts', 'dist/transports/cli/cli.js']) {
        const briefing = fs.readFileSync(path.join(root, file), 'utf8').match(/\.command\(['"]briefing['"]\)/)?.[0];
        expect(briefing).toBeDefined();
        mutate(file, briefing!, ".command('wrong-boundary')", 'public message commands must be exactly four actions');
      }
      for (const file of ['src/transports/http/server.ts', 'dist/transports/http/server.js']) {
        mutate(file, 'res.status(410).json', 'res.status(200).json', 'fixed HTTP 410 retired-route handler');
        mutate(file, 'Object.entries(RETIRED_ROUTES)', 'Object.entries({})', 'fixed HTTP 410 retired-route handler');
        mutate(file, 'app.post(retiredRoute', "app.post('/v1/other'", 'fixed HTTP 410 retired-route handler');
        mutate(file, 'app.post(retiredRoute', "executeAgentMessageAction(); app.post(retiredRoute", 'retired HTTP message dispatcher must not exist');
      }
      for (const file of ['src/transports/http/retired-routes.ts', 'dist/transports/http/retired-routes.js']) {
        mutate(file, "'/v1/message':", "'/v1/other':", 'explicit message route retirement');
      }
      mutate('hooks/hooks.json', 'messages.js', 'dist/host-runtime/codex-session.js', 'retired Codex companion must not be wired');
      mutate('src/core/conversation-messages.ts', 'MESSAGE_MAX_BYTES = 8_000', 'MESSAGE_MAX_BYTES = 80_000', 'MESSAGE_MAX_BYTES');
      mutate('dist/core/conversation-messages.js', "reason ? 'rejected' : 'queued'", "'queued'", 'rejected');
      for (const file of ['src/core/conversation-messages.ts', 'dist/core/conversation-messages.js']) {
        mutate(file, "requirePrivateWritableDirectory(path.dirname(file), 'messages must remain owner-private');", '', 'owner-private directory guard call');
        mutate(file, '!makeWindowsMessageStorePrivate(file)', 'false', 'owner-private Windows message-store guard call');
        mutate(file, 'const tooLarge = Buffer.byteLength', 'const tooLarge = false && Buffer.byteLength', 'rendered-byte limit and rejection branch');
        mutate(file, 'this.insert(message, {', 'this.removedInsert(message, {', 'send insert and rejected audit event');
        mutate(file, "this.event(message.id, reason ? 'rejected' : 'queued', { actor: from.id, ...(reason ? { reason } : {}) });", '', 'send insert and rejected audit event');
        const audit = "this.event(message.id, reason ? 'rejected' : 'queued', { actor: from.id, ...(reason ? { reason } : {}) });";
        mutate(file, audit, `this.db.prepare("UPDATE messages SET body = ?").run('changed');\n${audit}`, 'message/event mutation outside expiry');
        // Even the exact permitted backfill is forbidden on the normal send path.
        mutate(file, audit, `this.db.exec("UPDATE messages SET sender_local=1 WHERE kind != 'legacy';");\n${audit}`, 'message/event mutation outside expiry');
        mutate(file, "columns.some(c => c.name === 'sender_local')", 'false', 'message/event mutation outside expiry');
      }
      mutate('src/transports/mcp/handlers.ts',
        'executeConversationMessageAction(args, { session: requestContext.hostSession })',
        'executeConversationMessageAction(args, { session: args.sender })',
        'MCP awaited session-bound handler');
      mutate('docs/api/API_REFERENCE.md', '| `status` | optional `message_id`', '| `other` | optional `message_id`', 'message action rows');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // Title deliberately avoids spelling the forbidden form — the scan below
  // reads this file too, and a test that fails on its own name is noise.
  it('resolves module paths with fileURLToPath, never the URL pathname property', () => {
    // On Windows that returns a leading-slash drive path ("/D:/repo/..."), and
    // `path.join`/`path.resolve` then concatenate it with the cwd drive into
    // "D:\D:\repo\..." — a path that cannot exist. `fileURLToPath` does the
    // OS-correct conversion.
    //
    // This is a structural gate rather than a note because the note already
    // existed: `scripts/check-version-coherence.mjs` carries a paragraph
    // explaining the exact failure, and a test written later in the same
    // release reintroduced it and took both Windows CI legs down. A trap that
    // has bitten twice needs something that fails, not something that explains.
    const roots = ['src', 'scripts', 'tests'];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
        const rel = path.posix.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '_generated') continue;
          walk(rel);
        } else if (/\.(ts|tsx|mjs|js|cjs)$/.test(entry.name)) {
          const text = read(rel);
          // Skip the line that documents the hazard rather than commits it.
          for (const [i, line] of text.split('\n').entries()) {
            if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
            if (/new URL\([^)]*\)\s*\.pathname/.test(line)) offenders.push(`${rel}:${i + 1}`);
          }
        }
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });

  it('can actually reach its release-only branch', () => {
    // The `[Unreleased]` anchor is a hard error on a release run and a note on
    // a feature branch. The first version keyed that on `MEMESH_RELEASE === '1'`
    // with a comment saying the publish workflow set it. Nothing set it — not
    // the workflow, not prepublishOnly, not a test — so the branch was dead and
    // the one anchor the gate cannot cross-check any other way stayed waived on
    // the publish path. A gate whose trigger never fires is the defect this
    // whole release is about, one level up.
    const text = read('scripts/check-version-coherence.mjs');
    // Inferred from signals npm and GitHub set on their own, not only from an
    // env var a human has to remember.
    expect(text).toMatch(/npm_command === 'publish'/);
    expect(text).toMatch(/GITHUB_EVENT_NAME === 'release'/);
    // ...and the publish workflow states the intent at the call site.
    expect(read('.github/workflows/publish-npm.yml')).toMatch(/MEMESH_RELEASE:\s*'1'/);
  });

  it('the publish path does not build the dashboard twice', () => {
    // ci.yml removed this step because building it once in `npm run build` and
    // again afterwards meant the release gate diffed the artifact produced by
    // the unpinned install. Leaving the copy in the publish workflow is the
    // same two-hand-maintained-lists problem the gate exists to prevent.
    expect(read('.github/workflows/publish-npm.yml')).not.toMatch(/cd dashboard && npm ci/);
  });

  describe('promoting a trial to latest happens only through the release workflow (#452)', () => {
    // Before this: `release: published` was the only trigger, so turning an
    // existing prerelease into a full release (`gh release edit v<version>
    // --prerelease=false`) fired `released`, which nothing listened for, and
    // CONTRIBUTING.md filled the gap with a manual `npm dist-tag add` run
    // from a local machine — bypassing CI and needing a maintainer's npm
    // credentials outside it.
    const workflow = read('.github/workflows/publish-npm.yml');

    /** The named top-level job's block, keyed by its 2-space-indented `name:` under `jobs:`. */
    function jobBlock(name: string): string {
      const match = workflow.match(new RegExp(`\\n {2}${name}:\\n[\\s\\S]*?(?=\\n {2}[A-Za-z0-9_-]+:\\n|$)`));
      // A guard on an ABSENT job would otherwise pass vacuously — every
      // `.not.toMatch(...)` below is true of an empty string.
      expect(match, `no job named "${name}" in publish-npm.yml`).not.toBeNull();
      return match?.[0] ?? '';
    }

    /**
     * Every `run:` command body in a job block, single-line and `run: |`
     * block forms alike — a mutation that moved the tag interpolation into a
     * multi-line block would otherwise hide from a check that only looked at
     * `run:\s+(.*)`.
     */
    function runBodies(block: string): string[] {
      const bodies: string[] = [];
      const lines = block.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const singleLine = line.match(/^\s*run:\s+(?!\|)(.*)$/);
        if (singleLine) {
          bodies.push(singleLine[1]);
          continue;
        }
        if (/^\s*run:\s*\|/.test(line)) {
          const indent = line.match(/^(\s*)run:/)?.[1].length ?? 0;
          const blockLines: string[] = [];
          let j = i + 1;
          while (j < lines.length && (lines[j].trim() === '' || (lines[j].match(/^\s*/)?.[0].length ?? 0) > indent)) {
            blockLines.push(lines[j]);
            j++;
          }
          bodies.push(blockLines.join('\n'));
        }
      }
      return bodies;
    }

    /**
     * Every non-comment, non-blank line across a set of run bodies. Several
     * checks below must not trip on prose inside a `#` comment — this step
     * legitimately says things like "npm view is not wrapped in `|| true`"
     * and "every npm view here reads --prefer-online" in its own commentary.
     */
    function commandLines(bodies: string[]): string[] {
      return bodies
        .flatMap((b) => b.split('\n'))
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'));
    }

    it('fires on both published and released', () => {
      expect(workflow).toMatch(/release:\s*\n\s*types:\s*\[\s*published\s*,\s*released\s*\]/);
    });

    it('publishes automatically only for published, with an explicit manual retry', () => {
      // A directly published full release fires BOTH `published` and
      // `released` as two separate workflow runs. Without this guard the
      // publish job — build, full suite, both smoke tests, `npm publish` —
      // would also run on the `released` delivery of that same release.
      //
      // Anchored to the whole job-level property line (4-space indent, `^`
      // to `$`): a bare `.toMatch(/if: ... == 'published'/)` substring check
      // survives a mutant that WIDENS the guard (`|| ... == 'released'`) or
      // MOVES it down from the job onto a single step, since both leave that
      // substring intact somewhere in the block.
      expect(jobBlock('publish')).toMatch(/^ {4}if: github\.event\.action == 'published' \|\| github\.event_name == 'workflow_dispatch'$/m);
    });

    it('retries only an existing non-draft prerelease, checks out that tag, and cannot promote latest', () => {
      const publish = jobBlock('publish');
      expect(publish).toContain("if: github.event_name == 'workflow_dispatch'");
      expect(publish).toContain('[[ "$RELEASE_TAG" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+$ ]]');
      expect(publish).toContain("--json isDraft,isPrerelease --jq '(.isDraft == false) and (.isPrerelease == true)'");
      expect(publish.indexOf('Validate prerelease retry')).toBeLessThan(publish.indexOf('Checkout code'));
      expect(publish).toContain('ref: ${{ inputs.release_tag || github.ref }}');
      expect(publish).toContain('RELEASE_TAG: ${{ inputs.release_tag || github.event.release.tag_name }}');
      expect(publish).toContain("(github.event_name == 'workflow_dispatch' || github.event.release.prerelease) && 'next' || 'latest'");
      for (const body of runBodies(publish)) expect(body).not.toMatch(/\$\{\{/);
    });

    it('the promote job runs only for a `released` action', () => {
      expect(jobBlock('promote')).toMatch(/^ {4}if: github\.event\.action == 'released'$/m);
    });

    it('neither job hides a failure behind continue-on-error', () => {
      expect(jobBlock('publish')).not.toMatch(/continue-on-error/);
      expect(jobBlock('promote')).not.toMatch(/continue-on-error/);
    });

    it('the promote job checks the release tag against package.json, through env: like the publish job', () => {
      const promoteJob = jobBlock('promote');
      expect(promoteJob).toMatch(/RELEASE_TAG:\s*\$\{\{\s*github\.event\.release\.tag_name\s*\}\}/);
      expect(promoteJob).toContain('check-tag-matches-version.mjs "$RELEASE_TAG"');
    });

    it('the promote job never interpolates ${{ }} inside a run: body', () => {
      // The tag must go through `env:`, never `${{ }}` inside `run:` — the
      // same reasoning the publish job's identical step documents: git
      // accepts `$(...)` inside a tag name, and this job also holds
      // NPM_TOKEN.
      const bodies = runBodies(jobBlock('promote'));
      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) {
        expect(body).not.toMatch(/\$\{\{/);
      }
    });

    it('the promote job moves the dist-tag to exactly `latest`, then polls the readback within a bound, failing unless it eventually matches', () => {
      const promoteJob = jobBlock('promote');
      // Pinned to the exact target — a mutant that pointed this at `next`
      // (or any other tag) fails this line specifically, not just a
      // substring check that `npm dist-tag add` appears somewhere.
      expect(promoteJob).toContain('npm dist-tag add "$PACKAGE@$VERSION" latest');
      expect(promoteJob).toMatch(/dist-tags\.latest/);
      // At least four real registry reads: the version-on-npm check, the
      // latest/next reads that decide whether this is a promotion at all,
      // and at least one readback attempt after the move.
      const npmViewCalls = promoteJob.match(/npm view /g) ?? [];
      expect(npmViewCalls.length).toBeGreaterThanOrEqual(4);
      // Registry propagation lags a dist-tag move by minutes
      // (scripts/lib/npm-latest-guard.mjs documents ~9 minutes observed on
      // the 4.10.1 cut), so the readback must be a POLL — but a BOUNDED one,
      // never an open-ended retry that could hang the job. Anchored to end
      // of line so `POLL_MAX_ATTEMPTS=20` cannot pass a mutant that widens
      // it to `2000` (which still contains the substring "20").
      expect(promoteJob).toMatch(/POLL_MAX_ATTEMPTS=20$/m);
      expect(promoteJob).toMatch(/POLL_INTERVAL_SECONDS=30$/m);
      expect(promoteJob).toMatch(/for attempt in \$\(seq 1 "\$POLL_MAX_ATTEMPTS"\); do/);
      expect(promoteJob).toContain('sleep "$POLL_INTERVAL_SECONDS"');
      expect(promoteJob).not.toMatch(/while\s+(true|:)\s*;?\s*do/);
      // The final failure check must sit AFTER the loop closes (`done`), not
      // inside it — a check inside the loop would fail on attempt 1 even
      // when a later attempt goes on to succeed.
      const doneAt = promoteJob.search(/\n\s*done\s*\n/);
      expect(doneAt, 'no `done` closing the poll loop').toBeGreaterThan(-1);
      const afterLoop = promoteJob.slice(doneAt);
      expect(afterLoop).toMatch(/if \[ "\$LATEST" != "\$VERSION" \]; then/);
      expect(afterLoop).toContain('::error::');
      expect(afterLoop).toMatch(/exit 1/);
    });

    it('every `npm view` in the promote step reads --prefer-online, including the very first one', () => {
      const npmViewLines = commandLines(runBodies(jobBlock('promote'))).filter((l) => /\$\(npm view |^npm view /.test(l));
      expect(npmViewLines.length).toBeGreaterThanOrEqual(4);
      for (const line of npmViewLines) {
        expect(line, line).toContain('--prefer-online');
      }
    });

    it('no `npm view` in the promote step is wrapped with `|| true` (a real registry/network error must fail loud)', () => {
      const npmViewLines = commandLines(runBodies(jobBlock('promote'))).filter((l) => /\$\(npm view |^npm view /.test(l));
      expect(npmViewLines.length).toBeGreaterThan(0);
      for (const line of npmViewLines) {
        expect(line, line).not.toMatch(/\|\|\s*true/);
      }
    });

    it('case 1: distinguishes E404 (not published yet) from a real registry/network error, and drops the now-false "publish job handles this release" text', () => {
      const promoteJob = jobBlock('promote');
      expect(promoteJob).toContain('case "$VERSION_ON_NPM_OUTPUT" in');
      expect(promoteJob).toContain('*E404*)');
      expect(promoteJob).toMatch(/::notice::\$PACKAGE@\$VERSION is not on npm/);
      // `set -e` must be restored (not left off) before the exit-code
      // decision runs, or a later failure in this same step would be
      // silently unguarded.
      expect(promoteJob).toMatch(/set \+e[\s\S]{0,200}VERSION_ON_NPM_EXIT=\$\?[\s\S]{0,40}set -e[\s\S]{0,60}if \[ "\$VERSION_ON_NPM_EXIT" -ne 0 \]/);
      expect(promoteJob).toContain('::error::');
      // The old blanket claim no longer holds once cases 2-4 exist below —
      // a next-mismatch is not "the publish job handles this release".
      expect(workflow).not.toMatch(/not a promotion, the publish job handles this release/);
    });

    it('case 2: exits 0 with a notice when latest already equals VERSION', () => {
      const promoteJob = jobBlock('promote');
      expect(promoteJob).toMatch(/if \[ "\$LATEST" = "\$VERSION" \]; then/);
      expect(promoteJob).toMatch(/::notice::\$PACKAGE@\$VERSION is already latest/);
    });

    it('case 3: refuses to move latest backwards with exit 1, comparing semver with an inline node snippet (no new dependency)', () => {
      const promoteJob = jobBlock('promote');
      expect(promoteJob).toMatch(/isPlainSemver/);
      expect(promoteJob).toMatch(/::error::\$PACKAGE@\$VERSION is not newer than the current latest/);
      expect(promoteJob).toContain('refusing to move latest backwards');
      const compareAt = promoteJob.indexOf('NEWER_THAN_LATEST_EXIT=$?');
      expect(compareAt, 'no comparator exit code captured').toBeGreaterThan(-1);
      expect(promoteJob.slice(compareAt)).toMatch(/exit 1/);
      // The repo carries no semver dependency for this — it must not gain one.
      const pkg = JSON.parse(read('package.json'));
      expect({ ...pkg.dependencies, ...pkg.devDependencies }).not.toHaveProperty('semver');
    });

    it('case 4: VERSION newer than latest but not the current next exits 1 (not 0), naming both values', () => {
      const promoteJob = jobBlock('promote');
      const guardAt = promoteJob.indexOf('if [ "$NEXT" != "$VERSION" ]; then');
      expect(guardAt, 'no next-mismatch guard').toBeGreaterThan(-1);
      const guardEnd = promoteJob.indexOf('\n          fi\n', guardAt);
      expect(guardEnd, 'next-mismatch guard has no closing fi').toBeGreaterThan(guardAt);
      const guardBlock = promoteJob.slice(guardAt, guardEnd);
      expect(guardBlock).toContain('::error::');
      expect(guardBlock).toMatch(/exit 1/);
      expect(guardBlock).not.toMatch(/exit 0/);
      expect(guardBlock).toContain('this job cannot promote it');
      expect(guardBlock).toContain('${LATEST');
      expect(guardBlock).toContain('${NEXT');
    });

    it('CONTRIBUTING.md no longer instructs a manual `npm dist-tag add`', () => {
      expect(read('CONTRIBUTING.md')).not.toMatch(/npm dist-tag add/);
    });

    it('the promote job authenticates to npm the same way the publish job does', () => {
      const promoteJob = jobBlock('promote');
      expect(promoteJob).toMatch(/registry-url:\s*'https:\/\/registry\.npmjs\.org'/);
      expect(promoteJob).toMatch(/NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/);
    });

    it('the promote job declares minimal permissions and pins every action by full sha', () => {
      const promoteJob = jobBlock('promote');
      expect(promoteJob).toMatch(/permissions:\s*\n\s*contents:\s*read/);
      expect(promoteJob).not.toMatch(/id-token:\s*write/);
      const usesLines = [...promoteJob.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
      expect(usesLines.length).toBeGreaterThan(0);
      for (const usesLine of usesLines) {
        expect(usesLine).toMatch(/@[0-9a-f]{40}$/);
      }
    });

    // Everything above reads the YAML as TEXT. None of it can catch a
    // mutation that keeps every keyword in place but inverts what they mean
    // — flip a `!=` to `=`, flip which branch breaks a loop — because the
    // mutated text still satisfies every substring/regex check above. This
    // runs the step's ACTUAL `run: |` body, under the same shell GitHub
    // Actions uses (`bash --noprofile --norc -eo pipefail`), against a stub
    // `npm` (and a no-op `sleep`) on PATH. No network, no real npm.
    describe.skipIf(process.platform === 'win32')('behavioural: runs the real promote script against a stub npm', () => {
      // The workflow itself only ever runs on `ubuntu-latest`; a real POSIX
      // bash execution is representative, and Windows has no bearing here.
      const promoteBody = runBodies(jobBlock('promote')).find((b) => b.includes('PACKAGE='));

      it('the promote step body was extracted', () => {
        expect(promoteBody, 'could not find the promote step\'s run: | body').toBeDefined();
      });

      // Reads FAKE_NPM_STATE (JSON) and answers `npm view`/`npm dist-tag add`
      // from it; never touches the network. Fails loud (exit 1) on any
      // unrecognised call, and on any `view` missing `--prefer-online`, so a
      // regression in the SCRIPT's own call shape breaks these tests too.
      const NPM_STUB = [
        '#!/usr/bin/env node',
        "'use strict';",
        "const fs = require('fs');",
        'const state = JSON.parse(fs.readFileSync(process.env.FAKE_NPM_STATE, "utf8"));',
        'const args = process.argv.slice(2);',
        'function fail(message) { process.stderr.write(message + "\\n"); process.exit(1); }',
        "if (args[0] === 'view') {",
        "  if (!args.includes('--prefer-online')) fail('fake npm: missing --prefer-online');",
        '  const spec = args[1];',
        '  const field = args[2];',
        "  if (field === 'version') {",
        '    if (state.versionError) fail(state.versionError);',
        "    if (!state.versionOnNpm) fail('npm error code E404\\nnpm error 404 No match found for version');",
        "    process.stdout.write(spec.slice(spec.lastIndexOf('@') + 1) + '\\n');",
        '    process.exit(0);',
        '  }',
        "  if (field === 'dist-tags.latest') {",
        '    state.latestReadCount = (state.latestReadCount || 0) + 1;',
        // Each `npm view` invocation is a SEPARATE node process — an
        // in-memory increment alone is lost the instant this process exits.
        // Persisting it back into the same state file is what lets the
        // poll loop's later reads see progress from its earlier ones (and
        // lets the harness see the count even on the read that fails).
        '    fs.writeFileSync(process.env.FAKE_NPM_STATE, JSON.stringify(state));',
        // `latestErrorAtRead` fails only that one 1-indexed read (across the
        // pre-poll check AND every poll attempt); omitting it fails every
        // read, unconditionally, from the first one.
        '    if (state.latestError && (state.latestErrorAtRead === undefined || state.latestReadCount === state.latestErrorAtRead)) fail(state.latestError);',
        '    const seq = state.latestSequence;',
        '    const idx = Math.min(state.latestReadCount - 1, seq.length - 1);',
        "    process.stdout.write((seq[idx] ?? '') + '\\n');",
        '    process.exit(0);',
        '  }',
        "  if (field === 'dist-tags.next') {",
        '    if (state.nextError) fail(state.nextError);',
        "    process.stdout.write((state.next ?? '') + '\\n');",
        '    process.exit(0);',
        '  }',
        "  fail('fake npm: unhandled view field ' + field);",
        "} else if (args[0] === 'dist-tag' && args[1] === 'add') {",
        "  fs.appendFileSync(process.env.FAKE_NPM_ADD_LOG, args[2] + ' ' + args[3] + '\\n');",
        '  process.exit(0);',
        '} else {',
        "  fail('fake npm: unhandled command ' + args.join(' '));",
        '}',
        '',
      ].join('\n');

      function runPromoteStep(state: Record<string, unknown>, version: string) {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-behavioural-'));
        try {
          const binDir = path.join(tmp, 'bin');
          fs.mkdirSync(binDir);
          writeNodeShim(binDir, 'npm', NPM_STUB, 'commonjs');
          // A no-op sleep: the "poll never propagates" case below runs its
          // full 20 attempts in milliseconds instead of 10 real minutes,
          // without editing the script's own POLL_INTERVAL_SECONDS.
          fs.writeFileSync(path.join(binDir, 'sleep'), '#!/bin/sh\nexit 0\n');
          fs.chmodSync(path.join(binDir, 'sleep'), 0o755);

          const work = path.join(tmp, 'work');
          fs.mkdirSync(work);
          fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ version }));

          const statePath = path.join(tmp, 'state.json');
          fs.writeFileSync(statePath, JSON.stringify(state));
          const addLogPath = path.join(tmp, 'dist-tag-add.log');
          const scriptPath = path.join(tmp, 'step.sh');
          fs.writeFileSync(scriptPath, promoteBody!);

          // The exact shell GitHub Actions uses for an unspecified `run:`
          // shell on a Linux runner — not a plain `bash -c`, which has no
          // `-e` and so cannot exercise the set +e/-e toggle at all.
          const result = spawnSync(
            'bash',
            ['--noprofile', '--norc', '-eo', 'pipefail', scriptPath],
            {
              cwd: work,
              env: {
                ...process.env,
                PATH: `${binDir}:${process.env.PATH}`,
                FAKE_NPM_STATE: statePath,
                FAKE_NPM_ADD_LOG: addLogPath,
              },
              encoding: 'utf8',
              timeout: 30000,
            },
          );
          const distTagAddLog = fs.existsSync(addLogPath) ? fs.readFileSync(addLogPath, 'utf8').trim() : '';
          const finalState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
          const latestReads = finalState.latestReadCount ?? 0;
          return { ...result, distTagAddLog, latestReads };
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      }

      it('case 1: VERSION not on npm (E404) exits 0 with a notice, and never calls dist-tag add', () => {
        const r = runPromoteStep({ versionOnNpm: false, next: '4.11.0', latestSequence: ['4.10.4'] }, '4.11.0');
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toMatch(/not on npm/);
        expect(r.distTagAddLog).toBe('');
      });

      it('a real registry error on the version check exits 1, never a false "not on npm" notice', () => {
        const r = runPromoteStep({ versionError: 'npm error code ECONNRESET', next: '4.11.0', latestSequence: ['4.10.4'] }, '4.11.0');
        expect(r.status).toBe(1);
        expect(r.stdout).not.toMatch(/::notice::/);
        expect(r.distTagAddLog).toBe('');
      });

      it('proves set -e is restored after the toggle: a failure on the latest read (after the version check passes) still exits 1', () => {
        const r = runPromoteStep({ versionOnNpm: true, latestError: 'npm error code ECONNRESET', next: '4.11.0', latestSequence: ['4.10.4'] }, '4.11.0');
        expect(r.status).toBe(1);
        expect(r.distTagAddLog).toBe('');
      });

      it('case 2: latest already equals VERSION exits 0 with a notice, and never calls dist-tag add', () => {
        const r = runPromoteStep({ versionOnNpm: true, next: '4.11.0', latestSequence: ['4.11.0'] }, '4.11.0');
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toMatch(/already latest/);
        expect(r.distTagAddLog).toBe('');
      });

      it('case 3: VERSION not newer than latest exits 1, refusing to move latest backwards, and never calls dist-tag add', () => {
        const r = runPromoteStep({ versionOnNpm: true, next: '4.9.0', latestSequence: ['4.11.0'] }, '4.9.0');
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/refusing to move latest backwards/);
        expect(r.distTagAddLog).toBe('');
      });

      it('case 4: VERSION newer than latest but not the current next exits 1 (not 0), and never calls dist-tag add', () => {
        const r = runPromoteStep({ versionOnNpm: true, next: '4.10.5', latestSequence: ['4.10.4'] }, '4.11.0');
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/this job cannot promote it/);
        expect(r.distTagAddLog).toBe('');
      });

      it('case 5: promotes and the poll confirms it once the registry propagates (3rd read)', () => {
        const r = runPromoteStep({ versionOnNpm: true, next: '4.11.0', latestSequence: ['4.10.4', '4.10.4', '4.11.0'] }, '4.11.0');
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toMatch(/promoted @pcircle\/memesh@4\.11\.0 to latest/);
        expect(r.distTagAddLog).toBe('@pcircle/memesh@4.11.0 latest');
        expect(r.latestReads).toBe(3);
      });

      it('case 5 (worst case): the poll exhausts its 20-attempt bound and fails if latest never propagates', () => {
        const r = runPromoteStep({ versionOnNpm: true, next: '4.11.0', latestSequence: ['4.10.4'] }, '4.11.0');
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/promotion did not take after 20 attempts/);
        expect(r.distTagAddLog).toBe('@pcircle/memesh@4.11.0 latest');
        // 1 pre-poll read (case 2/3's own `dist-tags.latest` check) + the
        // poll's full 20 attempts = 21 total reads of that field.
        expect(r.latestReads).toBe(21);
      });

      it('a real registry error on the poll\'s 2nd attempt fails immediately, not after exhausting the poll', () => {
        // The pre-poll check (case 2/3) and every poll attempt are SEPARATE
        // `npm view` requests. A registry error on any one of them must
        // stop the job right there, not be swallowed and retried as if it
        // just meant "not yet propagated" until the poll runs out on its
        // own and prints the unrelated "did not take" exhaustion message.
        //
        // Read #1 = the pre-poll check, read #2 = poll attempt 1, read #3 =
        // poll attempt 2 — where this fails.
        const r = runPromoteStep(
          {
            versionOnNpm: true,
            next: '4.11.0',
            latestSequence: ['4.10.4', '4.10.4'],
            latestError: 'npm error code ECONNRESET',
            latestErrorAtRead: 3,
          },
          '4.11.0',
        );
        expect(r.status).not.toBe(0);
        expect(r.latestReads).toBe(3);
        expect(r.stderr).not.toMatch(/did not take/);
      });
    });
  });

  it('the test runner it shares with prepublishOnly also isolates HOME', () => {
    // Same guarantee, other entry point. `prepublishOnly` reaches the suite
    // through run-tests-isolated.mjs rather than this script, and it had the
    // identical hazard until it was extracted.
    const text = read('scripts/run-tests-isolated.mjs');
    expect(text).toMatch(/mkdtempSync/);
    // The throwaway HOME goes through the shared helper, which is where the
    // deletions now live — asserted behaviourally in
    // 'buildIsolatedSuiteEnv deletes the memesh path variables' below.
    expect(text).toMatch(/buildIsolatedSuiteEnv\(process\.env, \{ runtimeHome: home \}\)/);
    // MEMESH_DB_PATH must stay unset — pointing it at an existing file breaks
    // session-start's no-database-yet cases. This is
    // the assertion the helper cannot make for the runner: the runner must not
    // pin one of its own after building the env.
    expect(text).not.toMatch(/MEMESH_DB_PATH:/);
  });

  it('buildIsolatedRuntimeEnv strips common credentials, and every packaged/dashboard smoke uses it', () => {
    // buildIsolatedRuntimeEnv is extracted into a pure function
    // (scripts/lib/isolated-env.mjs,
    // shared by both smokes) so this test can call it directly instead of
    // running the full smoke (npm pack + install + Playwright).
    //
    // D17: scripts/smoke-packed-artifact.mjs had the same shape of bug in its
    // own `nativeEnv` — MEMESH_DIR was overridden but MEMESH_DB_PATH was left
    // to leak through from `...process.env`. src/host-runtime/router.ts's
    // data directory follows MEMESH_DB_PATH (getMemeshDirFromDbPath), not
    // MEMESH_DIR, so an ambient MEMESH_DB_PATH sent the router's `mkdirSync`
    // to the wrong directory while MEMESH_ROUTER_TOKEN_FILE still pointed at
    // the directory nothing had created — reproduced as `ENOENT` opening
    // `router.token`. Moving the helper to scripts/lib/ and asserting every
    // smoke imports it (below) is what keeps this from drifting apart again.

    const credentialKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_HOST'];

    const libSource = read('scripts/lib/isolated-env.mjs');
    for (const key of credentialKeys) {
      expect(libSource).toContain(`delete isolatedEnv.${key}`);
    }

    // Both scripts import the shared helper rather than hand-rolling their
    // own isolation — a second hand-rolled copy is exactly how D17 happened.
    const packedArtifactSource = read('scripts/smoke-packed-artifact.mjs');
    expect(packedArtifactSource).toMatch(/import \{ buildIsolatedRuntimeEnv \} from '\.\/lib\/isolated-env\.mjs';/);
    // The three scripts that need the deleting variant instead. Two of them —
    // both audit scripts — pinned only HOME, which `src/core/paths.ts`
    // resolves AFTER MEMESH_DIR and MEMESH_DB_PATH: an ambient MEMESH_DB_PATH
    // sent a mutation run, or an injection measurement, straight at the real
    // graph while each script's own comments promised isolation.
    for (const rel of [
      'scripts/run-tests-isolated.mjs',
      'scripts/audit/mutation-sample.mjs',
      'scripts/audit/measure-injection-tokens.mjs',
    ]) {
      expect(read(rel), rel).toMatch(
        /import \{ buildIsolatedSuiteEnv \} from '\.\.?\/lib\/isolated-env\.mjs';/,
      );
    }

    // The import alone proves nothing: reverting a single call site back to
    // the hand-rolled spread leaves the import in place, and this test stayed
    // green through exactly that mutation until it asserted the defect's own
    // shape instead. `{ ...process.env, HOME: … }` IS the defect —
    // `src/core/paths.ts` resolves MEMESH_DIR and MEMESH_DB_PATH before HOME,
    // so pinning HOME inside a full ambient spread reads as isolation and is
    // not. No script that spawns a child may write it.
    for (const rel of [
      'scripts/run-tests-isolated.mjs',
      'scripts/audit/mutation-sample.mjs',
      'scripts/audit/measure-injection-tokens.mjs',
      'scripts/smoke-packed-artifact.mjs',
    ]) {
      expect(read(rel), `${rel} hand-rolls an ambient spread with a pinned HOME`)
        .not.toMatch(/\{\s*\.\.\.process\.env,[^}]*\bHOME\b/);
    }

    // Regression pin for D17 itself: the native-router env must be built
    // through buildIsolatedRuntimeEnv, never a raw `...process.env` spread
    // that overrides MEMESH_DIR without also overriding MEMESH_DB_PATH —
    // that exact shape is the bug that shipped.
    expect(packedArtifactSource).toMatch(/nativeEnv = \{\s*\.\.\.buildIsolatedRuntimeEnv\(/);
    expect(packedArtifactSource).not.toMatch(/nativeEnv = \{\s*\.\.\.process\.env/);

    // The packaged smoke builds at least three child environments
    // deliberately through the helper: the installed-module import/openDatabase
    // check, the MCP protocol driver, and the native router acceptance flow.
    // A count regression here means one of those reverted to inheriting
    // process.env directly.
    const packedArtifactIsolationCalls = packedArtifactSource.match(/buildIsolatedRuntimeEnv\(process\.env,/g) ?? [];
    expect(packedArtifactIsolationCalls.length).toBeGreaterThanOrEqual(3);

    // A base env standing in for a maintainer's shell: real PATH (so the
    // "unrelated ambient state still passes through" assertion below means
    // something), plus a sentinel for every value the isolation must
    // remove or override. GEMINI_API_KEY is deliberately NOT included —
    // grepped repo-wide, it is not read anywhere in this codebase, so a
    // sentinel for it would assert nothing and just be dead weight.
    const paths = {
      runtimeHome: '/test-owned/runtime-home',
      memeshDir: '/test-owned/runtime-home/.memesh',
      dbPath: '/test-owned/runtime-home/.memesh/knowledge-graph.db',
    };
    const pollutedBaseEnv: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: '/ambient/maintainer-home-sentinel',
      USERPROFILE: 'C:\\ambient\\maintainer-home-sentinel',
      MEMESH_DIR: '/ambient/maintainer-memesh-sentinel',
      MEMESH_DB_PATH: '/ambient/maintainer-db-sentinel.db',
      NPM_CONFIG_CACHE: '/ambient/maintainer-npm-cache-sentinel',
      OLLAMA_HOST: 'http://ambient-ollama.invalid',
      OPENAI_API_KEY: 'ambient-openai-sentinel',
      ANTHROPIC_API_KEY: 'ambient-anthropic-sentinel',
      MEMESH_BRIEFING: 'full',
    };

    // Nothing about building this env should print anything — the isolated
    // values (and, on a real machine, real credentials in the base env)
    // must never reach a log.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let env: Record<string, string | undefined>;
    try {
      env = buildIsolatedRuntimeEnv(pollutedBaseEnv, paths);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    // Test-owned paths win over whatever the ambient shell had.
    expect(env.HOME).toBe(paths.runtimeHome);
    expect(env.USERPROFILE).toBe(paths.runtimeHome);
    expect(env.MEMESH_DIR).toBe(paths.memeshDir);
    expect(env.MEMESH_DB_PATH).toBe(paths.dbPath);
    // Common credential variables are gone, not merely overwritten. Asserted
    // key by key (never the whole `env` object) so a
    // failure here can never print a sentinel — or, on a real machine, a
    // real credential — into the test log.
    for (const key of credentialKeys) {
      expect(env[key]).toBeUndefined();
    }
    // The briefing level is product configuration, not plumbing: the default is
    // what the smokes assume, so an ambient value must not move it.
    expect('MEMESH_BRIEFING' in env).toBe(false);

    // Unrelated ambient state (PATH, needed to spawn npm/node) still passes through.
    expect(env.PATH).toBe(pollutedBaseEnv.PATH);
  });

  it('credential-free environment retains launch plumbing and removes owner configuration', () => {
    const clean = buildCredentialFreeBaseEnv({
      PATH: '/bin', LANG: 'en_US.UTF-8', TMPDIR: '/tmp',
      NPM_TOKEN: 'secret', npm_config_userconfig: '/owner/.npmrc', HTTPS_PROXY: 'http://owner',
      SSH_AUTH_SOCK: '/owner/agent', ANTHROPIC_API_KEY: 'secret', MEMESH_DB_PATH: '/owner/db',
    });
    expect(clean).toEqual({ PATH: '/bin', LANG: 'en_US.UTF-8', TMPDIR: '/tmp' });
    expect(read('scripts/smoke-packed-upgrade.mjs')).toContain("const registry = 'https://registry.npmjs.org/'");
  });

  // Calling npm's own CLI avoids a generated shim inheriting an ancestor's
  // ESM mode, while preserving this Node and the fixture's isolated env.
  it('the upgrade smoke calls real npm through Node without a PATH shim', () => {
    const source = read('scripts/smoke-packed-upgrade.mjs');
    expect(source).toContain('path.isAbsolute(npmCli)');
    expect(source).toContain('spawnSync(process.execPath, [npmCli, ...args]');
    expect(source).not.toContain('writeNodeShim');
    expect(source).not.toContain('npm-shim');
  });

  // The other half. `buildIsolatedRuntimeEnv` pins a database path; the suite
  // must NOT be handed one (several hook tests exercise the "no database yet"
  // branches, which a MEMESH_DB_PATH pointing at a real file makes
  // unreachable), so `buildIsolatedSuiteEnv` deletes the path variables
  // instead of setting them. Both were hand-rolled in three scripts, and two
  // of the three pinned only HOME — which is not isolation, because
  // `src/core/paths.ts` resolves MEMESH_DIR and MEMESH_DB_PATH BEFORE
  // falling back to HOME.
  it('buildIsolatedSuiteEnv deletes the memesh path variables rather than pinning them', () => {
    const runtimeHome = '/test-owned/suite-home';
    const pollutedBaseEnv: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: '/ambient/maintainer-home-sentinel',
      USERPROFILE: 'C:\\ambient\\maintainer-home-sentinel',
      MEMESH_DIR: '/ambient/maintainer-memesh-sentinel',
      MEMESH_DB_PATH: '/ambient/maintainer-db-sentinel.db',
      OLLAMA_HOST: 'http://ambient-ollama.invalid',
      OPENAI_API_KEY: 'ambient-openai-sentinel',
      ANTHROPIC_API_KEY: 'ambient-anthropic-sentinel',
      MEMESH_BRIEFING: 'full',
      CLAUDE_CODE_SESSION_ID: 'ambient-claude-session-sentinel',
      CODEX_THREAD_ID: 'ambient-codex-thread-sentinel',
      CODEX_SESSION_ID: 'ambient-codex-session-sentinel',
    };

    const env = buildIsolatedSuiteEnv(pollutedBaseEnv, { runtimeHome });

    expect(env.HOME).toBe(runtimeHome);
    expect(env.USERPROFILE).toBe(runtimeHome);
    // Deleted, not overwritten: an empty string or the ambient value would
    // both still be resolved ahead of HOME.
    expect('MEMESH_DIR' in env).toBe(false);
    expect('MEMESH_DB_PATH' in env).toBe(false);
    // The suite asserts the DEFAULT briefing level, so an ambient value must go.
    expect('MEMESH_BRIEFING' in env).toBe(false);
    // #497: the session a suite run happens to be launched from (inside
    // Claude Code) must not decide which messages a test sees as waiting.
    expect('CLAUDE_CODE_SESSION_ID' in env).toBe(false);
    expect('CODEX_THREAD_ID' in env).toBe(false);
    expect('CODEX_SESSION_ID' in env).toBe(false);
    expect(env.npm_config_cache).toBe(path.join(runtimeHome, 'npm-cache'));
    expect('NPM_CONFIG_CACHE' in env).toBe(false);
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_HOST']) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.PATH).toBe(pollutedBaseEnv.PATH);
  });

});
