// Stop-side handoff capture: keeps the agent's own last message as the
// project's "where we left off", so the next session can carry on without the
// user re-explaining.
//
// Not a hook (the `_` prefix): session-summary.js — the Stop hook — calls
// `runStopHandoff()` once per Stop, next to `runStopNotes()`. It lives apart
// from the capture path for the same reason `_stop-notes.js` does: that path
// bails early on quiet sessions, and a handoff must not inherit those exits.
//
// Contract:
//   - Costs no model turn and no quota: the text is what the agent already
//     said. Payload `last_assistant_message` first; when it is absent, the
//     newest assistant text in the last HANDOFF_TRANSCRIPT_TAIL_BYTES of the
//     transcript. The source used is written into the outcome.
//   - ONE entity per project (`session-handoff:<project>`), replaced on every
//     Stop. A message that is too short after cleaning keeps the previous one.
//   - Secrets are redacted before anything is cut or stored; fenced code is
//     dropped.
//   - NEVER blocks the host and never throws: every failure is recorded and
//     swallowed. Every path records an outcome under its own hook name,
//     `handoff-capture`, so its skips do not dilute session-summary's window.
//   - Writes a memory, so it is gated on auto-capture.

import { closeSync, existsSync, fstatSync, openSync, readSync } from 'fs';
import {
  AUTO_CAPTURE_TAG,
  captureEntity,
  hookErrorReason,
  openHookDb,
  recordHookOutcome,
  redactSecrets,
  SKIP_REASONS,
} from './_shared.js';
import {
  cleanHandoffText,
  HANDOFF_MIN_CHARS,
  HANDOFF_TRANSCRIPT_TAIL_BYTES,
  lastAssistantText,
  SESSION_HANDOFF_TYPE,
  sessionHandoffName,
} from './_generated/session-handoff.js';

const HANDOFF_TITLE = 'Where the last session left off';

/** The last `maxBytes` of a file. Its first line may be torn; the parser skips a line it cannot read. */
export function readTranscriptTail(transcriptPath, maxBytes = HANDOFF_TRANSCRIPT_TAIL_BYTES) {
  const fd = openSync(transcriptPath, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n === 0) break;
      got += n;
    }
    return buf.subarray(0, got).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Decide and perform the handoff write for this Stop. Returns
 * `{ outcome, reason, entity }`; every return carries a `reason`, because the
 * caller records it and a skip nobody can explain is the silent skip the
 * outcome gate exists to forbid.
 */
export function captureHandoff(payload, { captureEnabled, project, env = process.env }) {
  if (!captureEnabled) return { outcome: 'skipped', reason: SKIP_REASONS.autoCaptureOff };
  if (project === undefined || project === null) return { outcome: 'skipped', reason: SKIP_REASONS.cwdAbsent };

  let source = 'payload';
  let raw = payload?.last_assistant_message;
  if (typeof raw !== 'string' || !raw.trim()) {
    source = 'transcript';
    const transcriptPath = payload?.transcript_path;
    if (typeof transcriptPath !== 'string' || !transcriptPath || !existsSync(transcriptPath)) {
      return { outcome: 'skipped', reason: SKIP_REASONS.noTranscript };
    }
    raw = lastAssistantText(readTranscriptTail(transcriptPath));
    if (raw === null) return { outcome: 'skipped', reason: SKIP_REASONS.noAssistantText };
  }

  const text = cleanHandoffText(redactSecrets(raw));
  if (text.length < HANDOFF_MIN_CHARS) return { outcome: 'skipped', reason: SKIP_REASONS.handoffTooShort };

  const name = sessionHandoffName(project);
  const sessionId = typeof payload?.session_id === 'string' && /^[A-Za-z0-9_-]+$/.test(payload.session_id)
    ? payload.session_id
    : null;
  const { db } = openHookDb(env, { fts: true });
  try {
    const result = captureEntity(db, {
      name,
      type: SESSION_HANDOFF_TYPE,
      observations: [text],
      tags: [AUTO_CAPTURE_TAG, `project:${project}`, ...(sessionId ? [`session:${sessionId}`] : [])],
      title: HANDOFF_TITLE,
      replace: true,
    });
    if (result === null) throw new Error('captureEntity could not resolve the handoff entity');
    if (result.archived) return { outcome: 'skipped', reason: SKIP_REASONS.handoffArchived, entity: name };
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
  return { outcome: 'wrote', reason: `kept ${text.length} characters of the last message (from the ${source})`, entity: name };
}

export function runStopHandoff(payload, { captureEnabled, project, env = process.env }) {
  try {
    const r = captureHandoff(payload, { captureEnabled, project, env });
    recordHookOutcome(env, { hook: 'handoff-capture', outcome: r.outcome, reason: r.reason, entity: r.entity, payload });
  } catch (err) {
    try { process.stderr.write(`[memesh handoff-capture] ${err?.message || err}\n`); } catch { /* stderr gone */ }
    recordHookOutcome(env, { hook: 'handoff-capture', outcome: 'error', reason: hookErrorReason(err), payload });
  }
}
