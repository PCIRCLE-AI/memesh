import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmSync } from './lib/npm-bin.mjs';

/**
 * Fail if any COMMITTED BUILD OUTPUT is stale.
 *
 * `npm run build` regenerates all three of these from source. If someone edited
 * source without regenerating and committing the output, the build just
 * rewrote it and this diff is non-empty.
 *
 *   scripts/hooks/_generated  — the F5 hook mirror of `src/core/paths.ts` and
 *     `src/storage/fts-index.ts`. Drift here is the class of bug behind the P0
 *     FTS omission: a hook wrote an entity but indexed it differently from
 *     core, so the memory was stored and unrecallable.
 *
 *   dist  — the compiled tree. This is not merely a convenience artefact:
 *     plugin-marketplace installs run `dist/` DIRECTLY, because they install
 *     with `--ignore-scripts` and never build. A stale `dist/` therefore ships
 *     code the repository does not describe, to the one install channel that
 *     cannot notice. `prepublishOnly` rebuilds before an npm publish, so npm
 *     users were never exposed — which is exactly why this could go unnoticed.
 *
 *   dashboard/dist — the single-file dashboard the HTTP server serves.
 *
 * Why this did not exist before: `dist/skills-manifest.json` carried a
 * `generated_at` timestamp, so every build produced a different file and "is
 * the committed output current?" had no answer a diff could give. The field was
 * written and never read (`doctor.ts` verifies `entries[].sha256` and nothing
 * else), so it is gone, and the build is now reproducible — verified by
 * building twice and comparing bytes.
 *
 * This script BUILDS, then diffs. It used to only diff, with a comment saying
 * "MUST run after `npm run build`" and nothing enforcing it — so
 * `npm run verify:release` on its own printed "✓ committed build output is
 * current" having built nothing, which is true of any tree whose `dist/`
 * matches `HEAD`, including one whose source was edited and never rebuilt.
 * That is the precise defect the gate exists to catch, reported as a pass. A
 * precondition stated in a comment is not a precondition; running the build
 * here costs ~4s and removes the ordering requirement instead of documenting
 * it.
 *
 * Extracted from an inline block in ci.yml because the publish workflow needs
 * the same gate and did not have it. Two hand-maintained copies of "what must
 * be true before this ships" is how the publish path ended up with fewer
 * checks than the PR path — the same shape as the hook and bin lists in
 * scripts/lib/executable-targets.mjs.
 */
const BUILD_OUTPUTS = ['scripts/hooks/_generated', 'dist', 'dashboard/dist'];

const COMPILER_SUFFIXES = ['.d.ts.map', '.d.ts', '.js.map', '.js'];

function filesBelow(root) {
  const files = [];
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  visit(root);
  return files;
}

export function findOrphanedTypeScriptOutputs(repoRoot) {
  const sourceRoot = path.join(repoRoot, 'src');
  const distRoot = path.join(repoRoot, 'dist');
  const sourceFamilies = new Set(
    filesBelow(sourceRoot)
      .filter(file => file.endsWith('.ts'))
      .map(file => path.relative(sourceRoot, file).slice(0, -3).split(path.sep).join('/')),
  );
  const orphanFiles = new Map();
  for (const file of filesBelow(distRoot)) {
    const relative = path.relative(distRoot, file).split(path.sep).join('/');
    if (relative.startsWith('cli/assets/')) continue;
    const suffix = COMPILER_SUFFIXES.find(candidate => relative.endsWith(candidate));
    if (!suffix) continue;
    const family = relative.slice(0, -suffix.length);
    if (sourceFamilies.has(family)) continue;
    const files = orphanFiles.get(family) ?? [];
    files.push(relative);
    orphanFiles.set(family, files);
  }
  return [...orphanFiles]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([family, files]) => ({ family, files: files.sort() }));
}

export function main() {
  // `npm run build` does not invoke this script, so there is no recursion. CI and
  // `prepublishOnly` build before calling it and therefore build twice; 4s of
  // duplicated work is the price of the gate being sound when invoked alone.
  try {
    npmSync(['run', 'build'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  } catch (err) {
  // stdout AND stderr, and `||` rather than `??`: tsc writes its errors to
  // STDOUT, and a failing npm run leaves `err.stderr` as an EMPTY STRING, which
  // `??` does not fall back on. The first version of this piped only stderr and
  // used `??`, so a real build failure printed the headline and then nothing at
  // all — a gate that fails correctly but tells you nothing is barely better
  // than one that passes wrongly.
  const detail = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || err.message;
  console.error(
    `✗ build failed, so the committed output cannot be checked against source.\n${detail}`
  );
    process.exit(1);
  }

  const orphans = findOrphanedTypeScriptOutputs(process.cwd());
  if (orphans.length > 0) {
    console.error('✗ dist contains compiler output whose authoritative src module no longer exists:');
    for (const orphan of orphans) {
      console.error(`  ${orphan.family}: ${orphan.files.join(', ')}`);
    }
    process.exit(1);
  }

  let diff;
  try {
    diff = execFileSync('git', ['--no-pager', 'diff', '--stat', 'HEAD', '--', ...BUILD_OUTPUTS], {
      encoding: 'utf8',
    });
  } catch (err) {
    console.error(`✗ could not run git diff on the build outputs: ${err.message}`);
    process.exit(1);
  }

// Untracked build output counts too — a NEW compiled file that was never
// committed is exactly as stale as a modified one, and `git diff` cannot see it.
  let untracked = '';
  try {
    untracked = execFileSync(
      'git',
      ['ls-files', '--others', '--exclude-standard', '--', ...BUILD_OUTPUTS],
      { encoding: 'utf8' }
    );
  } catch (err) {
    console.error(`✗ could not list untracked build output: ${err.message}`);
    process.exit(1);
  }

  if (diff.trim() !== '' || untracked.trim() !== '') {
    console.error(
      `✗ committed build output is stale — run 'npm run build' and commit the regenerated files.\n` +
        `  plugin-marketplace installs run dist/ as committed; they never build.\n`
    );
    if (diff.trim() !== '') console.error(diff);
    if (untracked.trim() !== '') console.error(`untracked build output:\n${untracked}`);
    process.exit(1);
  }

  console.log(`✓ committed build output (${BUILD_OUTPUTS.join(', ')}) is current`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
