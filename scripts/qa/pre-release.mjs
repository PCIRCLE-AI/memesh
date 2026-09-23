#!/usr/bin/env node
/**
 * One door before a release.
 *
 * The gates this repository owns were reachable only as a list of commands
 * someone had to remember, and the release incidents show what that costs:
 * every one of them (v4.7.0's tag with no npm publish, v4.8.2's stale plugin
 * cache, the 4.8.2-CLI-beside-4.8.3-plugin skew) happened with green gates,
 * because the green ones were not the ones that would have gone red.
 *
 * So this runs the enumerable gates in one place, reports each step's REAL
 * exit code, and — the half that keeps it honest — prints what it did not
 * check and could not. A gate that quietly omits a check reads exactly like
 * one that ran it.
 *
 * It shares its middle step with `prepublishOnly`: both call `verify:artifact`
 * rather than repeating the sequence, because two copies of one list is how
 * every drift in this repository started.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isMain, treeHash, readJson, writeJson } from '../lib/verify-core.mjs';

/** The steps, in order. Each `id` must be an npm script in package.json. */
export const STEPS = [
  {
    id: 'build',
    why: 'dist/ is version-controlled and several gates spawn it; a stale build makes every later step measure the wrong code.',
  },
  {
    id: 'qa:ui-review',
    why: 'require a fresh independent browser review bound to this clean candidate and built dashboard; fix and retest all UI findings before the full suite.',
  },
  {
    id: 'verify:artifact',
    why: 'lint, typecheck, version coherence, doc claims, the isolated test suite, the packed artifact and every derived upgrade path — the same sequence npm publish runs.',
    // The one step slow enough (several minutes: the full isolated suite plus
    // two packaged-artifact runs) that running it twice back to back for the
    // same unchanged tree — `finish-release.mjs --dry-run` immediately
    // followed by the real run — is pure waste. Caching is scoped to exactly
    // that sequence (see CACHE_ENV_VAR below): it does NOT hold for this
    // step's result in general, which also depends on the current branch,
    // local git tags and the live npm advisory database — none of them part
    // of the tree. See cacheableReceiptPath.
    cacheable: true,
  },
  {
    id: 'audit:memory',
    why: 'the memory-layer invariants, against this machine\'s real graph. Deliberately outside verify:release, which must reproduce on a fresh clone.',
  },
];

/**
 * `finish-release.mjs` sets this to `'1'` for BOTH its `--dry-run` and its
 * real invocation of `npm run qa:pre-release`. A bare `npm run
 * qa:pre-release`, or CI, never sets it, so it never reads or writes a cache
 * receipt — closing the gap a review found: `verify:artifact` also depends
 * on the current branch, local git tags and the live npm advisory database,
 * none of which a tree hash covers, and `check-version-coherence.mjs`'s own
 * `main-declares-published-version` check reads this exact variable to
 * loosen itself for a release about to tag. Caching a pass earned under
 * that loosened check and reusing it for a plain, unset-variable run would
 * be a false PASS.
 *
 * This closes that specific gap, not every gap the receipt has no
 * expiry on: a stale dry-run receipt could in principle be reused by a much
 * later real run on the same tree with this same marker set, past whatever
 * an operator would call "immediately". Branch and tags are safe regardless
 * — `release-preconditions.mjs` independently re-checks both right before
 * tagging, marker or no marker — and a stale npm-advisory-database result
 * is safe too, because `publish-npm.yml` re-runs `verify:release` (which
 * includes that audit) right before the actual `npm publish`. So a stale
 * receipt can waste the fast path, not let anything unsafe through; adding
 * an actual expiry is a candidate follow-up, not required for correctness.
 */
export const CACHE_ENV_VAR = 'MEMESH_FINISH_RELEASE_TAGGING';

/**
 * Where a cacheable step's last passing tree is recorded. One file per step
 * id, not a shared one, so a future second cacheable step cannot clobber this
 * one's receipt or be mistaken for it.
 *
 * @param {string} repoRoot
 * @param {string} stepId
 */
export function cacheableReceiptPath(repoRoot, stepId) {
  return path.join(repoRoot, '.qa', `${stepId.replace(/[^a-z0-9]+/gi, '-')}-receipt.json`);
}

/**
 * Same trust model `npm run verify` already uses for `.verify/receipt.json`
 * (scripts/lib/verify-core.mjs `receiptStatus`): a tree hash is the whole
 * question once `CACHE_ENV_VAR` has narrowed the caller to one where nothing
 * else relevant can have changed either. `treeHash` itself can fail (this
 * gate's own tests run it inside a bare temp directory with no `.git`); a
 * caller asking to cache anyway is told so on stderr rather than silently
 * falling back to "always run", so an operator debugging "why did this run
 * twice" is not left guessing.
 *
 * @param {string} repoRoot
 * @returns {string|null}
 */
export function currentTreeHash(repoRoot) {
  try {
    return treeHash(repoRoot);
  } catch (error) {
    if (process.env[CACHE_ENV_VAR] === '1') {
      console.error(`pre-release gate: could not compute a tree hash, caching disabled for this run (${error.message})`);
    }
    return null;
  }
}

/**
 * What this gate does NOT cover. Printed on every run, pass or fail.
 *
 * These are not omissions to be tidied away later: each one names why it
 * cannot run here, so nobody reads a green verdict as more than it is.
 */
export const NOT_CHECKED = [
  'UI review evidence is checked for completeness and candidate binding, not semantic truth. The release owner must verify reviewer independence and replay the retained browser observations; a JSON report cannot prove usability.',
  'Real-host qa:live-journey checks need a caller-prepared authenticated --codex-home for Codex and an interactive Claude Code session for Claude. ' +
    'Both --host codex and --host claude receipts are required by `release:finish`, using memesh-live-journey/v4 with all core journeys (see release-preconditions.mjs).',
  'npm run qa:post-release — only meaningful after the release is published; run it next.',
];

/**
 * @param {{id: string, status: number|null, signal: string|null}[]} results
 * @returns {{ok: boolean, lines: string[]}}
 */
export function formatVerdict(results) {
  const lines = results.map((result) => {
    const outcome = result.status === 0 ? 'PASS' : 'FAIL';
    const detail = result.signal
      ? `killed by ${result.signal}`
      : result.reused
        ? `reused, not re-run — see ${result.reused}`
        : `exit=${result.status}`;
    return `  ${outcome}  ${result.id} (${detail})`;
  });
  return { ok: results.length > 0 && results.every((result) => result.status === 0), lines };
}

/**
 * Every step must name an npm script that exists. A step naming a script that
 * does not exist would fail as "missing script" and read like a failing gate,
 * or worse, be silently dropped by a future refactor.
 *
 * @param {string} repoRoot
 * @returns {string[]} ids with no npm script behind them
 */
export function unknownSteps(repoRoot, steps = STEPS) {
  const scripts = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts ?? {};
  return steps.map((step) => step.id).filter((id) => !(id in scripts));
}

function main() {
  const repoRoot = process.cwd();
  const missing = unknownSteps(repoRoot);
  if (missing.length > 0) {
    console.error(`pre-release plan names npm scripts that do not exist: ${missing.join(', ')}`);
    process.exit(1);
  }

  console.log(`pre-release gate: ${STEPS.length} steps, in order\n`);
  // Only the finish-release.mjs dry-run/real pair sets this (see
  // CACHE_ENV_VAR); every other caller runs every step fresh, always.
  const cachingAllowed = process.env[CACHE_ENV_VAR] === '1';
  const results = [];
  for (const step of STEPS) {
    // Hashed fresh at each cacheable step, not once before the loop: `build`
    // (not cacheable) runs first and rewrites the version-controlled dist/,
    // so the tree `verify:artifact` actually measures only exists after it.
    const tree = step.cacheable && cachingAllowed ? currentTreeHash(repoRoot) : null;
    if (tree) {
      const receiptPath = cacheableReceiptPath(repoRoot, step.id);
      const receipt = readJson(receiptPath);
      if (receipt?.tree === tree) {
        console.log(`--- ${step.id}\n    reusing the pass already recorded for this exact tree (${receipt.at}); nothing under it has changed since. Delete ${receiptPath} to force a re-run.`);
        results.push({ id: step.id, status: 0, signal: null, reused: receiptPath });
        continue;
      }
    }
    console.log(`--- ${step.id}\n    ${step.why}`);
    const child = spawnSync('npm', ['run', step.id], { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' });
    results.push({ id: step.id, status: child.status, signal: child.signal });
    if (child.status !== 0) break;
    if (tree) writeJson(cacheableReceiptPath(repoRoot, step.id), { tree, at: new Date().toISOString() });
  }

  const verdict = formatVerdict(results);
  console.log('\npre-release verdict');
  for (const line of verdict.lines) console.log(line);
  const skipped = STEPS.slice(results.length).map((step) => step.id);
  if (skipped.length > 0) console.log(`  NOT RUN — stopped at the first failure: ${skipped.join(', ')}`);

  console.log('\nnot checked here:');
  for (const item of NOT_CHECKED) console.log(`  - ${item}`);

  console.log(`\n${verdict.ok ? 'PASS' : 'FAIL'} — pre-release gate`);
  process.exit(verdict.ok ? 0 : 1);
}

if (isMain(import.meta.url)) main();
