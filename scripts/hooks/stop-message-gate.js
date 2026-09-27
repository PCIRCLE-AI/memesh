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
  writePrivateJson,
} from './_shared.js';
import { MemeshDatabase } from './_generated/sqlite.js';
import { pruneNudgeState } from './_stop-notes.js';

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;
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
    // Claude Code sets this true on the extra Stop it fires when a PRIOR
    // Stop hook already blocked — without this check, a block that the model
    // acted on would immediately re-block on the very turn it was resolved.
    if (data.stop_hook_active === true) {
      record('skipped', SKIP_REASONS.stopHookActive);
      return exit0();
    }

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
    }, data.cwd, () => {
      // Ledger-only (#468): no block, no visible line — a multi-project
      // machine sharing one hosts/claude.json must not be blocked on
      // every OTHER project's Stop.
      record('skipped', SKIP_REASONS.fallbackProjectMismatch);
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
      refs = waitingMessageRefs(db, recipient, onInboxReadError);
      lines = waitingMessageLines(db, recipient, onInboxReadError);
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
      pruneNudgeState(dir, Date.now());
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

    const reason = `${lines.join(' ')} Poll, fetch and record intake for each before you stop.`;
    let delivered = true;
    try {
      // writeSync, not console.log/process.stdout.write: stdout is a pipe,
      // and an async write can be cut off by process.exit (see
      // session-summary.js's own comment on the same point).
      writeSync(1, `${JSON.stringify({ decision: 'block', reason })}\n`);
    } catch {
      delivered = false; // host closed stdout — the block was never shown.
    }
    if (!delivered) {
      // Do NOT persist these ids as blocked-for: a block nobody saw must not
      // be treated as delivered, or the next Stop would silently skip them.
      record('error', 'stdout: host closed the pipe before the block reason was delivered');
      return exit0();
    }

    for (const id of newIds) blocked.add(id);
    // Bound the ledger to the newest ids: a long-lived recipient with
    // thousands of historical messages must not grow this file forever.
    const boundedBlocked = [...blocked].slice(-MAX_BLOCKED_IDS);
    try {
      const tmp = `${statePath}.${process.pid}.tmp`;
      writePrivateJson(tmp, { blocked: boundedBlocked });
      renameSync(tmp, statePath);
    } catch (err) {
      // The block reason was already shown to the model — a failed persist
      // only means a FUTURE Stop may re-block for the same ids, not that
      // this one silently did nothing.
      record('error', `state: ${hookErrorReason(err)}`);
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
