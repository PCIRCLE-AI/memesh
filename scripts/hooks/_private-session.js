/**
 * Is this session private? The one answer for every hook that writes from a
 * session: `decidePrivacy` in src/core/private-session.ts (the same function
 * the dreamer, the note importer, the session activity and doctor ask), within
 * the hook's own time budget.
 *
 * Three answers. `yes`: the marker the PostToolUse hook wrote at the call, or a
 * call in the transcript, a subagent's transcript or a fork's parent. `no`: all
 * of it was read and there is no call. `unchecked`: something could not be read
 * in time or at all; the hook then saves nothing (it fails CLOSED), an `error`
 * outcome with a fixed reason says why, and the next hook decides again: an
 * unchecked session is never marked private.
 *
 * A transcript that does not exist is `no`: there is nothing to look in. The
 * few hooks that can write without one (the handoff from the Stop payload, a
 * compaction note) hold nothing the person said. A transcript deleted after a
 * private call would escape this, which is the person's own deletion, not a
 * check that failed. A file that vanishes WHILE the check reads it is not this
 * case: it is `unchecked`.
 */
import { join } from 'path';
import { getMemeshDirFromDbPath, recordHookOutcome, SKIP_REASONS } from './_shared.js';
import { decidePrivacy } from './_generated/private-session.js';
import { deadlineFor } from './_hook-budgets.js';

/** The fixed sentence an `unchecked` reason is recorded with (doctor quotes only fixed sentences). */
function uncheckedReasonSentence(reason) {
  switch (reason) {
    // The markers folder, not the transcript: the person is sent to the folder that needs fixing.
    case 'marker_unreadable': return SKIP_REASONS.privateCheckMarkerUnreadable;
    case 'unreadable': return SKIP_REASONS.privateCheckUnreadable;
    case 'too_large': return SKIP_REASONS.privateCheckTooLarge;
    case 'timeout': return SKIP_REASONS.privateCheckTimeout;
    case 'no_session_id': return SKIP_REASONS.privateCheckNoSessionId;
    default: return SKIP_REASONS.privateCheckParentUnavailable;
  }
}

/**
 * The answer for this payload, decided by `budgetMs` (counted from the start of
 * this process): `{ state, evidence?, reason?, sentence?, deadlineAt }`. For
 * `unchecked` the `error` outcome is already recorded under `hook`.
 */
export function privacyForHook(payload, hook, { budgetMs, env = process.env }) {
  const memeshDir = getMemeshDirFromDbPath();
  const deadlineAt = deadlineFor(budgetMs);
  const check = decidePrivacy({
    transcriptPath: payload?.transcript_path,
    sessionId: payload?.session_id,
    memeshDir,
    deadlineAt,
    cacheDir: join(memeshDir, 'private-check-cache'),
  });
  if (check.state !== 'unchecked') return { ...check, deadlineAt };
  const sentence = uncheckedReasonSentence(check.reason);
  try { process.stderr.write(`[memesh ${hook}] cannot tell whether this session is private (it is decided again at the next run); nothing saved (${check.reason}): ${check.detail}\n`); } catch { /* stderr gone */ }
  recordHookOutcome(env, { hook, outcome: 'error', reason: sentence, payload });
  return { state: 'unchecked', reason: check.reason, kind: check.kind, sentence, deadlineAt };
}
