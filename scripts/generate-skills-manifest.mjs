#!/usr/bin/env node
// =============================================================================
// Generate skills-manifest.json — SHA-256 manifest of every file that
// ships to the user's machine and gets executed or loaded as a prompt.
//
// F4 (skill supply chain): the npm `--provenance` flag attests that the
// tarball was built from this repo at this commit, but it does not let
// a user verify that the *runtime* files (skill prompts + hooks) match
// what's in the repo at the published version. A compromised publish
// box could rebuild with extra payload before tarballing.
//
// This manifest closes that gap: at install/run time, `memesh doctor
// --verify-skills` recomputes hashes and compares against the manifest
// shipped inside the package. Tampering shows up as a hash mismatch.
//
// What's covered:
//   - skills/**/SKILL.md           (loaded as Claude system prompt)
//   - scripts/hooks/*.{js,mjs}     (run in user's Claude Code process)
//   - hooks/hooks.json             (declares which hooks are active)
//   - .claude-plugin/mcp.json, .claude-plugin/plugin.json,
//     .codex-plugin/mcp.json, .codex-plugin/plugin.json
//     (host wiring)
//
// What's NOT covered (out of scope for this manifest):
//   - dist/**/*.js — Node code path. Tampering there is detected by
//     npm provenance + the standard package signature; covering it
//     here would just duplicate work and bloat the manifest.
// =============================================================================

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
// The scope (which files are covered) is one definition shared with `memesh doctor`, which scans the installed
// package with it and compares the result with this manifest. tsc has already compiled it when this runs.
import { manifestScope } from '../dist/core/manifest-scope.js';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = join(__filename, '..', '..');
const distDir = join(repoRoot, 'dist');
const manifestPath = join(distDir, 'skills-manifest.json');

function sha256(absolutePath) {
  const buf = readFileSync(absolutePath);
  return createHash('sha256').update(buf).digest('hex');
}

// Which files are covered is decided by manifestScope (src/core/manifest-scope.ts). A directory or a wiring
// file it was told to cover and cannot find is a BUILD FAILURE, not something to skip: omitting it silently
// means `memesh doctor` verifies what remains, reports "Skills + hooks integrity PASS", and says nothing about
// the package having shipped without it — absence read as success.
const scope = manifestScope(repoRoot);
if (scope.missingRequired.length > 0) {
  process.stderr.write(
    `[skills-manifest] required location missing: ${scope.missingRequired.join(', ')}\n` +
      `  These are part of what the plugin loads or runs. Generating a manifest without them\n` +
      `  would make 'memesh doctor' report integrity PASS for a package that lacks them.\n`
  );
  process.exit(1);
}
// A folder that exists and cannot be read, a symbolic link on the way to (or inside) a covered place, a folder
// named like something `npm pack` leaves out, or an entry that is not a file at all (a named pipe, a socket) is not
// "nothing there": writing the manifest anyway would leave what is inside (or behind it) unlisted, which `memesh
// doctor` then reports as tampering on every install, or worse, never.
if (scope.unreadable.length > 0 || scope.symlinks.length > 0 || scope.strayFolders.length > 0 || scope.special.length > 0) {
  process.stderr.write(
    `[skills-manifest] cannot write a complete manifest:\n` +
      (scope.unreadable.length > 0 ? `  unreadable folder(s): ${scope.unreadable.join(', ')}\n` : '') +
      (scope.symlinks.length > 0 ? `  symbolic link(s) (npm pack does not ship them; replace with the real file): ${scope.symlinks.join(', ')}\n` : '') +
      (scope.strayFolders.length > 0 ? `  folder(s) named like something npm pack leaves out (they would not be in a published package): ${scope.strayFolders.join(', ')}\n` : '') +
      (scope.special.length > 0 ? `  entr(ies) that are not files (a named pipe, a socket, a device): ${scope.special.join(', ')}\n` : '')
  );
  process.exit(1);
}
const targets = scope.files.map((rel) => join(repoRoot, rel));

const entries = targets
  .map(absolute => ({
    path: relative(repoRoot, absolute).replace(/\\/g, '/'),
    sha256: sha256(absolute),
    bytes: statSync(absolute).size,
  }))
  .sort((a, b) => a.path.localeCompare(b.path));

mkdirSync(distDir, { recursive: true });
// No timestamp. It was written and never read — `doctor.ts` verifies
// `entries[].sha256` and nothing else — and it made every build produce a
// different file, which is why nothing could gate "is the committed build
// output current?". `dist/` is what plugin-marketplace installs run: they
// install with --ignore-scripts and never build, so committed-vs-source drift
// there ships code the repository does not describe. Determinism is what makes
// that checkable; scripts/check-generated-mirror.mjs does the checking.
const manifest = {
  schema: 'memesh.skills-manifest/v1',
  entries,
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

const total = entries.length;
const totalBytes = entries.reduce((s, e) => s + e.bytes, 0);
process.stderr.write(
  `[skills-manifest] wrote ${total} entries (${totalBytes} bytes covered) → ${relative(repoRoot, manifestPath)}\n`
);
