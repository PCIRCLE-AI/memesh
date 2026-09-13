// Runs every evals/cases/*.json headlessly and checks what each run left
// behind. Exit 1 if any case fails. Needs `claude` on PATH and an API key.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "../scripts/sdlc/cli.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CASES = path.join(ROOT, "evals", "cases");
const OUT = path.join(ROOT, ".sdlc-run", "evals");

function run(command, args, { cwd = ROOT, env = process.env, capture = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });
    let out = "";
    if (capture) child.stdout.on("data", (chunk) => { out += chunk; });
    child.once("error", (error) => resolve({ code: null, out, error }));
    child.once("exit", (code) => resolve({ code, out }));
  });
}

export function loadCases(dir = CASES) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json")).sort()
    .map((name) => ({ file: name, ...JSON.parse(readFileSync(path.join(dir, name), "utf8")) }));
}

async function runCase(c) {
  mkdirSync(OUT, { recursive: true });
  const transcript = path.join(OUT, `${c.name}.jsonl`);
  const claude = await run("claude", ["-p", c.prompt, "--output-format", "stream-json", "--verbose", "--max-turns", String(c.maxTurns ?? 30), "--allowedTools", c.allowedTools ?? "Read,Grep,Glob", ...(c.model ? ["--model", c.model] : [])], { capture: true });
  writeFileSync(transcript, claude.out);
  if (claude.code !== 0) return { name: c.name, ok: false, detail: `claude exited ${claude.code ?? claude.error?.message}` };
  const [cmd, ...args] = c.check.split(/\s+/u);
  const check = await run(cmd, args, { env: { ...process.env, EVAL_TRANSCRIPT: transcript } });
  return { name: c.name, ok: check.code === 0, detail: `check exited ${check.code}` };
}

if (isMain(import.meta.url)) {
  const cases = loadCases();
  const results = [];
  for (const c of cases) {
    console.log(`\n[eval] ${c.name}: ${c.why}`);
    const result = await runCase(c);
    results.push(result);
    console.log(`[eval] ${result.ok ? "PASS" : "FAIL"} ${result.name} (${result.detail})`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n[eval] ${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}
