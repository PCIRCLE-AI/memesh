#!/usr/bin/env node

// PostToolUse for the `private_session` tool: the moment the agent calls it, mark
// the session private for the note importer.
//
// Notes the session writes after this point reach disk before its Stop or
// SessionEnd has recorded which ones it named. Without a marker, another
// session's Stop in that window imports them. The marker (written here, kept
// by every private Stop, removed by SessionEnd) makes the importer leave any
// note changed since this moment alone until the session has recorded its holds;
// the notes the session had already named are held out now, from its
// transcript. Where there is no notes folder to protect (Codex), only the call
// itself is recorded. That record is the first thing every later hook of the
// session checks (`_private-session.js`).
//
// It writes no memory and prints nothing; every outcome is recorded.

import { claudeMemoryDirExpected, holdOutNotes, noteErrorReason } from './_stop-notes.js';
import { isPrivateToolName } from './_generated/private-session.js';
import { recordHookOutcome, SKIP_REASONS } from './_shared.js';
import { deadlineFor, HOOK_BUDGET_MS } from './_hook-budgets.js';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  let payload = null;
  const record = (outcome, reason) => recordHookOutcome(process.env, { hook: 'note-ingest', outcome, reason, payload });
  try {
    payload = JSON.parse(input);
    const tool = payload?.tool_name;
    if (typeof tool !== 'string' || !isPrivateToolName(tool)) {
      record('skipped', SKIP_REASONS.notPrivateSessionTool);
      return process.exit(0);
    }
    // The folder may not exist yet (Claude Code makes it with the first note): the marker then names
    // the path it will have. Where the host has no notes folder at all (Codex), the call is recorded alone.
    const memoryDir = claudeMemoryDirExpected(payload?.transcript_path);
    const held = await holdOutNotes({
      memoryDir, transcriptPath: payload.transcript_path, sessionId: payload.session_id, metaUrl: import.meta.url,
      deadlineAt: deadlineFor(HOOK_BUDGET_MS.privateMark.notes), payload, state: 'yes',
    });
    recordHookOutcome(process.env, { hook: 'note-ingest', outcome: 'skipped', reason: held === null ? SKIP_REASONS.noteIngesterNotBuilt : SKIP_REASONS.privateSession, ...(held ? { count: held } : {}), payload });
  } catch (err) {
    try { process.stderr.write(`[memesh private-session-mark] ${err?.message || err}\n`); } catch { /* stderr gone */ }
    record('error', noteErrorReason(err));
  }
  process.exit(0);
});
