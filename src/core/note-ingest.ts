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
import { remember } from './operations.js';
import { sanitizeNoteText, splitObservations, NOTE_DEFAULT_TYPE, NOTE_MAX_OBSERVATIONS } from './note-derive.js';
import { truncateTitle } from './title.js';

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
};

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
    more: 0,
  };

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
      // A loser whose name's memory is now MISSING must be read again: the
      // name is free, and its fingerprint is bound to a file whose stat may
      // never change again. Without this, a newcomer refused once (by the
      // per-run cap, or by a recorded file it could not see) stayed refused
      // while a file on disk declared that very name.
      const nameIsFree = !!priorSkip?.name && missingNames.has(priorSkip.name);
      if (priorSkip && !priorSkip.reportOnly && !nameIsFree
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
      contentSkip(`splits into ${observations.length} paragraphs; at most ${NOTE_MAX_OBSERVATIONS} are stored per memory`);
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
    const currentTags = existing
      ? (db.prepare('SELECT tag FROM tags WHERE entity_id = ?').all(existing.id) as { tag: string }[]).map((t) => t.tag)
      : [];
    const keptTags = currentTags.filter((t) => !t.startsWith('source:'));
    const hasProject = keptTags.some((t) => t.startsWith('project:'));
    const tags = [NOTE_FILE_TAG, ...keptTags, ...(!hasProject && opts.project ? [`project:${opts.project}`] : [])];

    const written = remember({
      name,
      type: owner.type!,
      title: owner.title,
      observations: owner.observations,
      tags,
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
    });
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
  if (r.more) parts.push(`${r.more} more not processed (per-run cap)`);
  return parts.join(', ');
}
