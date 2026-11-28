// Import the project memory notes on Stop.

import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from 'fs';
import { createHash } from 'crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import {
  ensurePrivateDir,
  getMemeshDirFromDbPath,
  getProjectName,
  HOOK_BUSY_TIMEOUT_MS,
  SKIP_REASONS,
  hookErrorReason,
  importFromPluginRoot,
  recordHookOutcome,
  resolvePluginRoot,
  writePrivateJson,
} from './_shared.js';

/** Files ingestion may read in one Stop. The rest wait for the next Stop. */
export const INGEST_MAX_FILES = 100;
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
 * Additional outcomes retain each fixed refusal/defer reason in the same run.
 * @returns {Promise<{outcome: string, reason: string, entity?: string, count?: number, additionalOutcomes?: Array<{outcome: string, reason: string, count: number}>}>}
 */
export async function runNoteIngestion({ memoryDir, project, metaUrl }) {
  if (!memoryDir) return { outcome: 'skipped', reason: SKIP_REASONS.noMemoryDir };
  const memeshDir = getMemeshDirFromDbPath();
  // A new name, so every folder is read once more after an upgrade: an unreleased 4.13.0 build left
  // notes it held back in the skip cache with an unchanged folder stamp, and only a read clears them.
  // The old note-ingest-state.json is no longer read.
  const statePath = join(memeshDir, 'note-ingest-state-2.json');
  const key = createHash('sha256').update(memoryDir).digest('hex').slice(0, 16);
  const state = readJson(statePath) ?? {};
  const newest = newestNoteMtime(memoryDir);
  const last = typeof state[key]?.at === 'number' ? state[key].at : 0;
  // A folder read before its notes were trusted is read once more, so the notes already stored are made trusted.
  if (newest <= last && !state[key]?.more && state[key]?.trusted === true && state[key]?.outcomeCodes === true) {
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
    result = ingestNoteDirectory({ dir: memoryDir, project, maxFiles: INGEST_MAX_FILES, trusted: true });
  } finally {
    closeDatabase();
  }
  ensurePrivateDir(memeshDir);
  // `startedAt`, not `newest`: a file edited while this run was reading is
  // newer than the stamp and is picked up next time.
  // `trusted` is recorded only when the folder's notes are trusted: a run that could not take the copy it needs first leaves it unset, so the next Stop tries again.
  if (!result.retryNeeded) {
    writeJsonAtomic(statePath, { ...state, [key]: { at: startedAt, more: result.more > 0, trusted: !result.retrustFailed, outcomeCodes: true } });
  }
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
  const changed = result.created.length + result.replaced.length + result.repathed.length
    + result.restored.length + result.markedMissing.length + result.retrusted.length > 0;
  // These are files still not imported this run, including cached refusals,
  // not a claim that the same file was newly lost on every Stop.
  const reasons = {
    tooLarge: SKIP_REASONS.noteTooLarge,
    noFrontmatter: SKIP_REASONS.noteNoFrontmatter,
    tooManyObservations: SKIP_REASONS.noteTooManyObservations,
    symlink: SKIP_REASONS.noteIsSymlink,
    other: SKIP_REASONS.noteOtherNotImported,
  };
  const skipped = Object.entries(result.skippedCounts)
    .filter(([, count]) => count > 0)
    .map(([code, count]) => ({ outcome: 'skipped', reason: reasons[code], count }));
  if (result.more > 0) skipped.push({ outcome: 'skipped', reason: SKIP_REASONS.notesLeftForNextRun, count: result.more });
  const primary = changed
    ? { outcome: 'wrote', reason: summarizeNoteIngest(result), entity: touched }
    : skipped.shift() ?? { outcome: 'skipped', reason: SKIP_REASONS.noteNothingNew };
  return { ...primary, entity: changed ? touched : undefined, additionalOutcomes: skipped };
}

const SESSION_STATE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_STATE_PRUNE_PER_RUN = 50;

/**
 * Remove per-session state files not touched for 30 days. One file per
 * session would otherwise accumulate forever. At most SESSION_STATE_PRUNE_PER_RUN
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
    if (removed >= SESSION_STATE_PRUNE_PER_RUN) break;
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    try {
      if (now - lstatSync(file).mtimeMs > SESSION_STATE_MAX_AGE_MS) {
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

export async function runStopNotes(payload, { captureEnabled, project, metaUrl, env = process.env }) {
  if (!captureEnabled) {
    recordHookOutcome(env, { hook: 'note-ingest', outcome: 'skipped', reason: SKIP_REASONS.autoCaptureOff, payload });
    return;
  }
  try {
    const memoryDir = claudeMemoryDir(payload?.transcript_path);
    if (project === undefined || project === null) {
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
      recordHookOutcome(env, { hook: 'note-ingest', outcome: 'skipped', reason: SKIP_REASONS.cwdAbsent, payload });
    } else if (memoryDir && !memoryDirBelongsTo(memoryDir, { transcriptPath: payload?.transcript_path, cwd: payload?.cwd, project })) {
      // No folder (memoryDir null) is runNoteIngestion's own recorded skip, below.
      recordHookOutcome(env, { hook: 'note-ingest', outcome: 'skipped', reason: SKIP_REASONS.memoryDirOtherProject, payload });
    } else {
      const r = await runNoteIngestion({ memoryDir, project, metaUrl });
      for (const extra of r.additionalOutcomes ?? []) recordHookOutcome(env, { hook: 'note-ingest', ...extra, payload });
      recordHookOutcome(env, { hook: 'note-ingest', outcome: r.outcome, reason: r.reason, entity: r.entity, count: r.count, payload });
    }
  } catch (err) {
    try { process.stderr.write(`[memesh note-ingest] ${err?.message || err}\n`); } catch { /* stderr gone */ }
    recordHookOutcome(env, { hook: 'note-ingest', outcome: 'error', reason: hookErrorReason(err), payload });
  }
}
