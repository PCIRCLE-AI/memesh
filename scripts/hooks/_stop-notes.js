// Stop-side note work (#324): note-directory ingestion and the
// "this session decided things and stored nothing" nudge.
//
// Not a hook (the `_` prefix): session-summary.js — the Stop hook — calls
// `runStopNotes()` once per Stop. Both halves live apart from the capture
// path on purpose: the capture path bails early on quiet sessions, on
// already-captured sessions and when auto-capture is off, and neither half
// may inherit those exits by accident.
//
// Contract:
//   - NEVER blocks the host. Everything is bounded (ingestion reads at most
//     INGEST_MAX_FILES files per Stop, the nudge reads only the transcript
//     bytes appended since the previous Stop) and every failure is recorded
//     and swallowed. The only output is at most one `systemMessage` line,
//     which the caller prints.
//   - Every path records an outcome (`recordHookOutcome`) under its own hook
//     name — `note-ingest` and `remember-nudge` — so their skips do not dilute
//     session-summary's capture-liveness window.
//   - Ingestion WRITES memories and is therefore gated on auto-capture; the
//     nudge writes nothing and is not.

import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  statSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from 'fs';
import { createHash } from 'crypto';
import { homeDir } from './_generated/core-paths.js';
import { notePathsWrittenInTranscript } from './_session-written-notes.js';
import { PRIVATE_WINDOW_MS, privateCheckCacheDir, prunePrivateCheckCache } from './_generated/private-session.js';
import { isCodexRollout, isCodexToolRequest } from './_generated/host-transcript.js';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import {
  ensurePrivateDir,
  getMemeshDirFromDbPath,
  getProjectName,
  HOOK_BUSY_TIMEOUT_MS,
  SKIP_REASONS,
  hookErrorReason,
  importFromPluginRoot,
  isGitCommitCommand,
  recordHookOutcome,
  resolvePluginRoot,
  writePrivateJson,
} from './_shared.js';

/** Fewer tool calls than this since the last Stop is a trivial turn: no nudge. */
export const NUDGE_MIN_TOOL_CALLS = 5;
/** Files ingestion may read in one Stop. The rest wait for the next Stop. */
export const INGEST_MAX_FILES = 100;
/** Most transcript bytes the nudge reads in one Stop (the newest ones). */
const MAX_WINDOW_BYTES = 16 * 1024 * 1024;
/** A session id safe to use as a file name. */
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The file name of one context's pre-edit recall list (#521): a session, or a
 * subagent inside it (its payload carries the parent's session id plus its own
 * agent id). A hash of the ids, so the name has a fixed length, and ids that
 * differ only in case stay different files on a case-insensitive disk.
 */
export function recallListName(sessionId, agentId) {
  return `${createHash('sha256').update(agentId ? `${sessionId}\n${agentId}` : sessionId).digest('hex').slice(0, 32)}.json`;
}
const SKIPPED_DIRS = new Set(['.git', 'node_modules']);

const MEMORY_WRITE_TOOL_RE = /(?:^|__)(?:remember|learn)$/;
const MEMORY_WRITE_BASH_RE = /\bmemesh\s+(?:remember|learn)\b/;
const TEST_RE = /\b(?:vitest|jest|pytest|go\s+test|cargo\s+test|npm\s+(?:run\s+)?test|run-tests[\w-]*)\b/;
// The sentence Claude Code puts in a tool_result block when the user turned
// the call down ("The user doesn't want to proceed with this tool use. The
// tool use was rejected …"). Matched as that sentence, and only on
// plan/question results: the bare words "rejected"/"declined" appear in
// ordinary commit and test output, and in approved plans.
const DECLINED_RE = /The user doesn't want to proceed with this tool use/;
/** Days a per-session nudge offset file is kept after its last Stop. */
const NUDGE_STATE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Most stale offset files one Stop removes — the pruning stays bounded. */
const NUDGE_PRUNE_PER_RUN = 50;
const NOTE_PATH_RE = /(?:^|[\\/])(?:memory|\.remember)[\\/][^\\/]+\.md$/;
/** Unresolved tool_use ids carried into the next Stop window (newest kept). */
const PENDING_CARRY_MAX = 200;

/**
 * Claude Code keeps a project's memory directory next to its transcripts:
 * `~/.claude/projects/<slug>/<session>.jsonl` and `~/.claude/projects/<slug>/memory/`.
 * Deriving it from `transcript_path` avoids re-implementing Claude Code's
 * slug rule. Null when there is none (Codex, or a project with no memory yet),
 * and null for a symlinked directory — ingestion never follows links.
 *
 * THROWS when the directory cannot be looked at for a reason that is not
 * "it is not there". The catch here used to swallow everything and return
 * null, which made EACCES and EIO give the same answer as ENOENT: the run
 * recorded `no Claude Code memory directory for this project`, a sentence
 * that is false and reassuring at the same time. A user whose memory
 * directory became unreadable would see a hook reporting, every Stop and
 * forever, that they simply have no notes.
 *
 * ENOENT stays null because it is the ordinary case — most projects have no
 * memory directory, and that is not a fault. Everything else is a fault, and
 * the caller records it as one.
 */
export function claudeMemoryDir(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  const dir = join(dirname(transcriptPath), 'memory');
  try {
    const st = lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() ? dir : null;
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null;
    throw err;
  }
}

/** Transcript bytes read to find the directory the session started in. */
const START_CWD_SCAN_BYTES = 1024 * 1024;

/**
 * Whether the memory folder (the one of the directory the session started in) belongs to
 * `project`, the project of the payload's cwd. A session that moved to another repository
 * would otherwise file that folder's notes, trusted, under the wrong project. Decided by
 * project identity, so a move within one repository still matches: the transcript records
 * the directory each line was written in, and the one whose slug names the folder is where
 * the session started. No such line: false, and the notes wait for a Stop that can tell.
 */
export function memoryDirBelongsTo(memoryDir, { transcriptPath, cwd, project }) {
  const slug = basename(dirname(memoryDir));
  const slugOf = (dir) => dir.replace(/[^a-zA-Z0-9]/g, '-');
  if (typeof cwd === 'string' && slugOf(cwd) === slug) return true;
  let head;
  let fd;
  try {
    fd = openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(START_CWD_SCAN_BYTES);
    head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  for (const line of head.split('\n')) {
    let started;
    try { started = JSON.parse(line)?.cwd; } catch { continue; }
    if (typeof started === 'string' && slugOf(started) === slug) return inSameWorkTree(started, cwd) || getProjectName(started) === project;
  }
  return false;
}

/**
 * Whether `cwd` is `started` or below it with no `.git` in between, and `started` is inside a
 * git work tree: git then finds the same repository from both, so they are one project, and
 * the git calls of a second identity are not spent (the Stop hook has a 10 s budget). Anything
 * else (a nested repository or submodule, a directory outside any repository, whose id is its
 * own path, or `cwd` elsewhere) is left to the project ids.
 */
function inSameWorkTree(startedPath, cwdPath) {
  if (typeof cwdPath !== 'string' || !isAbsolute(startedPath) || !isAbsolute(cwdPath)) return false;
  const started = resolve(startedPath);
  const below = relative(started, resolve(cwdPath));
  if (below === '..' || below.startsWith(`..${sep}`) || isAbsolute(below)) return false;
  let dir = resolve(cwdPath);
  while (dir !== started) {
    if (existsSync(join(dir, '.git'))) return false;
    dir = dirname(dir);
  }
  for (let up = started; ; up = dirname(up)) {
    if (existsSync(join(up, '.git'))) return true;
    if (dirname(up) === up) return false;
  }
}

/**
 * Where a project's notes folder is, or will be: Claude Code creates `memory/`
 * when it writes the first note, so the folder next to the transcript need not
 * exist yet. Null when there is no transcript path.
 */
export function claudeMemoryDirExpected(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath || isCodexRollout(transcriptPath)) return null;
  return join(dirname(transcriptPath), 'memory');
}

/** The real path of a folder, or undefined when it is not there; throws when it cannot be looked at. */
function realPathIfThere(dir) {
  try { return realpathSync(dir); } catch (err) {
    if (err?.code === 'ENOENT') return undefined;
    throw err;
  }
}


/** Claude Code's projects folder (`<config dir>/projects`): where a session of another host can still write notes. */
export function claudeProjectsRoot(env = process.env) {
  const root = join(env.CLAUDE_CONFIG_DIR || join(homeDir(), '.claude'), 'projects');
  try { return realpathSync(root); } catch { return root; } // not there yet: nothing in it to protect either
}

/** Newest mtime among the directory and its `.md` files (links not followed). */
export function newestNoteMtime(dir) {
  let newest = 0;
  const walk = (abs, depth) => {
    newest = Math.max(newest, lstatSync(abs).mtimeMs);
    if (depth > 8) return;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const child = join(abs, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(child, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        newest = Math.max(newest, lstatSync(child).mtimeMs);
      }
    }
  };
  walk(dir, 0);
  return newest;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      try { process.stderr.write(`[memesh stop-notes] unreadable state ${path}: ${err?.message || err}; starting fresh\n`); } catch { /* stderr gone */ }
    }
    return null;
  }
}

function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writePrivateJson(tmp, value);
  renameSync(tmp, path);
}

/**
 * A private session imports no note. The notes it named, in any notes folder
 * of its projects root, and every note changed while it ran in a folder it
 * reached (its own always counts as reached), are recorded by content hash in
 * a file of its own beside the database, so that content is never imported by
 * a later Stop, after another note changes, or while the database is busy.
 *
 * `state` is the session's answer from `privacyForHook`. For `yes` the marker
 * is written first (it is the evidence of the call, and it makes other imports
 * wait while this hook reads), the holds are permanent, and the marker then
 * records the moment they were recorded from a complete read. For `unchecked`
 * no marker is ever written: the holds are tentative, they are themselves the
 * wait other imports respect, and the session is decided again at its next
 * hook. Returns the number held, or null when the note importer is not built
 * (nothing would ever import them either). Throws when a record cannot be
 * written: the caller reports it.
 */
/** A hold record or marker that cannot be read or written gets the fixed reason that says what to do; any other error its usual one. */
export const noteErrorReason = (err) => {
  switch (err?.code) {
    case 'MEMESH_NOTE_HOLDS_UNREADABLE': return SKIP_REASONS.noteHoldsUnreadable;
    case 'MEMESH_NOTE_HOLDS_DIR_UNREADABLE': return SKIP_REASONS.noteHoldsDirUnreadable;
    case 'MEMESH_NOTE_HOLDS_UNWRITABLE': return SKIP_REASONS.noteHoldsUnwritable;
    case 'MEMESH_NOTE_MARKERS_UNREADABLE': return SKIP_REASONS.noteMarkersUnreadable;
    case 'MEMESH_NOTE_MARKERS_DIR_UNREADABLE': return SKIP_REASONS.noteMarkersDirUnreadable;
    case 'MEMESH_NOTE_MARKER_UNWRITABLE': return SKIP_REASONS.noteMarkerUnwritable;
    case 'MEMESH_PRIVATE_STATE_BUSY': return SKIP_REASONS.privateStateBusy;
    case 'MEMESH_NOTE_FOLDER_UNREADABLE': return SKIP_REASONS.noteFolderUnreadable;
    default: return hookErrorReason(err);
  }
};

/** The note importer of this plugin, or null when it is not built. */
async function loadNoteIngest(metaUrl) {
  const pluginRoot = resolvePluginRoot(metaUrl);
  if (!existsSync(join(pluginRoot, 'dist/core/note-ingest.js'))) return null;
  return importFromPluginRoot(pluginRoot, 'dist/core/note-ingest.js');
}

/** When the session began, as far as can be told: the transcript's creation, else the window before now. */
function sessionStartMs(transcriptPath, now) {
  try { return Math.min(statSync(transcriptPath).birthtimeMs || now, now - PRIVATE_WINDOW_MS); } catch { return now - PRIVATE_WINDOW_MS; }
}

export async function holdOutNotes({ memoryDir, transcriptPath, sessionId, metaUrl, deadlineAt, env = process.env, payload, state = 'yes', uncheckedReason }) {
  // A hook that does not pass its deadline would read without one: that is a bug to record, not a default to guess.
  if (!Number.isFinite(deadlineAt)) throw new Error('holdOutNotes needs the hook\'s deadline');
  const ni = await loadNoteIngest(metaUrl);
  if (!ni) return null;
  const now = Date.now();
  const id = typeof sessionId === 'string' && sessionId !== '' ? sessionId : 'unknown';
  const isPrivate = state === 'yes';
  // A Codex session has no notes folder of its own, but it can write into Claude Code's: those are the folders to protect.
  const codex = !memoryDir && isCodexRollout(transcriptPath);
  // Real paths, as the importer compares them; the session's own folder may not exist yet.
  const ownReal = memoryDir ? realPathIfThere(memoryDir) : undefined;
  const root = codex ? claudeProjectsRoot(env) : memoryDir ? ni.projectsRootOf(ni.realPathOrExpected(memoryDir)) : undefined;
  let startedAt = now;
  if (isPrivate) {
    // The marker comes first: if this hook is killed while it reads a large transcript, other sessions already wait.
    const first = { sessionId: id, dirs: memoryDir ? [memoryDir] : [], transcript: transcriptPath, deadlineAt, ...(codex ? { projectsRoot: root } : {}) };
    try {
      startedAt = ni.markPrivateSession(first);
    } catch (err) {
      if (err?.code !== ni.NOTE_MARKERS_UNREADABLE) throw err;
      // This session's own marker is damaged: it is written again from no later than the session's start, and that is recorded.
      startedAt = ni.markPrivateSession({ ...first, rebuildFrom: sessionStartMs(transcriptPath, now) });
      recordHookOutcome(env, { hook: 'note-ingest', outcome: 'error', reason: SKIP_REASONS.privateMarkerRebuilt, payload });
    }
  }
  // No notes folder to protect and no other host's (no transcript path): for a private session the call itself is recorded above.
  if (root === undefined) return 0;
  const folders = [...new Set([...(ownReal ? [ownReal] : []), ...ni.projectMemoryFolders(root)])];
  const scanStartedAt = Date.now();
  const scan = folders.length === 0 ? { byDir: new Map(), reached: new Set(), complete: true } : notePathsWrittenInTranscript(transcriptPath, folders, { ownDir: ownReal, deadlineAt });
  const complete = scan.complete;
  if (!complete) recordHookOutcome(env, { hook: 'note-ingest', outcome: 'notified', reason: SKIP_REASONS.notesHeldByTime, payload });
  // Reached folders (and every folder, when the read was not complete) hold what changed while the session may have written there.
  const windowStart = isPrivate ? (complete ? startedAt : Math.min(startedAt, now - PRIVATE_WINDOW_MS)) : now - PRIVATE_WINDOW_MS;
  let held = 0;
  let recorded = false;
  for (const dir of folders) {
    const reached = !complete || scan.reached.has(dir);
    const paths = scan.byDir.get(dir) ?? [];
    if (!reached && paths.length === 0) continue;
    recorded = true;
    held += ni.holdOutNoteFiles({
      dir, sessionId: id, paths, transcript: transcriptPath, deadlineAt,
      ...(reached ? { sinceMs: windowStart } : {}),
      ...(isPrivate ? {} : { tentative: { reason: uncheckedReason ?? 'unreadable', projectsRoot: root, holdsAt: complete ? scanStartedAt : undefined } }),
    });
  }
  // Nothing to hold yet (no notes folder at all, or none reached), but other imports must still wait while this session cannot be checked.
  if (!isPrivate && !recorded) ni.holdOutNoteFiles({ sessionId: id, paths: [], transcript: transcriptPath, deadlineAt, tentative: { reason: uncheckedReason ?? 'unreadable', projectsRoot: root } });
  if (isPrivate) {
    ni.markPrivateSession({ sessionId: id, dirs: [...scan.reached], transcript: transcriptPath, deadlineAt, ...(complete ? { holdsAt: scanStartedAt } : {}) });
  }
  return held;
}

/**
 * The session's user wrote a prompt: a private session's marker is live again.
 * Nothing for a session that has no marker; recorded when the importer is not
 * built, and when the marker cannot be read or written (the importer stops
 * meanwhile, and the session's next hook rebuilds it).
 */
export async function renewPrivateNoteMarker({ sessionId, metaUrl, deadlineAt, env = process.env, payload }) {
  if (typeof sessionId !== 'string' || sessionId === '') return;
  if (!Number.isFinite(deadlineAt)) throw new Error('renewPrivateNoteMarker needs the hook\'s deadline');
  const ni = await loadNoteIngest(metaUrl);
  if (!ni) { recordHookOutcome(env, { hook: 'note-ingest', outcome: 'skipped', reason: SKIP_REASONS.noteIngesterNotBuilt, payload }); return; }
  try {
    ni.renewPrivateSession(sessionId, Date.now(), deadlineAt);
  } catch (err) {
    try { process.stderr.write(`[memesh note-ingest] ${err?.message || err}\n`); } catch { /* stderr gone */ }
    recordHookOutcome(env, { hook: 'note-ingest', outcome: 'error', reason: noteErrorReason(err), payload });
  }
}

/** The private session has ended and its holds are recorded: other imports stop waiting for it (the marker stays as the record of the call). */
export async function endPrivateNoteMarker({ sessionId, metaUrl, state = 'yes', deadlineAt }) {
  if (!Number.isFinite(deadlineAt)) throw new Error('endPrivateNoteMarker needs the hook\'s deadline');
  const ni = await loadNoteIngest(metaUrl);
  if (!ni) return;
  const id = typeof sessionId === 'string' && sessionId !== '' ? sessionId : 'unknown';
  if (state === 'yes') ni.endPrivateSession(id, Date.now(), deadlineAt);
  else ni.endTentativeWait(id, Date.now(), deadlineAt);
}

/** The session was decided `no` by its own hook: what was held only while it could not be checked is let through. Returns whether anything changed. */
export async function releaseOwnTentativeHolds({ sessionId, metaUrl, deadlineAt }) {
  if (typeof sessionId !== 'string' || sessionId === '') return false;
  const ni = await loadNoteIngest(metaUrl);
  if (!ni) return false;
  return ni.settleTentativeHolds(sessionId, 'no', { deadlineAt });
}

/** The hold records' newest change: a release or a new hold makes the next import look again. */
function holdsChangedAt() {
  const dir = join(getMemeshDirFromDbPath(), 'note-ingest-holds');
  let newest = 0;
  try {
    newest = lstatSync(dir).mtimeMs;
    for (const name of readdirSync(dir)) { try { newest = Math.max(newest, lstatSync(join(dir, name)).mtimeMs); } catch { /* gone */ } }
  } catch { /* no holds */ }
  return newest;
}

/**
 * Ingest the memory directory when anything in it changed since the last
 * run. The mtime throttle makes the common Stop (nothing changed) cost one
 * directory walk and no database handle at all.
 *
 * Returns `{ outcome, reason, entity }`. The outcome is `wrote` when the run
 * changed a memory: created, replaced, moved (its file was renamed), restored
 * (its file came back) or marked missing. A fingerprint refresh — same bytes,
 * new mtime after a `touch` or a checkout — is bookkeeping about the file, not
 * a change to anything the user stored, and reads as a skip. `entity` names one
 * memory the run touched, and is set exactly when the outcome is `wrote`.
 */
export async function runNoteIngestion({ memoryDir, project, metaUrl, deadlineAt }) {
  if (!memoryDir) return { outcome: 'skipped', reason: SKIP_REASONS.noMemoryDir };
  const memeshDir = getMemeshDirFromDbPath();
  const statePath = join(memeshDir, 'note-ingest-state.json');
  const key = createHash('sha256').update(memoryDir).digest('hex').slice(0, 16);
  const state = readJson(statePath) ?? {};
  const newest = Math.max(newestNoteMtime(memoryDir), holdsChangedAt());
  const last = typeof state[key]?.at === 'number' ? state[key].at : 0;
  // A folder read before its notes were trusted is read once more, so the notes already stored are made trusted.
  if (newest <= last && !state[key]?.more && state[key]?.trusted === true) {
    return { outcome: 'skipped', reason: SKIP_REASONS.noNoteChanged };
  }

  const pluginRoot = resolvePluginRoot(metaUrl);
  const ingestPath = join(pluginRoot, 'dist/core/note-ingest.js');
  if (!existsSync(ingestPath)) {
    return { outcome: 'skipped', reason: SKIP_REASONS.noteIngesterNotBuilt };
  }
  const { ingestNoteDirectory, summarizeNoteIngest } = await importFromPluginRoot(pluginRoot, 'dist/core/note-ingest.js');
  const { openDatabase, closeDatabase } = await importFromPluginRoot(pluginRoot, 'dist/db.js');
  const startedAt = Date.now();
  openDatabase(undefined, { busyTimeoutMs: HOOK_BUSY_TIMEOUT_MS });
  let result;
  try {
    // The directory is this session's own memory folder (derived from its transcript path): its notes are trusted.
    result = ingestNoteDirectory({ dir: memoryDir, project, maxFiles: INGEST_MAX_FILES, deadlineAt, trusted: true });
  } finally {
    closeDatabase();
  }
  ensurePrivateDir(memeshDir);
  // `startedAt`, not `newest`: a file edited while this run was reading is
  // newer than the stamp and is picked up next time. A run that left notes
  // waiting or held only tentatively runs again, whether or not a note changes.
  // `trusted` is recorded only when the folder's notes are trusted: a run that could not take the copy it needs first leaves it unset, so the next Stop tries again.
  writeJsonAtomic(statePath, { ...state, [key]: { at: startedAt, more: result.more > 0 || result.pendingPrivate > 0 || result.held.unchecked > 0 || result.redecideLeft > 0, trusted: !result.retrustFailed } });
  if (result.retrustFailed) return { outcome: 'error', reason: `note trust: ${result.retrustFailed}` };
  // Every shape of MEMORY change counts, not only the ones that store text:
  // a move re-points the memory at its file and a restore takes it out of
  // missing, and a record saying "nothing new" about a run that changed a
  // memory is exactly the silent-skip shape doctor's capture-liveness reads
  // these records for. A fingerprint refresh (same bytes, new mtime) is
  // deliberately NOT counted: it updates provenance so the next run can skip
  // the read, and changes nothing a reader of the memory would notice.
  // Named in the same precedence as `changed` below, so the entity doctor
  // shows as `lastEntity` is one this run actually touched. Without it a
  // `wrote` record carried no entity at all, and doctor reported a hook with
  // `lastWriteAt` set and `lastEntity` null — a write with nothing written,
  // which reads as a bug in doctor rather than as the missing field it is.
  const touched = result.created[0] ?? result.replaced[0] ?? result.repathed[0]
    ?? result.restored[0] ?? result.markedMissing[0] ?? result.retrusted[0];
  const heldNow = result.held.private + result.held.unchecked;
  const changed = result.created.length + result.replaced.length + result.repathed.length
    + result.restored.length + result.markedMissing.length + result.retrusted.length > 0;
  // A write records the summary (counts only); a skip records a known
  // reason, the only kind doctor will quote.
  // A run that stored nothing but REFUSED files is not the same event as a
  // quiet one, and `noteNothingNew` — "note files were read and nothing new
  // needed storing" — said it was: the user's file was rejected and the hook
  // reported contentment. `refusedNow`, never `skipped.length`: the latter
  // sticks forever once a file is bad, so every later Stop would keep
  // re-reporting old news as if it had just happened. When the run DID store
  // something, summarizeNoteIngest already names the refusals alongside it.
  return {
    outcome: changed ? 'wrote' : 'skipped',
    reason: changed
      ? summarizeNoteIngest(result)
      : (result.refusedNow > 0 ? SKIP_REASONS.noteFilesRefused
        : heldNow > 0 ? SKIP_REASONS.notesHeldPrivate
          : result.pendingPrivate > 0 ? SKIP_REASONS.notesWaitingForPrivateSession
            : result.more > 0 ? SKIP_REASONS.notesLeftForNextRun
              : SKIP_REASONS.noteNothingNew),
    entity: changed ? touched : undefined,
    // Every note held out or left waiting is counted, whatever else the run did.
    count: heldNow + result.pendingPrivate > 0 ? heldNow + result.pendingPrivate : undefined,
  };
}

/**
 * Read the transcript bytes appended since `offset`, whole lines only.
 * A file smaller than the offset was replaced; it is read from the start.
 */
export function readTranscriptWindow(transcriptPath, offset) {
  const fd = openSync(transcriptPath, 'r');
  try {
    const size = fstatSync(fd).size;
    let start = Number.isInteger(offset) && offset >= 0 && offset <= size ? offset : 0;
    if (size - start > MAX_WINDOW_BYTES) start = size - MAX_WINDOW_BYTES;
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n === 0) break;
      got += n;
    }
    const lastNewline = buf.lastIndexOf(0x0a, got - 1);
    if (lastNewline < 0) return { text: '', nextOffset: start };
    return { text: buf.subarray(0, lastNewline + 1).toString('utf8'), nextOffset: start + lastNewline + 1 };
  } finally {
    closeSync(fd);
  }
}

/**
 * What a transcript window shows: how many tool calls, which decision-shaped
 * moves (the rules' own triggers — a plan approved, a question answered, a
 * commit, a test made red then green), and whether a memory was written
 * (`remember`/`learn` via MCP or the CLI, or a write to a note file).
 *
 * `carry` seeds the tool_use → kind map with calls whose RESULT had not
 * arrived when the previous window ended, and the returned `pending` is what
 * this window leaves for the next one. Without it a plan approved either side
 * of a Stop was never paired: the tool_use fell in one window and the
 * tool_result in the next, and the hook reported "no decision-shaped move
 * since the last Stop" — a miss that looks exactly like a quiet turn.
 *
 * How often a pair actually straddles a Stop is NOT known. This comment used
 * to claim a scan of 1090 real transcripts had found every ExitPlanMode pair
 * adjacent. No command for that scan is recorded anywhere in this repository —
 * `git log -S"1090 real transcripts"` reaches the commit that introduced the
 * sentence and it carries no scan either — and the number appears nowhere but
 * in this paragraph. It is written down here as unmeasured rather than deleted,
 * because a reader who wants the frequency should know it is still open and
 * not go looking for a result that does not exist. Two comments on this branch
 * had the same shape — each named a function nobody wrote.
 *
 * The carry does not depend on that frequency. It costs one bounded map, and
 * the failure it prevents is silent and gives a plausible reason, which is the
 * combination that makes a rare miss expensive rather than tolerable.
 *
 * The map is capped (PENDING_CARRY_MAX, newest kept) so a session that opens
 * calls it never closes cannot grow the state file without bound.
 */
export function scanTranscriptWindow(text, carry = null) {
  const pending = new Map(); // tool_use_id → kind
  if (carry && typeof carry === 'object') {
    for (const [id, kind] of Object.entries(carry)) {
      if (typeof id === 'string' && typeof kind === 'string') pending.set(id, kind);
    }
  }
  const moves = [];
  let toolCalls = 0;
  let wroteMemory = false;
  let firstTimestamp = null;
  let testWentRed = false;
  let testWentGreen = false;
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; } // torn/foreign line: not evidence either way
    if (firstTimestamp === null && typeof entry?.timestamp === 'string') {
      const t = Date.parse(entry.timestamp);
      if (!Number.isNaN(t)) firstTimestamp = t;
    }
    // Codex: a tool request is a function_call / custom_tool_call row (the same
    // count the session summary uses); what came of a command or a memory tool is
    // in the completed item beside it, so there is nothing to pair across windows.
    if (isCodexToolRequest(entry)) {
      toolCalls++;
      continue;
    }
    if (entry?.type === 'event_msg' && entry.payload?.type === 'item_completed') {
      const item = entry.payload.item;
      if (item?.type === 'McpToolCall') {
        if (item.status === 'completed' && MEMORY_WRITE_TOOL_RE.test(String(item.tool ?? ''))) wroteMemory = true;
      } else if (item?.type === 'CommandExecution') {
        const cmd = String(Array.isArray(item.command) ? item.command[item.command.length - 1] : item.command ?? '');
        // The same rule the rollout reader uses for success: completed, with exit code 0.
        const failed = !(item.status === 'completed' && item.exit_code === 0);
        if (MEMORY_WRITE_BASH_RE.test(cmd)) {
          if (!failed) wroteMemory = true;
        } else if (isGitCommitCommand(cmd)) {
          if (!failed) moves.push('a commit');
        } else if (TEST_RE.test(cmd)) {
          if (failed) testWentRed = true;
          else if (testWentRed && !testWentGreen) { testWentGreen = true; moves.push('a test went red then green'); }
        }
      }
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (entry.type === 'assistant' && block?.type === 'tool_use') {
        toolCalls++;
        const name = typeof block.name === 'string' ? block.name : '';
        const input = block.input ?? {};
        if (MEMORY_WRITE_TOOL_RE.test(name)) pending.set(block.id, 'memory');
        else if (name === 'ExitPlanMode') pending.set(block.id, 'plan');
        else if (name === 'AskUserQuestion') pending.set(block.id, 'question');
        else if ((name === 'Write' || name === 'Edit') && NOTE_PATH_RE.test(String(input.file_path ?? ''))) pending.set(block.id, 'memory');
        else if (name === 'Bash') {
          const cmd = String(input.command ?? '');
          if (MEMORY_WRITE_BASH_RE.test(cmd)) pending.set(block.id, 'memory');
          else if (isGitCommitCommand(cmd)) pending.set(block.id, 'commit');
          else if (TEST_RE.test(cmd)) pending.set(block.id, 'test');
        }
      } else if (entry.type === 'user' && block?.type === 'tool_result') {
        const kind = pending.get(block.tool_use_id);
        if (!kind) continue;
        pending.delete(block.tool_use_id);
        const resultText = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
        const declined = (kind === 'plan' || kind === 'question') && DECLINED_RE.test(resultText);
        const failed = block.is_error === true || declined;
        if (kind === 'test') {
          if (failed) testWentRed = true;
          else if (testWentRed && !testWentGreen) { testWentGreen = true; moves.push('a test went red then green'); }
          continue;
        }
        if (failed) continue;
        if (kind === 'memory') wroteMemory = true;
        else if (kind === 'plan') moves.push('a plan was approved');
        else if (kind === 'question') moves.push('a question was answered');
        else if (kind === 'commit') moves.push('a commit');
      }
    }
  }
  // Newest last: Map preserves insertion order, so the tail is the most
  // recent unresolved calls — the ones whose result is still plausibly coming.
  const carried = [...pending.entries()].slice(-PENDING_CARRY_MAX);
  return { toolCalls, moves, wroteMemory, firstTimestamp, pending: Object.fromEntries(carried) };
}

/**
 * Remove per-session state files not touched for 30 days. One file per
 * session would otherwise accumulate forever. At most NUDGE_PRUNE_PER_RUN
 * removals per call, so a long backlog is worked off over several runs
 * rather than in one.
 */
export function pruneSessionState(dir, now, onFault) {
  let removed = 0;
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    // The directory itself is unreadable: nothing was pruned, and the caller
    // must not have to guess why. Same line as a failed per-file removal.
    try { process.stderr.write(`[memesh] could not prune ${dir}: ${err?.message || err}\n`); } catch { /* stderr gone */ }
    if (onFault) onFault(err);
    return removed;
  }
  for (const name of names) {
    if (removed >= NUDGE_PRUNE_PER_RUN) break;
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    try {
      if (now - lstatSync(file).mtimeMs > NUDGE_STATE_MAX_AGE_MS) {
        unlinkSync(file);
        removed++;
      }
    } catch (err) {
      // Another hook removed it first: it is gone, which is what was wanted.
      if (err?.code === 'ENOENT') continue;
      // Unreadable: this run leaves it; the next one retries.
      try { process.stderr.write(`[memesh] could not prune ${file}: ${err?.message || err}\n`); } catch { /* stderr gone */ }
      if (onFault) onFault(err);
    }
  }
  return removed;
}

export function buildNudge(moves) {
  const kinds = [...new Set(moves)].join(', ');
  return `MeMesh: this session made ${moves.length} decision-shaped move(s) (${kinds}) and stored no memory — \`remember\` them.`;
}

/**
 * Decide the nudge for this Stop, so each Stop judges only what happened
 * since the previous one.
 *
 * Returns `{ message, reason, commit }`; `message` is null when silent.
 *
 * `commit` advances the per-session offset and is NOT called here. The offset
 * used to move the moment the window was read, which meant a nudge that never
 * reached the user was still paid for: the window was consumed, the next Stop
 * saw only what came after it, and the decision-shaped moves the user was
 * supposed to be told about were never mentioned again. Deciding and
 * committing are separate so the caller can advance the offset only once the
 * line has actually been written. The paths that return before the window is
 * read have no `commit` — there is nothing to advance.
 */
export function decideNudge({ transcriptPath, sessionId, memoryDir }) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return { message: null, reason: SKIP_REASONS.noSessionId };
  if (typeof transcriptPath !== 'string' || !transcriptPath || !existsSync(transcriptPath)) {
    return { message: null, reason: SKIP_REASONS.noTranscript };
  }
  const dir = join(getMemeshDirFromDbPath(), 'remember-nudge');
  ensurePrivateDir(dir);
  pruneSessionState(dir, Date.now());
  const statePath = join(dir, `${sessionId}.json`);
  const state = readJson(statePath) ?? {};
  const { text, nextOffset } = readTranscriptWindow(transcriptPath, state.offset);
  const now = Date.now();
  const scan = scanTranscriptWindow(text, state.pending);
  // The unresolved calls travel with the offset: both describe where this
  // session's reading got to, and committing one without the other would
  // either lose a pairing or replay one.
  const commit = () => writeJsonAtomic(statePath, { offset: nextOffset, lastStopAt: now, pending: scan.pending });

  if (scan.toolCalls < NUDGE_MIN_TOOL_CALLS) return { message: null, reason: SKIP_REASONS.trivialTurn, commit };
  if (scan.moves.length === 0) return { message: null, reason: SKIP_REASONS.noDecisionMove, commit };
  if (scan.wroteMemory) return { message: null, reason: SKIP_REASONS.memoryWritten, commit };
  const since = typeof state.lastStopAt === 'number' ? state.lastStopAt : scan.firstTimestamp;
  if (memoryDir && typeof since === 'number' && newestNoteMtime(memoryDir) >= since) {
    return { message: null, reason: SKIP_REASONS.noteFileChanged, commit };
  }
  return { message: buildNudge(scan.moves), reason: scan.moves.join('; '), commit };
}

/**
 * Both halves. Ingestion runs first so a note written this turn is already
 * searchable when the turn ends; the nudge judges "was a note written" by the
 * note files' mtimes rather than by what ingestion wrote, because the first
 * ingestion after install imports every OLD note and would otherwise silence
 * a nudge the session earned.
 *
 * Returns `{ message, settle }`. `message` is the one advisory line to print,
 * or null. `settle(delivered)` MUST be called once the caller has tried to
 * print it: it records the nudge's outcome — which is the delivery's verdict,
 * not a prediction of it — and advances the per-session transcript offset only
 * when the line actually went out. A caller that never settles leaves no
 * record, which is the silent skip this whole module exists to avoid.
 */
export async function runStopNotes(payload, { captureEnabled, project, metaUrl, privacy = { state: 'no' }, deadlineAt, env = process.env }) {
  if (!Number.isFinite(deadlineAt)) throw new Error('runStopNotes needs the hook\'s deadline');
  // `claudeMemoryDir` throws on anything that is not "no such directory"
  // (EACCES, EIO). That is an error for ingestion — capture is being LOST,
  // not declined — but it must not take the nudge down with it, so it is
  // caught here rather than left to either half's try block. The nudge then
  // runs with no memory directory, which only costs it the note-file check.
  let memoryDir = null;
  let memoryDirError = null;
  try {
    memoryDir = claudeMemoryDir(payload?.transcript_path);
  } catch (err) {
    memoryDirError = err;
  }
  // Every Stop of every host removes the private-check cache entries of files that are gone, and the temporary files a
  // writer that died left beside the markers and holds. A marker is never removed: it is the record of the call.
  prunePrivateCheckCache(privateCheckCacheDir(getMemeshDirFromDbPath()));
  try {
    (await loadNoteIngest(metaUrl))?.removeStalePrivateStateTemps();
  } catch (err) {
    try { process.stderr.write(`[memesh note-ingest] ${err?.message || err}\n`); } catch { /* stderr gone */ }
    recordHookOutcome(env, { hook: 'note-ingest', outcome: 'error', reason: noteErrorReason(err), payload });
  }
  // The session is private, or could not be checked: no note is imported, the
  // note files it wrote are held out of every later import (for good, or until
  // it is decided again), and the nudge, which would ask the agent to remember
  // something, stays silent.
  if (privacy.state !== 'no') {
    let holdFailed = false;
    try {
      if (memoryDirError) throw memoryDirError;
      const held = await holdOutNotes({
        memoryDir: memoryDir ?? claudeMemoryDirExpected(payload?.transcript_path), transcriptPath: payload?.transcript_path, sessionId: payload?.session_id,
        metaUrl, deadlineAt, env, payload, state: privacy.state, uncheckedReason: privacy.reason,
      });
      recordHookOutcome(env, {
        hook: 'note-ingest',
        outcome: 'skipped',
        reason: held === null ? SKIP_REASONS.noteIngesterNotBuilt : privacy.skipReason,
        ...(held ? { count: held } : {}),
        payload,
      });
    } catch (err) {
      holdFailed = true; // the holds are not in place: the caller keeps the session's marker
      try { process.stderr.write(`[memesh note-ingest] ${err?.message || err}\n`); } catch { /* stderr gone */ }
      recordHookOutcome(env, { hook: 'note-ingest', outcome: 'error', reason: noteErrorReason(err), payload });
    }
    recordHookOutcome(env, { hook: 'remember-nudge', outcome: 'skipped', reason: privacy.skipReason, payload });
    return { message: null, settle: () => {}, holdFailed };
  }
  // Decided `no` by its own hook: what was held while it could not be checked is let through, and imported below.
  try {
    await releaseOwnTentativeHolds({ sessionId: payload?.session_id, metaUrl, deadlineAt });
  } catch (err) {
    try { process.stderr.write(`[memesh note-ingest] ${err?.message || err}\n`); } catch { /* stderr gone */ }
    recordHookOutcome(env, { hook: 'note-ingest', outcome: 'error', reason: noteErrorReason(err), payload });
  }
  try {
    if (!captureEnabled) {
      // Ordered before the directory error on purpose: with ingestion turned
      // off there was never going to be a read, so a fault in a directory
      // this run would not have opened is not this run's news.
      recordHookOutcome(env, { hook: 'note-ingest', outcome: 'skipped', reason: SKIP_REASONS.autoCaptureOff, payload });
    } else if (memoryDirError) {
      try { process.stderr.write(`[memesh note-ingest] cannot read the memory directory: ${memoryDirError?.message || memoryDirError}\n`); } catch { /* stderr gone */ }
      recordHookOutcome(env, { hook: 'note-ingest', outcome: 'error', reason: hookErrorReason(memoryDirError), payload });
    } else if (project === undefined || project === null) {
      // No `cwd` in the payload, so the caller could not resolve a project.
      // Ingesting anyway files every note under NO project, and unlike a
      // missed capture that is not recoverable: `note-ingest` fast-paths a
      // file whose fingerprint is unchanged, so the run that could add the
      // tag never reads the file again unless the user edits it.
      //
      // session-summary refuses session capture for this same condition and
      // says why — better to miss one capture than to file it under the
      // wrong project. A note with no project at all is the same mistake
      // with a worse ending, so ingestion waits for a Stop that has a cwd.
      // The nudge below is unaffected: it writes nothing and needs no project.
      recordHookOutcome(env, { hook: 'note-ingest', outcome: 'skipped', reason: SKIP_REASONS.cwdAbsent, payload });
    } else if (memoryDir && !memoryDirBelongsTo(memoryDir, { transcriptPath: payload?.transcript_path, cwd: payload?.cwd, project })) {
      // No folder (memoryDir null) is runNoteIngestion's own recorded skip, below.
      recordHookOutcome(env, { hook: 'note-ingest', outcome: 'skipped', reason: SKIP_REASONS.memoryDirOtherProject, payload });
    } else {
      const r = await runNoteIngestion({ memoryDir, project, metaUrl, deadlineAt });
      recordHookOutcome(env, { hook: 'note-ingest', outcome: r.outcome, reason: r.reason, entity: r.entity, count: r.count, payload });
    }
  } catch (err) {
    try { process.stderr.write(`[memesh note-ingest] ${err?.message || err}\n`); } catch { /* stderr gone */ }
    recordHookOutcome(env, { hook: 'note-ingest', outcome: 'error', reason: noteErrorReason(err), payload });
  }

  try {
    const n = decideNudge({ transcriptPath: payload?.transcript_path, sessionId: payload?.session_id, memoryDir });
    return {
      message: n.message,
      settle: (delivered) => {
        // The outcome is the DELIVERY's verdict, not a prediction of it.
        // It used to be recorded here, before the line had been written:
        // piping this hook's stdout into a process that exits immediately
        // gave exit 0, empty stderr and a `wrote` record, with the user
        // having seen nothing. The offset moved too, so the window was
        // never reconsidered and the moves it described were never
        // mentioned again.
        if (n.message && !delivered) {
          recordHookOutcome(env, {
            hook: 'remember-nudge',
            outcome: 'error',
            reason: 'the host closed stdout before the nudge could be written',
            payload,
          });
          return; // Offset not advanced: the next Stop judges this window again.
        }
        // `notified`, never `wrote`: the nudge stores nothing. It is what
        // memesh says when nothing HAS been stored, so counting it towards
        // doctor's `writes` let the one hook that fires because capture is
        // quiet report that capture is alive.
        recordHookOutcome(env, { hook: 'remember-nudge', outcome: n.message ? 'notified' : 'skipped', reason: n.reason, payload });
        n.commit?.();
      },
    };
  } catch (err) {
    try { process.stderr.write(`[memesh remember-nudge] ${err?.message || err}\n`); } catch { /* stderr gone */ }
    recordHookOutcome(env, { hook: 'remember-nudge', outcome: 'error', reason: hookErrorReason(err), payload });
    return { message: null, settle: () => {} };
  }
}
