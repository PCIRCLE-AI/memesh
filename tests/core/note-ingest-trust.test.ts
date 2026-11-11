/**
 * Notes from a project's OWN memory folder (what the user and the agent wrote there) are trusted, so the
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
    expect(blocked.retrustFailed).toMatch(/none of them was made trusted/);
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

describe('a note stored untrusted is made trusted only by the copied, recorded change', () => {
  const idOf = (name: string) => (getDatabase().prepare('SELECT id FROM entities WHERE name = ?').get(name) as { id: number }).id;
  const decision = (dir: string, file: string, name: string, lines: string[]) =>
    fs.writeFileSync(path.join(dir, file), `---\nname: ${name}\ndescription: d\nmetadata:\n  type: decision\n---\n${lines.join('\n\n')}\n`);
  const trustIn = (dbFile: string, name: string) => {
    const copy = new MemeshDatabase(dbFile);
    try {
      return (copy.prepare("SELECT json_extract(metadata, '$.trust') AS trust FROM entities WHERE name = ?").get(name) as { trust: string }).trust;
    } finally { copy.close(); }
  };
  const copies = () => fs.readdirSync(path.join(root, 'backups')).filter(n => n.endsWith('.db')).sort();

  it('a NEW decision note that states its reason is stored trusted by the read itself', () => {
    decision(folderB, 'd.md', 'decision-d', ['Use tabs', 'Why: diffs stay small']);
    ingestNoteDirectory({ dir: folderB, project: 'proj-b', trusted: true });
    expect(row('decision-d').meta.trust).toBe('trusted');
  });

  it('a decision note with its reason, stored before the folder was trusted, becomes trusted like any other note', () => {
    decision(folderB, 'd.md', 'decision-d', ['Use tabs', 'Why: diffs stay small']);
    ingestNoteDirectory({ dir: folderB, project: 'proj-b' });
    expect(row('decision-d').meta.trust).toBe('untrusted');
    const result = ingestNoteDirectory({ dir: folderB, project: 'proj-b', trusted: true });
    expect(result.retrusted).toEqual(['decision-d']);
    expect(row('decision-d').meta.trust).toBe('trusted');
  });

  it('an EDITED note stored untrusted: the copy still holds it untrusted and the record lists its id', () => {
    note(folderB, 'a.md', 'feedback-a', 'feedback', 'Prefer small diffs');
    ingestNoteDirectory({ dir: folderB, project: 'proj-b' });
    const id = idOf('feedback-a');
    note(folderB, 'a.md', 'feedback-a', 'feedback', 'Prefer small diffs, and say why');
    const result = ingestNoteDirectory({ dir: folderB, project: 'proj-b', trusted: true });
    expect(result.replaced).toEqual(['feedback-a']);
    expect(result.retrusted).toEqual(['feedback-a']);
    expect(row('feedback-a').meta.trust).toBe('trusted');
    expect(trustIn(result.retrustBackup!, 'feedback-a')).toBe('untrusted');
    const record = JSON.parse(fs.readFileSync(`${result.retrustBackup}.json`, 'utf8')) as { ids: number[] };
    expect(record.ids).toEqual([id]);
  });

  it('an EDITED note stored untrusted stays untrusted when no copy can be made, and the run says nothing was made trusted', () => {
    note(folderB, 'a.md', 'feedback-a', 'feedback', 'Prefer small diffs');
    ingestNoteDirectory({ dir: folderB, project: 'proj-b' });
    fs.writeFileSync(path.join(root, 'backups'), 'in the way');
    note(folderB, 'a.md', 'feedback-a', 'feedback', 'Prefer small diffs, and say why');
    const result = ingestNoteDirectory({ dir: folderB, project: 'proj-b', trusted: true });
    expect(result.replaced).toEqual(['feedback-a']);
    expect(row('feedback-a').meta.trust).toBe('untrusted');
    expect(result.retrustFailed).toMatch(/none of them was made trusted/);
  });

  it('a note whose file was deleted is not made trusted', () => {
    note(folderB, 'a.md', 'feedback-a', 'feedback', 'Prefer small diffs');
    ingestNoteDirectory({ dir: folderB, project: 'proj-b' });
    fs.rmSync(path.join(folderB, 'a.md'));
    const result = ingestNoteDirectory({ dir: folderB, project: 'proj-b', trusted: true });
    expect(result.markedMissing).toEqual(['feedback-a']);
    expect(result.retrusted).toEqual([]);
    expect(row('feedback-a').meta.trust).toBe('untrusted');
  });

  it('a memory with metadata that is not JSON does not stop the folder\'s notes from being made trusted', () => {
    note(folderB, 'a.md', 'feedback-a', 'feedback', 'Prefer small diffs');
    ingestNoteDirectory({ dir: folderB, project: 'proj-b' });
    getDatabase().prepare("INSERT INTO entities (name, type, metadata) VALUES ('junk', 'note', '{oops')").run();
    const result = ingestNoteDirectory({ dir: folderB, project: 'proj-b', trusted: true });
    expect(result.retrusted).toEqual(['feedback-a']);
    expect(row('feedback-a').meta.trust).toBe('trusted');
  });

  it('undone with the SQL the record gives, a note stays untrusted through the next runs, edited or not', () => {
    note(folderB, 'a.md', 'feedback-a', 'feedback', 'Prefer small diffs');
    note(folderB, 'b.md', 'feedback-b', 'feedback', 'Say why');
    ingestNoteDirectory({ dir: folderB, project: 'proj-b' });
    const lifted = ingestNoteDirectory({ dir: folderB, project: 'proj-b', trusted: true });
    const record = JSON.parse(fs.readFileSync(`${lifted.retrustBackup}.json`, 'utf8')) as { ids: number[]; undo: string };
    getDatabase().exec(record.undo.slice(record.undo.indexOf('UPDATE')).replace('<ids>', record.ids.join(',')));
    expect(row('feedback-a').meta.trust).toBe('untrusted');
    note(folderB, 'a.md', 'feedback-a', 'feedback', 'Prefer small diffs, edited after the undo');
    const touched = path.join(folderB, 'b.md');
    fs.utimesSync(touched, new Date(), new Date(Date.now() + 5000));
    const next = ingestNoteDirectory({ dir: folderB, project: 'proj-b', trusted: true });
    expect(next.retrusted).toEqual([]);
    expect(row('feedback-a').meta.trust).toBe('untrusted');
    expect(row('feedback-b').meta.trust).toBe('untrusted');
    expect(copies()).toHaveLength(1);
  });

  it('undone by restoring the copy, the notes stay untrusted through the next run', () => {
    note(folderB, 'a.md', 'feedback-a', 'feedback', 'Prefer small diffs');
    ingestNoteDirectory({ dir: folderB, project: 'proj-b' });
    const lifted = ingestNoteDirectory({ dir: folderB, project: 'proj-b', trusted: true });
    closeDatabase();
    for (const suffix of ['-wal', '-shm']) fs.rmSync(path.join(root, `kg.db${suffix}`), { force: true });
    fs.copyFileSync(lifted.retrustBackup!, path.join(root, 'kg.db'));
    openDatabase(path.join(root, 'kg.db'));
    expect(row('feedback-a').meta.trust).toBe('untrusted');
    note(folderB, 'a.md', 'feedback-a', 'feedback', 'Prefer small diffs, edited after the restore');
    const next = ingestNoteDirectory({ dir: folderB, project: 'proj-b', trusted: true });
    expect(next.retrusted).toEqual([]);
    expect(row('feedback-a').meta.trust).toBe('untrusted');
  });

  it('a note a later run adds to an already trusted folder needs no copy', () => {
    note(folderB, 'a.md', 'feedback-a', 'feedback', 'Prefer small diffs');
    ingestNoteDirectory({ dir: folderB, project: 'proj-b' });
    ingestNoteDirectory({ dir: folderB, project: 'proj-b', trusted: true });
    note(folderB, 'c.md', 'feedback-c', 'feedback', 'Added later');
    ingestNoteDirectory({ dir: folderB, project: 'proj-b', trusted: true });
    expect(row('feedback-c').meta.trust).toBe('trusted');
    expect(copies()).toHaveLength(1);
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

  it('at every level, another project\'s memory-folder decisions and lessons stay in it; its feedback travels', () => {
    note(folderB, 'a.md', 'feedback-own-folder', 'feedback', 'Own-folder rule: read before writing');
    fs.writeFileSync(path.join(folderB, 'd.md'), '---\nname: folder-decision\ndescription: d\nmetadata:\n  type: decision\n---\nFolder decision: deploy with vault\n\nWhy: ops asked\n');
    note(folderB, 'l.md', 'folder-lesson', 'lesson_learned', 'Folder lesson: the staging host is slow');
    ingestNoteDirectory({ dir: folderB, project: 'proj-b', trusted: true });
    expect(row('folder-decision').meta.trust).toBe('trusted');
    const previous = process.env.MEMESH_BRIEFING;
    try {
      for (const level of ['minimal', 'standard', 'full']) {
        process.env.MEMESH_BRIEFING = level;
        const text = assembleBriefing('proj-a').text;
        expect(text, level).toContain('Own-folder rule: read before writing');
        expect(text, level).not.toContain('Folder decision');
        expect(text, level).not.toContain('Folder lesson');
      }
    } finally {
      if (previous === undefined) delete process.env.MEMESH_BRIEFING;
      else process.env.MEMESH_BRIEFING = previous;
    }
  });

  it('a trusted note whose file the user deleted is no longer shown to another project', () => {
    note(folderB, 'a.md', 'feedback-own-folder', 'feedback', 'Own-folder rule: read before writing');
    note(folderB, 'b.md', 'feedback-deleted', 'feedback', 'Deleted rule: never mind');
    ingestNoteDirectory({ dir: folderB, project: 'proj-b', trusted: true });
    fs.rmSync(path.join(folderB, 'b.md'));
    ingestNoteDirectory({ dir: folderB, project: 'proj-b', trusted: true });
    const text = assembleBriefing('proj-a').text;
    expect(text).toContain('Own-folder rule: read before writing');
    expect(text).not.toContain('Deleted rule');
  });

  it('a memory of another project with metadata that is not JSON does not break the briefing', () => {
    note(folderB, 'a.md', 'feedback-own-folder', 'feedback', 'Own-folder rule: read before writing');
    ingestNoteDirectory({ dir: folderB, project: 'proj-b', trusted: true });
    getDatabase().prepare("INSERT INTO entities (name, type, metadata) VALUES ('broken-pref', 'preference', '{not json')").run();
    getDatabase().prepare("INSERT INTO tags (entity_id, tag) SELECT id, 'project:proj-c' FROM entities WHERE name = 'broken-pref'").run();
    expect(assembleBriefing('proj-a').text).toContain('Own-folder rule: read before writing');
  });
});
