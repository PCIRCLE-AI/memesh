/**
 * `scripts/lint-tracked.mjs` is `npm run lint`. Each case spawns the real
 * entry point inside a throwaway git repository under `os.tmpdir()`
 * (tests/lint-files.test.ts covers the pure functions and never imports it,
 * since it runs `main()` on load):
 *
 * - reached through a symlinked `scripts/` directory, it still lints and
 *   still fails on a real error;
 * - it fails, naming what it found, when a lint directory contributes no
 *   file, when `eslint.config.js` ignores a whole directory, and when a file
 *   matches no config block; it skips a tracked file deleted on disk and a
 *   git-ignored one;
 * - ESLint killed by a signal exits 2 (fatal), not 1 (findings);
 * - `--fix` reaches every batch, not only the first.
 *
 * The fixture holds copies of the entry point, its library and
 * eslint.config.js, never this checkout: a fixture planted here would change
 * the tree the verify receipt is bound to. The script derives its root from
 * its own location, so the copy lints the throwaway tree; ESLint comes from
 * this checkout's node_modules through a directory link (a junction, which
 * needs no privilege on Windows).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARGV_BUDGET_CHARS, LINT_DIRS, batchFiles } from '../scripts/lib/lint-files.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Whether this platform lets an unprivileged process create a directory
 * link of `type`, checked once at module load so the cases below can
 * register `it.skip` instead of failing for a reason unrelated to what they
 * check. (Windows needs Developer Mode or elevation for `dir`, not for
 * `junction`.)
 */
function linksSupported(type: 'dir' | 'junction'): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-entrypoint-link-probe-'));
  try {
    fs.mkdirSync(path.join(dir, 'target'));
    fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'), type);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Makes this checkout's node_modules reachable from a fixture, so ESLint resolves. */
function linkNodeModules(root: string): void {
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), 'junction');
}

/** The inherited environment without any variable that points git elsewhere. */
function envWithoutGit(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A git repository holding the entry point, its library, the ESLint config
 * and one clean file (`cleanName`) in each of `dirs`. Nothing is committed:
 * the script lists untracked-but-not-ignored files too.
 */
function buildLintRepo(dirs: string[], cleanName = 'clean.ts'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-entrypoint-repo-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  for (const rel of ['scripts/lint-tracked.mjs', 'scripts/lib/lint-files.mjs', 'eslint.config.js']) {
    fs.copyFileSync(path.join(repoRoot, rel), path.join(root, rel));
  }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
  for (const dir of dirs) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, cleanName), 'export const clean = 1;\n');
  }
  const init = spawnSync('git', ['init', '--quiet', root], { encoding: 'utf8', env: envWithoutGit() });
  expect(init.status, init.stderr).toBe(0);
  return root;
}

describe('Feature: the lint entry point never reports a clean pass it did not earn', () => {
  it('fails, naming the directory, when one lint directory contributes no file', () => {
    const root = buildLintRepo(LINT_DIRS.filter((dir) => dir !== 'dashboard/src'));

    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'lint-tracked.mjs'), '--max-warnings', '0'], {
      encoding: 'utf8',
      env: envWithoutGit(),
      timeout: 60_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no lintable file under dashboard/src');
  }, 60_000);

  // No node_modules symlink needed: the missing path was the ONLY file
  // under `tests/`, so `emptyLintDirs` exits 1 having printed the skip
  // line first, before ESLint enters the picture at all.
  it('a tracked-but-deleted file is skipped with a count on stderr, printed before the run otherwise fails', () => {
    const root = buildLintRepo(LINT_DIRS);
    const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env: envWithoutGit() });
    expect(git('add', '-A').status).toBe(0);
    fs.rmSync(path.join(root, 'tests', 'clean.ts'));

    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'lint-tracked.mjs'), '--max-warnings', '0'], {
      encoding: 'utf8',
      env: envWithoutGit(),
      timeout: 60_000,
    });

    expect(result.stderr).toContain('skipped 1 tracked file(s) that no longer exist on disk');
  }, 60_000);

  // Only the symlinked-entry case needs a real symlink; every case that
  // reaches ESLint needs just the node_modules link.
  const canLinkModules = linksSupported('junction');
  const canSymlink = linksSupported('dir');
  const needsModules = canLinkModules ? it : it.skip;
  const needsSymlink = canLinkModules && canSymlink ? it : it.skip;
  if (!canLinkModules) {
    console.warn('skipping the lint entry-point cases that reach ESLint: this platform/user cannot link node_modules');
  }
  if (!canSymlink) {
    console.warn('skipping the symlinked-entry-point test: symlinkSync is not permitted on this platform/user');
  }

  // With a SECOND file left in `tests/`, the missing one no longer empties
  // its directory, so the run reaches a real ESLint pass — proving
  // `filterExistingFiles` keeps the missing path OUT of what reaches
  // ESLint, not only that a message printed.
  needsModules('a tracked-but-deleted file does not stop the rest of its own directory from linting', () => {
    const root = buildLintRepo(LINT_DIRS);
    linkNodeModules(root);
    const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env: envWithoutGit() });
    fs.writeFileSync(path.join(root, 'tests', 'second.ts'), 'export const second = 1;\n');
    expect(git('add', '-A').status).toBe(0);
    fs.rmSync(path.join(root, 'tests', 'clean.ts'));

    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'lint-tracked.mjs'), '--max-warnings', '0'], {
      encoding: 'utf8',
      env: envWithoutGit(),
      timeout: 60_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('skipped 1 tracked file(s) that no longer exist on disk');
  }, 60_000);

  // Kills the mutant "drop --exclude-standard": without it, `git ls-files
  // --others` also lists gitignored files, and this one carries a real
  // `no-var` error that a run which actually respects .gitignore must never
  // see.
  needsModules('a git-ignored file is not linted even though it has a real error and sits on disk', () => {
    const root = buildLintRepo(LINT_DIRS);
    linkNodeModules(root);
    fs.appendFileSync(path.join(root, '.gitignore'), 'scripts/ignored-fixture.mjs\n');
    fs.writeFileSync(path.join(root, 'scripts', 'ignored-fixture.mjs'), 'var shouldBeConst = 1;\nconsole.log(shouldBeConst);\n');

    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'lint-tracked.mjs'), '--max-warnings', '0'], {
      encoding: 'utf8',
      env: envWithoutGit(),
      timeout: 60_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('ignored-fixture.mjs');
  }, 60_000);

  /**
   * `eslint.config.js`'s own `ignores` patched to cover a WHOLE lint
   * directory, plus a real `no-var` error planted inside it (#372):
   * `git ls-files` still tracks these files, so only ESLint's own config
   * knows they are ignored.
   */
  function buildLintRepoWithConfigIgnoredDir(dirs: string[], ignoredDir: string): string {
    const root = buildLintRepo(dirs);
    const configPath = path.join(root, 'eslint.config.js');
    const original = fs.readFileSync(configPath, 'utf8');
    const patched = original.replace('ignores: [', `ignores: [\n      '${ignoredDir}/**',`);
    if (patched === original) throw new Error("fixture is stale: eslint.config.js has no 'ignores: [' array to patch");
    fs.writeFileSync(configPath, patched);
    fs.writeFileSync(path.join(root, ignoredDir, 'planted.ts'), 'var shouldBeConst = 1;\nconsole.log(shouldBeConst);\n');
    return root;
  }

  needsModules('a whole lint directory ignored by eslint.config.js fails naming the directory, not a silent clean pass', () => {
    const root = buildLintRepoWithConfigIgnoredDir(LINT_DIRS, 'tests');
    linkNodeModules(root);

    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'lint-tracked.mjs'), '--max-warnings', '0'], {
      encoding: 'utf8',
      env: envWithoutGit(),
      timeout: 60_000,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('2 file(s) ignored by eslint.config.js');
    expect(result.stderr).toContain('no lintable file under tests');
    expect(result.stderr).toContain("eslint.config.js's own ignores");
  }, 60_000);

  // `isPathIgnored` is true both for an `ignores` match and for a file no
  // config block matches; the second is not "ignored", it is never linted.
  // Here the only block has no `files`, so it covers .js/.mjs/.cjs and
  // nothing else: the planted `.ts` error would exit 0 with no output if
  // both cases were treated alike.
  needsModules('a file no config block matches fails the run, naming it', () => {
    const root = buildLintRepo(LINT_DIRS, 'clean.mjs');
    linkNodeModules(root);
    fs.writeFileSync(path.join(root, 'eslint.config.js'), "export default [{ rules: { 'no-var': 'error' } }];\n");
    fs.writeFileSync(path.join(root, 'src', 'planted.ts'), 'var a: number = 1;\n');

    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'lint-tracked.mjs'), '--max-warnings', '0'], {
      encoding: 'utf8',
      env: envWithoutGit(),
      timeout: 60_000,
    });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('no matching configuration in eslint.config.js for 1 file(s)');
    expect(result.stderr).toContain('src/planted.ts');
    expect(result.stderr).not.toContain('clean.mjs');
  }, 60_000);

  needsSymlink(
    'spawning lint-tracked.mjs through a symlinked scripts/ directory still lints, and still fails on a real error',
    () => {
      const root = buildLintRepo(LINT_DIRS);
      linkNodeModules(root);
      // A real, obvious ESLint ERROR (not merely a warning) that a run which
      // actually lints MUST fail on.
      fs.writeFileSync(path.join(root, 'scripts', 'planted.mjs'), 'var shouldBeConst = 1;\nconsole.log(shouldBeConst);\n');

      const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-entrypoint-symlink-'));
      tempDirs.push(linkDir);
      const scriptsLink = path.join(linkDir, 'scripts-link');
      fs.symlinkSync(path.join(root, 'scripts'), scriptsLink, 'dir');
      const typedEntry = path.join(scriptsLink, 'lint-tracked.mjs');

      // Precondition: the typed path and its realpath genuinely differ — the
      // divergence between `process.argv[1]` and `import.meta.url` — so a
      // platform quirk that produced no real symlink cannot make this pass
      // for the wrong reason.
      expect(fs.realpathSync(typedEntry)).not.toBe(path.resolve(typedEntry));

      const result = spawnSync(process.execPath, [typedEntry, '--max-warnings', '0'], {
        encoding: 'utf8',
        env: envWithoutGit(),
        timeout: 60_000,
      });

      // A guard that missed would exit 0 with empty stdout. Assert the exit
      // code AND the planted finding, so a failure for an unrelated reason
      // (ESLint not found, a broken config) cannot pass as "it linted".
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toContain('planted.mjs');
      expect(result.stdout).toContain('no-var');
    },
    60_000,
  );

  // `classifySpawnResult` maps a signal-killed ESLint to exit 2 (fatal), not
  // exit 1 (ordinary findings). A custom ESLint rule that kills its own
  // process is the reliable way to reproduce a signal kill.
  //
  // Skipped on win32: a self-`SIGTERM` there is `TerminateProcess(h, 1)` —
  // exit status 1, signal null, not the POSIX shape this test needs — a
  // platform difference in what a self-kill looks like, not a code fact.
  if (process.platform === 'win32') {
    console.warn('skipping the signal-kill test on win32: process.kill(pid, "SIGTERM") there is TerminateProcess(h, 1) — exit status 1, signal null — not a real POSIX signal kill');
  }
  const maybeItPosixSignal = canLinkModules && process.platform !== 'win32' ? it : it.skip;
  maybeItPosixSignal('ESLint terminated by a signal makes the whole run exit 2, not 1', () => {
    const root = buildLintRepo(LINT_DIRS);
    linkNodeModules(root);
    fs.writeFileSync(
      path.join(root, 'eslint.config.js'),
      [
        "export default [{",
        "  files: ['**/*.{js,mjs,ts}'],",
        '  plugins: {',
        '    kill: {',
        '      rules: {',
        '        now: {',
        '          create() {',
        "            process.kill(process.pid, 'SIGTERM');",
        '            return {};',
        '          },',
        '        },',
        '      },',
        '    },',
        '  },',
        "  rules: { 'kill/now': 'error' },",
        '}];',
        '',
      ].join('\n'),
    );

    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'lint-tracked.mjs'), '--max-warnings', '0'], {
      encoding: 'utf8',
      env: envWithoutGit(),
      timeout: 60_000,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('terminated by');
  }, 60_000);

  // `runAllBatches` runs EVERY batch and keeps the worst status, and `--fix`
  // is forwarded into each spawned ESLint call; only a tree big enough to
  // split into several batches exercises both through the real entry point.
  needsModules('--fix reaches every batch, not only the first', () => {
    const root = buildLintRepo(LINT_DIRS);
    linkNodeModules(root);

    // Long, shared-prefix filenames keep the file count needed to cross
    // ARGV_BUDGET_CHARS (8,000) low: weight = path.length + 3 per file.
    const GEN_COUNT = 160;
    const genPaths: string[] = [];
    for (let i = 0; i < GEN_COUNT; i++) {
      const name = `gen-${String(i).padStart(3, '0')}-${'x'.repeat(50)}.ts`;
      fs.writeFileSync(path.join(root, 'src', name), `var shouldBeConst${i} = ${i};\n`);
      genPaths.push(path.join(root, 'src', name));
    }

    // Precondition: with the SAME budget and weight function the entry
    // point uses, this tree really does split into more than one batch —
    // otherwise a run that only ever called ESLint once could still pass.
    const relPaths = [...LINT_DIRS.map((dir) => `${dir}/clean.ts`), ...genPaths.map((p) => path.relative(root, p))];
    const batches = batchFiles(relPaths, ARGV_BUDGET_CHARS);
    expect(batches.length).toBeGreaterThan(1);

    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'lint-tracked.mjs'), '--fix'], {
      encoding: 'utf8',
      env: envWithoutGit(),
      timeout: 60_000,
    });

    expect(result.status, result.stderr).toBe(0);
    // Every generated file must have been fixed, not only the ones ESLint
    // would have reached in a single un-batched call — a partial-batch
    // failure would leave some `var`s behind while the process still exits
    // 0, since `--fix` findings do not themselves fail the run.
    const stillVar = genPaths.filter((p) => fs.readFileSync(p, 'utf8').includes('var '));
    expect(stillVar, `left un-fixed: ${stillVar.map((p) => path.relative(root, p)).join(', ')}`).toEqual([]);
  }, 60_000);
});
