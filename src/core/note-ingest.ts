// =============================================================================
// note-ingest — make a directory of note files searchable memories (#324 C)
// =============================================================================
//
// The cheapest memory is the one the agent already wrote. Claude Code keeps a
// per-project memory directory (`~/.claude/projects/<slug>/memory/*.md`) whose
// files carry exactly the shape memesh wants: YAML frontmatter with `name`,
// `description` and `metadata.type`, then a body. This module upserts one
// entity per such file, so a note written there becomes recallable, cross-tool
// and eligible for the briefing without a second write.
//
// Contract, in order of importance:
//   1. READ-ONLY on the directory. memesh never writes, moves or deletes a note
//      file, and never deletes a memory because its file went away — a file
//      that disappears gets the `source:note-file:missing` tag on the next run
//      and deleting it stays an explicit `forget`.
//   2. BOUNDED. Symlinks are refused (a link can point anywhere, including out
//      of the directory), every file's realpath must stay inside the
//      directory's realpath, `.git` and `node_modules` are never entered, a
//      file over NOTE_FILE_MAX_BYTES is reported and skipped, and one run
//      processes at most NOTE_DIR_MAX_FILES files, reporting how many more
//      there were.
//   3. NO GUESSING. A file without frontmatter, or without a `name` in it, is
//      reported and skipped. The name is the idempotency key; inventing one
//      from the filename would turn a rename into a duplicate.
//   4. PROVENANCE WITHOUT THE HOME PATH. Each entity records the file's path
//      RELATIVE to the directory and a hash of its bytes, never the absolute
//      path — exports and a shared dashboard must not carry `/Users/<name>`.
//      The directory itself is identified by a digest of its realpath.
//
// A changed file REPLACES its entity (remember's `replace: true`, which keeps
// the previous version in `metadata.replaced_history`); an unchanged file is a
// no-op, decided by the content hash.

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { getDatabase } from '../db.js';
import { getMemeshDirFromDbPath } from './paths.js';
import { remember } from './operations.js';
import { sanitizeNoteText, splitObservations, NOTE_DEFAULT_TYPE, NOTE_MAX_OBSERVATIONS } from './note-derive.js';
import { truncateTitle } from './title.js';
import { decidePrivacy, PRIVATE_WINDOW_MS, sessionFileName, sessionLastWriteMs, uncheckedKind, type UncheckedReason } from './private-session.js';
import { PRIVATE_STATE_BUSY, withPrivateStateLock } from './private-state-lock.js';

export const NOTE_FILE_TAG = 'source:note-file';
export const NOTE_FILE_MISSING_TAG = 'source:note-file:missing';
export const NOTE_FILE_MAX_BYTES = 256 * 1024;
export const NOTE_DIR_MAX_FILES = 500;
const SKIPPED_DIRS = new Set(['.git', 'node_modules']);

export interface NoteIngestOptions {
  dir: string;
  /** Adds a `project:<name>` tag to every ingested memory when given. */
  project?: string;
  maxFiles?: number;
  /**
   * Per-file size cap, default NOTE_FILE_MAX_BYTES.
   *
   * No production caller overrides it — the CLI and the Stop hook pass only
   * `maxFiles`. It is kept as the SEAM for the size-refusal branch: without
   * it, pinning that branch needs a 256 KB fixture written to disk on every
   * run of the suite. tests/core/note-ingest.test.ts is the caller.
   */
  maxBytes?: number;
  /** The current time (tests); default `Date.now()`. */
  now?: number;
  /** When the private-session work of this run must stop (absolute ms); default five seconds from now. */
  deadlineAt?: number;
}

export interface NoteIngestResult {
  /** Digest of the directory's realpath — the provenance key, not the path. */
  dirId: string;
  /** Note files found (regular `.md` files, symlinks excluded). */
  discovered: number;
  created: string[];
  replaced: string[];
  unchanged: number;
  /** Memories whose file moved with its bytes intact: path updated, no new version. */
  repathed: string[];
  /** Memories that were tagged missing and whose file came back. */
  restored: string[];
  /** Memories newly tagged `source:note-file:missing` this run. */
  markedMissing: string[];
  /** Files looked at and not ingested, with the reason, by relative path. */
  skipped: Array<{ path: string; reason: string }>;
  /** Note files changed while a private (or unchecked) session may still record holds for them: left for a later run (not imported, not refused). */
  pendingPrivate: number;
  /** Notes held out this run: by a private session (`private`) or while a session could not be checked (`unchecked`). */
  held: { private: number; unchecked: number };
  /** Sessions held only tentatively for this folder that were not decided again this run (time or count): the caller runs again. */
  redecideLeft: number;
  /**
   * How many of `skipped` are NEW — refused for a reason this file did not
   * already carry on an earlier run.
   *
   * `skipped.length` cannot answer "did this run have anything to report":
   * it sticks forever once a file is bad, so a caller using it either
   * reports the same rejection on every Stop or, using the write counts
   * alone, reports "nothing new needed storing" over a run that rejected
   * files. Neither is what happened; this is the figure that is.
   */
  refusedNow: number;
  /** Files beyond the per-run cap, not processed this run. */
  more: number;
}

export interface Frontmatter {
  data: Record<string, string | Record<string, string>>;
  body: string;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try { return JSON.parse(v) as string; } catch { return v.slice(1, -1); }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/**
 * The frontmatter subset note files use: top-level `key: value` pairs and one
 * level of nested `key:` maps (`metadata:\n  type: feedback`). Anything more
 * elaborate (lists, block scalars) is ignored rather than half-parsed. Returns
 * null when the file does not open with a `---` fence that is closed.
 */
export function parseFrontmatter(text: string): Frontmatter | null {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && (l.trim() === '---' || l.trim() === '...'));
  if (end < 0) return null;
  const data: Frontmatter['data'] = {};
  let nested: Record<string, string> | null = null;
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indented = /^\s/.test(line);
    const m = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rawValue] = m;
    if (indented) {
      if (nested) nested[key] = unquote(rawValue);
      continue;
    }
    if (rawValue.trim() === '') {
      nested = {};
      data[key] = nested;
    } else {
      nested = null;
      data[key] = unquote(rawValue);
    }
  }
  return { data, body: lines.slice(end + 1).join('\n') };
}

function stringField(data: Frontmatter['data'], key: string): string | undefined {
  const v = data[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Walk the directory, collecting regular `.md` files and refused symlinks. */
function discover(realDir: string): { files: string[]; symlinks: string[] } {
  const files: string[] = [];
  const symlinks: string[] = [];
  const walk = (abs: string) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, entry.name);
      if (entry.isSymbolicLink()) {
        if (entry.name.toLowerCase().endsWith('.md')) symlinks.push(child);
        continue;
      }
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(child);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(child);
    }
  };
  walk(realDir);
  files.sort();
  symlinks.sort();
  return { files, symlinks };
}

const relPath = (realDir: string, abs: string) => path.relative(realDir, abs).split(path.sep).join('/');

interface ExistingRow { id: number; metadata: string | null; status: string; is_note: number; is_missing: number }

function parseProvenance(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const meta = JSON.parse(raw) as { provenance?: unknown };
    return meta?.provenance && typeof meta.provenance === 'object' ? meta.provenance as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** A file read (or recognised unchanged) this run, claiming a name. */
interface Claim {
  rel: string;
  name: string;
  stat: fs.Stats;
  /** Recognised from its stat fingerprint; not read, nothing to write. */
  unchanged: boolean;
  contentHash?: string;
  type?: string;
  title?: string;
  observations?: string[];
}

/**
 * What a skipped file looked like when it was skipped. `name` is the name it
 * claimed (a losing claimant), so a later run can tell what the recorded file
 * of some other memory now declares without re-reading it.
 */
type SkipPrint = {
  mtime: number;
  size: number;
  reason: string;
  name?: string;
  owner?: { rel: string; mtime: number; size: number };
  /**
   * Recorded so the refusal is not announced as NEW every run, but NOT used
   * to skip the read in phase 1.
   *
   * The three name-level refusals depend on the state of some OTHER memory —
   * it is not a note, it came from another directory, it was forgotten — and
   * none of those is a function of this file's bytes. Letting the
   * fingerprint skip the read would leave the file refused after its cause
   * was gone, which is the trap `unreachableSkip` documents. So the file is
   * re-read every run and simply stops being news.
   */
  reportOnly?: boolean;
  /**
   * The content hash of a note held out by a private session (or one that could
   * not be checked) when it was read. The file is not read again while its stat
   * is unchanged and that content is still held, so held notes never use the
   * per-run cap; once the content is released it is read like any other file.
   */
  held?: string;
};

// ---------------------------------------------------------------------------
// Private sessions: markers, holds, and the waits they impose on the importer.
// The answer to "is this session private?" is `decidePrivacy` alone; what is
// kept here is what follows from it. Every write goes through
// `withPrivateStateLock` (read again, apply this run's change, write); reads
// take no lock, since every file is replaced whole by a rename.
// ---------------------------------------------------------------------------

const MARKERS_DIR = 'private-sessions';
const HOLDS_DIR = 'note-ingest-holds';
const markersDir = (): string => path.join(getMemeshDirFromDbPath(), MARKERS_DIR);
const holdsDir = (): string => path.join(getMemeshDirFromDbPath(), HOLDS_DIR);
const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const dirIdOf = (realDir: string): string => sha256(realDir).slice(0, 16);
const codeOf = (err: unknown): string => (err as NodeJS.ErrnoException)?.code ?? 'error';
/** How long a lock may be waited for when the caller gives no deadline (the CLI, tests). */
const DEFAULT_LOCK_WAIT_MS = 5_000;
/** A marker of an ended session whose transcript cannot be told apart from gone is kept this long. */
const MARKER_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** Tentative sessions judged again per import, at most. */
const REDECIDE_PER_RUN = 10;
/** Project folders looked at under one projects root, at most. */
const MAX_PROJECT_FOLDERS = 200;

/** A private-session marker cannot be read or is not one: notes are not imported until it is rebuilt or, for a session that has ended, deleted. */
export const NOTE_MARKERS_UNREADABLE = 'MEMESH_NOTE_MARKERS_UNREADABLE';
/** The private-sessions folder cannot be listed: notes are not imported until it can be. */
export const NOTE_MARKERS_DIR_UNREADABLE = 'MEMESH_NOTE_MARKERS_DIR_UNREADABLE';
/** A marker could not be written. */
export const NOTE_MARKER_UNWRITABLE = 'MEMESH_NOTE_MARKER_UNWRITABLE';
/** A hold record cannot be read or is not one: notes are not imported until it is repaired. */
export const NOTE_HOLDS_UNREADABLE = 'MEMESH_NOTE_HOLDS_UNREADABLE';
/** The note-ingest-holds folder cannot be listed. */
export const NOTE_HOLDS_DIR_UNREADABLE = 'MEMESH_NOTE_HOLDS_DIR_UNREADABLE';
/** A hold record could not be written. */
export const NOTE_HOLDS_UNWRITABLE = 'MEMESH_NOTE_HOLDS_UNWRITABLE';
export { PRIVATE_STATE_BUSY };

const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code });

/** The reason shown for a note held out because its session was private. */
export const NOTE_PRIVATE_HOLD_REASON = 'held out by a private session — not imported';
/** The reason shown for a note held while its session could not be checked. */
export const NOTE_UNCHECKED_HOLD_REASON = 'held while a session could not be checked — not imported yet';

/** A real path for a folder that may not exist yet (Claude Code makes `memory/` when it writes its first note). */
function realPathOrExpected(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch (err) {
    if (codeOf(err) !== 'ENOENT') throw err;
    return path.join(fs.realpathSync(path.dirname(dir)), path.basename(dir));
  }
}

/** The folder that holds every project folder of a Claude Code notes folder (`<root>/<project>/memory`). */
export const projectsRootOf = (memoryDir: string): string => path.dirname(path.dirname(memoryDir));

/**
 * Every Claude Code notes folder under a projects root, as real paths: what a
 * private session can reach besides its own. Folders that cannot be told are
 * skipped; at most `MAX_PROJECT_FOLDERS` (`complete` is false past that).
 */
export function projectMemoryFolders(projectsRoot: string): { folders: string[]; complete: boolean } {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(projectsRoot, { withFileTypes: true }); } catch { return { folders: [], complete: false }; }
  const folders: string[] = [];
  let complete = true;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (folders.length >= MAX_PROJECT_FOLDERS) { complete = false; break; }
    const dir = path.join(projectsRoot, entry.name, 'memory');
    try {
      const st = fs.lstatSync(dir);
      if (st.isDirectory() && !st.isSymbolicLink()) folders.push(fs.realpathSync(dir));
    } catch { /* no notes folder in this project */ }
  }
  return { folders, complete };
}

/** The newest of a file's two times: a `mv` or `cp -p` keeps the old modification time but not the change time. */
const touchedAt = (st: fs.Stats): number => Math.max(st.mtimeMs, st.ctimeMs);

// --- markers ----------------------------------------------------------------

interface Marker {
  session: string; dirs: string[]; projectsRoot: string; transcript?: string;
  startedAt: number; updatedAt: number; holdsAt: number; endedAt?: number; finalizedAt?: number;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseMarker(text: string): Marker {
  const m = JSON.parse(text) as Record<string, unknown>;
  if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.session !== 'string' || !isNum(m.startedAt) || !isNum(m.updatedAt)
    || !isNum(m.holdsAt) || typeof m.projectsRoot !== 'string' || !Array.isArray(m.dirs) || !m.dirs.every((d) => typeof d === 'string')
    || (m.transcript !== undefined && typeof m.transcript !== 'string')
    || (m.endedAt !== undefined && !isNum(m.endedAt)) || (m.finalizedAt !== undefined && !isNum(m.finalizedAt))) {
    throw new Error('not a marker');
  }
  return m as unknown as Marker;
}

const markerFile = (sessionId: string): string => path.join(markersDir(), sessionFileName(sessionId));
const markerUnreadable = (name: string, err: unknown): Error =>
  fail(NOTE_MARKERS_UNREADABLE, `${MARKERS_DIR}/${name} cannot be read (${(err as Error).message}); notes are not imported until it is rebuilt by its session or, for a session that has ended, deleted`);

/** The marker of a session, undefined when it has none; throws `NOTE_MARKERS_UNREADABLE` when it is there but cannot be read. */
function readMarker(file: string): Marker | undefined {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (codeOf(err) === 'ENOENT') return undefined;
    throw markerUnreadable(path.basename(file), err);
  }
  try { return parseMarker(text); } catch (err) { throw markerUnreadable(path.basename(file), err); }
}

function writeMarker(file: string, marker: Marker): void {
  try {
    fs.mkdirSync(markersDir(), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ v: 2, ...marker }), { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (err) {
    throw fail(NOTE_MARKER_UNWRITABLE, `${MARKERS_DIR}/${path.basename(file)} could not be written (${codeOf(err)})`);
  }
}

const lockDeadline = (deadlineAt?: number): number => deadlineAt ?? Date.now() + DEFAULT_LOCK_WAIT_MS;

/**
 * The agent called `private_session` (the PostToolUse hook), or a later hook of
 * the session found it private: written at once and kept while the session
 * runs, so no other session's import takes a note this one has just written.
 * It holds the session id, the notes folders the session reached (real paths,
 * or the path the session's own folder will have), the projects root those
 * folders sit in, the transcript path and times; no conversation text.
 * `startedAt` stays the first time; `updatedAt` moves on every call;
 * `holdsAt`, when given, is the moment the session's holds were last recorded
 * from a complete read of its transcripts. Returns `startedAt`.
 *
 * Only for a real call: a session that could not be checked never gets one.
 * A marker of this session that cannot be read throws `NOTE_MARKERS_UNREADABLE`
 * unless `rebuildFrom` is given: it is then written again with `startedAt` no
 * later than `rebuildFrom` (the caller holds the notes changed since then).
 * `projectsRoot` names the projects root for a session with no notes folder of
 * its own (Codex writes into Claude Code's): every folder under it waits.
 */
export function markPrivateSession(opts: { sessionId: string; dirs?: readonly string[]; projectsRoot?: string; transcript?: string; now?: number; holdsAt?: number; rebuildFrom?: number; deadlineAt?: number }): number {
  const now = opts.now ?? Date.now();
  const file = markerFile(opts.sessionId);
  const dirs = (opts.dirs ?? []).map(realPathOrExpected);
  return withPrivateStateLock(getMemeshDirFromDbPath(), lockDeadline(opts.deadlineAt), () => {
    let prior: Marker | undefined;
    try { prior = readMarker(file); } catch (err) {
      if (opts.rebuildFrom === undefined) throw err;
      prior = undefined;
    }
    const startedAt = Math.min(prior?.startedAt ?? now, opts.rebuildFrom ?? now);
    const transcript = opts.transcript ?? prior?.transcript;
    const projectsRoot = prior?.projectsRoot || opts.projectsRoot || (dirs[0] ? projectsRootOf(dirs[0]) : '');
    const marker: Marker = {
      session: opts.sessionId,
      dirs: [...new Set([...(prior?.dirs ?? []), ...dirs])],
      projectsRoot,
      ...(transcript === undefined ? {} : { transcript }),
      startedAt,
      updatedAt: Math.max(now, prior?.updatedAt ?? 0),
      holdsAt: opts.holdsAt ?? prior?.holdsAt ?? startedAt,
    };
    writeMarker(file, marker);
    return startedAt;
  });
}

/** The private session is heard from again (its user wrote a prompt): the marker is live, not idle or ended. A session with no marker has nothing to renew. */
export function renewPrivateSession(sessionId: string, now = Date.now(), deadlineAt?: number): boolean {
  return updateMarker(sessionId, deadlineAt, ({ endedAt: _e, finalizedAt: _f, ...live }) => ({ ...live, updatedAt: Math.max(now, live.updatedAt) }));
}

/** Under the lock: the session's marker read again and replaced by `change(marker)`. False when it has none. */
function updateMarker(sessionId: string, deadlineAt: number | undefined, change: (marker: Marker) => Marker): boolean {
  const file = markerFile(sessionId);
  return withPrivateStateLock(getMemeshDirFromDbPath(), lockDeadline(deadlineAt), () => {
    const marker = readMarker(file);
    if (!marker) return false;
    writeMarker(file, change(marker));
    return true;
  });
}

/**
 * The session has ended and its holds are recorded: other imports stop waiting
 * for it. The marker stays, as the record that the call was made (a later
 * reader of the transcript asks it first), until `prunePrivateMarkers` finds
 * its transcript gone.
 */
export function endPrivateSession(sessionId: string, now = Date.now(), deadlineAt?: number): void {
  updateMarker(sessionId, deadlineAt, (marker) => ({ ...marker, endedAt: now }));
}

/** Removes the markers of ended sessions whose transcript is gone (or unknown and a month old), at most `max` per run, and the temporary files a crashed writer left in either folder. Returns how many markers. */
export function prunePrivateMarkers(now = Date.now(), max = 50, deadlineAt?: number): number {
  let names: string[];
  try { names = fs.readdirSync(markersDir()); } catch (err) {
    if (codeOf(err) === 'ENOENT') return 0;
    throw fail(NOTE_MARKERS_DIR_UNREADABLE, `${MARKERS_DIR} cannot be read (${codeOf(err)})`);
  }
  let removed = 0;
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    if (removed >= max) break;
    const file = path.join(markersDir(), name);
    let marker: Marker | undefined;
    try { marker = readMarker(file); } catch { continue; } // a damaged marker is the importer's error to report
    if (!marker || (marker.endedAt === undefined && marker.finalizedAt === undefined)) continue;
    let gone: boolean;
    if (typeof marker.transcript === 'string' && marker.transcript !== '') {
      try { fs.statSync(marker.transcript); gone = false; } catch (err) { gone = codeOf(err) === 'ENOENT'; }
    } else {
      gone = now - marker.updatedAt > MARKER_KEEP_MS;
    }
    if (!gone) continue;
    withPrivateStateLock(getMemeshDirFromDbPath(), lockDeadline(deadlineAt), () => {
      const again = readMarker(file);
      if (again && (again.endedAt !== undefined || again.finalizedAt !== undefined)) fs.rmSync(file, { force: true });
    });
    removed++;
  }
  removeStaleTemps(markersDir(), names, now);
  try { removeStaleTemps(holdsDir(), fs.readdirSync(holdsDir()), now); } catch { /* no holds folder: nothing left behind */ }
  return removed;
}

/** A temporary file a writer left behind when it died between writing and renaming (older than a minute: no live writer holds one that long). */
function removeStaleTemps(dir: string, names: readonly string[], now: number): void {
  for (const name of names.filter((n) => n.endsWith('.tmp'))) {
    try { const p = path.join(dir, name); if (now - fs.statSync(p).mtimeMs > 60_000) fs.rmSync(p, { force: true }); } catch { /* gone */ }
  }
}

// --- holds ------------------------------------------------------------------

/**
 * dirId → relative path → content hash, or `?<ms>` for a note that could not be
 * read when it was held (and the time it was held). A held note is identified
 * by its content: the path is only where a `?` waits to be read.
 */
type DirHolds = Record<string, Record<string, string>>;

/** A session that could not be checked: what was kept out meanwhile, why, and the wait it imposes. */
interface TentativeHold {
  reason: string; since: number; updatedAt: number; holdsAt: number; endedAt?: number; projectsRoot: string; dirs: DirHolds;
}

interface HoldFile { rev: number; session: string; transcript?: string; firm: DirHolds; tentative?: TentativeHold }

const isUnreadableMark = (hash: string): boolean => hash.startsWith('?');
const unreadableSince = (hash: string): number => { const n = Number(hash.slice(1)); return Number.isFinite(n) ? n : 0; };

const isDirHolds = (value: unknown): value is DirHolds => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as object).every((files) => !!files && typeof files === 'object' && !Array.isArray(files)
    && Object.values(files as object).every((hash) => typeof hash === 'string'));
};

function parseHoldFile(text: string): HoldFile {
  const p = JSON.parse(text) as Record<string, unknown>;
  if (!p || typeof p !== 'object' || Array.isArray(p) || !isDirHolds(p.firm) || typeof p.session !== 'string' || !isNum(p.rev)
    || (p.transcript !== undefined && typeof p.transcript !== 'string')) throw new Error('not a hold record');
  const t = p.tentative as Record<string, unknown> | undefined;
  if (t === undefined) return { rev: p.rev, session: p.session, ...(p.transcript === undefined ? {} : { transcript: p.transcript as string }), firm: p.firm };
  if (!t || typeof t !== 'object' || typeof t.reason !== 'string' || !isNum(t.since) || !isNum(t.updatedAt) || !isNum(t.holdsAt)
    || typeof t.projectsRoot !== 'string' || !isDirHolds(t.dirs) || (t.endedAt !== undefined && !isNum(t.endedAt))) throw new Error('not a hold record');
  return {
    rev: p.rev, session: p.session, ...(p.transcript === undefined ? {} : { transcript: p.transcript as string }), firm: p.firm,
    tentative: { reason: t.reason, since: t.since, updatedAt: t.updatedAt, holdsAt: t.holdsAt, projectsRoot: t.projectsRoot, dirs: t.dirs, ...(t.endedAt === undefined ? {} : { endedAt: t.endedAt as number }) },
  };
}

const holdsUnreadable = (what: string, err: unknown): Error =>
  fail(NOTE_HOLDS_UNREADABLE, `${HOLDS_DIR}${what} cannot be read (${(err as Error).message}); notes are not imported until it is repaired; deleting it releases the notes it holds`);

const holdFile = (sessionId: string): string => path.join(holdsDir(), sessionFileName(sessionId));

function readHoldFile(file: string): HoldFile | undefined {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (codeOf(err) === 'ENOENT') return undefined;
    throw holdsUnreadable(`/${path.basename(file)}`, err);
  }
  try { return parseHoldFile(text); } catch (err) { throw holdsUnreadable(`/${path.basename(file)}`, err); }
}

const holdCount = (dirs: DirHolds): number => Object.values(dirs).reduce((sum, files) => sum + Object.keys(files).length, 0);

/** Writes a session's record; one that holds nothing is removed. Never overwrites a damaged record (the read before it throws). */
function writeHoldFile(file: string, rec: HoldFile): void {
  try {
    if (holdCount(rec.firm) === 0 && rec.tentative === undefined) { fs.rmSync(file, { force: true }); return; }
    fs.mkdirSync(holdsDir(), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ v: 2, ...rec, rev: rec.rev + 1 }), { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (err) {
    throw fail(NOTE_HOLDS_UNWRITABLE, `${HOLDS_DIR}/${path.basename(file)} could not be written (${codeOf(err)}); nothing was released`);
  }
}

const mergeDirHolds = (into: DirHolds, from: DirHolds): void => {
  for (const [dirId, files] of Object.entries(from)) into[dirId] = { ...(into[dirId] ?? {}), ...files };
};

/** The hash of every candidate note, read before the lock is taken: `?<now>` for one that cannot be read. */
function hashNotes(realDir: string, candidates: Iterable<string>, now: number): Record<string, string> {
  const forDir: Record<string, string> = {};
  for (const real of candidates) {
    let st: fs.Stats;
    try { st = fs.lstatSync(real); } catch { continue; }
    if (!st.isFile() || !real.toLowerCase().endsWith('.md') || !real.startsWith(realDir + path.sep)) continue;
    // A note over the size limit is refused by the importer anyway: there is nothing to hold, and it is not read.
    if (st.size > NOTE_FILE_MAX_BYTES) continue;
    const rel = relPath(realDir, real);
    try { forDir[rel] = sha256(fs.readFileSync(real)); } catch { forDir[rel] = `?${now}`; }
  }
  return forDir;
}

/** The notes of a folder changed in `[sinceMs, untilMs]` (both optional ends). */
function notesTouchedBetween(realDir: string, sinceMs: number, untilMs = Number.POSITIVE_INFINITY): string[] {
  let files: string[];
  try { files = discover(realDir).files; } catch { return []; }
  return files.filter((abs) => { try { const t = touchedAt(fs.lstatSync(abs)); return t >= sinceMs && t <= untilMs; } catch { return false; } });
}

/**
 * A private session imports no note. The note files it wrote or named, in this
 * folder, are recorded by CONTENT HASH in a small file of its own beside the
 * database: no later import reads that content, whatever path it has, so a
 * `touch`, a rename, a `mv` or a copy does not release it. Content that is
 * different (rewritten later) imports as usual; an already imported note with
 * the same content is unaffected.
 *
 * `paths` are files its tool calls name. `sinceMs` adds every note in the
 * folder changed (modified or moved in) since then, up to `untilMs` when given.
 * A note that cannot be read is recorded as unreadable, with the time: the
 * folder then waits on everything changed since, until that note can be read
 * (see `readPrivateState`). With `tentative`, the holds are the provisional
 * kind kept while the session cannot be checked. Throws when the record is
 * damaged (it is never overwritten), cannot be written, or the lock cannot be
 * had in time; the caller reports it. Returns how many notes are held.
 */
export function holdOutNoteFiles(opts: {
  dir: string; sessionId: string; paths: readonly string[]; sinceMs?: number; untilMs?: number; transcript?: string;
  tentative?: { reason: string; projectsRoot?: string; holdsAt?: number }; now?: number; deadlineAt?: number;
}): number {
  const now = opts.now ?? Date.now();
  const realDir = fs.realpathSync(opts.dir);
  const dirId = dirIdOf(realDir);
  const candidates = new Set<string>();
  for (const candidate of opts.paths) {
    try { candidates.add(fs.realpathSync(candidate)); } catch { /* a path that no longer exists holds nothing */ }
  }
  if (opts.sinceMs !== undefined) for (const abs of notesTouchedBetween(realDir, opts.sinceMs, opts.untilMs)) candidates.add(abs);
  const forDir = hashNotes(realDir, candidates, now);
  updateHold(holdFile(opts.sessionId), opts.deadlineAt, (found) => {
    const rec: HoldFile = found ?? { rev: 0, session: opts.sessionId, firm: {} };
    if (opts.transcript !== undefined) rec.transcript = opts.transcript;
    if (opts.tentative) {
      const prior = rec.tentative;
      const dirs = prior?.dirs ?? {};
      mergeDirHolds(dirs, { [dirId]: forDir });
      rec.tentative = {
        reason: opts.tentative.reason, since: prior?.since ?? now, updatedAt: now,
        holdsAt: opts.tentative.holdsAt ?? prior?.holdsAt ?? now,
        projectsRoot: opts.tentative.projectsRoot ?? prior?.projectsRoot ?? projectsRootOf(realDir), dirs,
      };
    } else {
      mergeDirHolds(rec.firm, { [dirId]: forDir });
    }
    return rec;
  });
  return Object.keys(forDir).length;
}

/** Under the lock: a hold record read again and, unless `change` returns undefined, replaced by what it returns. Returns whether it was written. */
function updateHold(file: string, deadlineAt: number | undefined, change: (rec: HoldFile | undefined) => HoldFile | undefined): boolean {
  return withPrivateStateLock(getMemeshDirFromDbPath(), lockDeadline(deadlineAt), () => {
    const next = change(readHoldFile(file));
    if (next === undefined) return false;
    writeHoldFile(file, next);
    return true;
  });
}

/**
 * The session has been decided again: `no` releases what was held only while
 * it could not be checked, `yes` makes it permanent. With `expectRev`, nothing
 * changes when the record was written since it was read (that writer knew
 * more). The session's own hook passes no `expectRev`. Returns whether the
 * record changed.
 */
export function settleTentativeHolds(sessionId: string, verdict: 'yes' | 'no', opts: { expectRev?: number; deadlineAt?: number } = {}): boolean {
  return updateHold(holdFile(sessionId), opts.deadlineAt, (rec) => {
    if (!rec?.tentative) return undefined;
    if (opts.expectRev !== undefined && rec.rev !== opts.expectRev) return undefined;
    if (verdict === 'yes') mergeDirHolds(rec.firm, rec.tentative.dirs);
    delete rec.tentative;
    return rec;
  });
}

/** A session that could not be checked has ended: it imposes no wait any more (its holds stay until it is decided). */
export function endTentativeWait(sessionId: string, now = Date.now(), deadlineAt?: number): void {
  updateHold(holdFile(sessionId), deadlineAt, (rec) => {
    if (!rec?.tentative) return undefined;
    rec.tentative.endedAt = now;
    return rec;
  });
}

/** Every session's record, by file name; throws on a folder or a record that cannot be read. */
function readAllHolds(): Array<{ name: string; rec: HoldFile }> {
  let names: string[];
  try { names = fs.readdirSync(holdsDir()); } catch (err) {
    if (codeOf(err) === 'ENOENT') return [];
    throw fail(NOTE_HOLDS_DIR_UNREADABLE, `${HOLDS_DIR} cannot be read (${codeOf(err)}); notes are not imported until it can be`);
  }
  const out: Array<{ name: string; rec: HoldFile }> = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const rec = readHoldFile(path.join(holdsDir(), name));
    if (rec) out.push({ name, rec });
  }
  return out;
}

/** Every marker, parsed; throws on a folder or a marker that cannot be read. */
function readAllMarkers(): Array<{ file: string; marker: Marker }> {
  let names: string[];
  try { names = fs.readdirSync(markersDir()); } catch (err) {
    if (codeOf(err) === 'ENOENT') return [];
    throw fail(NOTE_MARKERS_DIR_UNREADABLE, `${MARKERS_DIR} cannot be read (${codeOf(err)}); notes are not imported until it can be`);
  }
  const out: Array<{ file: string; marker: Marker }> = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const file = path.join(markersDir(), name);
    const marker = readMarker(file);
    if (marker) out.push({ file, marker });
  }
  return out;
}

/** The session's last write: its marker's last sign of life or its transcripts', whichever is later; undefined when its files cannot be listed. */
function lastActivity(updatedAt: number, transcript: string | undefined): number | undefined {
  if (typeof transcript !== 'string' || transcript === '') return updatedAt;
  const written = sessionLastWriteMs(transcript);
  return written === undefined ? undefined : Math.max(updatedAt, written);
}

/**
 * A private session not heard from for `PRIVATE_WINDOW_MS`, whose transcripts
 * have also not been written for that long, is gone (killed, or idle for a
 * night) without having recorded its last holds. What it may have written is
 * held by content, once, up to its LAST ACTIVITY, not up to now: in every
 * folder it reached, the notes changed while it ran; in every other folder of
 * its projects root, the notes changed after its last recorded holds. Holds
 * first, then the marker says so. A session whose files cannot be listed is
 * treated as live (it keeps the wait).
 */
function finalizeIdleMarker(entry: { file: string; marker: Marker }, now: number, deadlineAt: number): 'live' | 'finalized' {
  const { marker } = entry;
  if (now - marker.updatedAt <= PRIVATE_WINDOW_MS) return 'live';
  const last = lastActivity(marker.updatedAt, marker.transcript);
  if (last === undefined || now - last <= PRIVATE_WINDOW_MS) return 'live';
  const reached = new Set(marker.dirs);
  const all = marker.projectsRoot ? projectMemoryFolders(marker.projectsRoot).folders : [];
  for (const dir of new Set([...reached, ...all])) {
    if (!fs.existsSync(dir)) continue;
    holdOutNoteFiles({ dir, sessionId: marker.session, paths: [], sinceMs: reached.has(dir) ? marker.startedAt : marker.holdsAt, untilMs: last, deadlineAt, now });
  }
  withPrivateStateLock(getMemeshDirFromDbPath(), deadlineAt, () => {
    const again = readMarker(entry.file);
    if (again && again.finalizedAt === undefined && again.updatedAt === marker.updatedAt) writeMarker(entry.file, { ...again, finalizedAt: now });
  });
  return 'finalized';
}

/** What the importer of one folder must respect this run. */
interface FolderPrivacy {
  /** Notes changed at or after this wait (a private or unchecked session may still record holds for them). */
  waitSince?: number;
  firm: Set<string>;
  tentative: Set<string>;
  /** Unchecked sessions not decided again this run (time or count). */
  redecideLeft: number;
}

/**
 * Everything private that bears on importing `realDir`, in the order that
 * keeps it safe: markers first (a writer records holds before it ends or
 * finalizes a marker, so a wait seen here covers what is not yet held), then
 * the holds. Sessions held only tentatively for this folder are decided again
 * (`decidePrivacy`, within the deadline, at most `REDECIDE_PER_RUN`), and a
 * held note that could not be read is read again; the changes are applied
 * under the lock.
 */
function readPrivateState(realDir: string, now: number, deadlineAt: number, memeshDir: string): FolderPrivacy {
  const dirId = dirIdOf(realDir);
  const root = projectsRootOf(realDir);
  const out: FolderPrivacy = { firm: new Set(), tentative: new Set(), redecideLeft: 0 };
  const wait = (since: number): void => { out.waitSince = out.waitSince === undefined ? since : Math.min(out.waitSince, since); };

  for (const entry of readAllMarkers()) {
    const { marker } = entry;
    if (marker.endedAt !== undefined || marker.finalizedAt !== undefined) continue;
    const mine = marker.dirs.includes(realDir) || marker.projectsRoot === root;
    if (!mine) continue;
    if (finalizeIdleMarker(entry, now, deadlineAt) === 'finalized') continue;
    wait(marker.holdsAt);
  }

  let redecided = 0;
  for (const { name, rec } of readAllHolds()) {
    let current = rec;
    const t = current.tentative;
    if (t && (t.dirs[dirId] !== undefined || (t.endedAt === undefined && t.projectsRoot === root))) {
      // A record that does not say which transcript was not checkable can only be decided on its marker.
      const decidable = current.transcript !== undefined || t.reason === 'marker_unreadable';
      if (!decidable) {
        // kept as it is: nothing can settle it but its own session's next hook
      } else if (redecided < REDECIDE_PER_RUN && Date.now() < deadlineAt) {
        redecided++;
        const state = decidePrivacy({ sessionId: current.session, transcriptPath: current.transcript, memeshDir, deadlineAt, cacheDir: path.join(memeshDir, 'private-check-cache') });
        if (state.state !== 'unchecked' && settleTentativeHolds(current.session, state.state, { expectRev: current.rev, deadlineAt })) {
          current = readHoldFile(path.join(holdsDir(), name)) ?? { ...current, firm: {}, tentative: undefined };
        }
      } else {
        out.redecideLeft++;
      }
    }
    const t2 = current.tentative;
    if (t2 && t2.endedAt === undefined && t2.projectsRoot === root) {
      const last = lastActivity(t2.updatedAt, current.transcript);
      if (last !== undefined && now - t2.updatedAt > PRIVATE_WINDOW_MS && now - last > PRIVATE_WINDOW_MS) {
        // Gone without being settled: what it may have written since its last holds is held (provisionally) up to its last activity; the wait ends.
        holdOutNoteFiles({ dir: realDir, sessionId: current.session, paths: [], sinceMs: t2.holdsAt, untilMs: last, tentative: { reason: t2.reason }, deadlineAt, now });
        endTentativeWait(current.session, now, deadlineAt);
        current = readHoldFile(path.join(holdsDir(), name)) ?? current;
      } else {
        wait(t2.holdsAt);
      }
    }
    for (const [kind, dirs] of [['firm', current.firm], ['tentative', current.tentative?.dirs ?? {}]] as const) {
      for (const [rel, hash] of Object.entries(dirs[dirId] ?? {})) {
        if (!isUnreadableMark(hash)) { (kind === 'firm' ? out.firm : out.tentative).add(hash); continue; }
        // A held note that could not be read: read it now. Until it can be, everything changed in the folder since it was held waits
        // (a rename or a copy changes the change time, so the note cannot slip out under another name).
        const since = unreadableSince(hash);
        let resolved: Record<string, string> | undefined;
        try {
          resolved = { [rel]: sha256(fs.readFileSync(path.join(realDir, rel))) };
        } catch (err) {
          if (codeOf(err) === 'ENOENT') resolved = hashNotes(realDir, notesTouchedBetween(realDir, since), now); // gone: whatever changed since may be it
        }
        if (resolved === undefined || Object.values(resolved).some(isUnreadableMark)) { wait(since); continue; }
        updateHold(path.join(holdsDir(), name), deadlineAt, (again) => {
          const target = kind === 'firm' ? again?.firm : again?.tentative?.dirs;
          if (!again || target?.[dirId]?.[rel] !== hash) return undefined;
          delete target[dirId][rel];
          target[dirId] = { ...target[dirId], ...resolved };
          return again;
        });
        for (const h of Object.values(resolved)) (kind === 'firm' ? out.firm : out.tentative).add(h);
      }
    }
  }
  return out;
}

/** The reasons an unchecked hold can carry, as doctor may quote them: never the text in the file. */
const UNCHECKED_REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  marker_unreadable: 'the session\'s private-session marker could not be read',
  unreadable: 'the session\'s transcript or a subagent transcript could not be read',
  timeout: 'the check ran out of time',
  parent_not_found: 'the parent rollout of the forked thread was not found',
  parent_unreadable: 'the parent rollout of the forked thread could not be read',
  too_large: 'the session\'s transcripts are too large to check, or a line that names the tool is longer than 64 MiB',
  parent_too_large: 'the parent rollout is too large to check',
  fork_too_deep: 'the thread is forked more than five levels deep',
  header_unreadable: 'the first line of a rollout is damaged',
  no_zstd: 'this Node cannot read the archived parent rollout (it needs Node 22.15 or later)',
  no_session_id: 'the host gave no session id',
});

/** A hold or marker file name memesh writes: a plain token or a hash, `.json`. Anything else is not shown as it is. */
const SAFE_FILE_NAME = /^[A-Za-z0-9_-]{1,128}\.json$/;
const shownName = (name: string): string => (SAFE_FILE_NAME.test(name) ? name : '(a file name memesh did not write)');

export interface PrivateHoldSummary {
  sessions: number; notes: number; holdsFolder: string; markersFolder: string;
  unsettled: Array<{ session: string; file: string; reason: string; reasonText: string; kind: 'transient' | 'persistent'; since: number; notes: number; transcript?: string }>;
  waitingOnUnreadable: Array<{ file: string; notes: number; since: number }>;
  damaged: Array<{ folder: 'holds' | 'markers'; file: string }>;
  /** A folder that exists and cannot be listed: what it holds cannot be told, and every import stops on it. */
  unreadableFolders: Array<'holds' | 'markers'>;
}

/**
 * What the holds say, for `memesh doctor`: how many sessions and notes are
 * kept out, which sessions could not be checked (by reason code, with the
 * fixed text for it), which folders wait on a note that could not be read, and
 * which records are damaged. File names are shown only when they have the
 * shape memesh writes; no text is taken from a file.
 */
export function summarizeNoteHolds(now = Date.now()): PrivateHoldSummary {
  const out: PrivateHoldSummary = { sessions: 0, notes: 0, holdsFolder: holdsDir(), markersFolder: markersDir(), unsettled: [], waitingOnUnreadable: [], damaged: [], unreadableFolders: [] };
  const list = (dir: string, folder: 'holds' | 'markers'): string[] => {
    try { return fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch (err) {
      if (codeOf(err) !== 'ENOENT') out.unreadableFolders.push(folder); // not there is nothing held; anything else is said
      return [];
    }
  };
  for (const name of list(holdsDir(), 'holds')) {
    let rec: HoldFile | undefined;
    try { rec = readHoldFile(path.join(holdsDir(), name)); } catch { out.damaged.push({ folder: 'holds', file: shownName(name) }); continue; }
    if (!rec) continue;
    out.sessions++;
    const firm = holdCount(rec.firm);
    out.notes += firm;
    const unread = [...Object.values(rec.firm), ...Object.values(rec.tentative?.dirs ?? {})].flatMap((files) => Object.values(files)).filter(isUnreadableMark);
    if (unread.length > 0) out.waitingOnUnreadable.push({ file: shownName(name), notes: unread.length, since: Math.min(...unread.map(unreadableSince)) });
    if (rec.tentative) {
      const n = holdCount(rec.tentative.dirs);
      out.notes += n;
      const reason = Object.prototype.hasOwnProperty.call(UNCHECKED_REASON_TEXT, rec.tentative.reason) ? rec.tentative.reason : 'unrecognised';
      out.unsettled.push({
        session: shownName(name), file: shownName(name), reason, reasonText: UNCHECKED_REASON_TEXT[reason] ?? 'an unrecognised reason',
        kind: reason === 'unrecognised' ? 'persistent' : uncheckedKind(reason as UncheckedReason, rec.tentative.since, now),
        since: rec.tentative.since, notes: n, ...(rec.transcript === undefined ? {} : { transcript: rec.transcript }),
      });
    }
  }
  for (const name of list(markersDir(), 'markers')) {
    try { readMarker(path.join(markersDir(), name)); } catch { out.damaged.push({ folder: 'markers', file: shownName(name) }); }
  }
  return out;
}

/**
 * Ingest every note file under `dir`. Throws when `dir` is not a readable
 * directory; everything file-level is reported in the result instead.
 *
 * Two phases. Phase 1 reads and parses every file this run processes (within
 * the caps). Phase 2 decides, per name, which file owns it — ONE rule, in
 * this order:
 *   1. the file the existing memory records (`provenance.note_path`), if it
 *      is present and still declares the name;
 *   2. else a file whose bytes hash to the recorded `content_hash` (the
 *      recorded file was renamed);
 *   3. else the first claimant in path order.
 * Every other claimant is reported and fingerprinted. A memory whose recorded
 * file is present but now declares a different name is tagged
 * `source:note-file:missing`, exactly like a vanished file. Deciding
 * ownership while reading (path order) is what let an edited or renamed
 * owner lose its name — and its new content — to a duplicate sorting first.
 */
export function ingestNoteDirectory(opts: NoteIngestOptions): NoteIngestResult {
  const maxFiles = opts.maxFiles ?? NOTE_DIR_MAX_FILES;
  const maxBytes = opts.maxBytes ?? NOTE_FILE_MAX_BYTES;
  const realDir = fs.realpathSync(opts.dir);
  if (!fs.statSync(realDir).isDirectory()) throw new Error(`not a directory: ${opts.dir}`);
  const dirId = createHash('sha256').update(realDir).digest('hex').slice(0, 16);

  const { files, symlinks } = discover(realDir);
  const presentRels = new Set(files.map((abs) => relPath(realDir, abs)));
  const result: NoteIngestResult = {
    dirId,
    discovered: files.length,
    created: [],
    replaced: [],
    unchanged: 0,
    repathed: [],
    restored: [],
    markedMissing: [],
    skipped: [],
    refusedNow: 0,
    pendingPrivate: 0,
    held: { private: 0, unchecked: 0 },
    redecideLeft: 0,
    more: 0,
  };

  // First: a session that has gone idle has its notes held now, so the holds read next include them.
  const now = opts.now ?? Date.now();
  const privacy = readPrivateState(realDir, now, opts.deadlineAt ?? Date.now() + DEFAULT_LOCK_WAIT_MS, getMemeshDirFromDbPath());
  const privateSince = privacy.waitSince;
  result.redecideLeft = privacy.redecideLeft;

  const db = getDatabase();
  const existingStmt = db.prepare(
    `SELECT e.id, e.metadata, e.status,
            EXISTS(SELECT 1 FROM tags t WHERE t.entity_id = e.id AND t.tag = ?) AS is_note,
            EXISTS(SELECT 1 FROM tags t WHERE t.entity_id = e.id AND t.tag = ?) AS is_missing
       FROM entities e WHERE e.name = ?`,
  );

  // What this directory already contributed, keyed by relative path. The
  // stat fingerprint lets an unchanged file be recognised WITHOUT reading it,
  // so a re-run costs one lstat per file, and such files do not count toward
  // the per-run cap.
  const noteRows = db.prepare(
    `SELECT e.id, e.name, e.metadata,
            EXISTS(SELECT 1 FROM tags m WHERE m.entity_id = e.id AND m.tag = ?) AS is_missing
       FROM entities e
       JOIN tags t ON t.entity_id = e.id AND t.tag = ?`,
  ).all(NOTE_FILE_MISSING_TAG, NOTE_FILE_TAG) as Array<{ id: number; name: string; metadata: string | null; is_missing: number }>;
  const known = new Map<string, { id: number; name: string; mtime: unknown; size: unknown; ino: unknown; missing: boolean }>();
  for (const row of noteRows) {
    const prov = parseProvenance(row.metadata);
    if (prov.note_dir_id === dirId && typeof prov.note_path === 'string') {
      known.set(prov.note_path, { id: row.id, name: row.name, mtime: prov.note_mtime_ms, size: prov.note_size, ino: prov.note_ino, missing: row.is_missing === 1 });
    }
  }

  // Skip fingerprints (memesh_metadata, shared by the CLI and the Stop hook):
  // a file skipped for its own content, or as a losing claimant, is reported
  // again without being re-read until it — or, for a loser, the owner —
  // changes. Otherwise unusable files would use the per-run cap every run.
  const skipKey = `note_ingest_skips:${dirId}`;
  const skipRow = db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(skipKey) as { value: string } | undefined;
  let priorSkips: Record<string, SkipPrint> = {};
  try {
    const parsedSkips = skipRow ? JSON.parse(skipRow.value) as unknown : {};
    if (parsedSkips && typeof parsedSkips === 'object') priorSkips = parsedSkips as typeof priorSkips;
  } catch {
    // A corrupt cache only costs re-reading the skipped files once; it is
    // rewritten below.
    priorSkips = {};
  }
  const nextSkips: Record<string, SkipPrint> = {};
  /**
   * Report a file as skipped, and count it as newly refused unless it was
   * already refused for the same reason. The comparison is against the
   * stored fingerprints, so "new" survives a restart — an ephemeral counter
   * would make every process's first run a flood of old news.
   */
  const counted = new Set<string>();
  const report = (rel: string, reason: string) => {
    result.skipped.push({ path: rel, reason });
    if (priorSkips[rel]?.reason === reason || counted.has(rel)) return;
    counted.add(rel);
    result.refusedNow++;
  };
  // Symlinks are refused before the read loop (a link can point anywhere).
  // They are fingerprinted like any other refusal, or every run would call
  // the same link news again — the stickiness this counter exists to avoid,
  // moved somewhere it is harder to see.
  for (const abs of symlinks) {
    const rel = relPath(realDir, abs);
    const reason = 'symlink refused';
    report(rel, reason);
    let st: fs.Stats | null;
    try { st = fs.lstatSync(abs); } catch { st = null; }
    nextSkips[rel] = st
      ? { mtime: st.mtimeMs, size: st.size, reason }
      : { mtime: 0, size: 0, reason };
  }

  /** Names whose memory is tagged missing: nobody owns them, so they are free. */
  const missingNames = new Set(noteRows.filter((r) => r.is_missing).map((r) => r.name));
  /**
   * rel → the name that file declares, for every file this run processed; `''`
   * when it declared none (no frontmatter, no name, or too large to read).
   * The missing sweep reads it: both "declares another name" and "declares
   * nothing" mean the recorded file no longer holds the memory's name.
   */
  const declaredNameAt = new Map<string, string>();
  const statOf = (rel: string): fs.Stats | null => {
    try { return fs.lstatSync(path.join(realDir, rel)); } catch { return null; }
  };
  const ownerUnchanged = (print: SkipPrint): boolean => {
    if (!print.owner) return true;
    const st = statOf(print.owner.rel);
    return !!st && st.mtimeMs === print.owner.mtime && st.size === print.owner.size;
  };

  /** Whether content is held out, and how: for good (a private session) or until its session is decided. */
  const heldAs = (hash: string): 'private' | 'unchecked' | undefined =>
    (privacy.firm.has(hash) ? 'private' : privacy.tentative.has(hash) ? 'unchecked' : undefined);
  const countHeld = (rel: string, hash: string): void => {
    if (heldAs(hash) === 'private') {
      result.held.private++;
      result.skipped.push({ path: rel, reason: NOTE_PRIVATE_HOLD_REASON });
    } else {
      result.held.unchecked++;
      result.skipped.push({ path: rel, reason: NOTE_UNCHECKED_HOLD_REASON });
    }
  };

  // ---- Phase 1: read ------------------------------------------------------
  const claims: Claim[] = [];
  const readRels = new Set<string>();
  let read = 0;
  /** Cap slots handed back to failed reads; bounded, see the catch below. */
  let refunds = 0;
  for (const abs of files) {
    const rel = relPath(realDir, abs);
    const skip = (reason: string) => { report(rel, reason); };
    let raw: Buffer;
    let stat: fs.Stats;
    const contentSkip = (reason: string) => {
      skip(reason);
      nextSkips[rel] = { mtime: stat.mtimeMs, size: stat.size, reason };
      declaredNameAt.set(rel, '');
    };
    /**
     * A file memesh could not reach: unreadable, or resolving outside the
     * directory. Deliberately NOT fingerprinted, unlike contentSkip.
     *
     * The fingerprint's premise is "the same bytes will be refused the same
     * way", and reachability is not a function of the bytes: `chmod +r`
     * changes neither mtime nor size, so a fingerprinted file would stay
     * refused after the problem was fixed — and its memory would stay tagged
     * missing forever. One failed syscall per run is the price of noticing.
     *
     * It DOES record that the file declares no name, which is what the
     * missing sweep needs: without it the sweep sees the path in
     * presentRels and leaves the memory pointing at a file nobody can read,
     * so `source:note-file:missing` — the only user-visible signal this
     * module has — never appears.
     *
     * And it gives the per-run cap slot back, because it sits after
     * `read++` and would otherwise spend a slot a readable file could use.
     * Bounded by `maxFiles`, so a directory full of unreadable files cannot
     * drive an unbounded number of attempts in one run.
     */
    const unreachableSkip = (reason: string) => {
      skip(reason);
      declaredNameAt.set(rel, '');
      // `readRels.has(rel)` is exactly "read++ already ran for this file";
      // the entry itself stays, because the file WAS looked at this run and
      // the ownership rules below read that set to mean just that.
      if (readRels.has(rel) && refunds < maxFiles) { read--; refunds++; }
    };
    // The lstat gets its own try. Everything below it needs `stat`, so a
    // failure here cannot be fingerprinted — and folding the two together is
    // how a catch ends up reading an uninitialised `stat`. Nothing has been
    // charged to the per-run cap at this point either.
    try {
      stat = fs.lstatSync(abs);
    } catch (err) {
      // The file was listed by the directory walk and is gone or unreachable
      // now. It declares no name, which is what the missing sweep needs to
      // know: a memory recording this path no longer has it.
      skip(`unreadable: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
      declaredNameAt.set(rel, '');
      continue;
    }
    try {
      if (stat.isSymbolicLink()) { skip('symlink refused'); continue; }
      // A private session began in this folder and has not ended: a note changed or
      // moved in since then may be one it wrote, so it waits (neither imported nor
      // refused) until that session has recorded what it held. A `mv` or `cp -p`
      // keeps the old modification time, so the change time counts too.
      if (privateSince !== undefined && touchedAt(stat) >= privateSince) {
        result.pendingPrivate++;
        continue;
      }
      const prior = known.get(rel);
      // The inode is part of the fingerprint: two files of the same size
      // written in the same millisecond that swap NAMES are otherwise both
      // "unchanged" forever, each memory pointing at the other's file. A
      // memory stored before `note_ino` existed has none, so it is read once
      // and refreshed (the provenance-only path below).
      if (prior && !prior.missing && prior.mtime === stat.mtimeMs && prior.size === stat.size && prior.ino === stat.ino) {
        claims.push({ rel, name: prior.name, stat, unchanged: true });
        continue;
      }
      const priorSkip = priorSkips[rel];
      if (priorSkip?.held !== undefined && priorSkip.mtime === stat.mtimeMs && priorSkip.size === stat.size && heldAs(priorSkip.held)) {
        countHeld(rel, priorSkip.held);
        nextSkips[rel] = priorSkip;
        continue;
      }
      // A loser whose name's memory is now MISSING must be read again: the
      // name is free, and its fingerprint is bound to a file whose stat may
      // never change again. Without this, a newcomer refused once (by the
      // per-run cap, or by a recorded file it could not see) stayed refused
      // while a file on disk declared that very name.
      const nameIsFree = !!priorSkip?.name && missingNames.has(priorSkip.name);
      if (priorSkip && priorSkip.held === undefined && !priorSkip.reportOnly && !nameIsFree
        && priorSkip.mtime === stat.mtimeMs && priorSkip.size === stat.size && ownerUnchanged(priorSkip)) {
        skip(priorSkip.reason);
        nextSkips[rel] = priorSkip;
        continue;
      }
      if (read >= maxFiles) { result.more++; continue; }
      read++;
      readRels.add(rel);
      if (stat.size > maxBytes) { contentSkip(`larger than ${Math.round(maxBytes / 1024)} KB`); continue; }
      const real = fs.realpathSync(abs);
      if (!real.startsWith(realDir + path.sep)) { unreachableSkip('resolves outside the directory'); continue; }
      raw = fs.readFileSync(real);
    } catch (err) {
      unreachableSkip(`unreadable: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
      continue;
    }

    // The content a private session wrote or named is never imported, whatever
    // the file is called now; content held while a session could not be checked
    // waits for that session to be decided. Not counted as newly refused: it is
    // the person's choice, not a defect in the file. Every held note is counted.
    // It gives its slot of the per-run cap back and is fingerprinted, so held
    // notes cannot keep an ordinary note out (they are not read again until they
    // change or are released).
    const contentHash = sha256(raw);
    if (heldAs(contentHash)) {
      read--;
      countHeld(rel, contentHash);
      nextSkips[rel] = { mtime: stat.mtimeMs, size: stat.size, reason: heldAs(contentHash) === 'private' ? NOTE_PRIVATE_HOLD_REASON : NOTE_UNCHECKED_HOLD_REASON, held: contentHash };
      continue;
    }

    const parsed = parseFrontmatter(raw.toString('utf8'));
    if (!parsed) { contentSkip('no frontmatter — a note file needs a `---` block with a name'); continue; }
    // Same hygiene as every other field: the name is stored and shown too.
    const rawName = stringField(parsed.data, 'name');
    const name = rawName ? sanitizeNoteText(rawName).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 255) : '';
    if (!name) { contentSkip('frontmatter has no name'); continue; }

    const metaBlock = parsed.data.metadata;
    const rawType = (typeof metaBlock === 'object' ? metaBlock.type : undefined) ?? stringField(parsed.data, 'type');
    const type = (rawType ? sanitizeNoteText(rawType).slice(0, 100) : '') || NOTE_DEFAULT_TYPE;
    const description = stringField(parsed.data, 'description');
    const cleanDescription = description ? sanitizeNoteText(description) : '';
    let observations = splitObservations(sanitizeNoteText(parsed.body));
    if (observations.length === 0 && cleanDescription) observations = [cleanDescription];
    if (observations.length === 0) { contentSkip('empty note — no description and no body'); continue; }
    if (observations.length > NOTE_MAX_OBSERVATIONS) {
      // Refused, not trimmed. `slice` stored the first 100 and dropped the
      // rest with `skipped` empty and `more` zero — on a Stop-hook path,
      // where a silent drop is indistinguishable from nothing having
      // happened. The transport rejects the same shape and names the count;
      // so does this. contentSkip fingerprints it, so the file is not
      // re-read on every Stop until the user edits it.
      // "observations", not "paragraphs": this count is post-split, and one
      // paragraph can yield more than one observation. The cap is on what is
      // stored, which is what the reader needs to act on.
      contentSkip(`yields ${observations.length} observations; at most ${NOTE_MAX_OBSERVATIONS} are stored per memory`);
      continue;
    }
    claims.push({
      rel,
      name,
      stat,
      unchanged: false,
      contentHash: createHash('sha256').update(raw).digest('hex'),
      type,
      title: truncateTitle(cleanDescription || observations[0]),
      observations,
    });
  }

  // ---- Phase 2: resolve names, then write ---------------------------------
  const byName = new Map<string, Claim[]>();
  for (const c of claims) {
    const list = byName.get(c.name);
    if (list) list.push(c);
    else byName.set(c.name, [c]);
  }
  const touchedIds = new Set<number>();
  for (const c of claims) declaredNameAt.set(c.rel, c.name);

  for (const [name, claimants] of byName) {
    const existing = existingStmt.get(NOTE_FILE_TAG, NOTE_FILE_MISSING_TAG, name) as ExistingRow | undefined;
    const prov = existing ? parseProvenance(existing.metadata) : {};
    const skipAll = (reason: string) => {
      for (const c of claimants) {
        report(c.rel, reason);
        // Fingerprinted `reportOnly`: remembered so it is not news again,
        // but the file is still read next run so the refusal can lift.
        nextSkips[c.rel] = { mtime: c.stat.mtimeMs, size: c.stat.size, reason, name: c.name, reportOnly: true };
      }
    };
    if (existing) {
      // Never overwrite a memory that did not come from a note file, nor one
      // ingested from a different directory (two projects' memory
      // directories may both hold a `feedback_testing.md`).
      if (!existing.is_note) { skipAll(`name "${name}" belongs to a memory that did not come from a note file`); continue; }
      if (prov.note_dir_id !== dirId) { skipAll(`name "${name}" was already ingested from another note directory`); continue; }
      // A memory archived with `forget` stays archived: editing the file
      // must not quietly undo an explicit forget.
      if (existing.status === 'archived') { skipAll(`memory "${name}" was archived with forget; not re-ingested`); continue; }
    }

    // `prov` is empty unless `existing`, so this is the recorded file or nothing.
    const recordedRel = typeof prov.note_path === 'string' ? prov.note_path : undefined;
    // A name is free exactly when its memory is tagged missing — the sweep
    // below tags it in the same run the recorded file is read and found to
    // declare something else (or nothing at all). So the ONE case where a
    // newcomer must wait is a memory that is NOT missing whose recorded file
    // is present but was not read this run (past the per-run cap): this run
    // cannot tell whether that file still holds the name. Everything else —
    // the recorded file renamed itself a run ago, or stopped being a note —
    // has already been recorded as missing, and the newcomer takes over
    // whichever run it turns up in.
    if (recordedRel
      && existing && !existing.is_missing
      && presentRels.has(recordedRel)
      && !readRels.has(recordedRel)
      && !claimants.some((c) => c.rel === recordedRel)) {
      const reason = `name "${name}" belongs to ${recordedRel}, which was not read this run`;
      const ownerStat = statOf(recordedRel);
      for (const c of claimants) {
        report(c.rel, reason);
        // Fingerprinted against the recorded file, or the claimant would be
        // re-read on every run and keep the cap away from the very file that
        // owns the name. `name` is what lets the fingerprint be dropped once
        // that name is freed (see `nameIsFree` in phase 1).
        if (ownerStat) nextSkips[c.rel] = { mtime: c.stat.mtimeMs, size: c.stat.size, reason, name: c.name, owner: { rel: recordedRel, mtime: ownerStat.mtimeMs, size: ownerStat.size } };
      }
      continue;
    }
    const owner =
      claimants.find((c) => c.rel === recordedRel)
      ?? (typeof prov.content_hash === 'string' ? claimants.find((c) => c.contentHash === prov.content_hash) : undefined)
      ?? claimants[0];

    for (const c of claimants) {
      if (c === owner) continue;
      const reason = `name "${name}" already used by ${owner.rel} in this directory`;
      report(c.rel, reason);
      nextSkips[c.rel] = { mtime: c.stat.mtimeMs, size: c.stat.size, reason, name: c.name, owner: { rel: owner.rel, mtime: owner.stat.mtimeMs, size: owner.stat.size } };
    }

    if (owner.unchanged) {
      result.unchanged++;
      if (existing) touchedIds.add(existing.id);
      continue;
    }
    if (existing && prov.content_hash === owner.contentHash) {
      // The bytes are the memory. Same hash means nothing searchable changed,
      // whatever moved: a `touch`, a checkout, a `git mv` (new path), or the
      // file coming back after being reported missing. Provenance only — no
      // FTS work, and no history entry. Writing one would have let twenty
      // renames evict the real history, which is capped at twenty versions.
      const moved = prov.note_path !== owner.rel;
      const meta = JSON.parse(existing.metadata ?? '{}') as Record<string, unknown>;
      meta.provenance = { ...prov, note_path: owner.rel, note_mtime_ms: owner.stat.mtimeMs, note_size: owner.stat.size, note_ino: owner.stat.ino };
      db.prepare('UPDATE entities SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), existing.id);
      if (existing.is_missing) {
        // The file is back (or was renamed): the memory is no longer missing.
        // Tags are not in the FTS document, so no index work.
        db.prepare('DELETE FROM tags WHERE entity_id = ? AND tag = ?').run(existing.id, NOTE_FILE_MISSING_TAG);
        result.restored.push(name);
      } else if (moved) result.repathed.push(name);
      // Same bytes at the same path: this UPDATE only refreshes the stat
      // fingerprint so the next run can skip the read. Nothing a reader of
      // the memory would notice changed, so it counts as unchanged — and the
      // Stop hook records it as a skip rather than a capture.
      else result.unchanged++;
      touchedIds.add(existing.id);
      continue;
    }

    // Tags: the file owns `source:*`; everything else a person added
    // survives a file change. The project tag is set on first ingestion and
    // then kept — the CLI and the hook may run from different directories.
    // An existing memory keeps its stored tags: `replace` without `tags`
    // puts them back, so a memory two projects already share is not sent as
    // a new two-project write. The write names one project it belongs to, so
    // the ownership check still runs: its only project, or — when it has
    // several — this run's project if it is one of them; otherwise the file
    // is reported and left as it is rather than guessed. A memory first
    // stored with no project stays that way.
    let project: string | undefined;
    if (existing) {
      const projects = (db.prepare("SELECT tag FROM tags WHERE entity_id = ? AND tag LIKE 'project:%' ORDER BY tag").all(existing.id) as { tag: string }[])
        .map((t) => t.tag.slice('project:'.length));
      if (projects.length === 1) project = projects[0];
      else if (projects.length > 1) {
        if (!opts.project || !projects.includes(opts.project)) {
          const reason = `memory "${name}" belongs to several projects (${projects.join(', ')}); ${opts.project ? `this run's project ${opts.project} is not one of them` : 'this run names no project'}, so it was not updated`;
          report(owner.rel, reason);
          // Remembered so it is not news again; still read next run, so a run
          // of a member project updates it (same as `skipAll`).
          nextSkips[owner.rel] = { mtime: owner.stat.mtimeMs, size: owner.stat.size, reason, name: owner.name, reportOnly: true };
          continue;
        }
        project = opts.project;
      }
    }
    const fields = {
      name,
      type: owner.type!,
      title: owner.title,
      observations: owner.observations,
      ...(existing ? { project } : { tags: [NOTE_FILE_TAG, ...(opts.project ? [`project:${opts.project}`] : [])] }),
      replace: true,
      // Same stance as the JSON importer: text from a file is not a trusted
      // re-assertion and must not lift confidence.
      trustOverride: 'untrusted',
      provenanceOverride: {
        source: 'note-file',
        note_path: owner.rel,
        content_hash: owner.contentHash,
        note_dir_id: dirId,
        note_mtime_ms: owner.stat.mtimeMs,
        note_size: owner.stat.size,
        note_ino: owner.stat.ino,
      },
      sourceHost: 'note-file',
    } as const;
    let written: ReturnType<typeof remember>;
    try {
      written = db.transaction(() => {
        const stored = remember(fields);
        if (existing) {
          // The file owns `source:*`: whatever a missing file left behind goes,
          // and the note tag is there. Tags are not in the keyword index.
          db.prepare("DELETE FROM tags WHERE entity_id = ? AND tag LIKE 'source:%' AND tag <> ?").run(existing.id, NOTE_FILE_TAG);
          db.prepare('INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)').run(existing.id, NOTE_FILE_TAG);
        }
        return stored;
      }).immediate();
    } catch (err) {
      // A refused write (ownership, project tags) leaves this memory as it was
      // and is reported; the rest of the directory is still read.
      if (err instanceof Error && err.message.startsWith('MeMesh did not store this memory')) {
        report(owner.rel, err.message);
        nextSkips[owner.rel] = { mtime: owner.stat.mtimeMs, size: owner.stat.size, reason: err.message, name: owner.name, reportOnly: true };
        continue;
      }
      throw err;
    }
    touchedIds.add(written.entityId);
    (existing ? result.replaced : result.created).push(name);
  }

  if (Object.keys(nextSkips).length > 0) {
    db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run(skipKey, JSON.stringify(nextSkips));
  } else {
    db.prepare('DELETE FROM memesh_metadata WHERE key = ?').run(skipKey);
  }

  // ---- Missing sweep -------------------------------------------------------
  // A memory is tagged missing when its recorded file is gone, or is present,
  // was read this run and now declares a different name. Files past the cap
  // or fingerprint-skipped are still on disk and prove nothing. Memories
  // written or confirmed this run are excluded: the snapshot above predates
  // them (a renamed file's memory still shows the old path there).
  // Tags are not part of the FTS document (name, title, observations are), so
  // adding one needs no index rebuild.
  const tagMissing = db.prepare('INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)');
  for (const row of noteRows) {
    if (row.is_missing || touchedIds.has(row.id)) continue;
    const prov = parseProvenance(row.metadata);
    if (prov.note_dir_id !== dirId || typeof prov.note_path !== 'string') continue;
    const gone = !presentRels.has(prov.note_path);
    // "Declares a different name" and "declares no name at all" (unparseable,
    // nameless, or too large to read) are the same fact about the memory: the
    // file it records no longer holds it. Both free the name, so both must
    // report it — the missing tag is the only signal recall and the dashboard
    // get, and a memory silently pointing at a file that disowned it is the
    // shape this sweep exists to show.
    const declaresNow = declaredNameAt.get(prov.note_path);
    const renamedAway = declaresNow !== undefined && declaresNow !== row.name;
    if (!gone && !renamedAway) continue;
    tagMissing.run(row.id, NOTE_FILE_MISSING_TAG);
    result.markedMissing.push(row.name);
  }

  return result;
}

/** One-line human summary, shared by the CLI and the hook's outcome record. */
export function summarizeNoteIngest(r: NoteIngestResult): string {
  const parts = [
    `${r.created.length} created`,
    `${r.replaced.length} replaced`,
    `${r.unchanged} unchanged`,
    ...(r.repathed.length ? [`${r.repathed.length} moved`] : []),
    ...(r.restored.length ? [`${r.restored.length} restored`] : []),
    `${r.skipped.length} skipped`,
    ...(r.refusedNow ? [`${r.refusedNow} newly refused`] : []),
  ];
  if (r.markedMissing.length) parts.push(`${r.markedMissing.length} marked missing`);
  if (r.held.private) parts.push(`${r.held.private} held out by a private session`);
  if (r.held.unchecked) parts.push(`${r.held.unchecked} held while a session could not be checked`);
  if (r.pendingPrivate) parts.push(`${r.pendingPrivate} waiting for a private session's next Stop`);
  if (r.more) parts.push(`${r.more} more not processed (per-run cap)`);
  return parts.join(', ');
}
