// Stop: a session that changed the working tree may only end once a green
// `pnpm verify` receipt exists for exactly the tree it leaves behind, or once
// a verify run for that tree has been attempted after the session started
// and is on record as red or crashed (then the closing message reports it).
//
// Reads git and .verify/ only. Never reads the transcript or the message.
// `stop_hook_active` (Claude continuing because of an earlier block) changes
// nothing: the same two exits apply, and `pnpm verify` always writes
// .verify/last-run.json, even when it crashes, so the second exit is always
// reachable.

import { loadSdlc, readPayload, sessionFile, allow, block, verifyCommand } from "./lib.mjs";

const VERIFY = verifyCommand();

const payload = readPayload();
let sdlc;
try {
  sdlc = await loadSdlc();
} catch (error) {
  block(`verify gate cannot load scripts/sdlc/lib.mjs (${error.message}). Restore it before ending the session.`);
}

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const status = sdlc.receiptStatus(root);
const session = sdlc.readJson(sessionFile(payload.session_id));
const baseline = session?.tree ?? sdlc.headTreeHash(root);

if (status.tree === baseline) allow();
if (status.state === "fresh") allow();

const lastRun = status.lastRun;
const sessionStartedAt = session?.recordedAt ?? "1970-01-01T00:00:00.000Z";
const attemptedThisTree = lastRun && lastRun.tree === status.tree && lastRun.outcome !== "passed" && lastRun.finishedAt > sessionStartedAt;
if (attemptedThisTree) {
  allow(`verify gate: last \`${VERIFY}\` for this tree ${lastRun.outcome.toUpperCase()}${lastRun.failedStep ? ` at step ${lastRun.failedStep}` : ""} (${lastRun.finishedAt}). The closing message must report that result; nothing here is done.`);
}

const short = status.tree.slice(0, 12);
block(`verify gate: this session changed the working tree (now ${short}, session started at ${String(baseline).slice(0, 12)}) and no green \`${VERIFY}\` receipt matches it (${status.state}).

Run \`${VERIFY}\` and let it finish. Green writes .verify/receipt.json for this tree and the session can end. Red or crashed records .verify/last-run.json; fix the code (never the tests) and run again, or end the session reporting that result.

Do not create or edit anything under .verify/; both the Write/Edit hook and the Bash hook block it.`);
