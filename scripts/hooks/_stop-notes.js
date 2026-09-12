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
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import {
  ensurePrivateDir,
  getMemeshDirFromDbPath,
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
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;
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
export async function runNoteIngestion({ memoryDir, project, metaUrl }) {
  if (!memoryDir) return { outcome: 'skipped', reason: SKIP_REASONS.noMemoryDir };
  const memeshDir = getMemeshDirFromDbPath();
  const statePath = join(memeshDir, 'note-ingest-state.json');
  const key = createHash('sha256').update(memoryDir).digest('hex').slice(0, 16);
  const state = readJson(statePath) ?? {};
  const newest = newestNoteMtime(memoryDir);
  const last = typeof state[key]?.at === 'number' ? state[key].at : 0;
  if (newest <= last && !state[key]?.more) {
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
  openDatabase();
  let result;
  try {
    result = ingestNoteDirectory({ dir: memoryDir, project, maxFiles: INGEST_MAX_FILES });
  } finally {
    closeDatabase();
  }
  ensurePrivateDir(memeshDir);
  // `startedAt`, not `newest`: a file edited while this run was reading is
  // newer than the stamp and is picked up next time.
  writeJsonAtomic(statePath, { ...state, [key]: { at: startedAt, more: result.more > 0 } });
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
    ?? result.restored[0] ?? result.markedMissing[0];
  const changed = result.created.length + result.replaced.length + result.repathed.length
    + result.restored.length + result.markedMissing.length > 0;
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
      : (result.refusedNow > 0 ? SKIP_REASONS.noteFilesRefused : SKIP_REASONS.noteNothingNew),
    entity: changed ? touched : undefined,
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
 * since the last Stop" — a miss that looks exactly like a quiet turn. A scan
 * of 1090 real transcripts found all four ExitPlanMode pairs adjacent, so it
 * is uncommon; it is also silent, and the reason it gives is plausible.
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
 * Remove offset files of sessions that have not stopped for 30 days. One
 * file per session would otherwise accumulate forever. At most
 * NUDGE_PRUNE_PER_RUN removals per Stop, so a long backlog is worked off
 * over several Stops rather than in one.
 */
export function pruneNudgeState(dir, now) {
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (removed >= NUDGE_PRUNE_PER_RUN) break;
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    try {
      if (now - lstatSync(file).mtimeMs > NUDGE_STATE_MAX_AGE_MS) {
        unlinkSync(file);
        removed++;
      }
    } catch (err) {
      // Another Stop removed it first, or it is unreadable: either way this
      // run leaves it; the next one retries.
      try { process.stderr.write(`[memesh remember-nudge] could not prune ${file}: ${err?.message || err}\n`); } catch { /* stderr gone */ }
    }
  }
  return removed;
}

export function buildNudge(moves) {
  const kinds = [...new Set(moves)].join(', ');
  return `MeMesh: this session made ${moves.length} decision-shaped move(s) (${kinds}) and stored no memory — \`remember\` what should outlive it.`;
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
  pruneNudgeState(dir, Date.now());
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
export async function runStopNotes(payload, { captureEnabled, project, metaUrl, env = process.env }) {
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
    } else {
      const r = await runNoteIngestion({ memoryDir, project, metaUrl });
      recordHookOutcome(env, { hook: 'note-ingest', outcome: r.outcome, reason: r.reason, entity: r.entity, payload });
    }
  } catch (err) {
    try { process.stderr.write(`[memesh note-ingest] ${err?.message || err}\n`); } catch { /* stderr gone */ }
    recordHookOutcome(env, { hook: 'note-ingest', outcome: 'error', reason: hookErrorReason(err), payload });
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
