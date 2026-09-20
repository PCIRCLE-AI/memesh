// The file-selection and batching logic behind `npm run lint`
// (scripts/lint-tracked.mjs). Pulled into its own module — rather than
// living in the entry point — so tests can import these functions directly
// without ever executing the entry point itself: the entry point runs
// `main()` unconditionally on load (see its own header comment for why),
// so importing IT from a test would spawn ESLint and call `process.exit()`
// as a side effect of the import.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const LINT_DIRS = ['src', 'scripts', 'tests', 'dashboard/src'];
// Extensions ESLint's flat config (eslint.config.js) actually parses here:
// js.configs.recommended + tseslint.configs.recommended cover
// .js/.mjs/.cjs/.ts/.tsx/.mts/.cts. The list follows what the CONFIG
// covers, not which extensions the tree happens to use today: an extension
// missing here is a file `npm run lint` silently never sees.
export const LINT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);

// Windows' whole-command-line ceiling is ~32,767 characters. 8,000 keeps
// each batch under a quarter of that even before the node/eslint paths and
// flag arguments are added on top — generous headroom for this tree to grow
// several times over, chosen wide rather than shaved to the wire.
export const ARGV_BUDGET_CHARS = 8_000;
// Per-file padding in the weight estimate below: 1 separating space plus up
// to 2 quote characters Windows adds around an argument containing a space.
// Applied to every path unconditionally (not only the ones that need
// quoting) to keep the estimate simple and always an overcount, which can
// only make a batch smaller than the real command line, never larger.
export const ARGV_PATH_OVERHEAD = 3;

export function defaultArgvWeight(p) {
  return p.length + ARGV_PATH_OVERHEAD;
}

/**
 * Tracked, or untracked-but-not-ignored, files under `dirs` — the same set
 * `git add -A` would stage. NUL-separated so a path containing a space
 * round-trips exactly. No extension filter here: `listTrackedLintFiles`
 * below applies the lint-specific one.
 */
export function listGitFiles(repoRoot, dirs) {
  const raw = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...dirs],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return raw.split('\0').filter(Boolean);
}

/** Tracked, or untracked-but-not-ignored, files under LINT_DIRS with a lint-covered extension. */
export function listTrackedLintFiles(repoRoot) {
  return listGitFiles(repoRoot, LINT_DIRS).filter((rel) => LINT_EXTENSIONS.has(path.extname(rel)));
}

/**
 * The LINT_DIRS entries that contribute no file to `relativePaths`. `git
 * ls-files` exits 0 and prints nothing for a pathspec that matches nothing,
 * so a renamed or moved directory would otherwise drop out of the lint run
 * without a word while the other three still produce files — where the
 * directory-argument ESLint call this replaced failed with "No files
 * matching the pattern".
 */
export function emptyLintDirs(relativePaths, lintDirs = LINT_DIRS) {
  return lintDirs.filter((dir) => !relativePaths.some((rel) => rel.startsWith(`${dir}/`)));
}

/**
 * Splits files by what ESLint's own flat config does with them, checked
 * against the REAL config (#372): `kept` are linted; `ignored` match an
 * `ignores` pattern; `unconfigured` match no config block at all, so ESLint
 * would silently never lint them. `isPathIgnored` is true for both of the
 * last two, so `lintText` is asked why: any reason other than an ignore
 * pattern counts as unconfigured, which fails closed.
 *
 * `import('eslint')` is dynamic: this module is copied into fixtures with no
 * `node_modules` next to it, and a static import would fail at module load
 * for tests that never call this function.
 */
export async function filterEslintIgnored(relativePaths, repoRoot) {
  const { ESLint } = await import('eslint');
  const eslint = new ESLint({ cwd: repoRoot });
  const kept = [];
  const ignored = [];
  const unconfigured = [];
  for (const rel of relativePaths) {
    if (!(await eslint.isPathIgnored(rel))) {
      kept.push(rel);
      continue;
    }
    const [result] = await eslint.lintText('', { filePath: rel, warnIgnored: true });
    const reason = result.messages[0]?.message ?? '';
    if (/matching ignore pattern|node_modules directory/.test(reason)) ignored.push(rel);
    else unconfigured.push(rel);
  }
  return { kept, ignored, unconfigured };
}

/**
 * Splits `relativePaths` (relative to `repoRoot`) into `{ kept, missing }`
 * by whether each still exists on disk, order preserved in both. `git
 * ls-files --cached` lists a tracked file the developer deleted but has not
 * yet staged; handing that path to ESLint fails with "No files matching the
 * pattern" — confusing for an ordinary working-tree state, not a real
 * finding.
 */
export function filterExistingFiles(relativePaths, repoRoot) {
  const kept = [];
  const missing = [];
  for (const rel of relativePaths) {
    if (fs.existsSync(path.join(repoRoot, rel))) kept.push(rel);
    else missing.push(rel);
  }
  return { kept, missing };
}

/**
 * Greedily groups `paths` into batches whose summed `weightFn` stays at or
 * under `budgetChars` — order preserved, nothing dropped, nothing
 * duplicated. `weightFn` defaults to the real argv-length estimate and
 * exists as a parameter so tests can use plain character counts instead.
 *
 * A path whose own weight already exceeds the budget still gets a batch of
 * its own: the `current.length > 0` guard below only flushes a batch that
 * already holds something, so an over-budget path is added to a fresh
 * (empty) batch and flushed on the next path or at the final flush — never
 * skipped, never causing a loop that fails to advance. Empty input returns
 * `[]`, not `[[]]`.
 */
export function batchFiles(paths, budgetChars, weightFn = defaultArgvWeight) {
  const batches = [];
  let current = [];
  let currentWeight = 0;
  for (const p of paths) {
    const weight = weightFn(p);
    if (current.length > 0 && currentWeight + weight > budgetChars) {
      batches.push(current);
      current = [];
      currentWeight = 0;
    }
    current.push(p);
    currentWeight += weight;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Turns a `spawnSync()` result into the status `runAllBatches` should
 * aggregate: a spawn failure or a signal kill (`status === null`) is fatal
 * (2), never silently mapped to 0. A pure function so this is testable with
 * a synthetic result, without provoking a real spawn failure.
 */
export function classifySpawnResult(result) {
  if (result.error) return { status: 2, reason: 'spawn-error', detail: result.error.message };
  if (result.status === null) return { status: 2, reason: 'signal', detail: result.signal ?? 'a signal' };
  return { status: result.status, reason: 'exit' };
}

/**
 * Runs ESLint on one batch and returns the status `runAllBatches`
 * aggregates. `spawn` and `log` are injectable so the mapping from a spawn
 * failure or a signal kill to a fatal status (2) is testable without
 * provoking either: the real command is always `process.execPath`, which
 * essentially never fails to launch, and a missing script path is a plain
 * exit status 1 from node.
 *
 * @param {string[]} batch
 * @param {{
 *   eslintBin: string,
 *   extraArgs: string[],
 *   cwd: string,
 *   spawn?: (command: string, args: string[], options: object) => { error?: Error | null, status: number | null, signal?: string | null },
 *   log?: (line: string) => void,
 * }} options
 * @returns {number}
 */
export function runEslintBatch(batch, { eslintBin, extraArgs, cwd, spawn = spawnSync, log = console.error }) {
  const result = spawn(process.execPath, [eslintBin, ...batch, ...extraArgs], { cwd, stdio: 'inherit' });
  const classified = classifySpawnResult(result);
  if (classified.reason === 'spawn-error') log(`lint-tracked: failed to spawn eslint: ${classified.detail}`);
  else if (classified.reason === 'signal') log(`lint-tracked: eslint was terminated by ${classified.detail}`);
  return classified.status;
}

/**
 * Calls `runBatch(batch)` once per batch, in order, for EVERY batch — never
 * stopping at the first non-zero result — and returns the highest status
 * seen (ESLint's scale: 0 clean, 1 findings or `--max-warnings` exceeded, 2
 * fatal). `--max-warnings 0` is enforced per ESLint process, so a warning
 * confined to one batch would otherwise only fail that batch; running every
 * batch regardless and keeping the worst result is what makes the whole
 * `npm run lint` still fail on it, the same as one un-batched call would.
 * That equivalence holds for a limit of 0 only: a limit of N > 0 would be
 * applied to each batch separately.
 */
export function runAllBatches(batches, runBatch) {
  let worst = 0;
  for (const batch of batches) {
    const status = runBatch(batch);
    if (status > worst) worst = status;
  }
  return worst;
}
