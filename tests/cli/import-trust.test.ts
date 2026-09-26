// #407 — `memesh import` names how many rows came in untrusted and how to
// trust them; `memesh import --trust` (behind a confirmation) marks a
// restored backup trusted so it is injected into new sessions like the
// user's own. Through the real CLI and the real SessionStart hook, the same
// way tests/cli/import-restore-archived.test.ts covers #363.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'child_process';
import { build } from 'esbuild';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getProjectName } from '../../src/core/paths.js';
import { isPromptAbort } from '../../src/transports/cli/cli.js';

// Spawns a bundle of the SOURCE, not `dist` — the same reason as
// tests/cli/import-restore-archived.test.ts: `dist` is a build product, and
// a test that spawns it stays green while src/transports/cli/cli.ts is
// mutated.
const REPO_ROOT = path.join(__dirname, '..', '..');
// Fixed for every CLI invocation AND the hook's own `cwd` input below, so
// `remember`, `briefing` and the SessionStart hook all derive the identical
// project identity regardless of which HOME wrote or reads it (#408 made
// this identity a hash of the real path / git remote, not the HOME dir).
const PROJECT_CWD = REPO_ROOT;
const PROJECT = getProjectName(PROJECT_CWD);

let bundleDir: string;
let CLI_PATH: string;

async function bundleCliFromSource(): Promise<void> {
  bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-src-'));
  CLI_PATH = path.join(bundleDir, 'dist', 'transports', 'cli', 'cli.js');
  fs.mkdirSync(path.dirname(CLI_PATH), { recursive: true });
  // cli.ts reads '../../../package.json' relative to its own URL.
  fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(bundleDir, 'package.json'));
  await build({
    absWorkingDir: REPO_ROOT,
    entryPoints: [path.join(REPO_ROOT, 'src', 'transports', 'cli', 'cli.ts')],
    outfile: CLI_PATH,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22.13',
    packages: 'bundle',
    external: ['node:*'],
    legalComments: 'none',
    banner: { js: "import { createRequire as __memeshCreateRequire } from 'node:module'; const require = __memeshCreateRequire(import.meta.url);" },
  });
}

function runCli(args: string[], home: string): { stdout: string; stderr: string; exitCode: number } {
  // No `input` given: spawnSync still pipes stdin, but nothing is written to
  // it, so the child sees EOF immediately — the same "not a terminal" shape
  // a real non-interactive run (CI, a script, a piped command) has.
  const r = spawnSync('node', [CLI_PATH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status ?? 1 };
}

/** The SessionStart hook's own injected-context string, against a real HOME. */
function runSessionStartHook(home: string): string {
  const hookPath = path.resolve('scripts/hooks/session-start.js');
  const out = execFileSync('node', [hookPath], {
    input: JSON.stringify({ cwd: PROJECT_CWD }),
    env: { ...process.env, HOME: home, USERPROFILE: home, MEMESH_BRIEFING: 'standard' },
    encoding: 'utf8',
    timeout: 15000,
  });
  const parsed = JSON.parse(out.trim()) as { hookSpecificOutput?: { additionalContext?: string } };
  return parsed.hookSpecificOutput?.additionalContext ?? '';
}

function recallEntities(home: string, query: string): Array<{ id: number; name: string }> {
  const r = runCli(['recall', query, '--json'], home);
  expect(r.exitCode, r.stderr).toBe(0);
  return (JSON.parse(r.stdout) as { entities: Array<{ id: number; name: string }> }).entities;
}

function briefingIndexIds(home: string): number[] {
  const r = runCli(['briefing', '--index', '--json'], home);
  expect(r.exitCode, r.stderr).toBe(0);
  return (JSON.parse(r.stdout) as { ids: number[] }).ids;
}

describe('isPromptAbort — the --trust confirmation catch recognizes only EOF, never any error', () => {
  it('is true for the AbortError rl.question() throws on Ctrl-D', () => {
    expect(isPromptAbort(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))).toBe(true);
  });
  it('is false for an ordinary error, so it rethrows rather than reading it as "no"', () => {
    expect(isPromptAbort(new Error('boom'))).toBe(false);
    expect(isPromptAbort(new TypeError('nope'))).toBe(false);
  });
  it('is false for a non-Error value', () => {
    expect(isPromptAbort('AbortError')).toBe(false);
    expect(isPromptAbort(undefined)).toBe(false);
  });
});

describe('memesh import --trust (#407)', () => {
  // A distinctive marker so the hook's rendered context can be checked by
  // substring without depending on exactly how a title/snippet is derived.
  const MARKER = 'TRUST407-MARKER unique observation text';
  const MEMORY_NAME = 'trust-407-alpha';

  let home: string;
  let bundlePath: string;

  beforeAll(async () => { await bundleCliFromSource(); }, 120_000);
  afterAll(() => { fs.rmSync(bundleDir, { recursive: true, force: true }); });

  beforeEach(() => {
    const seedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-trust-seed-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-trust-home-'));

    expect(runCli(
      ['remember', '--name', MEMORY_NAME, '--type', 'note', '--obs', MARKER, '--tags', `project:${PROJECT}`],
      seedHome,
    ).exitCode).toBe(0);

    // A path with a space AND an apostrophe: the suggested RE-RUN COMMANDS
    // (the untrusted notice, the no-terminal refusal) name this file and
    // must shell-quote it. The interactive confirmation prompt is a
    // question for a human, not a command to paste, so it prints this same
    // path raw — deliberately NOT covered by the quoting assertions below.
    bundlePath = path.join(home, "it's a backup.json");
    expect(runCli(['export', '-o', bundlePath], seedHome).exitCode).toBe(0);
    fs.rmSync(seedHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('a plain import prints the untrusted notice with the right count and a command that actually works; the row is recallable but not injected', () => {
    const r = runCli(['import', bundlePath, '--merge', 'overwrite'], home);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain('1 memory imported as untrusted');
    expect(r.stdout).toContain('memesh import');
    expect(r.stdout).toContain('--merge overwrite --trust');

    // recall still finds it — untrusted rows are recallable, just not injected.
    const recalled = recallEntities(home, MEMORY_NAME);
    expect(recalled).toHaveLength(1);
    expect(recalled.map((e) => e.name)).toContain(MEMORY_NAME);
    const entityId = recalled.find((e) => e.name === MEMORY_NAME)!.id;

    // The briefing index — the same gate the SessionStart hook uses — omits it.
    expect(briefingIndexIds(home)).not.toContain(entityId);
    expect(runSessionStartHook(home)).not.toContain(MARKER);

    // "A command that works": extract the suggested command verbatim,
    // substitute the real CLI binary, and actually run it through a shell —
    // this is a claim to prove, not merely to read.
    const match = /memesh import (.+) --merge overwrite --trust/.exec(r.stdout);
    expect(match, r.stdout).toBeTruthy();
    const quotedFileArg = match![1];
    const rerun = spawnSync('sh', ['-c', `node "${CLI_PATH}" import ${quotedFileArg} --merge overwrite --trust --yes`], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(rerun.stdout).toContain('Trusted: 1');
  });

  it('the no-terminal refusal preserves --merge in its suggested re-run (a dropped --merge silently trusts nothing)', () => {
    // Follow the notice's own suggested command (`--merge overwrite
    // --trust`), without --yes and without a terminal — the row from this
    // plain import already exists, so a re-run that drops --merge back to
    // the default `skip` would import nothing and trust nothing.
    expect(runCli(['import', bundlePath, '--merge', 'overwrite'], home).exitCode).toBe(0);

    const r = runCli(['import', bundlePath, '--trust', '--merge', 'overwrite'], home);
    expect(r.exitCode).toBe(1);
    const match = /Re-run with: memesh (import .+)$/m.exec(r.stderr);
    expect(match, r.stderr).toBeTruthy();
    const rerun = spawnSync('sh', ['-c', `node "${CLI_PATH}" ${match![1]}`], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(rerun.stdout).toContain('Trusted: 1');
  });

  it('omits the overwrite suggestion and names the count when the file also names a memory that already exists (skip)', () => {
    // A local memory the bundle ALSO names: --merge overwrite would replace
    // it, and it was never touched by this import (skipped, not imported).
    expect(runCli(['remember', '--name', 'already-here', '--type', 'note', '--obs', 'LOCAL TEXT'], home).exitCode).toBe(0);
    const mixedBundle = path.join(home, 'mixed-skip.json');
    fs.writeFileSync(mixedBundle, JSON.stringify({
      version: '3.1.0', exported_at: '2026-09-26T00:00:00.000Z', entity_count: 2,
      entities: [
        { name: 'brand-new-a', type: 'note', namespace: 'personal', observations: ['fresh'], tags: [], relations: [] },
        { name: 'already-here', type: 'note', namespace: 'personal', observations: ['from file'], tags: [], relations: [] },
      ],
    }));

    const r = runCli(['import', mixedBundle, '--merge', 'skip'], home);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain('1 memory imported as untrusted');
    expect(r.stdout).not.toContain('run: memesh import');
    expect(r.stdout).toContain('(--trust --merge overwrite not suggested: it would also replace 1 memory already here.)');
  });

  it('omits the overwrite suggestion, pluralizes the count and the reason, and separately names the memories an append marked untrusted', () => {
    expect(runCli(['remember', '--name', 'already-here-1', '--type', 'note', '--obs', 'LOCAL 1'], home).exitCode).toBe(0);
    expect(runCli(['remember', '--name', 'already-here-2', '--type', 'note', '--obs', 'LOCAL 2'], home).exitCode).toBe(0);
    const mixedBundle = path.join(home, 'mixed-append.json');
    fs.writeFileSync(mixedBundle, JSON.stringify({
      version: '3.1.0', exported_at: '2026-09-26T00:00:00.000Z', entity_count: 3,
      entities: [
        { name: 'brand-new-b', type: 'note', namespace: 'personal', observations: ['fresh'], tags: [], relations: [] },
        { name: 'already-here-1', type: 'note', namespace: 'personal', observations: ['from file 1'], tags: [], relations: [] },
        { name: 'already-here-2', type: 'note', namespace: 'personal', observations: ['from file 2'], tags: [], relations: [] },
      ],
    }));

    // append: brand-new-b is CREATED (no existing row, so it is IMPORTED);
    // the other two are APPENDED to (they already existed) — neither was
    // freshly imported, so overwriting them on re-run would drop LOCAL 1/2.
    const r = runCli(['import', mixedBundle, '--merge', 'append'], home);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain('1 memory imported as untrusted');
    expect(r.stdout).not.toContain('run: memesh import');
    expect(r.stdout).toContain('(--trust --merge overwrite not suggested: it would also replace 2 memories already here.)');
    // A plain `append` has always marked an entity untrusted too (whether it
    // was untrusted or trusted before) — a fact distinct from "imported".
    expect(r.stdout).toContain('Marked untrusted because this file added text to them: 2 memories you already had.');
  });

  it('a malformed bundle (no entities array) fails with the core error before any confirmation, even without --yes or a terminal', () => {
    const badBundle = path.join(home, 'no-entities.json');
    fs.writeFileSync(badBundle, JSON.stringify({ version: '3.1.0', exported_at: new Date().toISOString(), entity_count: 0 }));
    const r = runCli(['import', badBundle, '--trust'], home);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('This file has no "entities" array');
    // If the array check ran AFTER the terminal check, this would print
    // "Not a terminal" instead — the wrong reason, for a request that was
    // never valid in the first place.
    expect(r.stderr).not.toContain('Not a terminal');
  });

  it('--trust --merge overwrite --yes makes the rows injectable — briefing lists them and the SessionStart hook injects them', () => {
    expect(runCli(['import', bundlePath, '--merge', 'overwrite'], home).exitCode).toBe(0);

    const r = runCli(['import', bundlePath, '--merge', 'overwrite', '--trust', '--yes'], home);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain('Trusted: 1');
    // Nothing was appended in this run, so there is nothing more to say.
    expect(r.stdout).not.toContain('appended');

    const recalled = recallEntities(home, MEMORY_NAME);
    const entityId = recalled.find((e) => e.name === MEMORY_NAME)!.id;
    expect(briefingIndexIds(home)).toContain(entityId);
    expect(runSessionStartHook(home)).toContain(MARKER);
  });

  it('the --trust summary names appended rows that kept their own trust, and only those', () => {
    // One entity the file creates fresh (trusted), one it appends onto an
    // existing local memory (which keeps whatever trust it already had).
    expect(runCli(['remember', '--name', 'left-alone', '--type', 'note', '--obs', 'LOCAL'], home).exitCode).toBe(0);
    const mixedBundle = path.join(home, 'mixed-trust.json');
    fs.writeFileSync(mixedBundle, JSON.stringify({
      version: '3.1.0', exported_at: '2026-09-26T00:00:00.000Z', entity_count: 2,
      entities: [
        { name: 'brand-new-c', type: 'note', namespace: 'personal', observations: ['fresh'], tags: [], relations: [] },
        { name: 'left-alone', type: 'note', namespace: 'personal', observations: ['from file'], tags: [], relations: [] },
      ],
    }));

    const r = runCli(['import', mixedBundle, '--merge', 'append', '--trust', '--yes'], home);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain('Trusted: 1');
    expect(r.stdout).toContain('1 memory appended kept their own trust.');
  });

  it('--trust without --yes and without a terminal refuses (exit 1) and writes nothing', () => {
    const r = runCli(['import', bundlePath, '--merge', 'overwrite', '--trust'], home);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('--yes');

    // Nothing was imported: the row is not even recallable yet.
    expect(recallEntities(home, MEMORY_NAME)).toHaveLength(0);
  });

  it('--yes without --trust is refused', () => {
    const r = runCli(['import', bundlePath, '--yes'], home);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('--yes only applies with --trust');
    expect(recallEntities(home, MEMORY_NAME)).toHaveLength(0);
  });

  it('--trust with --notes is refused, using the existing notes-refusal list', () => {
    const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-trust-notes-'));
    try {
      const r = runCli(['import', '--notes', notesDir, '--trust'], home);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('--notes does not take --trust');
    } finally {
      fs.rmSync(notesDir, { recursive: true, force: true });
    }
  });

  it('a plain import that imports and appends nothing prints no untrusted-count line', () => {
    const emptyBundle = path.join(home, 'empty.json');
    fs.writeFileSync(emptyBundle, JSON.stringify({
      version: '3.1.0', exported_at: new Date().toISOString(), entity_count: 0, entities: [],
    }));
    const r = runCli(['import', emptyBundle], home);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).not.toContain('imported as untrusted');
  });
});
