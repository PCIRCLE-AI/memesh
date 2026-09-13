// PreToolUse(Bash): three deterministic gates on the way out of the repo.
//
// 1. Nothing under .verify/ may be written from a shell command. Receipts
//    come from `pnpm verify` only.
// 2. `git commit` needs a green receipt for the exact working tree;
//    `git push` needs one for HEAD's tree.
// 3. `git commit` of a non-trivial source change (sdlc/config.json `plan`)
//    needs a plan under docs/plans/ on this branch.
//
// The command string is parsed only far enough to find git subcommands,
// including inside `sh -c "…"`, `eval "…"`, quoted words and `$VAR` at the
// command position. Anything that still slips past this parser is caught at
// the pull request, where CI reruns the same verification.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT_DIR, loadSdlc, readPayload, allow, block, verifyCommand } from "./lib.mjs";

const VERIFY = verifyCommand();

const WRAPPERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "eval", "env", "sudo", "nohup", "time", "xargs", "command", "exec", "nice", "timeout"]);
const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

function unquote(token) {
  return token.replace(/^\$?(["'])(.*)\1$/su, "$2");
}

// Split a shell string into words, keeping quoted strings as single words so
// `sh -c "git commit"` yields a word whose content can be parsed again.
function words(segment) {
  const out = [];
  const re = /"(?:\\.|[^"\\])*"|'[^']*'|\$'(?:\\.|[^'\\])*'|\S+/gu;
  for (const m of segment.matchAll(re)) out.push(m[0]);
  return out;
}

export function gitSubcommands(command, depth = 0) {
  const found = new Set();
  if (depth > 4) return found;
  const segments = String(command).split(/\s*(?:&&|\|\||;|\||\n|\(|\))\s*/u);
  for (const segment of segments) {
    const tokens = words(segment);
    // Skip leading assignments (`G=git FOO=1 cmd …`).
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[i])) i += 1;
    while (i < tokens.length && WRAPPERS.has(unquote(tokens[i]))) {
      const wrapper = unquote(tokens[i]);
      i += 1;
      if (["bash", "sh", "zsh", "dash", "ksh"].includes(wrapper)) {
        const c = tokens.indexOf("-c", i);
        if (c !== -1 && tokens[c + 1]) for (const sub of gitSubcommands(unquote(tokens[c + 1]), depth + 1)) found.add(sub);
        break;
      }
      if (wrapper === "eval") {
        for (const sub of gitSubcommands(tokens.slice(i).map(unquote).join(" "), depth + 1)) found.add(sub);
        break;
      }
      while (i < tokens.length && (tokens[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[i]))) i += 1;
    }
    const head = tokens[i] ? unquote(tokens[i]) : "";
    const isGit = head === "git" || head.endsWith("/git") || /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/u.test(head);
    if (!isGit) continue;
    i += 1;
    while (i < tokens.length && tokens[i].startsWith("-")) {
      if (GIT_GLOBAL_WITH_VALUE.has(tokens[i])) i += 1;
      i += 1;
    }
    if (tokens[i]) {
      const sub = unquote(tokens[i]);
      if (/^[a-z-]+$/u.test(sub)) found.add(sub);
    }
  }
  return found;
}

export function writesVerifyDir(command) {
  const text = String(command);
  if (!/\.verify(\/|\b)/u.test(text)) return false;
  // Read-only shapes are allowed: cat/ls/head/tail/jq/stat/wc/less on the
  // receipt, and the repo's own receipt reader.
  const readOnly = /^\s*(?:cat|ls|head|tail|jq|stat|wc|less|more|file|node\s+scripts\/verify-receipt\.mjs|pnpm\s+verify(?::receipt)?|npm\s+run\s+verify(?::receipt)?)\b[^>|;&]*$/u;
  if (readOnly.test(text)) return false;
  return true;
}

function git(args) {
  return execFileSync("git", args, { cwd: PROJECT_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
}

function baseRef(defaultBranch) {
  for (const ref of [`origin/${defaultBranch}`, defaultBranch]) {
    try {
      git(["rev-parse", "--verify", `${ref}^{commit}`]);
      return git(["merge-base", "HEAD", ref]);
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function changedLinesOnSource(plan, base) {
  const ranges = base ? [[base, "HEAD"], null] : [null];
  let lines = 0;
  const files = new Set();
  for (const range of ranges) {
    const args = range ? ["diff", "--numstat", `${range[0]}..${range[1]}`] : ["diff", "--numstat", "--cached"];
    for (const row of git(args).split("\n").filter(Boolean)) {
      const [added, removed, file] = row.split("\t");
      if (!file || !plan.sourcePrefixes.some((prefix) => file.startsWith(prefix))) continue;
      if (/\.(test|spec)\.[cm]?[jt]sx?$/u.test(file) || /(^|\/)tests?\//u.test(file)) continue;
      files.add(file);
      lines += (Number(added) || 0) + (Number(removed) || 0);
    }
  }
  return { lines, files: [...files] };
}

function planFilesOnBranch(base) {
  const names = new Set();
  const listings = [git(["diff", "--name-only", "--cached"])];
  if (base) listings.push(git(["diff", "--name-only", `${base}..HEAD`]));
  for (const listing of listings) {
    for (const file of listing.split("\n")) {
      if (/^docs\/plans\/[^/]+\.md$/u.test(file) && !/(README|TEMPLATE)\.md$/u.test(file) && existsSync(path.join(PROJECT_DIR, file))) names.add(file);
    }
  }
  return [...names];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const payload = readPayload();
  if (payload.__parseError) block(`verify gate: could not parse the hook payload (${payload.__parseError}); refusing the command rather than guessing.`);
  const command = payload?.tool_input?.command ?? "";

  if (writesVerifyDir(command)) {
    block(`Blocked: this command touches .verify/, which only \`${VERIFY}\` writes. Read the receipt with \`node scripts/verify-receipt.mjs\`; produce one by running \`${VERIFY}\`.`);
  }

  const subs = gitSubcommands(command);
  if (!subs.has("commit") && !subs.has("push")) allow();

  let sdlc;
  let config;
  try {
    sdlc = await loadSdlc();
    config = sdlc.loadConfig(PROJECT_DIR);
  } catch (error) {
    block(`verify gate cannot load scripts/sdlc/lib.mjs or sdlc/config.json (${error.message}).`);
  }

  if (subs.has("commit")) {
    const status = sdlc.receiptStatus(PROJECT_DIR);
    if (status.state !== "fresh") {
      block(`git commit blocked: no green \`${VERIFY}\` receipt for the current working tree (${status.state}). Run \`${VERIFY}\`; commit only what it verified.`);
    }
    const base = baseRef(config.defaultBranch ?? "main");
    const change = changedLinesOnSource(config.plan, base);
    if (change.lines >= config.plan.thresholdLines) {
      const plans = planFilesOnBranch(base);
      if (plans.length === 0) {
        block(`git commit blocked: ${change.lines} source lines changed on this branch (${change.files.slice(0, 5).join(", ")}${change.files.length > 5 ? ", …" : ""}) and no plan is committed under docs/plans/. Write docs/plans/<slug>.md from docs/plans/TEMPLATE.md (files, order, risks, Proof) and commit it with, or before, the code.`);
      }
    }
  }

  if (subs.has("push")) {
    const status = sdlc.receiptStatus(PROJECT_DIR);
    const headTree = sdlc.headTreeHash(PROJECT_DIR);
    const receiptForHead = status.receipt && status.receipt.tree === headTree;
    if (!receiptForHead) {
      block(`git push blocked: the last green \`${VERIFY}\` receipt is not for HEAD's tree (receipt ${status.receipt ? status.receipt.tree.slice(0, 12) : "missing"}, HEAD tree ${String(headTree).slice(0, 12)}). Run \`${VERIFY}\` on a clean tree at HEAD, then push.`);
    }
  }

  allow();
}
