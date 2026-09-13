import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { REPO_ROOT, receiptPath, treeHash, writeJson } from "./lib.mjs";
import { decide } from "./git-gate.mjs";

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), "sdlc-gitgate-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  for (const f of ["lib.mjs", "cli.mjs", "git-gate.mjs", "install-git-hooks.mjs"]) {
    mkdirSync(path.join(dir, "scripts", "sdlc"), { recursive: true });
    cpSync(path.join(REPO_ROOT, "scripts", "sdlc", f), path.join(dir, "scripts", "sdlc", f));
  }
  cpSync(path.join(REPO_ROOT, "scripts", "sdlc", "git-hooks"), path.join(dir, "scripts", "sdlc", "git-hooks"), { recursive: true });
  mkdirSync(path.join(dir, "sdlc"));
  const config = { host: "github", defaultBranch: "main", commands: { verify: "npm run verify" }, plan: { thresholdLines: 20, sourcePrefixes: ["src/"] } };
  writeFileSync(path.join(dir, "sdlc", "config.json"), JSON.stringify(config));
  mkdirSync(path.join(dir, "src"));
  mkdirSync(path.join(dir, "docs", "plans"), { recursive: true });
  writeFileSync(path.join(dir, ".gitignore"), ".verify/\n");
  writeFileSync(path.join(dir, "src", "a.js"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  git("branch", "-q", "origin/main");
  return { dir, git, config, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const receipt = (dir) => writeJson(receiptPath(dir), { tree: treeHash(dir), finishedAt: new Date().toISOString(), outcome: "passed" });

test("commit needs a fresh receipt; push needs a receipt for HEAD's tree", () => {
  const s = scratch();
  try {
    writeFileSync(path.join(s.dir, "src", "a.js"), "export const a = 2;\n");
    const blocked = decide("commit", { config: s.config, cwd: s.dir, env: {} });
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason, /no green `npm run verify` receipt/u);
    receipt(s.dir);
    assert.equal(decide("commit", { config: s.config, cwd: s.dir, env: {} }).ok, true);
    const push = decide("push", { config: s.config, cwd: s.dir, env: {} });
    assert.equal(push.ok, false, "the receipt is for the working tree, HEAD has not got it yet");
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "change");
    assert.equal(decide("push", { config: s.config, cwd: s.dir, env: {} }).ok, true);
  } finally {
    s.cleanup();
  }
});

test("20+ source lines on the branch need a plan file, whichever tool commits", () => {
  const s = scratch();
  try {
    writeFileSync(path.join(s.dir, "src", "big.js"), Array.from({ length: 25 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");
    s.git("add", "-A");
    receipt(s.dir);
    const r = decide("commit", { config: s.config, cwd: s.dir, env: {} });
    assert.equal(r.ok, false);
    assert.match(r.reason, /docs\/plans\/<slug>\.md/u);
    writeFileSync(path.join(s.dir, "docs", "plans", "big.md"), "---\nstatus: accepted\n---\n## Proof\n- `npm run verify` exit 0\n");
    s.git("add", "docs/plans/big.md");
    receipt(s.dir);
    assert.equal(decide("commit", { config: s.config, cwd: s.dir, env: {} }).ok, true);
  } finally {
    s.cleanup();
  }
});

test("on a CI runner the gate lets the loop's own commits through and says so", () => {
  const s = scratch();
  try {
    const r = decide("commit", { config: s.config, cwd: s.dir, env: { GITHUB_ACTIONS: "true" } });
    assert.equal(r.ok, true);
    assert.match(r.reason, /skipped on the CI runner/u);
    assert.throws(() => decide("rebase", { config: s.config, cwd: s.dir, env: {} }), /usage/u);
  } finally {
    s.cleanup();
  }
});

test("the installed git hooks refuse a real commit without a receipt and allow it with one; a foreign hook is not overwritten", () => {
  const s = scratch();
  try {
    const install = spawnSync(process.execPath, ["scripts/sdlc/install-git-hooks.mjs"], { cwd: s.dir, encoding: "utf8" });
    assert.equal(install.status, 0, install.stderr);
    assert.match(install.stderr, /wrote {4}.*pre-commit/u, "npm pack --json needs a silent stdout, so the installer reports on stderr");
    assert.match(install.stderr, /wrote {4}.*pre-push/u);
    writeFileSync(path.join(s.dir, "src", "a.js"), "export const a = 3;\n");
    s.git("add", "src/a.js");
    const refused = spawnSync("git", ["commit", "-q", "-m", "x"], { cwd: s.dir, encoding: "utf8" });
    assert.notEqual(refused.status, 0, "commit must be refused without a receipt");
    assert.match(refused.stderr, /git commit blocked: no green/u);
    receipt(s.dir);
    const allowed = spawnSync("git", ["commit", "-q", "-m", "x"], { cwd: s.dir, encoding: "utf8" });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stdout + allowed.stderr, /sdlc git gate: receipt fresh/u);
    const hooksDir = s.git("rev-parse", "--git-path", "hooks");
    writeFileSync(path.join(s.dir, hooksDir, "pre-push"), "#!/bin/sh\necho someone else\n");
    const again = spawnSync(process.execPath, ["scripts/sdlc/install-git-hooks.mjs"], { cwd: s.dir, encoding: "utf8" });
    assert.match(again.stderr, /skipped {2}.*pre-push \(a hook not written by the loop/u);
    assert.equal(readFileSync(path.join(s.dir, hooksDir, "pre-push"), "utf8").includes("someone else"), true);
  } finally {
    s.cleanup();
  }
});
