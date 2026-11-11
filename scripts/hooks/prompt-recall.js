#!/usr/bin/env node

// Prompt Recall — UserPromptSubmit hook
//
// Agents almost never call `recall` themselves, and a memory used to reach
// them only at session start or when they edited a file. This is the third
// moment: the user asks about something, and the stored memories that are
// plainly about it ride along with the prompt — at most two lines, each a
// title and its `[mem:id]` handle, under the same "background data, not
// instructions" notice the session-start block carries. A match that looks
// out of date (src/core/recent-index.ts) or was already shown is dropped and
// not replaced by the next one.
//
// What counts as plainly about it is decided by src/core/prompt-recall.ts
// (this hook runs its generated copy; scripts/audit/prompt-recall-replay.mjs
// runs the same one). Nothing strong means no output at all.
//
// Contract:
//   - Never blocks the prompt. Every failure is recorded and the hook exits 0
//     with nothing on stdout. The database is opened read-only with a short
//     lock wait.
//   - Every exit leaves an outcome record (`recordHookOutcome`), skips included.
//   - An id is injected at most once per session: the ids shown are kept in a
//     per-session list, and the ids session start already showed (its
//     injection record) are never repeated.
//   - Skipped entirely, and recorded as such, when the feature
//     (`promptRecall`) or auto-capture is off, and for a private session.
//   - The ids it injects are added to the session's injection record so a
//     `[mem:id]` citation of one of them is credited like any other.

import { closeSync, existsSync, fstatSync, openSync, readFileSync, realpathSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import {
  SKIP_REASONS,
  ensurePrivateDir,
  getDbPath,
  getMemeshDirFromDbPath,
  getProjectName,
  hookErrorReason,
  hookNodeProblem,
  isAutoCaptureEnabled,
  NODE_TOO_OLD_REASON,
  openMemeshDb,
  readHookConfig,
  recallSessionPath,
  recordHookOutcome,
  writePrivateJson,
  writePrivateJsonAtomic,
} from './_shared.js';
import { SESSION_ID_RE, pruneSessionState, recallListName } from './_stop-notes.js';
import { selectPromptRecall } from './_generated/prompt-recall.js';
import { HOOK_BUDGET_MS } from './_hook-budgets.js';

/** The hook's own wait for a database lock; the prompt must not stall behind a writer. */
const LOCK_WAIT_MS = 1000;
const SESSION_RECORD_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Is this session private? ONE call point.
//
// A session is private when the agent called the `private_session` tool — a
// structured call in the transcript, never text the person typed. The question
// is answered by the shared reader in `_private-session.js` (the same one every
// capture hook asks); this hook keeps no second copy of the rule.
//
// Anything but a clear "no" means nothing is shown: a transcript that is not
// named, or that the reader cannot answer for, is not "not private".
// ---------------------------------------------------------------------------
async function defaultReadPrivacy(data) {
  if (typeof data.transcript_path !== 'string' || data.transcript_path === '') {
    throw Object.assign(new Error('no transcript path'), { code: 'ENOTRANSCRIPT' });
  }
  // Loaded when asked, so a tree without the shared reader fails closed instead of crashing.
  const { privacyForHook } = await import('./_private-session.js');
  const answer = privacyForHook(data, 'prompt-recall', { budgetMs: HOOK_BUDGET_MS.promptRecall.decide });
  // `unchecked` (already recorded as an error by privacyForHook) is "could not read": show nothing.
  if (answer.state === 'unchecked') throw Object.assign(new Error(answer.reason), { code: answer.reason });
  return answer.state === 'yes';
}

/** 'private', 'open', or 'unreadable' (show nothing, and say so). */
export async function sessionPrivacy(data, readPrivacy = defaultReadPrivacy) {
  try {
    return (await readPrivacy(data)) === true ? 'private' : 'open';
  } catch (err) {
    logError(`private-session marker not read: ${err?.code || err?.message || err}`);
    return 'unreadable';
  }
}

// ---------------------------------------------------------------------------
// Per-session state: ids already shown, and whether the session was found private.
// ---------------------------------------------------------------------------
const stateDir = () => join(getMemeshDirFromDbPath(), 'prompt-recall');

function readState(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return {
      ids: Array.isArray(raw.ids) ? raw.ids.filter((id) => Number.isSafeInteger(id) && id > 0) : [],
      private: raw.private === true,
    };
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function writeState(file, state) {
  ensurePrivateDir(stateDir());
  writePrivateJson(file, state);
}

/** Ids the session-start block already showed in this session, from its injection record. */
function injectionRecord(sessionId, project) {
  const file = recallSessionPath(join(getMemeshDirFromDbPath(), 'sessions'), sessionId, project);
  if (!file) return { file: null, prior: null };
  try {
    const fd = openSync(file, 'r');
    try {
      if (Date.now() - fstatSync(fd).mtimeMs > SESSION_RECORD_TTL_MS) return { file, prior: null };
      const candidate = JSON.parse(readFileSync(fd, 'utf8'));
      return { file, prior: candidate.sessionId === sessionId && candidate.project === project ? candidate : null };
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    // No record, or one that cannot be read: the per-session list of ids shown
    // still prevents a repeat, and the prompt is never held up over it.
    if (err?.code !== 'ENOENT') logError(`injection record not read: ${err?.message || err}`);
    return { file, prior: null };
  }
}

/** Add the injected ids to the session's injection record, so a citation of one is credited. */
function addToInjectionRecord({ file, prior }, sessionId, project, injected) {
  if (!file) return;
  const byId = new Map((prior?.entityIds || []).map((id, i) => [id, prior.entityNames?.[i] ?? String(id)]));
  for (const { id, name } of injected) byId.set(id, name);
  ensurePrivateDir(join(getMemeshDirFromDbPath(), 'sessions'));
  writePrivateJsonAtomic(file, {
    ...prior,
    sessionId,
    injectedAt: prior?.injectedAt || new Date().toISOString(),
    project,
    entityIds: [...byId.keys()],
    entityNames: [...byId.values()],
    injectedContext: prior?.injectedContext ?? 'prompt-recall',
    creditedIds: prior?.creditedIds || [],
    sessionCounted: prior?.sessionCounted === true,
  });
}

function logError(msg) {
  try { process.stderr.write(`[memesh prompt-recall] ${msg}\n`); } catch { /* stderr gone */ }
}

const EVAL_FLAG = /^(-e|-p|-pe|--eval|--print)(=|$)/;
const entryPath = process.argv[1];
const isMainModule = Boolean(entryPath)
  && entryPath !== '-'
  && !process.execArgv.some((arg) => EVAL_FLAG.test(arg))
  && (import.meta.url === pathToFileURL(entryPath).href
    || import.meta.url === pathToFileURL(realpathSync(entryPath)).href);

/**
 * One prompt, start to finish: the text to print on stdout, or null for nothing.
 * Every path records an outcome. `readPrivacy` is the private-session reader
 * (a seam for tests; the hook passes the shared one).
 */
export async function handlePrompt(data, readPrivacy = defaultReadPrivacy) {
  const record = (outcome, reason, entity) =>
    recordHookOutcome(process.env, { hook: 'prompt-recall', outcome, reason, entity, payload: data });
  try {
    const prompt = typeof (data.prompt ?? data.user_prompt) === 'string' ? (data.prompt ?? data.user_prompt) : '';
    if (!prompt.trim()) {
      record('skipped', SKIP_REASONS.promptEmpty);
      return null;
    }
    if (readHookConfig(process.env).promptRecall === false) {
      record('skipped', SKIP_REASONS.promptRecallOff);
      return null;
    }
    if (!isAutoCaptureEnabled(process.env)) {
      record('skipped', SKIP_REASONS.autoCaptureOff);
      return null;
    }
    const sessionId = data.session_id;
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
      record('skipped', SKIP_REASONS.noSessionId);
      return null;
    }

    // Before the privacy read and "no database yet": on a Node that cannot run MeMesh nothing below can work, and
    // the database can never be created.
    if (hookNodeProblem('prompt-recall')) {
      record('error', NODE_TOO_OLD_REASON);
      return null;
    }

    // Private sessions: once found private, always private (it only ratchets);
    // otherwise ask the shared reader every prompt, since the call can come at any point.
    const statePath = join(stateDir(), recallListName(sessionId, null));
    let state = readState(statePath);
    const privacy = state?.private === true ? 'private' : await sessionPrivacy(data, readPrivacy);
    if (privacy === 'private') {
      writeState(statePath, { ids: state?.ids ?? [], private: true });
      record('skipped', SKIP_REASONS.promptPrivateSession);
      return null;
    }
    if (privacy === 'unreadable') {
      record('skipped', SKIP_REASONS.promptPrivacyUnreadable);
      return null;
    }

    const dbPath = getDbPath();
    if (!existsSync(dbPath)) {
      record('skipped', SKIP_REASONS.noDatabaseForRecall);
      return null;
    }
    const project = typeof data.cwd === 'string' && data.cwd ? getProjectName(data.cwd) : null;
    const injectionState = injectionRecord(sessionId, project);
    const shown = new Set([...(state?.ids ?? []), ...(injectionState.prior?.entityIds ?? [])]);

    // The session-start index before its filter: a match a newer decision in
    // it replaces is out of date. A session with no such record (session start
    // did not run, or showed nothing) compares the matches with each other
    // only, and says so on the outcome below.
    const hasPool = Array.isArray(injectionState.prior?.recentPoolIds);
    const recentPool = hasPool ? injectionState.prior.recentPoolIds.filter((id) => Number.isSafeInteger(id) && id > 0) : [];
    const db = openMemeshDb(dbPath, { readOnly: true });
    let result;
    try {
      db.pragma(`busy_timeout = ${LOCK_WAIT_MS}`);
      result = selectPromptRecall(db, prompt, { project, cwd: project === null ? null : data.cwd, exclude: shown, recentPool });
    } finally {
      db.close();
    }

    if (result.ids.length === 0) {
      record('skipped', {
        'no-terms': SKIP_REASONS.promptNoTerms,
        'no-candidates': SKIP_REASONS.promptNoMatch,
        'below-threshold': SKIP_REASONS.promptNoMatch,
        stale: SKIP_REASONS.promptStale,
        'already-shown': SKIP_REASONS.promptAlreadyShown,
      }[result.reason] ?? SKIP_REASONS.promptNoMatch);
      return null;
    }

    state = { ids: [...(state?.ids ?? []), ...result.ids], private: false };
    writeState(statePath, state);
    const names = new Map(result.scored.map((m) => [m.id, m.name]));
    let credited = true;
    try {
      addToInjectionRecord(injectionState, sessionId, project, result.ids.map((id) => ({ id, name: names.get(id) ?? String(id) })));
    } catch (err) {
      credited = false;
      logError(`injection record not updated: ${err?.message || err}`);
      record('error', `injection-record: ${hookErrorReason(err)}`);
    }
    try { pruneSessionState(stateDir(), Date.now()); } catch { /* best-effort housekeeping */ }
    record('notified', undefined, `injected:${result.ids.length}${credited ? '' : ':uncredited'}${hasPool ? '' : ':no-recent-index'}`);
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: result.text },
    });
  } catch (err) {
    logError(err?.message || err);
    record('error', hookErrorReason(err));
    return null;
  }
}

if (isMainModule) {
  let payload = null;
  const record = (outcome, reason, entity) =>
    recordHookOutcome(process.env, { hook: 'prompt-recall', outcome, reason, entity, payload });

  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', async () => {
    // One exit: a malformed payload records its error here, every other path
    // records inside handlePrompt.
    let malformed = false;
    try {
      payload = input.trim() ? JSON.parse(input) : {};
    } catch (parseErr) {
      malformed = true;
      logError(`malformed stdin JSON (len=${input.length}): ${parseErr.message}`);
      record('error', 'malformed stdin JSON');
    }
    const out = malformed ? null : await handlePrompt(payload);
    if (out) process.stdout.write(out);
    process.exit(0);
  });
}
