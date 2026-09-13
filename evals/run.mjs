// Runs every evals/cases/*.json headlessly with the configured provider
// (sdlc/config.json → agent.provider) and checks what each run left behind.
// Exit 1 if any case fails. A case a provider cannot judge (gemini emits no
// tool trace) is reported as SKIP with the reason, never as a pass.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { invocationFor, providerOf } from "../scripts/sdlc/agent.mjs";
import { isMain } from "../scripts/sdlc/cli.mjs";
import { loadConfig } from "../scripts/sdlc/lib.mjs";

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

async function runCase(c, config) {
  const provider = providerOf(config);
  if (!provider.tested) return { name: c.name, ok: null, detail: `SKIP: provider ${provider.name} emits no tool trace, so a behavioral check cannot run` };
  mkdirSync(OUT, { recursive: true });
  const transcript = path.join(OUT, `${c.name}.jsonl`);
  const inv = invocationFor(config, { stage: "evals", access: "read", prompt: c.prompt, tools: (c.allowedTools ?? "Read,Grep,Glob").split(","), maxTurns: c.maxTurns ?? 30, claudeDefault: c.model ?? null, runDir: OUT, name: c.name, stream: true });
  const model = await run(inv.command, inv.args, { capture: true, env: inv.env });
  writeFileSync(transcript, model.out);
  if (model.code !== 0) return { name: c.name, ok: false, detail: `${inv.command} exited ${model.code ?? model.error?.message}` };
  const [cmd, ...args] = c.check.split(/\s+/u);
  const check = await run(cmd, args, { env: { ...process.env, EVAL_TRANSCRIPT: transcript, EVAL_PROVIDER: inv.provider } });
  return { name: c.name, ok: check.code === 0, detail: `check exited ${check.code} (${inv.label})` };
}

if (isMain(import.meta.url)) {
  const config = loadConfig();
  const cases = loadCases();
  const results = [];
  for (const c of cases) {
    console.log(`\n[eval] ${c.name}: ${c.why}`);
    const result = await runCase(c, config);
    results.push(result);
    console.log(`[eval] ${result.ok === null ? "SKIP" : result.ok ? "PASS" : "FAIL"} ${result.name} (${result.detail})`);
  }
  const failed = results.filter((r) => r.ok === false);
  const skipped = results.filter((r) => r.ok === null);
  console.log(`\n[eval] ${results.length - failed.length - skipped.length}/${results.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}
