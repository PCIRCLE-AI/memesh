// Reports whether a green `npm run verify` receipt matches the current
// working tree. Usable by hand:
//
//   node scripts/verify-receipt.mjs           human-readable, exit 0 fresh / 1 not
//   node scripts/verify-receipt.mjs --json    machine-readable

import { REPO_ROOT, isMain, receiptStatus, verifyCommand } from "./lib/verify-core.mjs";

export function describe(status) {
  const short = status.tree.slice(0, 12);
  switch (status.state) {
    case "fresh":
      return `fresh: receipt ${status.receipt.finishedAt} matches working tree ${short}.`;
    case "stale":
      return `stale: receipt is for tree ${status.receipt.tree.slice(0, 12)} (${status.receipt.finishedAt}); working tree is ${short}. Run \`${verifyCommand()}\`.`;
    default: {
      const last = status.lastRun ? ` Last run ${status.lastRun.outcome}${status.lastRun.failedStep ? ` at ${status.lastRun.failedStep}` : ""} (${status.lastRun.finishedAt}).` : "";
      return `missing: no green receipt for working tree ${short}. Run \`${verifyCommand()}\`.${last}`;
    }
  }
}

if (isMain(import.meta.url)) {
  const status = receiptStatus(REPO_ROOT);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ state: status.state, tree: status.tree, receipt: status.receipt, lastRun: status.lastRun }, null, 2));
  } else {
    console.log(`verify receipt ${describe(status)}`);
  }
  process.exitCode = status.state === "fresh" ? 0 : 1;
}
