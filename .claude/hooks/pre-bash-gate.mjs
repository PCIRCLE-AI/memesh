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

  // The same decisions the git hooks make (scripts/sdlc/git-gate.mjs), so
  // Claude Code, codex and a person at a shell all meet one rule.
  if (subs.has("commit")) {
    const gate = sdlc.commitGate(config, PROJECT_DIR);
    if (!gate.ok) block(gate.reason);
  }
  if (subs.has("push")) {
    const gate = sdlc.pushGate(config, PROJECT_DIR);
    if (!gate.ok) block(gate.reason);
  }

  allow();
}
