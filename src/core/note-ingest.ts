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
  /** Memories newly tagged `source:note-file:missing` this run. */
  markedMissing: string[];
  /** Files looked at and not ingested, with the reason, by relative path. */
  skipped: Array<{ path: string; reason: string }>;
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

/**
 * Ingest every note file under `dir`. Throws when `dir` is not a readable
 * directory; everything file-level is reported in the result instead.
 */
export function ingestNoteDirectory(opts: NoteIngestOptions): NoteIngestResult {
  const maxFiles = opts.maxFiles ?? NOTE_DIR_MAX_FILES;
  const maxBytes = opts.maxBytes ?? NOTE_FILE_MAX_BYTES;
  const realDir = fs.realpathSync(opts.dir);
  if (!fs.statSync(realDir).isDirectory()) throw new Error(`not a directory: ${opts.dir}`);
  const dirId = createHash('sha256').update(realDir).digest('hex').slice(0, 16);

  const { files, symlinks } = discover(realDir);
  const result: NoteIngestResult = {
    dirId,
    discovered: files.length,
    created: [],
    replaced: [],
    unchanged: 0,
    markedMissing: [],
    skipped: symlinks.map((abs) => ({ path: relPath(realDir, abs), reason: 'symlink refused' })),
    more: 0,
  };

  const db = getDatabase();
  const existingStmt = db.prepare(
    `SELECT e.id, e.metadata, e.status,
            EXISTS(SELECT 1 FROM tags t WHERE t.entity_id = e.id AND t.tag = ?) AS is_note,
            EXISTS(SELECT 1 FROM tags t WHERE t.entity_id = e.id AND t.tag = ?) AS is_missing
       FROM entities e WHERE e.name = ?`,
  );

  // What this directory already contributed, keyed by relative path: the
  // stat fingerprint lets an unchanged file be recognised WITHOUT reading it,
  // so a re-run costs one lstat per file and — because such files do not
  // count toward the per-run cap — a directory larger than the cap makes
  // progress on every run instead of re-reading the same first files.
  const noteRows = db.prepare(
    `SELECT e.id, e.name, e.metadata,
            EXISTS(SELECT 1 FROM tags m WHERE m.entity_id = e.id AND m.tag = ?) AS is_missing
       FROM entities e
       JOIN tags t ON t.entity_id = e.id AND t.tag = ?`,
  ).all(NOTE_FILE_MISSING_TAG, NOTE_FILE_TAG) as Array<{ id: number; name: string; metadata: string | null; is_missing: number }>;
  const known = new Map<string, { name: string; mtime: unknown; size: unknown; missing: boolean }>();
  for (const row of noteRows) {
    const prov = parseProvenance(row.metadata);
    if (prov.note_dir_id === dirId && typeof prov.note_path === 'string') {
      known.set(prov.note_path, { name: row.name, mtime: prov.note_mtime_ms, size: prov.note_size, missing: row.is_missing === 1 });
    }
  }

  // Files skipped for something IN the file (no frontmatter, no name, empty,
  // too large) are remembered by the same stat fingerprint, in
  // memesh_metadata so the CLI and the Stop hook share it. Without this they
  // were re-read on every run and used up the per-run cap: a directory whose
  // first files were all unusable never reached its real notes, and the
  // hook's "more to do" flag never cleared.
  const skipKey = `note_ingest_skips:${dirId}`;
  const skipRow = db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(skipKey) as { value: string } | undefined;
  let priorSkips: Record<string, { mtime: number; size: number; reason: string }> = {};
  try {
    const parsedSkips = skipRow ? JSON.parse(skipRow.value) as unknown : {};
    if (parsedSkips && typeof parsedSkips === 'object') priorSkips = parsedSkips as typeof priorSkips;
  } catch {
    // A corrupt cache only costs re-reading the skipped files once; it is
    // rewritten below.
    priorSkips = {};
  }
  const nextSkips: typeof priorSkips = {};
  // name → the file that owns it. Seeded with every file this directory
  // already contributed, so a second file claiming the name is refused even
  // when the owner is unchanged (and therefore never read this run), and
  // whichever of the two sorts first.
  const seenNames = new Map<string, string>();
  const presentRels = new Set(files.map((abs) => relPath(realDir, abs)));
  for (const [rel, k] of known) if (presentRels.has(rel)) seenNames.set(k.name, rel);

  let read = 0;
  for (const abs of files) {
    const rel = relPath(realDir, abs);
    const skip = (reason: string) => { result.skipped.push({ path: rel, reason }); };
    let raw: Buffer;
    let stat: fs.Stats;
    // A skip decided by the file's own content: fingerprinted, so the next
    // run reports it without reading it again.
    const contentSkip = (reason: string) => {
      skip(reason);
      nextSkips[rel] = { mtime: stat.mtimeMs, size: stat.size, reason };
    };
    try {
      stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink()) { skip('symlink refused'); continue; }
      const prior = known.get(rel);
      if (prior && !prior.missing && prior.mtime === stat.mtimeMs && prior.size === stat.size) {
        result.unchanged++;
        continue;
      }
      const priorSkip = priorSkips[rel];
      if (priorSkip && priorSkip.mtime === stat.mtimeMs && priorSkip.size === stat.size) {
        skip(priorSkip.reason);
        nextSkips[rel] = priorSkip;
        continue;
      }
      if (read >= maxFiles) { result.more++; continue; }
      read++;
      if (stat.size > maxBytes) { contentSkip(`larger than ${Math.round(maxBytes / 1024)} KB`); continue; }
      const real = fs.realpathSync(abs);
      if (!real.startsWith(realDir + path.sep)) { skip('resolves outside the directory'); continue; }
      raw = fs.readFileSync(real);
    } catch (err) {
      skip(`unreadable: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
      continue;
    }

    const parsed = parseFrontmatter(raw.toString('utf8'));
    if (!parsed) { contentSkip('no frontmatter — a note file needs a `---` block with a name'); continue; }
    // Same hygiene as every other field: the name is stored and shown too.
    const rawName = stringField(parsed.data, 'name');
    const name = rawName ? sanitizeNoteText(rawName).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 255) : '';
    if (!name) { contentSkip('frontmatter has no name'); continue; }
    // Two files claiming one name would take turns replacing the same memory
    // on every run. The first in path order keeps it; the other is reported.
    const firstWithName = seenNames.get(name);
    if (firstWithName && firstWithName !== rel) { skip(`name "${name}" already used by ${firstWithName} in this directory`); continue; }
    seenNames.set(name, rel);

    const metaBlock = parsed.data.metadata;
    const rawType = (typeof metaBlock === 'object' ? metaBlock.type : undefined) ?? stringField(parsed.data, 'type');
    const type = (rawType ? sanitizeNoteText(rawType).slice(0, 100) : '') || NOTE_DEFAULT_TYPE;
    const description = stringField(parsed.data, 'description');
    const cleanDescription = description ? sanitizeNoteText(description) : '';
    let observations = splitObservations(sanitizeNoteText(parsed.body));
    if (observations.length === 0 && cleanDescription) observations = [cleanDescription];
    if (observations.length === 0) { contentSkip('empty note — no description and no body'); continue; }
    observations = observations.slice(0, NOTE_MAX_OBSERVATIONS);
    const title = truncateTitle(cleanDescription || observations[0]);

    const contentHash = createHash('sha256').update(raw).digest('hex');
    const existing = existingStmt.get(NOTE_FILE_TAG, NOTE_FILE_MISSING_TAG, name) as ExistingRow | undefined;
    if (existing) {
      const prov = parseProvenance(existing.metadata);
      // Never overwrite a memory that did not come from a note file, nor one
      // ingested from a different directory — two projects' memory
      // directories may well both contain a `feedback_testing.md`, and
      // letting them take turns replacing one entity would churn history
      // on every run.
      if (!existing.is_note) { skip(`name "${name}" belongs to a memory that did not come from a note file`); continue; }
      if (prov.note_dir_id !== dirId) { skip(`name "${name}" was already ingested from another note directory`); continue; }
      // A memory the user archived with `forget` stays archived: editing the
      // file must not quietly undo an explicit forget.
      if (existing.status === 'archived') { skip(`memory "${name}" was archived with forget; not re-ingested`); continue; }
      if (prov.content_hash === contentHash && prov.note_path === rel && !existing.is_missing) {
        // Same bytes, new mtime (a `touch`, a checkout): refresh the stat
        // fingerprint so the next run can skip the read again. Provenance
        // only — nothing searchable changes, so no FTS work.
        const meta = JSON.parse(existing.metadata ?? '{}') as Record<string, unknown>;
        meta.provenance = { ...prov, note_mtime_ms: stat.mtimeMs, note_size: stat.size };
        db.prepare('UPDATE entities SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), existing.id);
        result.unchanged++;
        continue;
      }
    }

    // Tags: the file owns `source:*`; everything else a person added to the
    // memory survives a file change. The project tag is set on first
    // ingestion and then kept — the CLI and the hook may run from different
    // directories, and the memory must not flip between projects with them.
    const currentTags = existing
      ? (db.prepare('SELECT tag FROM tags WHERE entity_id = ?').all(existing.id) as { tag: string }[]).map((t) => t.tag)
      : [];
    const keptTags = currentTags.filter((t) => !t.startsWith('source:'));
    const hasProject = keptTags.some((t) => t.startsWith('project:'));
    const tags = [NOTE_FILE_TAG, ...keptTags, ...(!hasProject && opts.project ? [`project:${opts.project}`] : [])];

    remember({
      name,
      type,
      title,
      observations,
      tags,
      replace: true,
      // Same stance as the JSON importer: text from a file is not a trusted
      // re-assertion and must not lift confidence.
      trustOverride: 'untrusted',
      provenanceOverride: {
        source: 'note-file',
        note_path: rel,
        content_hash: contentHash,
        note_dir_id: dirId,
        note_mtime_ms: stat.mtimeMs,
        note_size: stat.size,
      },
      sourceHost: 'note-file',
    });
    (existing ? result.replaced : result.created).push(name);
  }

  db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run(skipKey, JSON.stringify(nextSkips));

  // Missing sweep. The "present" set is EVERY discovered file, not only the
  // processed ones: a file past the per-run cap, or skipped for its size, is
  // still on disk, and tagging its memory missing would be a false report.
  const present = presentRels;
  // Tags are not part of the FTS document (name, title, observations are), so
  // adding one needs no index rebuild.
  const tagMissing = db.prepare('INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)');
  for (const row of noteRows) {
    if (row.is_missing) continue;
    const prov = parseProvenance(row.metadata);
    if (prov.note_dir_id !== dirId || typeof prov.note_path !== 'string') continue;
    if (present.has(prov.note_path)) continue;
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
    `${r.skipped.length} skipped`,
  ];
  if (r.markedMissing.length) parts.push(`${r.markedMissing.length} marked missing`);
  if (r.more) parts.push(`${r.more} more not processed (per-run cap)`);
  return parts.join(', ');
}
