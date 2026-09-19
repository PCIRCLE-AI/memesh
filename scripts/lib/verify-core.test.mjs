import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { tempRepo } from "./verify-test-helpers.mjs";
import { receiptPath, receiptStatus, treeHash, writeJson } from "./verify-core.mjs";

// git rev-parse HEAD^{tree} directly, rather than importing headTreeHash:
// that function stays with the maintainer-local git gates (scripts/sdlc/),
// since nothing public needs it — this test only wants a known-good tree to
// compare treeHash's clean-state answer against.
function headTree(cwd) {
  return execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("tree hash: equals HEAD when clean, changes on edit, ignores .verify/, restores on revert", () => {
  const repo = tempRepo();
  try {
    const clean = treeHash(repo.dir);
    assert.equal(clean, headTree(repo.dir));
    mkdirSync(path.join(repo.dir, ".verify"), { recursive: true });
    writeFileSync(path.join(repo.dir, ".verify", "receipt.json"), "{}");
    assert.equal(treeHash(repo.dir), clean, ".verify/ is ignored by the hash");
    writeFileSync(path.join(repo.dir, "a.txt"), "two\n");
    const edited = treeHash(repo.dir);
    assert.notEqual(edited, clean);
    writeFileSync(path.join(repo.dir, "new.txt"), "x\n");
    assert.notEqual(treeHash(repo.dir), edited, "an untracked file changes the hash");
    rmSync(path.join(repo.dir, "new.txt"));
    writeFileSync(path.join(repo.dir, "a.txt"), "one\n");
    assert.equal(treeHash(repo.dir), clean);
  } finally {
    repo.cleanup();
  }
});

test("receipt status: missing, fresh for the same tree, stale after any edit", () => {
  const repo = tempRepo();
  try {
    assert.equal(receiptStatus(repo.dir).state, "missing");
    writeJson(receiptPath(repo.dir), { tree: treeHash(repo.dir), finishedAt: "2026-01-01T00:00:00Z" });
    assert.equal(receiptStatus(repo.dir).state, "fresh");
    writeFileSync(path.join(repo.dir, "a.txt"), "three\n");
    assert.equal(receiptStatus(repo.dir).state, "stale");
  } finally {
    repo.cleanup();
  }
});
