// Test-only fixture shared by the verify tests: a throwaway git repo, so
// treeHash/receiptStatus/verify() can be exercised without touching this
// repository's own tree. Moved from scripts/sdlc/lib.test.mjs (maintainer-
// local) because scripts/verify.test.mjs is public and needs it.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function tempRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "verify-lib-"));
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
