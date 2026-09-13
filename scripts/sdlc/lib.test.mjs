import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { headTreeHash, parseFrontmatter, receiptStatus, receiptPath, treeHash, writeJson } from "./lib.mjs";

export function tempRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "sdlc-lib-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(path.join(dir, ".gitignore"), ".verify/\n");
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("frontmatter: flat keys, quotes stripped, body preserved", () => {
  const { data, body } = parseFrontmatter('---\ntitle: "Hello"\nstatus: accepted\n---\n# Body\n');
  assert.deepEqual(data, { title: "Hello", status: "accepted" });
  assert.equal(body, "# Body\n");
  assert.deepEqual(parseFrontmatter("no frontmatter").data, {});
});

test("tree hash: equals HEAD when clean, changes on edit, ignores .verify/, restores on revert", () => {
  const repo = tempRepo();
  try {
    const clean = treeHash(repo.dir);
    assert.equal(clean, headTreeHash(repo.dir));
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
