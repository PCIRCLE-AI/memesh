#!/usr/bin/env node

// Stop message gate — Claude Code Stop hook (#468).
//
// Surface whole pending conversation messages once before Claude Code stops.
// stdout success is delivery evidence; the bounded ledger prevents re-block loops.
//
// Claude-Code-only: Codex runs the same hook script (listed in
// .codex-plugin/plugin.json) and already has its own native queue wakeup, so
// this is a no-op skip under Codex, never a block.

import { existsSync, readFileSync, renameSync, writeSync } from 'fs';
import { join } from 'path';
import {
  ensurePrivateDir,
  getDbPath,
  getMemeshDirFromDbPath,
  hookErrorReason,
  HOOK_BUSY_TIMEOUT_MS,
  isClaudeCodeHost,
  recordHookOutcome,
  SKIP_REASONS,
  hookMessageSessionId,
  SESSION_ID_MISMATCH_REASON,
  writePrivateJson,
  hookNodeProblem,
  NODE_TOO_OLD_REASON,
} from './_shared.js';
import { pruneSessionState, SESSION_ID_RE } from './_stop-notes.js';
import { ConversationMessages } from './_generated/conversation-messages.js';

/** Newest blocked-for ids kept per session — bounds the state file. */
const MAX_BLOCKED_IDS = 2000;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });

let payload = null;
let store;
function record(outcome, reason) {
  recordHookOutcome(process.env, { hook: 'stop-message-gate', outcome, reason, payload });
}

process.stdin.on('end', () => {
  if (!input.trim()) {
    record('skipped', SKIP_REASONS.emptyStdin);
    return exit0();
  }

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    record('error', 'malformed stdin JSON');
    return exit0();
  }
  payload = data;

  try {
    // Claude Code sets `stop_hook_active: true` on the extra Stop it fires
    // when A Stop hook already blocked the prior turn — but not necessarily
    // THIS one (#492): an unrelated Stop hook (a verify-receipt gate, say)
    // can be the one holding the block chain open, and a message that
    // arrived during that window must still be surfaced once. So this is
    // deliberately NOT checked here. The "do not re-block" guarantee this
    // used to provide comes from the per-session blocked-id ledger further
    // down (`SKIP_REASONS.alreadyBlockedForGate`): once THIS gate has blocked
    // for a message id, every later Stop for that id skips — active or not,
    // and regardless of which hook set the flag. The flag is consulted only
    // when that ledger cannot be written.
    if (!isClaudeCodeHost(process.env)) {
      record('skipped', SKIP_REASONS.notClaudeCodeHost);
      return exit0();
    }

    const sessionId = typeof data.session_id === 'string' ? data.session_id : '';
    if (!SESSION_ID_RE.test(sessionId)) {
      record('skipped', SKIP_REASONS.noSessionId);
      return exit0();
    }

    const inboxSession = hookMessageSessionId(sessionId);
    if (inboxSession.mismatch) {
      record('skipped', SESSION_ID_MISMATCH_REASON);
      return exit0();
    }

    const dbPath = process.env.MEMESH_DB_PATH ?? getDbPath();
    if (hookNodeProblem('stop-message-gate')) {
      record('error', NODE_TOO_OLD_REASON);
      return exit0();
    }
    if (!existsSync(dbPath) && !existsSync(join(getMemeshDirFromDbPath(), 'messages.db'))) {
      record('skipped', SKIP_REASONS.noDatabaseForMessageGate);
      return exit0();
    }

    store = new ConversationMessages({ busyTimeoutMs: HOOK_BUSY_TIMEOUT_MS });
    if (store.hookBatch(sessionId).ids.length === 0) {
      record('skipped', SKIP_REASONS.nothingWaitingForGate);
      return exit0();
    }

    const dir = join(getMemeshDirFromDbPath(), 'stop-message-gate');
    ensurePrivateDir(dir);
    try {
      pruneSessionState(dir, Date.now());
    } catch { /* best-effort; a full directory still blocks correctly, just holds more files */ }
    const statePath = join(dir, `${sessionId}.json`);
    let state = null;
    try {
      state = JSON.parse(readFileSync(statePath, 'utf8'));
    } catch {
      // No file yet, or unreadable: treat as "nothing blocked for yet" — the
      // safe direction here is one extra block, never a silently missed one.
    }
    const blocked = new Set(Array.isArray(state?.blocked) ? state.blocked : []);
    // New-store message IDs are global; the ledger itself remains per conversation.
    const batch = store.hookBatch(sessionId, [...blocked]);
    const newIds = batch.ids;
    if (newIds.length === 0) {
      record('skipped', SKIP_REASONS.alreadyBlockedForGate);
      return exit0();
    }

    const writeLedger = (ids) => {
      const tmp = `${statePath}.${process.pid}.tmp`;
      writePrivateJson(tmp, { blocked: ids });
      renameSync(tmp, statePath);
    };
    const previous = [...blocked];
    for (const id of newIds) blocked.add(id);
    // Written BEFORE blocking: the ledger is the only thing that stops the
    // next Stop re-blocking for the same ids, now that `stop_hook_active` is
    // not honoured (#492). If it cannot be written (disk full, read-only
    // directory), a Stop that is already continuing a block chain ends here
    // rather than re-block on every Stop. Bounded to the newest ids so a
    // long-lived recipient's file does not grow forever.
    let ledgerWritten = true;
    try {
      writeLedger([...blocked].slice(-MAX_BLOCKED_IDS));
    } catch (err) {
      ledgerWritten = false;
      record('error', `state: ${hookErrorReason(err)}`); // this run's outcome, also on the early return below
      if (data.stop_hook_active === true) return exit0();
    }

    const reason = batch.text;
    try {
      // writeSync, not console.log/process.stdout.write: stdout is a pipe,
      // and an async write can be cut off by process.exit (see
      // session-summary.js's own comment on the same point).
      writeSync(1, `${JSON.stringify({ decision: 'block', reason })}\n`);
    } catch {
      // Host closed stdout — the block was never shown. Take these ids back
      // out of the ledger: a block nobody saw must not count as delivered, or
      // the next Stop would skip them.
      record('error', 'stdout: host closed the pipe before the block reason was delivered');
      if (ledgerWritten) {
        try { writeLedger(previous); } catch (err) { record('error', `state: ${hookErrorReason(err)}`); }
      }
      return exit0();
    }

    store.recordHookDelivery(sessionId, newIds, 'Stop');
    record('notified', 'blocked: whole conversation message(s) delivered');
    return exit0();
  } catch (err) {
    record('error', hookErrorReason(err));
    return exit0();
  }
});

function exit0() {
  try { store?.close(); } catch { /* already closed */ }
  process.exit(0);
}
