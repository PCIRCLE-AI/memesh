// Install the SDLC loop's git hooks (pre-commit, pre-push) into this clone.
// Git hooks are not versioned, so every clone runs this once; package.json's
// `prepare` script does it on install (guarded, because `prepare` also runs
// inside an unpacked tarball where this file does not exist). Reports on
// stderr (npm runs `prepare` during `npm pack --json`, whose stdout must stay
// JSON) and never overwrites a hook it did not write unless --force.
//
//   node scripts/sdlc/install-git-hooks.mjs [--force]

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MARKER = "sdlc-loop git gate";

export function installGitHooks({ force = false, log = (line) => process.stderr.write(`${line}\n`), cwd = process.cwd() } = {}) {
  let root;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    log("install-git-hooks: not inside a git repository; nothing installed");
    return { wrote: [], skipped: [] };
  }
  const hooksDir = path.resolve(root, execFileSync("git", ["rev-parse", "--git-path", "hooks"], { cwd: root, encoding: "utf8" }).trim());
  mkdirSync(hooksDir, { recursive: true });
  const result = { wrote: [], skipped: [] };
  for (const name of ["pre-commit", "pre-push"]) {
    const src = path.join(HERE, "git-hooks", name);
    const dst = path.join(hooksDir, name);
    if (existsSync(dst) && !readFileSync(dst, "utf8").includes(MARKER) && !force) {
      log(`skipped  ${dst} (a hook not written by the loop is there; --force to replace it, or chain it by hand)`);
      result.skipped.push(dst);
      continue;
    }
    copyFileSync(src, dst);
    chmodSync(dst, 0o755);
    log(`wrote    ${dst}`);
    result.wrote.push(dst);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installGitHooks({ force: process.argv.includes("--force") });
}
