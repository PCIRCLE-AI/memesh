#!/usr/bin/env node

// Stop message gate — Claude Code Stop hook (#468).
//
// An ordinary Claude Code session has no live channel by default (and the
// channel itself silently drops events when the launch flag is missing —
// see docs/platforms/agent-messaging.md), so a session that never polls
// never learns a message is waiting. This blocks the stop once per waiting
// message id not yet blocked for in this session, and asks the model to
// poll, fetch and record intake before finishing.
//
// Claude-Code-only: Codex loads the same hooks.json and already has its own
// native queue wakeup, so this is a no-op skip under Codex, never a block.

import { existsSync, readFileSync, renameSync, writeSync } from 'fs';
import { join } from 'path';
import {
  ensurePrivateDir,
  getDbPath,
  getMemeshDirFromDbPath,
  HOOK_BUSY_TIMEOUT_MS,
  hookErrorReason,
  isClaudeCodeHost,
  recordHookOutcome,
  resolveMessageRecipient,
  SKIP_REASONS,
  waitingMessageLines,
  waitingMessageRefs,
  hookMessageSessionId,
  SESSION_ID_MISMATCH_REASON,
  writePrivateJson,
} from './_shared.js';
import { MemeshDatabase } from './_generated/sqlite.js';
import { pruneSessionState, SESSION_ID_RE } from './_stop-notes.js';

/** Newest blocked-for ids kept per session — bounds the state file. */
const MAX_BLOCKED_IDS = 2000;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });

let payload = null;
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

    const recipient = resolveMessageRecipient(process.env, (label) => {
      record('notified', `recipient: MEMESH_RECIPIENT ignored (${label})`);
    });
    if (!recipient) {
      record('skipped', SKIP_REASONS.noRecipientForGate);
      return exit0();
    }

    const dbPath = process.env.MEMESH_DB_PATH ?? getDbPath();
    if (!existsSync(dbPath)) {
      record('skipped', SKIP_REASONS.noDatabaseForMessageGate);
      return exit0();
    }

    let refs;
    let lines;
    let db;
    // Set by either query's own recordFailure callback (waitingMessageRefs /
    // waitingMessageLines swallow the read error and return `[]`, so an
    // empty `refs` here is indistinguishable from "nothing waiting" unless
    // this flag says otherwise). One `error` record already explains the
    // run; a trailing `skipped: nothingWaitingForGate` would contradict it —
    // "the inbox could not be read" is not "the inbox was read and is empty".
    let inboxReadFailed = false;
    const onInboxReadError = (err) => {
      inboxReadFailed = true;
      record('error', `inbox: ${hookErrorReason(err)}`);
    };
    try {
      // `readOnly`, not `readonly`: node:sqlite ignores the lowercase spelling.
      db = new MemeshDatabase(dbPath, { readOnly: true });
      db.pragma(`busy_timeout = ${HOOK_BUSY_TIMEOUT_MS}`);
      // #497: the session leaves out a message meant for another session.
      const inboxSession = hookMessageSessionId(sessionId);
      if (inboxSession.mismatch) record('notified', SESSION_ID_MISMATCH_REASON);
      refs = waitingMessageRefs(db, recipient, inboxSession.sessionId, onInboxReadError);
      lines = waitingMessageLines(db, recipient, inboxSession.sessionId, onInboxReadError);
    } finally {
      try { db?.close(); } catch { /* already closed */ }
    }

    if (inboxReadFailed) {
      return exit0();
    }

    if (refs.length === 0) {
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
    // NUL-joined, not the id alone: two DIFFERENT projects can reuse the same
    // message_id string (it is scoped per (project, recipient) — see
    // agent_message_deliveries' own primary key), and this key must not
    // conflate them.
    const ids = refs.map((r) => `${r.project}\u0000${r.message_id}`);
    const newIds = ids.filter((id) => !blocked.has(id));
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

    const reason = `${lines.join(' ')} Poll, fetch and record intake for each before you stop.`;
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

    record('notified', 'blocked: waiting message(s) not yet fetched');
    return exit0();
  } catch (err) {
    record('error', hookErrorReason(err));
    return exit0();
  }
});

function exit0() {
  process.exit(0);
}
