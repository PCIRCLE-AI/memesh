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

// The commit and push decisions, shared by the Claude Code hook
// (.claude/hooks/pre-bash-gate.mjs) and the git hooks (scripts/sdlc/git-gate.mjs)
// so every tool and every person meets the same rule. Each returns
// { ok, reason }; the reason is the complete message to show.

function baseRef(cwd, defaultBranch) {
  for (const ref of [`origin/${defaultBranch}`, defaultBranch]) {
    try {
      git(["rev-parse", "--verify", `${ref}^{commit}`], { cwd });
      return git(["merge-base", "HEAD", ref], { cwd });
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function changedLinesOnSource(cwd, plan, base) {
  const ranges = base ? [[base, "HEAD"], null] : [null];
  let lines = 0;
  const files = new Set();
  for (const range of ranges) {
    const args = range ? ["diff", "--numstat", `${range[0]}..${range[1]}`] : ["diff", "--numstat", "--cached"];
    for (const row of git(args, { cwd }).split("\n").filter(Boolean)) {
      const [added, removed, file] = row.split("\t");
      if (!file || !plan.sourcePrefixes.some((prefix) => file.startsWith(prefix))) continue;
      if (/\.(test|spec)\.[cm]?[jt]sx?$/u.test(file) || /(^|\/)tests?\//u.test(file)) continue;
      files.add(file);
      lines += (Number(added) || 0) + (Number(removed) || 0);
    }
  }
  return { lines, files: [...files] };
}

function planFilesOnBranch(cwd, base) {
  const names = new Set();
  const listings = [git(["diff", "--name-only", "--cached"], { cwd })];
  if (base) listings.push(git(["diff", "--name-only", `${base}..HEAD`], { cwd }));
  for (const listing of listings) {
    for (const file of listing.split("\n")) {
      if (/^docs\/plans\/[^/]+\.md$/u.test(file) && !/(README|TEMPLATE)\.md$/u.test(file) && existsSync(path.join(cwd, file))) names.add(file);
    }
  }
  return [...names];
}

// The tree the index would commit right now. Differs from the working-tree
// hash whenever something verify saw is not staged (or something staged
// was edited afterwards): committing that would ship content the receipt
// never covered, so the commit gate compares both.
export function indexTreeHash(cwd = REPO_ROOT) {
  try {
    return git(["write-tree"], { cwd });
  } catch {
    return null;
  }
}

export function commitGate(config, cwd = REPO_ROOT) {
  const verify = config.commands?.verify || "node scripts/verify.mjs";
  const status = receiptStatus(cwd);
  if (status.state !== "fresh") {
    return { ok: false, reason: `git commit blocked: no green \`${verify}\` receipt for the current working tree (${status.state}). Run \`${verify}\`; commit only what it verified.` };
  }
  const indexTree = indexTreeHash(cwd);
  if (indexTree !== status.tree) {
    return { ok: false, reason: `git commit blocked: the index would commit tree ${String(indexTree).slice(0, 12)} but the receipt is for the working tree ${status.tree.slice(0, 12)}. Stage everything \`${verify}\` saw (git add -u, plus new files by name), or unstage, run \`${verify}\` on exactly what you will commit, then commit.` };
  }
  const plan = config.plan ?? { thresholdLines: 20, sourcePrefixes: [] };
  const base = baseRef(cwd, config.defaultBranch ?? "main");
  const change = changedLinesOnSource(cwd, plan, base);
  if (change.lines >= plan.thresholdLines && planFilesOnBranch(cwd, base).length === 0) {
    return { ok: false, reason: `git commit blocked: ${change.lines} source lines changed on this branch (${change.files.slice(0, 5).join(", ")}${change.files.length > 5 ? ", …" : ""}) and no plan is committed under docs/plans/. Write docs/plans/<slug>.md from docs/plans/TEMPLATE.md (files, order, risks, Proof) and commit it with, or before, the code.` };
  }
  return { ok: true, reason: `receipt fresh for tree ${status.tree.slice(0, 12)}; ${change.lines} source lines on this branch` };
}

export function pushGate(config, cwd = REPO_ROOT) {
  const verify = config.commands?.verify || "node scripts/verify.mjs";
  const status = receiptStatus(cwd);
  const headTree = headTreeHash(cwd);
  if (!(status.receipt && status.receipt.tree === headTree)) {
    return { ok: false, reason: `git push blocked: the last green \`${verify}\` receipt is not for HEAD's tree (receipt ${status.receipt ? status.receipt.tree.slice(0, 12) : "missing"}, HEAD tree ${String(headTree).slice(0, 12)}). Run \`${verify}\` on a clean tree at HEAD, then push.` };
  }
  return { ok: true, reason: `receipt matches HEAD tree ${String(headTree).slice(0, 12)}` };
}

// The public origin from sdlc/config.json is the only value that reaches an
// outbound request (release smoke, monitor). It is repository configuration
// a person merged, but it is still parsed and bounded before use: http(s)
// only, no credentials, no query or fragment; the normalized origin is what
// the probes build their URLs from. Throws on anything else.
export function assertPublicOrigin(origin) {
  let url;
  try {
    url = new URL(String(origin));
  } catch {
    throw new Error(`sdlc/config.json origin is not a URL: ${JSON.stringify(origin)}`);
  }
  if (!/^https?:$/u.test(url.protocol)) throw new Error(`sdlc/config.json origin must be http(s): ${origin}`);
  if (url.username || url.password) throw new Error("sdlc/config.json origin must not carry credentials");
  if (url.search || url.hash) throw new Error("sdlc/config.json origin must not carry a query or fragment");
  return url.origin;
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
