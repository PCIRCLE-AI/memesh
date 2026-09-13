// SessionStart: record the working-tree hash this session began with. The Stop
// hook compares against it, so a session that changed nothing is never asked
// for a receipt, and one that did cannot end without a green `pnpm verify`.

import { loadSdlc, readPayload, sessionFile, allow, verifyCommand } from "./lib.mjs";

const VERIFY = verifyCommand();

const payload = readPayload();
try {
  const sdlc = await loadSdlc();
  const tree = sdlc.treeHash(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  sdlc.writeJson(sessionFile(payload.session_id), { sessionId: payload.session_id ?? null, tree, recordedAt: new Date().toISOString() });
  allow(`verify gate armed: baseline tree ${tree.slice(0, 12)}. Ending a session that changed files requires a green \`${VERIFY}\` receipt for the final tree.`);
} catch (error) {
  // Without a baseline the Stop hook falls back to HEAD's tree, which is
  // stricter, so recording nothing here is safe; say so rather than hide it.
  allow(`verify gate: could not record the session baseline (${error.message}). The Stop hook will compare against HEAD instead.`);
}
