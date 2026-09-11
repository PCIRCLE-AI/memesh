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
  importFromPluginRoot,
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
// `git commit` in COMMAND position — at the start or after a shell separator,
// with any global options (-C <dir>, -c <k=v>, --flag[=v]) in between — and
// followed by a space or the end. Not `grep "git commit"`, not `git
// commit-tree`, not `echo git commit`.
const COMMIT_RE = /(?:^|[;&|(\n]\s*)git(?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?))*\s+commit(?=\s|$)/;
const TEST_RE = /\b(?:vitest|jest|pytest|go\s+test|cargo\s+test|npm\s+(?:run\s+)?test|run-tests[\w-]*)\b/;
// What Claude Code puts in a tool_result when the user turned the call down
// (e.g. rejected a plan). Usually also is_error, but not relied upon.
const DECLINED_RE = /\brejected\b|doesn't want to proceed|does not want to proceed|\bdeclined\b/i;
/** Days a per-session nudge offset file is kept after its last Stop. */
const NUDGE_STATE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Most stale offset files one Stop removes — the pruning stays bounded. */
const NUDGE_PRUNE_PER_RUN = 50;
const NOTE_PATH_RE = /(?:^|[\\/])(?:memory|\.remember)[\\/][^\\/]+\.md$/;

/**
 * Claude Code keeps a project's memory directory next to its transcripts:
 * `~/.claude/projects/<slug>/<session>.jsonl` and `~/.claude/projects/<slug>/memory/`.
 * Deriving it from `transcript_path` avoids re-implementing Claude Code's
 * slug rule. Null when there is none (Codex, or a project with no memory yet),
 * and null for a symlinked directory — ingestion never follows links.
 */
export function claudeMemoryDir(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  const dir = join(dirname(transcriptPath), 'memory');
  try {
    const st = lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() ? dir : null;
  } catch {
    return null; // ENOENT is the ordinary case: no memory directory.
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
 * Returns `{ outcome, reason, changed }`; `changed` is true when the run
 * created, replaced or marked a memory missing.
 */
export async function runNoteIngestion({ memoryDir, project, metaUrl }) {
  if (!memoryDir) return { outcome: 'skipped', reason: 'no Claude Code memory directory for this project', changed: false };
  const memeshDir = getMemeshDirFromDbPath();
  const statePath = join(memeshDir, 'note-ingest-state.json');
  const key = createHash('sha256').update(memoryDir).digest('hex').slice(0, 16);
  const state = readJson(statePath) ?? {};
  const newest = newestNoteMtime(memoryDir);
  const last = typeof state[key]?.at === 'number' ? state[key].at : 0;
  if (newest <= last && !state[key]?.more) {
    return { outcome: 'skipped', reason: 'no note file changed since the last ingestion', changed: false };
  }

  const pluginRoot = resolvePluginRoot(metaUrl);
  const ingestPath = join(pluginRoot, 'dist/core/note-ingest.js');
  if (!existsSync(ingestPath)) {
    return { outcome: 'skipped', reason: 'dist/core/note-ingest.js is not built; run npm run build', changed: false };
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
  const changed = result.created.length + result.replaced.length + result.markedMissing.length > 0;
  return { outcome: changed ? 'wrote' : 'skipped', reason: summarizeNoteIngest(result), changed };
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
 */
export function scanTranscriptWindow(text) {
  const pending = new Map(); // tool_use_id → kind
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
          else if (COMMIT_RE.test(cmd)) pending.set(block.id, 'commit');
          else if (TEST_RE.test(cmd)) pending.set(block.id, 'test');
        }
      } else if (entry.type === 'user' && block?.type === 'tool_result') {
        const kind = pending.get(block.tool_use_id);
        if (!kind) continue;
        pending.delete(block.tool_use_id);
        const resultText = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
        const failed = block.is_error === true || DECLINED_RE.test(resultText);
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
  return { toolCalls, moves, wroteMemory, firstTimestamp };
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
 * Decide the nudge for this Stop. Always advances the per-session offset, so
 * each Stop judges only what happened since the previous one.
 * Returns `{ message, reason }`; `message` is null when silent.
 */
export function decideNudge({ transcriptPath, sessionId, memoryDir }) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return { message: null, reason: 'no usable session_id in the payload' };
  if (typeof transcriptPath !== 'string' || !transcriptPath || !existsSync(transcriptPath)) {
    return { message: null, reason: 'no transcript to read' };
  }
  const dir = join(getMemeshDirFromDbPath(), 'remember-nudge');
  ensurePrivateDir(dir);
  pruneNudgeState(dir, Date.now());
  const statePath = join(dir, `${sessionId}.json`);
  const state = readJson(statePath) ?? {};
  const { text, nextOffset } = readTranscriptWindow(transcriptPath, state.offset);
  const now = Date.now();
  writeJsonAtomic(statePath, { offset: nextOffset, lastStopAt: now });

  const scan = scanTranscriptWindow(text);
  if (scan.toolCalls < NUDGE_MIN_TOOL_CALLS) return { message: null, reason: `trivial turn (${scan.toolCalls} tool calls since the last Stop)` };
  if (scan.moves.length === 0) return { message: null, reason: 'no decision-shaped move since the last Stop' };
  if (scan.wroteMemory) return { message: null, reason: 'a memory was written since the last Stop' };
  const since = typeof state.lastStopAt === 'number' ? state.lastStopAt : scan.firstTimestamp;
  if (memoryDir && typeof since === 'number' && newestNoteMtime(memoryDir) >= since) {
    return { message: null, reason: 'a note file changed since the last Stop' };
  }
  return { message: buildNudge(scan.moves), reason: scan.moves.join('; ') };
}

/**
 * Both halves. Ingestion runs first so a note written this turn is already
 * searchable when the turn ends; the nudge judges "was a note written" by the
 * note files' mtimes rather than by what ingestion wrote, because the first
 * ingestion after install imports every OLD note and would otherwise silence
 * a nudge the session earned. Returns the one advisory line to print, or null.
 */
export async function runStopNotes(payload, { captureEnabled, project, metaUrl, env = process.env }) {
  const memoryDir = claudeMemoryDir(payload?.transcript_path);
  try {
    if (!captureEnabled) {
      recordHookOutcome(env, { hook: 'note-ingest', outcome: 'skipped', reason: 'auto-capture is turned off', payload });
    } else {
      const r = await runNoteIngestion({ memoryDir, project, metaUrl });
      recordHookOutcome(env, { hook: 'note-ingest', outcome: r.outcome, reason: r.reason, payload });
    }
  } catch (err) {
    try { process.stderr.write(`[memesh note-ingest] ${err?.message || err}\n`); } catch { /* stderr gone */ }
    recordHookOutcome(env, { hook: 'note-ingest', outcome: 'error', reason: String(err?.message || err), payload });
  }

  try {
    const n = decideNudge({ transcriptPath: payload?.transcript_path, sessionId: payload?.session_id, memoryDir });
    recordHookOutcome(env, { hook: 'remember-nudge', outcome: n.message ? 'wrote' : 'skipped', reason: n.reason, payload });
    return n.message;
  } catch (err) {
    try { process.stderr.write(`[memesh remember-nudge] ${err?.message || err}\n`); } catch { /* stderr gone */ }
    recordHookOutcome(env, { hook: 'remember-nudge', outcome: 'error', reason: String(err?.message || err), payload });
    return null;
  }
}
