// Shared helpers for `npm run verify` / `npm run verify:receipt`: the
// working-tree hash a receipt is keyed on, the receipt itself, and the
// config the verify runner reads its step list from.
//
// This is the public half of what used to be scripts/sdlc/lib.mjs. The SDLC
// loop (git commit/push gates, artifact frontmatter, the stage scripts) is
// maintainer-local tooling and lives outside this repository; the verify
// receipt itself is a public gate — every contributor runs it, and CI's
// required "SDLC verify" check runs it too — so these functions moved here
// verbatim rather than leaving with the rest.
//
// Everything here is deterministic and reads only git and the filesystem. No
// transcript, no wording, no model: a gate built on these can only be passed
// by producing the artifact it asks for.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const VERIFY_DIR = ".verify";
export const RECEIPT_FILE = "receipt.json";
export const LAST_RUN_FILE = "last-run.json";

export function git(args, { cwd = REPO_ROOT, env = process.env } = {}) {
  // trimEnd, not trim: `status --porcelain` lines start with a space when
  // only the worktree changed, and trimming it would eat the first path's
  // leading character.
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
}

// Public config for the verify runner: only the two keys it reads
// (`commands.verify`, `verify.steps`). scripts/verify.config.json, not
// sdlc/config.json — the rest of that file (plan thresholds, CI required
// checks, agent stage models, …) is maintainer-local and stays with it.
export function loadConfig(root = REPO_ROOT) {
  return JSON.parse(readFileSync(path.join(root, "scripts", "verify.config.json"), "utf8"));
}

// The verify command as this project spells it (`commands.verify` in
// scripts/verify.config.json): quoted in every gate message so a pnpm
// project reads `pnpm verify` and an npm project reads `npm run verify`.
export function verifyCommand(root = REPO_ROOT) {
  try {
    return loadConfig(root).commands?.verify || "node scripts/verify.mjs";
  } catch {
    return "node scripts/verify.mjs";
  }
}

// Hash of the working tree as git would commit it right now: tracked changes,
// new files, deletions, file modes and symlinks, with .gitignore respected.
// Two trees with the same hash have identical content as git stores it (with
// core.autocrlf or .gitattributes text rules, that is the normalized form),
// so a receipt bound to this hash cannot be reused after any further edit.
// Ignored build output is not hashed; the verify command rebuilds it from
// this tree on every run. Tracked build output (a committed dist/) is hashed,
// and a verify step marked `regenerates` re-baselines the tree after rewriting
// it (scripts/verify.mjs).
export function treeHash(cwd = REPO_ROOT) {
  const indexDir = mkdtempSync(path.join(tmpdir(), "verify-index-"));
  const indexFile = path.join(indexDir, "index");
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    let hasHead = true;
    try {
      git(["rev-parse", "--verify", "HEAD"], { cwd });
    } catch {
      hasHead = false;
    }
    if (hasHead) git(["read-tree", "HEAD"], { cwd, env });
    git(["add", "-A", "--", "."], { cwd, env });
    return git(["write-tree"], { cwd, env });
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
}

export function headSha(cwd = REPO_ROOT) {
  try {
    return git(["rev-parse", "HEAD"], { cwd });
  } catch {
    return null;
  }
}

export function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function receiptPath(cwd = REPO_ROOT) {
  return path.join(cwd, VERIFY_DIR, RECEIPT_FILE);
}

export function lastRunPath(cwd = REPO_ROOT) {
  return path.join(cwd, VERIFY_DIR, LAST_RUN_FILE);
}

// The one question every gate asks: does a green `npm run verify` receipt
// exist for exactly this working tree?
export function receiptStatus(cwd = REPO_ROOT) {
  const tree = treeHash(cwd);
  const receipt = readJson(receiptPath(cwd));
  const lastRun = readJson(lastRunPath(cwd));
  if (!receipt) return { state: "missing", tree, receipt: null, lastRun };
  if (receipt.tree === tree) return { state: "fresh", tree, receipt, lastRun };
  return { state: "stale", tree, receipt, lastRun };
}

// Tell whether this file was run directly (`node script.mjs`) rather than
// imported. Moved from scripts/sdlc/cli.mjs (maintainer-local) because
// scripts/verify.mjs and scripts/verify-receipt.mjs are public and both use
// it as their `if (isMain(...))` entry-point guard.
//
// Node resolves `moduleUrl` (from `import.meta.url`) to its real path,
// following any symlink; `process.argv[1]` is the path as typed. Realpath
// the typed side before comparing, so a symlinked invocation still matches.
//
// Under `node -e` / `-p` there is no entry-point file: `argv[1]` is the first
// argument the caller passed, and a caller that passes this module's path in
// order to `import()` it must not start its `main()`.
//
// A realpath failure is left to throw. Answering "not the entry point" would
// be exit 0 with nothing checked, the failure this guard exists to prevent.
const EVAL_FLAG = /^(-e|-p|-pe|--eval|--print)(=|$)/;
export function isMain(moduleUrl) {
  if (!process.argv[1]) return false;
  // `node - < file`: reading the entry script from stdin. `argv[1]` is the
  // literal string `-`, not a path — there is no entry-point FILE to
  // realpath, so `path.resolve('-')` would resolve to `<cwd>/-` and
  // `realpathSync` would throw ENOENT on it. Same shape as the eval flags
  // below: no file means "not the entry point", not a crash.
  if (process.argv[1] === '-') return false;
  if (process.execArgv.some((arg) => EVAL_FLAG.test(arg))) return false;
  const modulePath = fileURLToPath(moduleUrl);
  const typed = path.resolve(process.argv[1]);
  if (typed === modulePath) return true;
  const resolved = realpathSync(typed);
  if (resolved === modulePath) return true;
  // `node <directory>` loads that directory's package.json `main`, but
  // `process.argv[1]` stays the DIRECTORY path, never rewritten to the file
  // Node actually loaded — falling through to `return false` would silently
  // answer "not main" for a process that genuinely is the entry point.
  // There is no way to recover the real entry file from argv[1] alone.
  if (statSync(resolved).isDirectory()) {
    throw new Error(
      `isMain: process.argv[1] (${process.argv[1]}) resolves to a directory (${resolved}), not the module Node ` +
        'actually loaded via that directory\'s package.json "main" — invoke the entry file directly (node <dir>/<entry>.mjs) rather than the directory.',
    );
  }
  return false;
}
