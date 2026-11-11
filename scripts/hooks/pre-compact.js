#!/usr/bin/env node

import { basename } from 'path';
import { existsSync } from 'fs';
import { AUTO_CAPTURE_TAG, captureEntity, getProjectName, isAutoCaptureEnabled, openHookDb, hookErrorReason, hookSourceHost, SKIP_REASONS, recordHookOutcome, recordHookRun, redactSecrets, truncateTitle } from './_shared.js';
import { isCodexToolRequest } from './_generated/host-transcript.js';
import { deadlineFor, forEachTranscriptLine, PRE_COMPACT_READ_BUDGET_MS } from './_generated/transcript-lines.js';

/** Thrown when the hook's reading time is used up: the count is not recorded, and the error says so. */
const READ_TIMEOUT = Object.assign(new Error('the transcript could not be read within the hook\'s time'), { code: 'ETIMEOUT' });


// There is no in-process timer, and its absence is deliberate: the bounds are
// the transcript read's own deadline (PRE_COMPACT_READ_BUDGET_MS) and the
// database lock wait after it, which together stay a second under the host's
// limit so the outcome record is written.
//
// This file used to arm `setTimeout(() => process.exit(0), 10_000).unref()`.
// It could not fire. Everything after `stdin`'s `end` event is one
// synchronous block — no `await`, no callback — so the event loop never gets
// a turn between the handler starting and the process exiting, and a JS
// timer cannot interrupt a blocking SQLite call. The one window where it
// COULD have run is while stdin is still open, which is not where a hook
// hangs.
//
// The timeout that does work is external: `hooks/hooks.json` declares
// `"timeout": 10` for PreCompact, and the harness enforces it on the
// process. `openHookDb` additionally caps the SQLite lock wait at 2s so
// contention ends in a skipped capture rather than in that kill.

// See post-commit.js for why every exit path leaves a record (#327).
let payload = null;
function record(outcome, reason, entity) {
  recordHookOutcome(process.env, { hook: 'pre-compact', outcome, reason, entity, payload });
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    // Opt-out check (env > config > default-on)
    if (!isAutoCaptureEnabled(process.env)) {
      record('skipped', SKIP_REASONS.autoCaptureOff);
      return exit0();
    }

    const data = JSON.parse(input);
    payload = data;
    const sessionId = data.session_id;
    const transcriptPath = data.transcript_path || '';
    // A payload with NEITHER a session id NOR a transcript is not a
    // PreCompact event — it used to fall through anyway, write a junk entity
    // whose only content was "Compaction reason: auto", report "Saved 2
    // observations", and that junk then surfaced in the next session's
    // context as a recent memory. A real session_id without a transcript
    // still records (that contract is pinned by the basic-scenario test).
    if (!data.session_id && !transcriptPath) {
      record('skipped', SKIP_REASONS.noSessionOrTranscript);
      process.exit(0);
    }
    // Both identities below name WHICH project and WHICH session this memory
    // belongs to, and neither has a safe default (#527). This hook's own
    // working directory is not the session's project, and every payload
    // without a session id used to land in one shared `pre-compact-unknown`
    // memory across projects. Skip and say why instead.
    const usable = (v) => typeof v === 'string' && v.trim().length > 0;
    if (!usable(data.session_id)) {
      record('skipped', SKIP_REASONS.noSessionId);
      process.exit(0);
    }
    if (!usable(data.cwd)) {
      record('skipped', SKIP_REASONS.cwdAbsent);
      process.exit(0);
    }
    const cwd = data.cwd;
    // Claude Code's PreCompact payload names this field `trigger` ('manual' |
    // 'auto'), not `reason` — verified against the shipped cli.js bundle
    // (`hook_event_name:"PreCompact",trigger:A.trigger,custom_instructions:...`).
    // Reading `data.reason` silently recorded "Compaction reason: auto" for
    // every compaction, manual and automatic alike. `reason` is kept as a
    // defensive fallback in case an older CLI used it.
    const reason = data.trigger || data.reason || 'auto';
    const projectName = getProjectName(cwd);

    // Parse transcript to gather insights
    let toolCallCount = 0;
    const editedFiles = new Set();
    // Set when a transcript the payload NAMED could not be read (or is gone): the
    // tool-call count is then unknown, and is not written as 0.
    let transcriptUnread = false;
    let readTimedOut = false;
    // Lines over 64 MiB are not read (a Codex `compacted` record can be that long): counted, and said with the count.
    let longLines = 0;

    if (transcriptPath && !existsSync(transcriptPath)) {
      transcriptUnread = true;
      try { process.stderr.write(`[memesh pre-compact] transcript ${transcriptPath} does not exist; its tool calls are not recorded.\n`); } catch { /* stderr must never throw */ }
    } else if (transcriptPath) {
      try {
        // Read in pieces: a long session's transcript is larger than a string can be. A line over 64 MiB (a Codex
        // `compacted` record can be that long; it is no tool call) is skipped, not a read failure.
        const read = forEachTranscriptLine(transcriptPath, deadlineFor(PRE_COMPACT_READ_BUDGET_MS), (bytes) => {
          const line = bytes.toString('utf8');
          if (!line.trim()) return;
          try {
            const entry = JSON.parse(line);
            // Claude Code transcript format: {type:'assistant', message:{content:[{type:'tool_use',...}]}}
            // The earlier legacy branch (entry.role === 'assistant', entry.content
            // at top level) was confirmed dead code via real-transcript audit:
            // no entry in production transcripts ever shipped that shape.
            // Removed to avoid confusion between two parsers that read
            // different fields for the same logical event.
            // Codex rollout: a request is a `function_call` or `custom_tool_call` response item,
            // and a file it edited is a completed `FileChange` event.
            if (isCodexToolRequest(entry)) {
              toolCallCount++;
            } else if (entry.type === 'event_msg' && entry.payload?.type === 'item_completed' && entry.payload.item?.type === 'FileChange'
              && entry.payload.item.status === 'completed') {
              for (const [target, change] of Object.entries(entry.payload.item.changes ?? {})) {
                if (change?.type === 'add' || change?.type === 'update') editedFiles.add(basename(change.move_path || target));
              }
            } else if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
              for (const block of entry.message.content) {
                if (block.type !== 'tool_use') continue;
                toolCallCount++;
                const name = block.name || '';
                if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') {
                  const filePath = block.input?.file_path || block.input?.path || '';
                  if (filePath) editedFiles.add(basename(filePath));
                }
              }
            }
          } catch {
            // Skip malformed lines — benign, per-line, deliberately not traced.
          }
        });
        longLines = read.longLines;
        if (read.timedOut) throw READ_TIMEOUT;
      } catch (err) {
        readTimedOut = err === READ_TIMEOUT;
        // existsSync passed above, so this is a REAL read failure (permission,
        // I/O, deleted mid-read), not a missing file. Left untraced, the hook
        // still reports "Saved 0 insights" — a success-shaped message hiding
        // that the whole pre-compaction capture was lost. Mirrors the trace
        // added to session-summary.js / extractor.ts for the same pattern.
        transcriptUnread = true;
        try {
          process.stderr.write(
            `[memesh pre-compact] transcript ${transcriptPath} unreadable ` +
              `(${err?.message || err}); its tool calls are not recorded.\n`,
          );
        } catch { /* stderr must never throw */ }
      }
    }

    const entityName = `pre-compact-${sessionId}`;

    // Build observation content
    // An unreadable transcript says nothing about the tool calls: the count is left
    // out, not written as 0, which would be a wrong fact stored as a memory.
    const obsLines = [
      `Compaction reason: ${reason}`,
      transcriptUnread ? 'Tool calls: not recorded (the transcript could not be read)'
        : `Tool calls: ${toolCallCount}${longLines > 0 ? ` (${longLines} line(s) over 64 MiB were not read and may hold more)` : ''}`,
    ];

    // No free-form human text exists for a pre-compact save (unlike a commit
    // subject) — same date+project+verb heuristic as session-summary.js.
    // This hook was the one missed by the original design (it hand-rolls the
    // same captureEntity dance as its two siblings but was overlooked as a
    // "write hook" until a code audit found it), so its entities were the
    // clearest case of a raw machine key (`pre-compact-<sessionId>`) with a
    // terse observation ("Compaction reason: manual") standing in as the
    // display label.
    const titleDate = new Date().toISOString().slice(0, 10);
    // #523: `reason` is payload text (the legacy field is free-form), so it
    // is redacted BEFORE the 200-character cut — `captureEntity` redacts
    // again, but a secret already cut in half no longer matches its pattern.
    const title = truncateTitle(redactSecrets(`${titleDate} ${projectName}: ${reason} compaction${transcriptUnread ? '' : ` (${toolCallCount} tool calls)`}`));
    if (editedFiles.size > 0) {
      obsLines.push(`Files edited: ${Array.from(editedFiles).join(', ')}`);
    }

    // Open DB via shared helper — applies SCHEMA_SQL + status migration.
    // FTS5 needed for the entity-search index updates below.
    const { db } = openHookDb(process.env, { fts: true });
    let written = null;
    try {
      // Shared write dance — upsert entity + observations + tags AND reindex FTS
      // so the pre-compact memory is recallable via the FTS keyword path.
      written = captureEntity(db, {
        name: entityName,
        type: 'session-summary',
        observations: obsLines,
        tags: [AUTO_CAPTURE_TAG, 'urgency:pre-compact', `project:${projectName}`],
        title,
        sourceHost: hookSourceHost(payload, process.env),
      });

      if (written?.archived) {
        record('skipped', SKIP_REASONS.captureTargetArchived, entityName);
        console.log(JSON.stringify({ systemMessage: 'MeMesh: pre-compaction memory is archived; left unchanged' }));
        return exit0();
      }

      // Heartbeat AFTER capture, so the stamp certifies "the capture loop
      // completed", not "a database handle existed". A throw above skips it,
      // and so does a null return — captureEntity's null means the write did
      // not land, and this very hook tells the user "could not save" below;
      // stamping would say "alive" to doctor about the same failed run.
      if (written && transcriptUnread) {
        // The note was written, but not what it should have held: a capture that
        // lost its input is an error in doctor, and is not stamped as alive.
        record('error', readTimedOut ? SKIP_REASONS.transcriptReadTimeout : 'the transcript could not be read', entityName);
      } else if (written) {
        recordHookRun(db, 'pre-compact');
        record('wrote', undefined, entityName);
      } else {
        record('error', 'captureEntity did not land the write', entityName);
      }
    } finally {
      db.close();
    }

    // Claude Code defines `hookSpecificOutput` variants for a fixed set of
    // events only — PreToolUse, PostToolUse, PostToolUseFailure,
    // PermissionRequest, UserPromptSubmit, SessionStart, Setup,
    // SubagentStart, Notification. There is no PreCompact variant, so
    // emitting one fails schema validation at the root and shows the user a
    // "Hook JSON output validation failed" error on *every* compaction —
    // even though the save above already succeeded (#53).
    //
    // `systemMessage` is a valid top-level field for any event and carries
    // the same information to the user. The contract is asserted in
    // tests/helpers/hook-output-contract.ts; do not hand-roll a shape here.
    // Report what was WRITTEN, not what was counted. The old message printed a
    // count derived from the transcript, unconditionally, and discarded
    // `captureEntity`'s null return — the entity row could not be resolved — so
    // it announced a save that may not have happened, with a number that never
    // matched the one entity and handful of observations actually written.
    //
    // `written.observationsWritten` is the honest count, NOT `obsLines.length`:
    // a session compacts more than once, and the second compaction's lines are
    // usually word-for-word the first's ("Compaction reason: auto", "Tool
    // calls: 0"), which captureEntity now declines to store twice. Reporting
    // the built count would announce "Saved 2 observations" on a run that
    // stored none — the same success-shaped lie this comment block exists to
    // stop. Zero written is still a successful run: the memory is already
    // there.
    const stored = written ? written.observationsWritten : 0;
    const hookOutput = {
      systemMessage: written && transcriptUnread
        ? 'MeMesh: saved the compaction note, but the transcript could not be read, so its tool calls and edits are not recorded (see stderr)'
        : written
        ? (stored > 0
          ? `Saved ${stored} observations to MeMesh before compaction`
          : 'MeMesh: this compaction added nothing new (already captured)')
        : 'MeMesh: could not save pre-compaction insights (see stderr)',
    };
    console.log(JSON.stringify(hookOutput));
  } catch (err) {
    // Hooks must never crash Claude Code — exit cleanly
    try { process.stderr.write(`[memesh pre-compact] ${err?.message || err}\n`); } catch {}
    record('error', hookErrorReason(err));
  }
  exit0();
});

function exit0() {
  process.exit(0);
}
