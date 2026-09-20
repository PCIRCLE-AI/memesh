#!/usr/bin/env node
// `npm run lint`: lints the git tree (tracked, plus untracked-not-ignored)
// under src/, scripts/, tests/, dashboard/src/, not whatever is on disk,
// and skips a tracked-but-deleted-on-disk file (count on stderr) instead of
// failing on ESLint's "no files matching the pattern". The file-selection
// and batching logic lives in scripts/lib/lint-files.mjs — see that
// module's own comments for the "why" of each piece; this file only wires
// them together and calls ESLint.
//
// `main()` below runs unconditionally. This module has no exports and
// nothing imports it (the tested logic lives in lib/lint-files.mjs), so it
// needs no "am I the entry point" guard — and a guard that answers wrongly
// is exit 0 with nothing linted.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARGV_BUDGET_CHARS,
  LINT_DIRS,
  batchFiles,
  emptyLintDirs,
  filterEslintIgnored,
  filterExistingFiles,
  listTrackedLintFiles,
  runAllBatches,
  runEslintBatch,
} from './lib/lint-files.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function resolveEslintBin() {
  // Resolved via package.json `bin` field, not `eslint/bin/eslint.js`
  // directly: that subpath is not in ESLint 10's `exports` map, so
  // `require.resolve()` cannot reach it even though the file exists.
  const eslintPkgPath = require.resolve('eslint/package.json');
  const eslintPkg = require(eslintPkgPath);
  return path.join(path.dirname(eslintPkgPath), eslintPkg.bin.eslint);
}

async function main() {
  const tracked = listTrackedLintFiles(REPO);
  const { kept: trackedExisting, missing } = filterExistingFiles(tracked, REPO);
  if (missing.length > 0) {
    console.error(`lint-tracked: skipped ${missing.length} tracked file(s) that no longer exist on disk (deleted, not yet staged)`);
  }

  // Zero lintable files is a broken invocation (wrong cwd, a renamed
  // directory), not a clean pass — exits 1 instead of reporting success.
  if (trackedExisting.length === 0) {
    console.error(
      `lint-tracked: no lintable file left under ${LINT_DIRS.join(', ')} — refusing to report a clean pass`,
    );
    process.exit(1);
  }

  // First check: against git's OWN list, before ESLint's config enters the
  // picture. One directory contributing nothing is as broken as all four:
  // the rest would lint clean and the command would report a pass for the
  // whole tree.
  const emptyDirsFromTree = emptyLintDirs(trackedExisting);
  if (emptyDirsFromTree.length > 0) {
    console.error(
      `lint-tracked: no lintable file under ${emptyDirsFromTree.join(', ')} — a renamed/moved directory, or every tracked file under it deleted and not yet staged? Refusing to report a clean pass`,
    );
    process.exit(1);
  }

  // Second check: against ESLint's OWN config, which git's list cannot see.
  // A file matching no config block is never linted, and a directory whose
  // files are all config-ignored lints nothing while reporting clean (#372).
  const { kept: files, ignored, unconfigured } = await filterEslintIgnored(trackedExisting, REPO);
  if (unconfigured.length > 0) {
    const shown = unconfigured.slice(0, 10).join(', ') + (unconfigured.length > 10 ? ', ...' : '');
    console.error(
      `lint-tracked: no matching configuration in eslint.config.js for ${unconfigured.length} file(s), so ESLint would never lint them: ${shown}`,
    );
    process.exit(1);
  }
  if (ignored.length > 0) {
    console.error(`lint-tracked: ${ignored.length} file(s) ignored by eslint.config.js`);
  }
  const emptyDirsFromConfig = emptyLintDirs(files);
  if (emptyDirsFromConfig.length > 0) {
    console.error(
      `lint-tracked: no lintable file under ${emptyDirsFromConfig.join(', ')} after eslint.config.js's own ignores — refusing to report a clean pass`,
    );
    process.exit(1);
  }

  const eslintBin = resolveEslintBin();
  const extraArgs = process.argv.slice(2); // e.g. --max-warnings 0 (lint), --fix (lint:fix)
  const batches = batchFiles(files, ARGV_BUDGET_CHARS);

  // Nothing in `files` is ignored or unconfigured, so no `--no-warn-ignored`:
  // a file that still comes back ignored surfaces as ESLint's own warning,
  // which `--max-warnings 0` turns into a failure (`lint:fix` passes no
  // limit, so there it stays a warning).
  const worst = runAllBatches(batches, (batch) => runEslintBatch(batch, { eslintBin, extraArgs, cwd: REPO }));

  process.exit(worst);
}

await main();
