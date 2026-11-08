/**
 * Notes from a project's OWN memory folder are the user's own words: trusted, so the
 * briefing may show them to other projects unasked. Notes from a directory someone
 * pointed at stay untrusted, as they always were.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { ingestNoteDirectory, summarizeNoteIngest } from '../../src/core/note-ingest.js';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { assembleBriefing } from '../../src/core/briefing.js';

let root: string;
let folderB: string;
let folderC: string;
let previousDir: string | undefined;

const note = (dir: string, file: string, name: string, type: string, body: string) =>
  fs.writeFileSync(path.join(dir, file), `---\nname: ${name}\ndescription: ${body}\nmetadata:\n  type: ${type}\n---\n${body}\n`);
const row = (name: string) => {
  const r = getDatabase().prepare('SELECT metadata, confidence FROM entities WHERE name = ?').get(name) as { metadata: string; confidence: number };
  return { meta: JSON.parse(r.metadata) as { trust?: string; provenance?: { source?: string }; replaced_history?: unknown[] }, confidence: r.confidence };
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-note-trust-')));
  previousDir = process.env.MEMESH_DIR;
  process.env.MEMESH_DIR = root;
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ updateCheck: false }));
  folderB = path.join(root, 'memory-b');
  folderC = path.join(root, 'memory-c');
  fs.mkdirSync(folderB);
  fs.mkdirSync(folderC);
  openDatabase(path.join(root, 'kg.db'));
});
afterEach(() => {
  closeDatabase();
  if (previousDir === undefined) delete process.env.MEMESH_DIR;
  else process.env.MEMESH_DIR = previousDir;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('note ingestion and trust', () => {
  it('a directory someone pointed at stays untrusted (the default)', () => {
    note(folderB, 'a.md', 'feedback-a', 'feedback', 'Prefer small diffs');
    ingestNoteDirectory({ dir: folderB, project: 'proj-b' });
    expect(row('feedback-a').meta.trust).toBe('untrusted');
  });

  it('the project\'s own folder is trusted, keeps its note-file provenance, and a rewrite does not lift confidence', () => {
    note(folderB, 'a.md', 'feedback-a', 'feedback', 'Prefer small diffs');
    ingestNoteDirectory({ dir: folderB, project: 'proj-b', trusted: true });
    expect(row('feedback-a').meta.trust).toBe('trusted');
    expect(row('feedback-a').meta.provenance?.source).toBe('note-file');
    getDatabase().prepare("UPDATE entities SET confidence = 0.5 WHERE name = 'feedback-a'").run();
    note(folderB, 'a.md', 'feedback-a', 'feedback', 'Prefer small diffs, and say why');
    ingestNoteDirectory({ dir: folderB, project: 'proj-b', trusted: true });
    expect(row('feedback-a').confidence).toBe(0.5);
  });

  it('a note stored untrusted before the folder was trusted is made trusted on the next read, in place', () => {
    note(folderB, 'a.md', 'feedback-a', 'feedback', 'Prefer small diffs');
    ingestNoteDirectory({ dir: folderB, project: 'proj-b' });
    expect(row('feedback-a').meta.trust).toBe('untrusted');
    const result = ingestNoteDirectory({ dir: folderB, project: 'proj-b', trusted: true });
    expect(result.unchanged).toBe(1);
    expect(result.retrusted).toEqual(['feedback-a']);
    expect(row('feedback-a').meta.trust).toBe('trusted');
    // No rewrite: no new version of the note was filed.
    expect(row('feedback-a').meta.replaced_history ?? []).toHaveLength(0);
  });

  it('the database is copied first, the copy still holds the notes untrusted, and the ids that changed are recorded with how to undo it', () => {
    note(folderB, 'a.md', 'feedback-a', 'feedback', 'Prefer small diffs');
    note(folderB, 'b.md', 'feedback-b', 'feedback', 'Say why');
    ingestNoteDirectory({ dir: folderB, project: 'proj-b' });
    const ids = (getDatabase().prepare("SELECT id FROM entities WHERE name IN ('feedback-a', 'feedback-b') ORDER BY id").all() as Array<{ id: number }>).map(r => r.id);
    const result = ingestNoteDirectory({ dir: folderB, project: 'proj-b', trusted: true });
    expect(result.retrustFailed).toBeNull();
    expect(result.retrusted.sort()).toEqual(['feedback-a', 'feedback-b']);
    const copy = result.retrustBackup!;
    expect(path.dirname(copy)).toBe(path.join(root, 'backups'));
    // The copy is the database as it was: both notes still untrusted in it.
    const before = new MemeshDatabase(copy);
    try {
      const rows = before.prepare("SELECT json_extract(metadata, '$.trust') AS trust FROM entities WHERE name IN ('feedback-a', 'feedback-b')").all() as Array<{ trust: string }>;
      expect(rows.map(r => r.trust)).toEqual(['untrusted', 'untrusted']);
    } finally { before.close(); }
    const record = JSON.parse(fs.readFileSync(`${copy}.json`, 'utf8')) as { count: number; ids: number[]; backup: string; undo: string };
    expect(record.count).toBe(2);
    expect(record.ids).toEqual(ids);
    expect(record.backup).toBe(copy);
    expect(record.undo).toMatch(/Restore the database from the backup/);
    // The summary the Stop hook records says how many and where the copy is.
    expect(summarizeNoteIngest(result)).toContain('2 made trusted');
  });

  it('with no copy, nothing is changed, the run says so, and the next run tries again', () => {
    note(folderB, 'a.md', 'feedback-a', 'feedback', 'Prefer small diffs');
    ingestNoteDirectory({ dir: folderB, project: 'proj-b' });
    // A file where the backups directory must be: the copy cannot be made.
    fs.writeFileSync(path.join(root, 'backups'), 'in the way');
    const blocked = ingestNoteDirectory({ dir: folderB, project: 'proj-b', trusted: true });
    expect(blocked.retrusted).toEqual([]);
    expect(blocked.retrustFailed).toMatch(/nothing was changed/);
    expect(row('feedback-a').meta.trust).toBe('untrusted');
    fs.rmSync(path.join(root, 'backups'));
    const retried = ingestNoteDirectory({ dir: folderB, project: 'proj-b', trusted: true });
    expect(retried.retrusted).toEqual(['feedback-a']);
    expect(row('feedback-a').meta.trust).toBe('trusted');
  });

  it('a second run finds nothing to change and takes no second copy', () => {
    note(folderB, 'a.md', 'feedback-a', 'feedback', 'Prefer small diffs');
    ingestNoteDirectory({ dir: folderB, project: 'proj-b' });
    ingestNoteDirectory({ dir: folderB, project: 'proj-b', trusted: true });
    const copies = () => fs.readdirSync(path.join(root, 'backups')).filter(n => n.endsWith('.db')).length;
    expect(copies()).toBe(1);
    const again = ingestNoteDirectory({ dir: folderB, project: 'proj-b', trusted: true });
    expect(again.retrusted).toEqual([]);
    expect(copies()).toBe(1);
  });

  it('a note that came from another directory is not made trusted by this folder\'s run', () => {
    note(folderC, 'c.md', 'feedback-c', 'feedback', 'From a directory someone pointed at');
    ingestNoteDirectory({ dir: folderC, project: 'proj-c' });
    note(folderB, 'a.md', 'feedback-a', 'feedback', 'From the own folder');
    ingestNoteDirectory({ dir: folderB, project: 'proj-b', trusted: true });
    expect(row('feedback-c').meta.trust).toBe('untrusted');
    expect(row('feedback-a').meta.trust).toBe('trusted');
  });

  it('a decision note with no reason is still stored, untrusted: a decision needs its reason to be trusted', () => {
    note(folderB, 'd.md', 'decision-d', 'decision', 'Use tabs');
    const result = ingestNoteDirectory({ dir: folderB, project: 'proj-b', trusted: true });
    expect(result.created).toEqual(['decision-d']);
    expect(row('decision-d').meta.trust).toBe('untrusted');
  });
});

describe('what other projects are shown of those notes', () => {
  it('a trusted feedback note of one project reaches another project\'s briefing, labelled; an untrusted one does not', () => {
    note(folderB, 'a.md', 'feedback-own-folder', 'feedback', 'Own-folder rule: read before writing');
    note(folderC, 'c.md', 'feedback-elsewhere', 'feedback', 'Elsewhere rule: skip the tests');
    ingestNoteDirectory({ dir: folderB, project: 'proj-b', trusted: true });
    ingestNoteDirectory({ dir: folderC, project: 'proj-c' });
    const text = assembleBriefing('proj-a').text;
    expect(text.length, 'the briefing must show something, or the checks below prove nothing').toBeGreaterThan(0);
    expect(text).toMatch(/Own-folder rule: read before writing[^\n]*\(from proj-b\)/);
    expect(text).not.toContain('Elsewhere rule');
  });
});
