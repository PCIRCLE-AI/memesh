// Headless three-pass review (REVIEW.md) for both hosts. Builds the diff
// against the target branch, prepends the request body, runs the configured
// provider with read-only access and the review prompt, and posts the answer
// as a comment / note through the host abstraction. One reviewer runs all
// three passes; a large change (the review workflow decides) runs one cell
// per directory x pass with --pass and --dir.
//
//   node scripts/sdlc/review.mjs --request <number> --base <target-branch> [--pass Bugs|Security|Compliance --dir <top-level dir>] [--dry-run]

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, git, loadConfig } from "./lib.mjs";
import { arg, isMain } from "./cli.mjs";
import { hostFor } from "./host.mjs";
import { invocationFor } from "./agent.mjs";
import { renderPrompt, promptVars } from "./run-stage.mjs";

export const REVIEW_TOOLS = ["Read", "Grep", "Glob", "Bash(git log *)", "Bash(git diff *)"];

export function cellInstructions({ pass, dir }) {
  if (!pass && !dir) return "Run all three passes over the whole diff.";
  return `You are one cell of a review matrix: pass = ${pass}, directory = ${dir}. Apply ONLY the ${pass} pass. You receive the complete diff; you must exhaust every changed file under \`${dir}/\` (or the root files if the directory is "(root)") and may report anything you notice elsewhere. Title your answer "Review matrix: ${pass} / ${dir}" and end with the list of files in your cell that you read, so the cells can be joined and a file no cell covered is visible.`;
}

export function reviewNote({ pass = "", dir = "", text }) {
  if (typeof text !== "string" || !text.trim()) throw new Error("Review produced no text; inspect the workflow log before retrying.");
  const title = pass ? `## Review matrix: ${pass} / ${dir}` : "## SDLC review (REVIEW.md, three passes)";
  return `${title}\n\n${text.trim()}`;
}

export async function main() {
  const config = loadConfig();
  const host = hostFor(config);
  const request = arg("request");
  const base = arg("base", config.defaultBranch ?? "main");
  const pass = arg("pass", "");
  const dir = arg("dir", "");
  if (!request) throw new Error("usage: --request <number> --base <branch> [--pass <pass> --dir <dir>] [--dry-run]");
  if ((pass && !dir) || (dir && !pass)) throw new Error("--pass and --dir go together");
  const dryRun = process.argv.includes("--dry-run");
  const body = dryRun ? "(dry run: request body not fetched)" : host.requestBody(request, { cwd: REPO_ROOT });
  const diff = git(["diff", `origin/${base}...HEAD`], { cwd: REPO_ROOT });
  const runDir = path.join(REPO_ROOT, ".sdlc-run");
  mkdirSync(runDir, { recursive: true });
  const cell = pass ? `-${pass.toLowerCase()}-${dir.replace(/[^A-Za-z0-9_-]/gu, "_")}` : "";
  const diffFile = path.join(".sdlc-run", `review-${request}.diff`);
  writeFileSync(path.join(REPO_ROOT, diffFile), `# Request body\n\n${body}\n\n# Diff against origin/${base}\n\n${diff}\n`);
  const prompt = renderPrompt(readFileSync(path.join(REPO_ROOT, ".claude/sdlc/prompts/review.md"), "utf8"), { ...promptVars(config), ARTIFACT: diffFile, CELL: cellInstructions({ pass, dir }) });
  const inv = invocationFor(config, { stage: "review", access: "read", prompt, tools: REVIEW_TOOLS, maxTurns: 80, claudeDefault: "claude-opus-5", runDir, name: `review-${request}${cell}` });
  if (dryRun) { console.log(`# ${inv.command} ${inv.args.map((a) => (a.length > 80 ? `"…${a.length} chars…"` : a)).join(" ")}\n\n${prompt}`); return; }
  const out = await new Promise((resolve, reject) => {
    const child = spawn(inv.command, inv.args, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "inherit"], env: inv.env });
    let text = "";
    child.stdout.on("data", (chunk) => { text += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve(text) : reject(new Error(`${inv.command} exited ${code}`))));
  });
  writeFileSync(path.join(runDir, `review-${request}${cell}.transcript.jsonl`), out);
  const result = inv.result(out);
  const note = reviewNote({ pass, dir, text: result.text });
  console.log(`[sdlc] reviewer ${inv.label}: ${JSON.stringify(result.usage ?? null)}`);
  host.postNote(request, note, { cwd: REPO_ROOT });
  console.log(note);
}

if (isMain(import.meta.url)) {
  main().catch((error) => { console.error(`[sdlc] ${error.message}`); process.exitCode = 1; });
}
