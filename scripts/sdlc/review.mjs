// Headless three-pass review for hosts without a Claude review action
// (GitLab). Builds the diff against the target branch, prepends the request
// body, runs `claude -p` with the review prompt and read-only tools, and
// posts the answer as a note through the host abstraction.
//
//   node scripts/sdlc/review.mjs --request <iid> --base <target-branch> [--dry-run]

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, git, loadConfig } from "./lib.mjs";
import { arg, isMain } from "./cli.mjs";
import { hostFor } from "./host.mjs";
import { agentEnv, renderPrompt, promptVars } from "./run-stage.mjs";

export async function main() {
  const config = loadConfig();
  const host = hostFor(config);
  const request = arg("request");
  const base = arg("base", config.defaultBranch ?? "main");
  if (!request) throw new Error("usage: --request <number> --base <branch> [--dry-run]");
  const dryRun = process.argv.includes("--dry-run");
  const body = dryRun ? "(dry run: request body not fetched)" : host.requestBody(request, { cwd: REPO_ROOT });
  const diff = git(["diff", `origin/${base}...HEAD`], { cwd: REPO_ROOT });
  mkdirSync(path.join(REPO_ROOT, ".sdlc-run"), { recursive: true });
  const diffFile = path.join(".sdlc-run", `review-${request}.diff`);
  writeFileSync(path.join(REPO_ROOT, diffFile), `# Request body\n\n${body}\n\n# Diff against origin/${base}\n\n${diff}\n`);
  const prompt = renderPrompt(readFileSync(path.join(REPO_ROOT, ".claude/sdlc/prompts/review.md"), "utf8"), { ...promptVars(config), ARTIFACT: diffFile });
  const agent = agentEnv(config, "review");
  const args = ["-p", prompt, "--output-format", "json", "--model", process.env.SDLC_MODEL ?? agent.model ?? "claude-opus-5", "--max-turns", "80", "--allowedTools", "Read,Grep,Glob,Bash(git log *),Bash(git diff *)"];
  if (dryRun) { console.log(prompt); return; }
  const out = await new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "inherit"], env: agent.env });
    let text = "";
    child.stdout.on("data", (chunk) => { text += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve(text) : reject(new Error(`claude exited ${code}`))));
  });
  const result = JSON.parse(out);
  const note = typeof result.result === "string" && result.result.trim() ? result.result : "Review produced no text; see the pipeline log.";
  host.postNote(request, `## SDLC review (REVIEW.md, three passes)\n\n${note}`, { cwd: REPO_ROOT });
  console.log(note);
}

if (isMain(import.meta.url)) {
  main().catch((error) => { console.error(`[sdlc] ${error.message}`); process.exitCode = 1; });
}

