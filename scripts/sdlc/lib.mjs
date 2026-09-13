// Shared helpers for the SDLC loop: artifact frontmatter, the working-tree
// hash that receipts and gates key on, and the verify receipt itself.
//
// Everything here is deterministic and reads only git and the filesystem. No
// transcript, no wording, no model: a gate built on these can only be passed
// by producing the artifact it asks for.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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

export function loadConfig(root = REPO_ROOT) {
  return JSON.parse(readFileSync(path.join(root, "sdlc", "config.json"), "utf8"));
}

// The verify command as this project spells it (`commands.verify` in
// sdlc/config.json): quoted in every gate message so a pnpm project reads
// `pnpm verify` and an npm project reads `npm run verify`.
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
  const indexDir = mkdtempSync(path.join(tmpdir(), "sdlc-index-"));
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

export function headTreeHash(cwd = REPO_ROOT) {
  try {
    return git(["rev-parse", "HEAD^{tree}"], { cwd });
  } catch {
    return null;
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

// The one question every gate asks: does a green `pnpm verify` receipt exist
// for exactly this working tree?
export function receiptStatus(cwd = REPO_ROOT) {
  const tree = treeHash(cwd);
  const receipt = readJson(receiptPath(cwd));
  const lastRun = readJson(lastRunPath(cwd));
  if (!receipt) return { state: "missing", tree, receipt: null, lastRun };
  if (receipt.tree === tree) return { state: "fresh", tree, receipt, lastRun };
  return { state: "stale", tree, receipt, lastRun };
}

// Minimal YAML frontmatter: flat `key: value` pairs, values kept as strings.
// Artifacts in this repo need nothing richer, and a parser this small cannot
// hide a status in a nested key the gate does not read.
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(text);
  if (!match) return { data: {}, body: text };
  const data = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/u.exec(line);
    if (!pair) continue;
    data[pair[1]] = pair[2].trim().replace(/^["']|["']$/gu, "");
  }
  return { data, body: text.slice(match[0].length) };
}

export function readArtifact(file) {
  const text = readFileSync(file, "utf8");
  return { file, ...parseFrontmatter(text) };
}

export function slugFromFile(file) {
  return path.basename(file).replace(/\.md$/u, "");
}
