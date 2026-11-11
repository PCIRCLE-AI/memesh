#!/usr/bin/env node

// SessionEnd: a private session may write a note after its last Stop. This
// holds that note out of every later import (the Stop hook does the same while
// the session runs). It does nothing for a session that is not private, and
// says so in an outcome record: no hook exits without one.
//
// It writes no memory and prints nothing.

import { endPrivateNoteMarker, releaseOwnTentativeHolds, runStopNotes } from './_stop-notes.js';
import { privacyForHook } from './_private-session.js';
import { deadlineFor, HOOK_BUDGET_MS } from './_hook-budgets.js';
import { hookErrorReason, recordHookOutcome, SKIP_REASONS } from './_shared.js';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  let payload = null;
  try {
    payload = JSON.parse(input);
    const privacy = privacyForHook(payload, 'note-ingest', { budgetMs: HOOK_BUDGET_MS.sessionEnd.decide });
    const deadlineAt = deadlineFor(HOOK_BUDGET_MS.sessionEnd.notes);
    if (privacy.state !== 'no') {
      const result = await runStopNotes(payload, {
        captureEnabled: true, project: undefined, metaUrl: import.meta.url, privacy, deadlineAt,
      });
      // The holds are recorded: other sessions stop waiting (the notes the holds name stay out). If they could
      // not be recorded, the wait stays, and ends only when the session is finalized after six idle hours.
      if (!result.holdFailed) await endPrivateNoteMarker({ sessionId: payload?.session_id, metaUrl: import.meta.url, state: privacy.state });
    } else {
      // Not private: what was held while it could not be checked is let through.
      await releaseOwnTentativeHolds({ sessionId: payload?.session_id, metaUrl: import.meta.url, deadlineAt });
      recordHookOutcome(process.env, { hook: 'note-ingest', outcome: 'skipped', reason: SKIP_REASONS.notPrivateSession, payload });
    }
  } catch (err) {
    try { process.stderr.write(`[memesh session-end-notes] ${err?.message || err}\n`); } catch { /* stderr gone */ }
    recordHookOutcome(process.env, { hook: 'note-ingest', outcome: 'error', reason: hookErrorReason(err), payload });
  }
  process.exit(0);
});
