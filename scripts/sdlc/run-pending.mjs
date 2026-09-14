// Run the pending stages from a runner-local JSON file, in order. Keeping the
// list out of job outputs avoids Actions suppressing it when an item matches a
// masked secret.
//
//   node scripts/sdlc/run-pending.mjs <pending-stages.json>

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STAGES = new Set(["spec", "plan", "build"]);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,79}$/u;
const RUN_STAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "run-stage.mjs");

export function readPendingItems(file) {
  let items;
  try {
    items = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read pending stages: ${error.message}`, { cause: error });
  }
  if (!Array.isArray(items)) throw new Error("pending stages must be a JSON array");
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== "object" || !STAGES.has(item.stage) || !SLUG_RE.test(item.slug ?? "") || typeof item.artifact !== "string" || item.artifact.length === 0) {
      throw new Error(`pending stage at index ${index} is malformed`);
    }
  }
  return items;
}

export function runPending(file) {
  const items = readPendingItems(file);
  if (items.length === 0) {
    console.log("[sdlc] no pending stages; nothing to run.");
    return 0;
  }

  for (const item of items) {
    try {
      execFileSync(process.execPath, [
        RUN_STAGE,
        "--stage", item.stage,
        "--slug", item.slug,
        "--artifact", item.artifact,
      ], { stdio: "inherit" });
    } catch (error) {
      const reason = Number.isInteger(error.status)
        ? `exit ${error.status}`
        : error.signal ? `signal ${error.signal}` : error.message;
      console.error(`[sdlc] ${item.stage} ${item.slug} (${item.artifact}) failed (${reason}); stopping pending stages.`);
      return Number.isInteger(error.status) && error.status > 0 ? error.status : 1;
    }
  }
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  if (process.argv.length !== 3) {
    console.error("usage: node scripts/sdlc/run-pending.mjs <pending-stages.json>");
    process.exitCode = 2;
  } else {
    try {
      process.exitCode = runPending(process.argv[2]);
    } catch (error) {
      console.error(`[sdlc] ${error.message}`);
      process.exitCode = 1;
    }
  }
}
