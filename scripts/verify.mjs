// `pnpm verify`: the one command that says whether the working tree is done.
//
// The steps come from sdlc/config.json (`verify.steps`), in order: for this
// repo that is the local CI (security baseline, typecheck, lint, unit,
// Python), one Web build, then both Playwright suites against that build.
// Green writes a receipt bound to the exact working-tree hash to .verify/;
// the Claude Code hooks and the commit gate accept nothing else.
//
// Every run records .verify/last-run.json, green, red, or crashed, so a run
// that did not finish is never mistaken for "not run".
//
// Usage:
//   node scripts/verify.mjs               full run, writes the receipt
//   node scripts/verify.mjs --journeys    only the steps marked `journeys`
//                                         (CI runs the fast steps as its own job)

import { spawn } from "node:child_process";
import path from "node:path";
import { REPO_ROOT, headSha, lastRunPath, loadConfig, receiptPath, treeHash, verifyCommand, writeJson } from "./sdlc/lib.mjs";
import { isMain } from "./sdlc/cli.mjs";

function resolveCommand(command) {
  if (["pnpm", "npm", "npx", "yarn"].includes(command)) return process.platform === "win32" ? `${command}.cmd` : command;
  if (command === "node") return process.execPath;
  return command;
}

export function verifySteps({ journeysOnly = false, config = loadConfig(), root = REPO_ROOT } = {}) {
  const steps = config.verify.steps.map((step) => ({
    id: step.id,
    label: step.label,
    command: resolveCommand(step.command),
    args: step.args ?? [],
    cwd: path.resolve(root, step.cwd ?? "."),
    journeys: Boolean(step.journeys),
  }));
  return journeysOnly ? steps.filter((step) => step.journeys) : steps;
}

function run(step) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(step.command, step.args, { cwd: step.cwd, stdio: "inherit", shell: false, env: process.env });
    child.once("error", (error) => resolve({ exit: null, error: error.message, seconds: (Date.now() - started) / 1000 }));
    child.once("exit", (code, signal) => resolve({ exit: code, signal, seconds: (Date.now() - started) / 1000 }));
  });
}

export async function verify({ journeysOnly = false, logger = console, execute = run, cwd = REPO_ROOT, config } = {}) {
  const steps = verifySteps({ journeysOnly, root: cwd, config: config ?? loadConfig(cwd) });
  const startedAt = new Date().toISOString();
  const treeBefore = treeHash(cwd);
  const results = [];
  let failed = null;
  let crashed = null;
  try {
    for (const [index, step] of steps.entries()) {
      logger.log(`\n[verify ${index + 1}/${steps.length}] ${step.label}`);
      const result = await execute(step);
      results.push({ id: step.id, label: step.label, ...result });
      if (result.exit !== 0) {
        failed = step;
        logger.error(`[verify] FAIL ${step.id}: ${step.command} ${step.args.join(" ")} exited ${result.exit ?? result.signal ?? result.error}`);
        break;
      }
      logger.log(`[verify] ok ${step.id} (${result.seconds.toFixed(0)}s)`);
    }
  } catch (error) {
    crashed = error;
  }
  let treeAfter = null;
  try {
    treeAfter = treeHash(cwd);
  } catch (error) {
    crashed = crashed ?? error;
  }
  const record = {
    version: 1,
    mode: journeysOnly ? "journeys" : "full",
    outcome: crashed ? "crashed" : failed ? "failed" : "passed",
    failedStep: failed?.id ?? null,
    error: crashed ? String(crashed.message ?? crashed) : null,
    tree: treeAfter ?? treeBefore,
    treeChangedDuringRun: treeAfter !== null && treeBefore !== treeAfter,
    head: headSha(cwd),
    startedAt,
    finishedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    steps: results,
  };
  writeJson(lastRunPath(cwd), record);
  logger.log(`\n[verify] tree ${record.tree} (${record.mode})`);
  if (crashed) {
    logger.error(`[verify] CRASHED: ${record.error}. Recorded at ${path.relative(cwd, lastRunPath(cwd))}. No receipt written.`);
    return { ok: false, record };
  }
  if (failed) {
    logger.error(`[verify] RED. Recorded at ${path.relative(cwd, lastRunPath(cwd))}. No receipt written.`);
    return { ok: false, record };
  }
  if (record.treeChangedDuringRun) {
    logger.error("[verify] The working tree changed while verify was running, so the result does not describe the current tree. No receipt written; run again.");
    return { ok: false, record };
  }
  if (journeysOnly) {
    logger.log(`[verify] Journeys green. Receipts are written by the full run only (\`${verifyCommand(cwd)}\`).`);
    return { ok: true, record };
  }
  writeJson(receiptPath(cwd), record);
  logger.log(`[verify] GREEN. Receipt for tree ${treeAfter.slice(0, 12)} written to ${path.relative(cwd, receiptPath(cwd))}.`);
  return { ok: true, record };
}

if (isMain(import.meta.url)) {
  const journeysOnly = process.argv.includes("--journeys");
  verify({ journeysOnly }).then(({ ok }) => {
    process.exitCode = ok ? 0 : 1;
  }, (error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
