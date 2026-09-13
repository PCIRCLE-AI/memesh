// Behavioral tests: each hook is spawned exactly as Claude Code spawns it,
// with a JSON payload on stdin and CLAUDE_PROJECT_DIR pointing at a scratch
// git repository, and judged by its exit code. The command parser is also
// tested directly against the bypass shapes a review found.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gitSubcommands, writesVerifyDir } from "./pre-bash-gate.mjs";

const HOOKS = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HOOKS, "..", "..");

function scratch({ verify = "pnpm verify" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "sdlc-hooks-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  mkdirSync(path.join(dir, "scripts", "sdlc"), { recursive: true });
  cpSync(path.join(REPO, "scripts", "sdlc", "lib.mjs"), path.join(dir, "scripts", "sdlc", "lib.mjs"));
  mkdirSync(path.join(dir, "sdlc"));
  writeFileSync(path.join(dir, "sdlc", "config.json"), JSON.stringify({ host: "github", defaultBranch: "main", commands: { verify }, plan: { thresholdLines: 20, sourcePrefixes: ["apps/web/src/"] } }));
  mkdirSync(path.join(dir, "apps", "web", "src"), { recursive: true });
  mkdirSync(path.join(dir, "docs", "plans"), { recursive: true });
  writeFileSync(path.join(dir, ".gitignore"), ".verify/\n.sdlc-run/\n");
  writeFileSync(path.join(dir, "apps", "web", "src", "a.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  git("branch", "-q", "origin/main");
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function hook(name, payload, dir) {
  const result = spawnSync(process.execPath, [path.join(HOOKS, name)], { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

async function writeReceipt(dir) {
  const lib = await import(path.join(dir, "scripts", "sdlc", "lib.mjs"));
  lib.writeJson(lib.receiptPath(dir), { tree: lib.treeHash(dir), finishedAt: new Date().toISOString(), outcome: "passed" });
  return lib;
}

test("the parser finds commit and push through quotes, wrappers, eval and variables, and ignores messages", () => {
  const gated = [
    "git commit -m x", "git -c a=b commit -m x", "git -C . commit -q -m x", "git \"commit\" -m x", "git 'push'",
    "bash -c \"git commit -m x\"", "sh -c 'git push'", "eval \"git commit\"", "G=git; $G commit", "${G} push origin main",
    "env FOO=1 git push", "sudo git push", "cd x && git push", "(git commit -m y)", "/usr/bin/git push", "git push && echo done",
  ];
  for (const command of gated) assert.ok([...gitSubcommands(command)].some((s) => s === "commit" || s === "push"), `should gate: ${command}`);
  const passed = ["git status", "git log --oneline", "echo 'git push'", "git commit-tree", "pnpm verify", "git diff --stat", "gh pr create --title 'git push'"];
  for (const command of passed) assert.ok(![...gitSubcommands(command)].some((s) => s === "commit" || s === "push"), `should pass: ${command}`);
  assert.ok(gitSubcommands("git commit -m 'about git push'").has("commit"));
  assert.ok(!gitSubcommands("git commit -m 'about git push'").has("push"), "a message is not a push");
});

test("writes to .verify/ from a shell are recognised; reads are not", () => {
  for (const command of ["echo '{}' > .verify/receipt.json", "tee .verify/receipt.json", "cp x .verify/receipt.json", "sed -i '' s/a/b/ .verify/receipt.json", "node -e \"require('fs').writeFileSync('.verify/receipt.json','{}')\"", "rm -rf .verify", "mv r.json .verify/receipt.json"]) {
    assert.ok(writesVerifyDir(command), `should block: ${command}`);
  }
  for (const command of ["cat .verify/receipt.json", "ls -la .verify", "jq .tree .verify/receipt.json", "node scripts/verify-receipt.mjs --json", "pnpm verify:receipt", "pnpm verify", "git status"]) {
    assert.ok(!writesVerifyDir(command), `should pass: ${command}`);
  }
});

test("session-start records the baseline; stop allows an unchanged tree", () => {
  const s = scratch();
  try {
    const start = hook("session-start.mjs", { session_id: "s1" }, s.dir);
    assert.equal(start.code, 0);
    assert.match(start.out, /baseline tree/u);
    assert.equal(hook("stop-receipt.mjs", { session_id: "s1" }, s.dir).code, 0);
  } finally {
    s.cleanup();
  }
});

test("stop blocks a changed tree with no receipt, allows it with a fresh receipt, and blocks again after another edit", async () => {
  const s = scratch();
  try {
    hook("session-start.mjs", { session_id: "s2" }, s.dir);
    writeFileSync(path.join(s.dir, "apps", "web", "src", "a.ts"), "export const a = 2;\n");
    let stop = hook("stop-receipt.mjs", { session_id: "s2" }, s.dir);
    assert.equal(stop.code, 2);
    assert.match(stop.err, /no green `pnpm verify` receipt/u);
    await writeReceipt(s.dir);
    assert.equal(hook("stop-receipt.mjs", { session_id: "s2" }, s.dir).code, 0);
    writeFileSync(path.join(s.dir, "apps", "web", "src", "a.ts"), "export const a = 3;\n");
    assert.equal(hook("stop-receipt.mjs", { session_id: "s2", stop_hook_active: true }, s.dir).code, 2, "stale receipt still blocks, stop_hook_active or not");
  } finally {
    s.cleanup();
  }
});

test("stop allows ending after a recorded red or crashed run for this exact tree, and says so", async () => {
  const s = scratch();
  try {
    hook("session-start.mjs", { session_id: "s3" }, s.dir);
    writeFileSync(path.join(s.dir, "apps", "web", "src", "a.ts"), "export const a = 4;\n");
    const lib = await import(path.join(s.dir, "scripts", "sdlc", "lib.mjs"));
    lib.writeJson(lib.lastRunPath(s.dir), { tree: lib.treeHash(s.dir), outcome: "crashed", failedStep: null, finishedAt: new Date(Date.now() + 1000).toISOString() });
    const stop = hook("stop-receipt.mjs", { session_id: "s3", stop_hook_active: true }, s.dir);
    assert.equal(stop.code, 0, stop.err);
    assert.match(stop.out, /CRASHED/u);
  } finally {
    s.cleanup();
  }
});

test("stop without a session baseline compares against HEAD", () => {
  const s = scratch();
  try {
    assert.equal(hook("stop-receipt.mjs", { session_id: "never-started" }, s.dir).code, 0);
    writeFileSync(path.join(s.dir, "new.ts"), "x\n");
    assert.equal(hook("stop-receipt.mjs", { session_id: "never-started" }, s.dir).code, 2);
  } finally {
    s.cleanup();
  }
});

test("pre-bash: non-git and read-only git pass; commit needs a receipt; .verify writes are blocked", async () => {
  const s = scratch();
  try {
    assert.equal(hook("pre-bash-gate.mjs", { tool_input: { command: "pnpm verify" } }, s.dir).code, 0);
    assert.equal(hook("pre-bash-gate.mjs", { tool_input: { command: "git status && git log --oneline -3" } }, s.dir).code, 0);
    const forged = hook("pre-bash-gate.mjs", { tool_input: { command: "echo '{\"tree\":\"x\"}' > .verify/receipt.json" } }, s.dir);
    assert.equal(forged.code, 2);
    assert.match(forged.err, /only `pnpm verify` writes/u);
    writeFileSync(path.join(s.dir, "apps", "web", "src", "a.ts"), "export const a = 5;\n");
    s.git("add", "-A");
    let r = hook("pre-bash-gate.mjs", { tool_input: { command: "git commit -m 'x'" } }, s.dir);
    assert.equal(r.code, 2);
    assert.match(r.err, /no green `pnpm verify` receipt/u);
    await writeReceipt(s.dir);
    assert.equal(hook("pre-bash-gate.mjs", { tool_input: { command: "git commit -m 'about git push'" } }, s.dir).code, 0);
    assert.equal(hook("pre-bash-gate.mjs", { tool_input: { command: "sh -c 'git commit -q -m x'" } }, s.dir).code, 0, "wrapped commit is gated by the same receipt and passes with one");
  } finally {
    s.cleanup();
  }
});

test("pre-bash: 20+ source lines need a committed or staged plan named docs/plans/<slug>.md", async () => {
  const s = scratch();
  try {
    writeFileSync(path.join(s.dir, "apps", "web", "src", "big.ts"), Array.from({ length: 25 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");
    s.git("add", "-A");
    await writeReceipt(s.dir);
    let r = hook("pre-bash-gate.mjs", { tool_input: { command: "git commit -m big" } }, s.dir);
    assert.equal(r.code, 2);
    assert.match(r.err, /docs\/plans\/<slug>\.md/u);
    writeFileSync(path.join(s.dir, "docs", "plans", "big.md"), "---\nstatus: accepted\n---\n## Proof\n- `pnpm verify` exit 0\n");
    s.git("add", "-A");
    await writeReceipt(s.dir);
    assert.equal(hook("pre-bash-gate.mjs", { tool_input: { command: "git commit -m big" } }, s.dir).code, 0);
    rmSync(path.join(s.dir, "docs", "plans", "big.md"));
    writeFileSync(path.join(s.dir, "apps", "web", "src", "big.test.ts"), Array.from({ length: 40 }, (_, i) => `test${i}();`).join("\n") + "\n");
    s.git("add", "-A");
    await writeReceipt(s.dir);
    assert.equal(hook("pre-bash-gate.mjs", { tool_input: { command: "git commit -m tests" } }, s.dir).code, 2, "test files do not count toward the threshold, but the source file still does");
  } finally {
    s.cleanup();
  }
});

test("pre-bash: push needs a receipt for HEAD's tree", async () => {
  const s = scratch();
  try {
    let r = hook("pre-bash-gate.mjs", { tool_input: { command: "git push -u origin feature" } }, s.dir);
    assert.equal(r.code, 2);
    assert.match(r.err, /not for HEAD's tree/u);
    await writeReceipt(s.dir);
    assert.equal(hook("pre-bash-gate.mjs", { tool_input: { command: "git push -u origin feature" } }, s.dir).code, 0);
    writeFileSync(path.join(s.dir, "apps", "web", "src", "a.ts"), "export const a = 6;\n");
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "unverified");
    assert.equal(hook("pre-bash-gate.mjs", { tool_input: { command: "git push" } }, s.dir).code, 2, "a commit made after the receipt cannot be pushed");
  } finally {
    s.cleanup();
  }
});

test("protect-verify-dir blocks Write/Edit under .verify/ only", () => {
  const s = scratch();
  try {
    assert.equal(hook("protect-verify-dir.mjs", { tool_input: { file_path: path.join(s.dir, ".verify", "receipt.json") } }, s.dir).code, 2);
    assert.equal(hook("protect-verify-dir.mjs", { tool_input: { file_path: ".verify/sessions/x.json" } }, s.dir).code, 2);
    assert.equal(hook("protect-verify-dir.mjs", { tool_input: { file_path: path.join(s.dir, "apps", "web", "src", "a.ts") } }, s.dir).code, 0);
    assert.equal(hook("protect-verify-dir.mjs", { tool_input: { edits: [{ file_path: ".verify/last-run.json" }] } }, s.dir).code, 2);
  } finally {
    s.cleanup();
  }
});

test("gate messages quote the verify command the project configured, and npm's spelling passes the read-only allowlist", () => {
  const s = scratch({ verify: "npm run verify" });
  try {
    writeFileSync(path.join(s.dir, "apps", "web", "src", "a.ts"), "export const a = 2;\n");
    const stop = hook("stop-receipt.mjs", { session_id: "npm" }, s.dir);
    assert.equal(stop.code, 2);
    assert.match(stop.err, /no green `npm run verify` receipt/u);
    assert.doesNotMatch(stop.err, /pnpm/u);
    for (const command of ["npm run verify", "npm run verify:receipt"]) {
      assert.equal(hook("pre-bash-gate.mjs", { tool_input: { command } }, s.dir).code, 0, command);
    }
    const forged = hook("protect-verify-dir.mjs", { tool_input: { file_path: ".verify/receipt.json" } }, s.dir);
    assert.equal(forged.code, 2);
    assert.match(forged.err, /only `npm run verify` writes/u);
  } finally {
    s.cleanup();
  }
});
