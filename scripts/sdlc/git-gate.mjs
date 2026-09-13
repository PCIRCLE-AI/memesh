// The git-native gate: pre-commit and pre-push hooks call this, so a commit
// needs a fresh verify receipt (and a plan past the source-line threshold)
// and a push needs a receipt for HEAD's tree, whoever or whatever is at the
// keyboard: a person, codex, Claude Code. Same decisions as the Claude Code
// hook, from scripts/sdlc/lib.mjs.
//
// Installed by scripts/sdlc/install-git-hooks.mjs (also `npm run prepare`).
// `git commit --no-verify` skips it, as it skips every git hook; the CI
// verify job and branch protection are the gate that cannot be skipped.
//
// On a CI runner the loop's own commits (stage artifacts, release receipts)
// are allowed through and say so: CI verifies the tree itself.
//
//   node scripts/sdlc/git-gate.mjs commit|push

import { REPO_ROOT, commitGate, loadConfig, pushGate } from "./lib.mjs";
import { isMain } from "./cli.mjs";

export function decide(kind, { config, cwd = REPO_ROOT, env = process.env } = {}) {
  if (env.GITHUB_ACTIONS || env.GITLAB_CI) return { ok: true, reason: `sdlc git gate: skipped on the CI runner (the loop's own commits; CI verifies the tree)` };
  if (kind === "commit") return commitGate(config, cwd);
  if (kind === "push") return pushGate(config, cwd);
  throw new Error("usage: node scripts/sdlc/git-gate.mjs commit|push");
}

if (isMain(import.meta.url)) {
  const kind = process.argv[2];
  let result;
  try {
    result = decide(kind, { config: loadConfig() });
  } catch (error) {
    console.error(`sdlc git gate: cannot decide (${error.message}); refusing rather than guessing.`);
    process.exit(1);
  }
  if (result.ok) {
    console.log(`sdlc git gate: ${result.reason}`);
  } else {
    console.error(result.reason);
    process.exit(1);
  }
}
