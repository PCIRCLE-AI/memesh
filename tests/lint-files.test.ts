/**
 * `scripts/lib/lint-files.mjs` backs `npm run lint` / `lint:fix`
 * (scripts/lint-tracked.mjs) and has two behaviours that cannot be safely
 * exercised by spawning the real entry point end to end: a Windows-only
 * command-line-length failure and a "tracked file deleted on
 * disk but not yet staged" case (#372). Both are tested here against
 * the exported pure functions instead — `batchFiles`, `runAllBatches`,
 * `filterExistingFiles` — which is also deliberately how this file avoids
 * adding any new knob (env var or CLI flag) to the entry point's real
 * execution path just to force a tiny argv budget for a test:
 * `runAllBatches` is proven correct with an injected batch-runner instead
 * of a real, budget-starved eslint spawn.
 *
 * This file imports the LIBRARY, never the entry point
 * (scripts/lint-tracked.mjs): that file runs `main()` unconditionally at
 * module load, so importing it here would spawn ESLint and call
 * `process.exit()` as a side effect of the import. The entry point itself
 * is spawned in tests/lint-tracked.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LINT_DIRS,
  LINT_EXTENSIONS,
  batchFiles,
  classifySpawnResult,
  emptyLintDirs,
  filterEslintIgnored,
  filterExistingFiles,
  listGitFiles,
  runAllBatches,
  runEslintBatch,
} from '../scripts/lib/lint-files.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('batchFiles', () => {
  it('returns no batches for empty input', () => {
    expect(batchFiles([], 100)).toEqual([]);
  });

  it('keeps every path — nothing lost, nothing duplicated, order preserved', () => {
    const paths = Array.from({ length: 50 }, (_, i) => `src/file-${i}.ts`);
    // A simple length-only weight (no ARGV_PATH_OVERHEAD) so the budget math
    // in this test is exact and independent of that internal constant.
    const batches = batchFiles(paths, 60, (p) => p.length);
    expect(batches.flat()).toEqual(paths);
  });

  it('keeps every batch at or under the budget when no single path exceeds it', () => {
    const paths = Array.from({ length: 50 }, (_, i) => `src/file-${i}.ts`);
    const budget = 60;
    const weight = (p: string) => p.length;
    const batches = batchFiles(paths, budget, weight);
    // Precondition: this actually exercised splitting into more than one
    // batch, or the "no batch over budget" assertion below would be trivially
    // true of a single all-in-one batch.
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      const totalWeight = batch.reduce((sum, p) => sum + weight(p), 0);
      expect(totalWeight).toBeLessThanOrEqual(budget);
    }
  });

  it('a single path longer than the budget gets its own batch instead of being dropped or looping forever', () => {
    const longPath = `src/${'x'.repeat(500)}.ts`;
    const paths = ['src/a.ts', longPath, 'src/b.ts'];
    const batches = batchFiles(paths, 50, (p) => p.length);
    expect(batches.flat()).toEqual(paths); // nothing dropped
    const longBatch = batches.find((b) => b.includes(longPath));
    expect(longBatch).toEqual([longPath]); // its own batch, not merged with a neighbour
  });

  it('terminates in at most N batches when the budget is smaller than every single path (no infinite loop)', () => {
    const paths = Array.from({ length: 20 }, (_, i) => `t${i}.ts`);
    const batches = batchFiles(paths, 1, (p) => p.length); // budget smaller than any single path
    expect(batches.length).toBe(paths.length); // every path is its own batch
    expect(batches.flat()).toEqual(paths);
  });

  it('the real default weight function also produces more than one batch for a large-enough tree, under ARGV_BUDGET_CHARS (8,000)', () => {
    // Uses the PRODUCTION default (no weightFn override) to confirm it is
    // actually wired up, not just the injectable version above.
    const paths = Array.from({ length: 2000 }, (_, i) => `src/some/deep/path/file-${i}.ts`);
    const batches = batchFiles(paths, 8_000);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(paths);
  });
});

describe('runAllBatches', () => {
  it('runs every batch — does not stop at the first non-zero status — and returns the worst (max) status', () => {
    const seen: string[][] = [];
    const statuses = [0, 1, 0];
    let i = 0;
    const worst = runAllBatches([['a'], ['b'], ['c']], (batch: string[]) => {
      seen.push(batch);
      return statuses[i++];
    });
    expect(seen).toEqual([['a'], ['b'], ['c']]); // all three ran, none skipped
    expect(worst).toBe(1);
  });

  it('a failure confined to the LAST batch still fails the whole run', () => {
    let calls = 0;
    const worst = runAllBatches([['a'], ['b']], (batch: string[]) => {
      calls++;
      return batch[0] === 'b' ? 1 : 0;
    });
    expect(worst).toBe(1);
    expect(calls).toBe(2);
  });

  it('a failure confined to the FIRST batch still runs (and does not skip) the remaining batches, and still fails the whole run', () => {
    let calls = 0;
    const worst = runAllBatches([['a'], ['b']], (batch: string[]) => {
      calls++;
      return batch[0] === 'a' ? 1 : 0;
    });
    expect(worst).toBe(1);
    expect(calls).toBe(2); // the second batch still ran even though the first already failed
  });

  it('returns 0 when every batch is clean', () => {
    expect(runAllBatches([['a'], ['b']], () => 0)).toBe(0);
  });

  it('returns 0 for an empty batch list without calling runBatch at all', () => {
    expect(runAllBatches([], () => { throw new Error('should never be called'); })).toBe(0);
  });

  it('a fatal status (2, a spawn/config failure) outranks an ordinary lint failure (1)', () => {
    expect(runAllBatches([['a'], ['b']], (batch: string[]) => (batch[0] === 'a' ? 1 : 2))).toBe(2);
  });
});

describe('filterExistingFiles', () => {
  it('partitions tracked-but-deleted-on-disk paths into missing, and keeps the rest — order preserved in each list', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-tracked-exists-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'a.ts'), '');
      fs.writeFileSync(path.join(dir, 'src', 'c.ts'), '');
      // src/b.ts is intentionally never created on disk — a file git still
      // has indexed (`git ls-files --cached` would list it) but the
      // developer has deleted without staging the deletion yet.
      const { kept, missing } = filterExistingFiles(['src/a.ts', 'src/b.ts', 'src/c.ts'], dir);
      expect(kept).toEqual(['src/a.ts', 'src/c.ts']);
      expect(missing).toEqual(['src/b.ts']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps everything and reports nothing missing when every path exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-tracked-exists-'));
    try {
      fs.writeFileSync(path.join(dir, 'only.ts'), '');
      const { kept, missing } = filterExistingFiles(['only.ts'], dir);
      expect(kept).toEqual(['only.ts']);
      expect(missing).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports everything missing (none kept) when nothing on the list exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-tracked-exists-'));
    try {
      const { kept, missing } = filterExistingFiles(['gone-a.ts', 'gone-b.ts'], dir);
      expect(kept).toEqual([]);
      expect(missing).toEqual(['gone-a.ts', 'gone-b.ts']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('LINT_EXTENSIONS', () => {
  // The set follows what the flat config covers, not what the tree happens
  // to use: an extension missing here is a file `npm run lint` never sees.
  it('covers every extension the flat config lints: .js/.mjs/.cjs/.ts/.tsx/.mts/.cts', () => {
    expect([...LINT_EXTENSIONS].sort()).toEqual(['.cjs', '.cts', '.js', '.mjs', '.mts', '.ts', '.tsx']);
  });

  // Derived from the LIVE config (ESLint#calculateConfigForFile), not a
  // second hand-copied list: an extension `calculateConfigForFile` hands a
  // real rule set to is one `npm run lint` opens; one it returns no config
  // for (`.jsx`, `.json`, `.md`, `.d.ts`) is one ESLint never examines.
  it('the derived-from-config set matches LINT_EXTENSIONS exactly', async () => {
    const { ESLint } = await import('eslint');
    const eslint = new ESLint({ cwd: repoRoot });
    const candidates = [
      '.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', // claimed as covered
      '.jsx', '.json', '.md', '.css', '.html', '.d.ts', // known NOT covered
    ];
    const covered: string[] = [];
    for (const ext of candidates) {
      const config = await eslint.calculateConfigForFile(`probe${ext}`);
      if (config !== undefined && Object.keys(config.rules ?? {}).length > 0) covered.push(ext);
    }
    expect(covered.sort()).toEqual([...LINT_EXTENSIONS].sort());
  });
});

describe('classifySpawnResult', () => {
  // The real call spawns `process.execPath` itself, which essentially never
  // fails to launch — a synthetic result is the only practical way to prove
  // this pure function does not silently map a spawn failure to 0.
  it('a spawn failure (the executable itself could not be launched) maps to fatal status 2', () => {
    const result = classifySpawnResult({ error: new Error('spawn ENOENT'), status: null, signal: null });
    expect(result.status).toBe(2);
    expect(result.reason).toBe('spawn-error');
  });

  it('a signal-killed process (status null) maps to fatal status 2', () => {
    const result = classifySpawnResult({ error: null, status: null, signal: 'SIGTERM' });
    expect(result.status).toBe(2);
    expect(result.reason).toBe('signal');
  });

  it('an ordinary exit status passes through unchanged, including 0 and 1', () => {
    expect(classifySpawnResult({ error: null, status: 0, signal: null })).toEqual({ status: 0, reason: 'exit' });
    expect(classifySpawnResult({ error: null, status: 1, signal: null })).toEqual({ status: 1, reason: 'exit' });
  });
});

describe('filterEslintIgnored', () => {
  // Read-only against the real repository's own eslint.config.js: `dist/` is
  // a real path this config ignores, `scripts/lint-tracked.mjs` one it lints.
  it('drops a file eslint.config.js ignores and keeps one it does not, checked against the REAL config', async () => {
    const candidates = ['dist/transports/cli/cli.js', 'scripts/lint-tracked.mjs'];
    const { kept, ignored, unconfigured } = await filterEslintIgnored(candidates, repoRoot);
    expect(ignored).toEqual(['dist/transports/cli/cli.js']);
    expect(kept).toEqual(['scripts/lint-tracked.mjs']);
    expect(unconfigured).toEqual([]);
  });

  it('drops EVERY file under a directory eslint.config.js ignores, not just one', async () => {
    const generated = fs.readdirSync(path.join(repoRoot, 'scripts/hooks/_generated'))
      .filter((name) => name.endsWith('.js'))
      .map((name) => `scripts/hooks/_generated/${name}`);
    expect(generated.length).toBeGreaterThan(0); // precondition: the fixture directory is not itself empty
    const { kept, ignored, unconfigured } = await filterEslintIgnored(generated, repoRoot);
    expect(ignored).toEqual(generated);
    expect(kept).toEqual([]);
    expect(unconfigured).toEqual([]);
  });

  // `isPathIgnored` is true for both an `ignores` match and a file no config
  // block matches; only the first is "ignored".
  it('tells a file an `ignores` pattern drops apart from one no config block matches', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-files-config-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
      fs.writeFileSync(
        path.join(dir, 'eslint.config.js'),
        "export default [{ ignores: ['gen/**'] }, { files: ['**/*.js'], rules: { 'no-var': 'error' } }];\n",
      );
      const result = await filterEslintIgnored(['gen/a.js', 'src/a.ts', 'src/b.js'], dir);
      expect(result).toEqual({ kept: ['src/b.js'], ignored: ['gen/a.js'], unconfigured: ['src/a.ts'] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runEslintBatch', () => {
  const options = { eslintBin: '/eslint/bin.js', extraArgs: ['--max-warnings', '0'], cwd: '/repo' };

  it('runs node on the ESLint binary with the batch and the extra arguments, and returns the exit status', () => {
    const calls: unknown[][] = [];
    const status = runEslintBatch(['a.ts', 'b.ts'], {
      ...options,
      spawn: (...args: unknown[]) => { calls.push(args); return { error: null, status: 1, signal: null }; },
      log: () => { throw new Error('an ordinary exit status logs nothing'); },
    });
    expect(status).toBe(1);
    expect(calls).toEqual([[process.execPath, ['/eslint/bin.js', 'a.ts', 'b.ts', '--max-warnings', '0'], { cwd: '/repo', stdio: 'inherit' }]]);
  });

  // The real command is `process.execPath`, which essentially never fails to
  // launch, so a synthetic spawn result is the way to reach these branches.
  it('a spawn failure is fatal (2) and says so', () => {
    const logged: string[] = [];
    const status = runEslintBatch(['a.ts'], {
      ...options,
      spawn: () => ({ error: new Error('spawn ENOENT'), status: null, signal: null }),
      log: (line: string) => logged.push(line),
    });
    expect(status).toBe(2);
    expect(logged).toEqual(['lint-tracked: failed to spawn eslint: spawn ENOENT']);
  });

  it('a signal-killed ESLint is fatal (2) and names the signal', () => {
    const logged: string[] = [];
    const status = runEslintBatch(['a.ts'], {
      ...options,
      spawn: () => ({ error: null, status: null, signal: 'SIGKILL' }),
      log: (line: string) => logged.push(line),
    });
    expect(status).toBe(2);
    expect(logged).toEqual(['lint-tracked: eslint was terminated by SIGKILL']);
  });
});

describe('listGitFiles', () => {
  function tempGitRepo(): { dir: string; git: (...args: string[]) => string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-files-listgit-'));
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    return { dir, git, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }

  // #372: a raw `readdirSync` walk cannot tell a git-ignored local file
  // from one actually part of the repository, and would let it silently
  // change a caller's verdict.
  it('excludes a git-ignored file from the listing', () => {
    const repo = tempGitRepo();
    try {
      fs.mkdirSync(path.join(repo.dir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(repo.dir, 'scripts', 'ignored.mjs'), 'export const x = 1;\n');
      fs.writeFileSync(path.join(repo.dir, 'scripts', 'kept.mjs'), 'export const y = 1;\n');
      fs.writeFileSync(path.join(repo.dir, '.gitignore'), 'scripts/ignored.mjs\n');
      expect(listGitFiles(repo.dir, ['scripts']).sort()).toEqual(['scripts/kept.mjs']);
    } finally {
      repo.cleanup();
    }
  });

  it('keeps an untracked file that is not ignored — about to be added, not yet committed', () => {
    const repo = tempGitRepo();
    try {
      fs.mkdirSync(path.join(repo.dir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(repo.dir, 'scripts', 'new.mjs'), 'export const z = 1;\n');
      expect(listGitFiles(repo.dir, ['scripts'])).toEqual(['scripts/new.mjs']);
    } finally {
      repo.cleanup();
    }
  });
});

describe('emptyLintDirs', () => {
  const oneEach = ['src/a.ts', 'scripts/b.mjs', 'tests/c.test.ts', 'dashboard/src/d.tsx'];

  it('reports nothing when every lint directory contributes a file', () => {
    expect(emptyLintDirs(oneEach)).toEqual([]);
  });

  it('names the one directory that contributes nothing while the others do', () => {
    expect(emptyLintDirs(oneEach.filter((rel) => !rel.startsWith('dashboard/')))).toEqual(['dashboard/src']);
  });

  it('matches a whole path segment: dashboard/srcfoo/x.ts is not under dashboard/src', () => {
    const paths = ['src/a.ts', 'scripts/b.mjs', 'tests/c.test.ts', 'dashboard/srcfoo/x.ts'];
    expect(emptyLintDirs(paths)).toEqual(['dashboard/src']);
  });

  it('names every directory for an empty list, in LINT_DIRS order', () => {
    expect(emptyLintDirs([])).toEqual(LINT_DIRS);
  });
});
