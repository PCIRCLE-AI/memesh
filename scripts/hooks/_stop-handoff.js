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
//   - Text the agent copied verbatim from another agent's message (a Channels
//     delivery or a `message` fetch in the transcript tail) is replaced right
//     after redaction, so the next session does not get another agent's words
//     back as this project's memory (#469). The tail is therefore read on every
//     Stop that has a transcript, not only when the payload lacks the reply.
//   - NEVER blocks the host and never throws: every failure is recorded and
//     swallowed. Every path records an outcome under its own hook name,
//     `handoff-capture`, so its skips do not dilute session-summary's window.
//   - Writes a memory, so it is gated on auto-capture.

import { closeSync, existsSync, fstatSync, openSync, readSync } from 'fs';
import {
  AUTO_CAPTURE_TAG,
  captureEntity,
  hookErrorReason,
  hookSourceHost,
  openHookDb,
  recordHookOutcome,
  redactSecrets,
  SKIP_REASONS,
} from './_shared.js';
import {
  AGENT_TEXT_OMITTED,
  agentMessageTexts,
  cleanHandoffText,
  HANDOFF_MIN_CHARS,
  HANDOFF_TRANSCRIPT_TAIL_BYTES,
  lastAssistantText,
  omitAgentMessageText,
  SESSION_HANDOFF_TYPE,
  sessionHandoffName,
} from './_generated/session-handoff.js';

const HANDOFF_TITLE = 'Where the last session left off';

/** The last HANDOFF_TRANSCRIPT_TAIL_BYTES of a file. Its first line may be torn; the parser skips a line it cannot read. */
function readTranscriptTail(transcriptPath) {
  const fd = openSync(transcriptPath, 'r');
  try {
    const stat = fstatSync(fd);
    if (stat.isDirectory()) throw new Error('transcript_path is a directory');
    const size = stat.size;
    const start = Math.max(0, size - HANDOFF_TRANSCRIPT_TAIL_BYTES);
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
function captureHandoff(payload, { captureEnabled, project, env }) {
  if (!captureEnabled) return { outcome: 'skipped', reason: SKIP_REASONS.autoCaptureOff };
  if (project === undefined || project === null) return { outcome: 'skipped', reason: SKIP_REASONS.cwdAbsent };

  let source = 'payload';
  let raw = payload?.last_assistant_message;
  const transcriptPath = payload?.transcript_path;
  const hasTranscript = typeof transcriptPath === 'string' && transcriptPath !== '' && existsSync(transcriptPath);
  const fromPayload = typeof raw === 'string' && raw.trim() !== '';
  let tail = null;
  let tailError = null;
  if (hasTranscript) {
    // With the reply already in the payload, the tail is only read to look for
    // quoted agent messages; an unreadable tail must not cost the handoff.
    try { tail = readTranscriptTail(transcriptPath); } catch (err) { if (!fromPayload) throw err; tailError = err; }
  }
  if (!fromPayload) {
    source = 'transcript';
    if (tail === null) return { outcome: 'skipped', reason: SKIP_REASONS.noTranscript };
    raw = lastAssistantText(tail);
    if (raw === null) return { outcome: 'skipped', reason: SKIP_REASONS.noAssistantText };
  }

  // Without a transcript there is no message to compare with; the reply is kept as it is.
  const messages = tail === null ? { texts: [], unreadTags: 0 } : agentMessageTexts(tail);
  // Redact FIRST, on the whole reply: cutting a quote first could leave the
  // rest of a secret behind, too short to look like one any more. The message
  // texts are matched both as sent and redacted: redacted so they line up with
  // the redacted reply, as sent so a quoted piece of a secret that is too short
  // to be redacted on its own is still left out.
  const quoted = omitAgentMessageText(redactSecrets(raw), [...messages.texts, ...messages.texts.map((t) => redactSecrets(t))]);
  const text = cleanHandoffText(quoted.text);
  // Measured without the markers: a reply that was mostly quotation must not
  // replace a useful handoff with a row of markers.
  if (text.split(AGENT_TEXT_OMITTED).join('').trim().length < HANDOFF_MIN_CHARS) {
    return {
      outcome: 'skipped',
      reason: quoted.omitted > 0
        ? `${SKIP_REASONS.handoffTooShort} once ${quoted.omitted} run(s) quoted from an agent message were left out`
        : SKIP_REASONS.handoffTooShort,
    };
  }

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
      localHandoff: true,
      sourceHost: hookSourceHost(payload, env),
    });
    if (result === null) throw new Error('captureEntity could not resolve the handoff entity');
    if (result.archived) return { outcome: 'skipped', reason: SKIP_REASONS.handoffArchived, entity: name };
  } finally {
    // By here the write has committed (or already thrown). A close that fails
    // must not turn a stored handoff into an `error` record.
    try {
      db.close();
    } catch (err) {
      try { process.stderr.write(`[memesh handoff-capture] closing the database failed: ${err?.message || err}\n`); } catch { /* stderr gone */ }
    }
  }
  const notes = [];
  if (quoted.omitted > 0) notes.push(`left out ${quoted.omitted} run(s) quoted from an agent message`);
  if (messages.unreadTags > 0) notes.push(`${messages.unreadTags} channel message(s) could not be read, so they were not checked`);
  if (tailError) notes.push(`the transcript could not be read (${hookErrorReason(tailError)}), so quoted agent messages were not checked`);
  const omitted = notes.length > 0 ? `; ${notes.join('; ')}` : '';
  return { outcome: 'wrote', reason: `kept ${text.length} characters of the last message (from the ${source})${omitted}`, entity: name };
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
