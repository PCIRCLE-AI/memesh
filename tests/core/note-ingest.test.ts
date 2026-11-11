// #324 piece C: note-file ingestion.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { remember, forget } from '../../src/core/operations.js';
import {
  endPrivateSession,
  holdOutNoteFiles,
  ingestNoteDirectory,
  markPrivateSession,
  NOTE_HOLDS_UNREADABLE,
  NOTE_HOLDS_DIR_UNREADABLE,
  NOTE_MARKERS_UNREADABLE,
  NOTE_FILE_MAX_BYTES,
  renewPrivateSession,
  summarizeNoteHolds,
  parseFrontmatter,
  NOTE_FILE_TAG,
  NOTE_FILE_MISSING_TAG,
  summarizeNoteIngest,
} from '../../src/core/note-ingest.js';
import { getMemeshDirFromDbPath } from '../../src/core/paths.js';
import { PRIVATE_WINDOW_MS } from '../../src/core/private-session.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

const fixture = useTestDatabase('memesh-note-ingest-');

// Holds and markers live beside the database. Keep them in this test's own folder: without this they would
// be $HOME/.memesh, and the `beforeEach` of the private-session blocks below would delete the real ones.
beforeEach(() => { vi.stubEnv('MEMESH_DB_PATH', fixture.dbPath); });
afterEach(() => { vi.unstubAllEnvs(); });

it('keeps the holds and markers of these tests out of $HOME/.memesh', () => {
  expect(getMemeshDirFromDbPath()).toBe(fixture.tmpDir);
});
const kg = () => new KnowledgeGraph(getDatabase());

function note(name: string, description: string, type: string, body: string): string {
  return `---\nname: ${name}\ndescription: "${description}"\nmetadata: \n  node_type: memory\n  type: ${type}\n---\n\n${body}\n`;
}

function makeDir(files: Record<string, string>): string {
  const dir = path.join(fixture.tmpDir, 'notes');
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

describe('parseFrontmatter', () => {
  it('reads top-level keys, quoted values and one nested map', () => {
    const fm = parseFrontmatter(note('feedback_x', 'KT wants: "no squash"', 'feedback', 'body'))!;
    expect(fm.data.name).toBe('feedback_x');
    // The helper wraps the value in double quotes, so the line the parser sees
    // is `description: "KT wants: "no squash""` — the inner pair has to survive
    // and the outer pair has to go. Written as a literal: this used to call
    // .replace(/"/g, '"'), which replaces a quote with itself and made the
    // assertion look like it was testing unescaping while testing nothing.
    expect(fm.data.description).toBe('KT wants: "no squash"');
    expect(fm.data.metadata).toEqual({ node_type: 'memory', type: 'feedback' });
    expect(fm.body.trim()).toBe('body');
  });

  it('returns null without an opening and closing fence', () => {
    expect(parseFrontmatter('# Title\n\nbody')).toBeNull();
    expect(parseFrontmatter('---\nname: x\nno close')).toBeNull();
  });
});

describe('ingestNoteDirectory', () => {
  it('three frontmatter notes → three entities; a file without frontmatter is reported, not guessed at', () => {
    const dir = makeDir({
      'a.md': note('note_a', 'Alpha decision', 'decision', 'Alpha body one.\n\nAlpha body two.'),
      'b.md': note('note_b', 'Beta lesson', 'lesson', 'Beta body.'),
      'sub/c.md': note('note_c', 'Gamma fact', 'fact', 'Gamma body.'),
      'MEMORY.md': '- [index](a.md) — no frontmatter here',
    });
    const r = ingestNoteDirectory({ trusted: false, dir, project: 'proj' });
    expect(r.created).toHaveLength(3);
    expect(r.created.sort()).toEqual(['note_a', 'note_b', 'note_c']);
    expect(r.skipped).toEqual([{ path: 'MEMORY.md', reason: expect.stringMatching(/no frontmatter/) }]);

    const a = kg().getEntity('note_a')!;
    expect(a.type).toBe('decision');
    expect(a.title).toBe('Alpha decision');
    expect(a.observations).toEqual(['Alpha body one.', 'Alpha body two.']);
    expect(a.tags.sort()).toEqual(['project:proj', NOTE_FILE_TAG].sort());
    const prov = a.metadata?.provenance as Record<string, unknown>;
    expect(prov.note_path).toBe('a.md');
    expect(prov.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(prov.source).toBe('note-file');
    // Relative only — the absolute directory never reaches the row.
    expect(JSON.stringify(a.metadata)).not.toContain(fixture.tmpDir);
    expect(kg().getEntity('note_c')!.metadata?.provenance).toMatchObject({ note_path: 'sub/c.md' });
    expect(kg().search('gamma').map((e) => e.name)).toContain('note_c');
  });

  it('a note first stored with no project is updated in place by a run that names one, and stays without a project', () => {
    const dir = makeDir({
      'a.md': note('note_a', 'Alpha', 'decision', 'alpha one'),
      'b.md': note('note_b', 'Beta', 'lesson', 'beta one'),
    });
    ingestNoteDirectory({ trusted: false, dir });
    fs.writeFileSync(path.join(dir, 'a.md'), note('note_a', 'Alpha', 'decision', 'alpha two'));
    fs.writeFileSync(path.join(dir, 'b.md'), note('note_b', 'Beta', 'lesson', 'beta two'));
    fs.writeFileSync(path.join(dir, 'c.md'), note('note_c', 'Gamma', 'decision', 'gamma one'));
    const second = ingestNoteDirectory({ trusted: false, dir, project: 'proj' });
    expect(second.replaced.sort()).toEqual(['note_a', 'note_b']);
    expect(second.created).toEqual(['note_c']);
    expect(kg().getEntity('note_a')!.observations).toEqual(['alpha two']);
    expect(kg().getEntity('note_b')!.observations).toEqual(['beta two']);
    expect(kg().getEntity('note_a')!.tags.filter((t) => t.startsWith('project:'))).toEqual([]);
    expect(kg().getEntity('note_b')!.tags.filter((t) => t.startsWith('project:'))).toEqual([]);
    expect(kg().getEntity('note_c')!.tags).toContain('project:proj');
    expect(ingestNoteDirectory({ trusted: false, dir, project: 'proj' })).toMatchObject({ created: [], replaced: [], unchanged: 3 });
  });

  it('an edited note whose memory already belongs to two projects is updated, keeps both, and does not stop the run', () => {
    const dir = makeDir({
      'a.md': note('note_a', 'Alpha', 'decision', 'alpha one'),
      'b.md': note('note_b', 'Beta', 'lesson', 'beta one'),
    });
    ingestNoteDirectory({ trusted: false, dir, project: 'A' });
    // An older memory that two projects share, last seen missing.
    const db = getDatabase();
    const id = (db.prepare('SELECT id FROM entities WHERE name = ?').get('note_a') as { id: number }).id;
    db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(id, 'project:B');
    db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(id, NOTE_FILE_MISSING_TAG);

    fs.writeFileSync(path.join(dir, 'a.md'), note('note_a', 'Alpha', 'decision', 'alpha two'));
    fs.writeFileSync(path.join(dir, 'b.md'), note('note_b', 'Beta', 'lesson', 'beta two'));
    const r = ingestNoteDirectory({ trusted: false, dir, project: 'A' });
    expect(r.skipped).toEqual([]);
    expect(r.replaced.sort()).toEqual(['note_a', 'note_b']);
    const a = kg().getEntity('note_a')!;
    expect(a.observations).toEqual(['alpha two']);
    expect(a.tags.filter((t) => t.startsWith('project:')).sort()).toEqual(['project:A', 'project:B']);
    expect(a.tags).toContain(NOTE_FILE_TAG);
    expect(a.tags).not.toContain(NOTE_FILE_MISSING_TAG);
    expect(kg().getEntity('note_b')!.observations).toEqual(['beta two']);
    // A write that itself names two projects is still refused.
    expect(() => remember({ name: 'two-new', type: 'fact', observations: ['x'], tags: ['project:A', 'project:B'] }))
      .toThrow(/more than one project tag/);
  });

  it('a shared memory is not updated by a run of a project it does not belong to; the file is reported and the rest is read', () => {
    const dir = makeDir({
      'a.md': note('note_a', 'Alpha', 'decision', 'alpha one'),
      'b.md': note('note_b', 'Beta', 'lesson', 'beta one'),
    });
    ingestNoteDirectory({ trusted: false, dir, project: 'A' });
    const db = getDatabase();
    const id = (db.prepare('SELECT id FROM entities WHERE name = ?').get('note_a') as { id: number }).id;
    db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(id, 'project:B');

    fs.writeFileSync(path.join(dir, 'a.md'), note('note_a', 'Alpha', 'decision', 'alpha two'));
    fs.writeFileSync(path.join(dir, 'b.md'), note('note_b', 'Beta', 'lesson', 'beta two'));
    const r = ingestNoteDirectory({ trusted: false, dir, project: 'C' });
    expect(r.skipped).toEqual([{ path: 'a.md', reason: expect.stringContaining('belongs to several projects (A, B)') }]);
    expect(r.refusedNow).toBe(1);
    expect(r.replaced).toEqual(['note_b']);
    expect(kg().getEntity('note_a')!.observations).toEqual(['alpha one']);
    expect(kg().getEntity('note_b')!.observations).toEqual(['beta two']);

    // The same refusal again is not news, but the file is still read:
    const again = ingestNoteDirectory({ trusted: false, dir, project: 'C' });
    expect(again.skipped).toHaveLength(1);
    expect(again.refusedNow).toBe(0);
    // so a run of a project it belongs to updates it, file unchanged since.
    const member = ingestNoteDirectory({ trusted: false, dir, project: 'A' });
    expect(member.replaced).toEqual(['note_a']);
    expect(kg().getEntity('note_a')!.observations).toEqual(['alpha two']);
  });

  it('re-import of unchanged files is a no-op; editing one replaces that entity only', () => {
    const dir = makeDir({
      'a.md': note('note_a', 'Alpha', 'decision', 'old alpha text'),
      'b.md': note('note_b', 'Beta', 'lesson', 'beta text'),
    });
    ingestNoteDirectory({ trusted: false, dir });
    const again = ingestNoteDirectory({ trusted: false, dir });
    expect(again).toMatchObject({ created: [], replaced: [], unchanged: 2 });

    fs.writeFileSync(path.join(dir, 'a.md'), note('note_a', 'Alpha v2', 'decision', 'new alpha text'));
    const third = ingestNoteDirectory({ trusted: false, dir });
    expect(third.replaced).toEqual(['note_a']);
    expect(third.unchanged).toBe(1);

    const a = kg().getEntity('note_a')!;
    expect(a.title).toBe('Alpha v2');
    expect(a.observations).toEqual(['new alpha text']);
    expect((a.metadata?.replaced_history as Array<{ observations: string[] }>)[0].observations).toEqual(['old alpha text']);
    expect(kg().search('old').map((e) => e.name)).not.toContain('note_a');
    expect(kg().getEntity('note_b')!.metadata?.replaced_history).toBeUndefined();
  });

  it('a deleted file tags its memory missing and never deletes it; it clears when the file returns', () => {
    const dir = makeDir({ 'a.md': note('note_a', 'Alpha', 'decision', 'alpha') });
    ingestNoteDirectory({ trusted: false, dir });
    fs.renameSync(path.join(dir, 'a.md'), path.join(fixture.tmpDir, 'a.md.away'));

    const r = ingestNoteDirectory({ trusted: false, dir });
    expect(r.markedMissing).toEqual(['note_a']);
    const a = kg().getEntity('note_a')!;
    expect(a.archived).toBeUndefined();
    expect(a.tags).toContain(NOTE_FILE_MISSING_TAG);
    // Idempotent: a second run does not report it again.
    expect(ingestNoteDirectory({ trusted: false, dir }).markedMissing).toEqual([]);

    fs.renameSync(path.join(fixture.tmpDir, 'a.md.away'), path.join(dir, 'a.md'));
    ingestNoteDirectory({ trusted: false, dir });
    expect(kg().getEntity('note_a')!.tags).not.toContain(NOTE_FILE_MISSING_TAG);
  });

  it('refuses symlinks, even ones pointing at a valid note', () => {
    const outside = path.join(fixture.tmpDir, 'outside.md');
    fs.writeFileSync(outside, note('evil', 'Outside', 'fact', 'outside text'));
    const dir = makeDir({ 'a.md': note('note_a', 'Alpha', 'decision', 'alpha') });
    fs.symlinkSync(outside, path.join(dir, 'link.md'));
    const r = ingestNoteDirectory({ trusted: false, dir });
    expect(r.created).toEqual(['note_a']);
    expect(r.skipped).toContainEqual({ path: 'link.md', reason: 'symlink refused' });
    expect(kg().getEntity('evil')).toBeNull();
  });

  it('skips .git and node_modules and oversized files', () => {
    const dir = makeDir({
      '1.md': note('n1', 'One', 'fact', 'one'),
      '.git/x.md': note('git_note', 'Git', 'fact', 'git'),
      'node_modules/y.md': note('nm_note', 'NM', 'fact', 'nm'),
      'big.md': note('big', 'Big', 'fact', 'x'.repeat(2000)),
    });
    const r = ingestNoteDirectory({ trusted: false, dir, maxBytes: 1024 });
    expect(r.created).toEqual(['n1']);
    expect(r.skipped).toContainEqual({ path: 'big.md', reason: 'larger than 1 KB' });
    expect(kg().getEntity('git_note')).toBeNull();
    expect(kg().getEntity('nm_note')).toBeNull();
    expect(kg().getEntity('big')).toBeNull();
  });

  it('caps reads per run, reports the rest, and makes progress across runs', () => {
    const dir = makeDir({
      '1.md': note('n1', 'One', 'fact', 'one'),
      '2.md': note('n2', 'Two', 'fact', 'two'),
      '3.md': note('n3', 'Three', 'fact', 'three'),
    });
    const first = ingestNoteDirectory({ trusted: false, dir, maxFiles: 1 });
    expect(first).toMatchObject({ created: ['n1'], more: 2 });
    // Unchanged files are recognised by their stat fingerprint and do not use
    // up the cap, so the next run reaches the next file.
    const second = ingestNoteDirectory({ trusted: false, dir, maxFiles: 1 });
    expect(second).toMatchObject({ created: ['n2'], unchanged: 1, more: 1 });
    expect(ingestNoteDirectory({ trusted: false, dir, maxFiles: 1 })).toMatchObject({ created: ['n3'], unchanged: 2, more: 0 });
  });

  it('a file past the cap is still on disk: its memory is not tagged missing', () => {
    const dir = makeDir({
      '1.md': note('n1', 'One', 'fact', 'one'),
      '2.md': note('n2', 'Two', 'fact', 'two'),
    });
    ingestNoteDirectory({ trusted: false, dir });
    fs.writeFileSync(path.join(dir, '1.md'), note('n1', 'One v2', 'fact', 'one changed'));
    fs.writeFileSync(path.join(dir, '2.md'), note('n2', 'Two v2', 'fact', 'two changed'));
    const capped = ingestNoteDirectory({ trusted: false, dir, maxFiles: 1 });
    expect(capped).toMatchObject({ replaced: ['n1'], more: 1, markedMissing: [] });
    expect(kg().getEntity('n2')!.tags).not.toContain(NOTE_FILE_MISSING_TAG);
  });

  it('never overwrites a memory that did not come from a note file', () => {
    remember({ name: 'shared_name', type: 'decision', why: 'written by hand, not from a file; revisit if it moves into notes', observations: ['hand-written'] });
    const dir = makeDir({ 'a.md': note('shared_name', 'From file', 'decision', 'file text') });
    const r = ingestNoteDirectory({ trusted: false, dir });
    expect(r.created).toEqual([]);
    expect(r.skipped[0].reason).toMatch(/did not come from a note file/);
    expect(kg().getEntity('shared_name')!.observations).toEqual(['hand-written', 'Why: written by hand, not from a file; revisit if it moves into notes']);
  });

  it('does not undo a forget', () => {
    const dir = makeDir({ 'a.md': note('note_a', 'Alpha', 'decision', 'alpha') });
    ingestNoteDirectory({ trusted: false, dir });
    forget({ name: 'note_a' });
    fs.writeFileSync(path.join(dir, 'a.md'), note('note_a', 'Alpha v2', 'decision', 'alpha two'));
    const r = ingestNoteDirectory({ trusted: false, dir });
    expect(r.skipped[0].reason).toMatch(/archived with forget/);
    expect(kg().getEntity('note_a')!.archived).toBe(true);
  });

  it('redacts credential-shaped text from the file body', () => {
    const secret = ['Bearer', 'placeholderplaceholder1234'].join(' ');
    const dir = makeDir({ 'a.md': note('note_a', 'Alpha', 'decision', `curl -H "${secret}"`) });
    ingestNoteDirectory({ trusted: false, dir });
    expect(kg().getEntity('note_a')!.observations.join(' ')).not.toContain('placeholderplaceholder');
  });

  it('throws on a directory that does not exist', () => {
    expect(() => ingestNoteDirectory({ trusted: false, dir: path.join(fixture.tmpDir, 'nope') })).toThrow();
  });

  it('F1: an unusable file is remembered by fingerprint, so it neither eats the cap nor starves real notes', () => {
    const dir = makeDir({
      '0-bad.md': '# no frontmatter here\n',
      '1-good.md': note('good_note', 'Good', 'fact', 'good body'),
    });
    const first = ingestNoteDirectory({ trusted: false, dir, maxFiles: 1 });
    expect(first.created).toHaveLength(0);
    expect(first.more).toBe(1);
    expect(first.skipped[0].path).toBe('0-bad.md');

    const second = ingestNoteDirectory({ trusted: false, dir, maxFiles: 1 });
    expect(second.created).toEqual(['good_note']);
    // Still reported — but from the fingerprint, without using the cap.
    expect(second.skipped.map((x) => x.path)).toContain('0-bad.md');
    expect(second.more).toBe(0);

    // Editing the bad file makes it eligible for a real read again.
    fs.writeFileSync(path.join(dir, '0-bad.md'), note('fixed_note', 'Fixed', 'fact', 'now valid'));
    expect(ingestNoteDirectory({ trusted: false, dir, maxFiles: 1 }).created).toEqual(['fixed_note']);
  });

  it('F3: two files with the same frontmatter name do not take turns replacing one memory', () => {
    const dir = makeDir({
      'a.md': note('dup_name', 'From A', 'fact', 'text a'),
      'b.md': note('dup_name', 'From B', 'fact', 'text b'),
    });
    const r = ingestNoteDirectory({ trusted: false, dir });
    expect(r.created).toEqual(['dup_name']);
    expect(r.skipped).toContainEqual({ path: 'b.md', reason: 'name "dup_name" already used by a.md in this directory' });
    const again = ingestNoteDirectory({ trusted: false, dir });
    expect(again.replaced).toHaveLength(0);
    expect(kg().getEntity('dup_name')!.observations).toEqual(['text a']);
    expect(kg().getEntity('dup_name')!.metadata?.replaced_history).toBeUndefined();
  });

  it('F3: the owner of a name keeps it even when a later-added duplicate sorts first', () => {
    const dir = makeDir({ 'b.md': note('dup2', 'Owner', 'fact', 'owner text') });
    ingestNoteDirectory({ trusted: false, dir });
    fs.writeFileSync(path.join(dir, 'a.md'), note('dup2', 'Intruder', 'fact', 'intruder text'));
    const r = ingestNoteDirectory({ trusted: false, dir });
    expect(r.replaced).toHaveLength(0);
    expect(r.skipped).toContainEqual({ path: 'a.md', reason: 'name "dup2" already used by b.md in this directory' });
    expect(kg().getEntity('dup2')!.observations).toEqual(['owner text']);
  });

  it('F4: the frontmatter name gets the same hygiene as the body', () => {
    const secret = ['Bearer', 'placeholderplaceholder1234'].join(' ');
    const dir = makeDir({ 'a.md': note(`leak ${secret}`, 'Alpha', 'fact', 'alpha') });
    const r = ingestNoteDirectory({ trusted: false, dir });
    expect(r.created).toHaveLength(1);
    expect(r.created[0]).not.toContain('placeholderplaceholder');
    expect(r.created[0]).toContain('***REDACTED***');
  });

  it('F5: a file change keeps tags a person added and the first project tag', () => {
    const dir = makeDir({ 'a.md': note('tagged', 'Alpha', 'fact', 'alpha') });
    ingestNoteDirectory({ trusted: false, dir, project: 'first' });
    remember({ name: 'tagged', type: 'fact', tags: ['topic:auth'] });
    fs.writeFileSync(path.join(dir, 'a.md'), note('tagged', 'Alpha v2', 'fact', 'alpha two'));
    ingestNoteDirectory({ trusted: false, dir, project: 'second' });
    expect(kg().getEntity('tagged')!.tags.sort()).toEqual([NOTE_FILE_TAG, 'project:first', 'topic:auth'].sort());
  });

  it('a note-file memory that a manual remember appended to: the next file change replaces the appended line (kept in history)', () => {
    const dir = makeDir({ 'a.md': note('mixed', 'Alpha', 'fact', 'from the file') });
    ingestNoteDirectory({ trusted: false, dir });
    remember({ name: 'mixed', type: 'fact', observations: ['added by hand'] });
    fs.writeFileSync(path.join(dir, 'a.md'), note('mixed', 'Alpha v2', 'fact', 'file edited'));
    ingestNoteDirectory({ trusted: false, dir });
    const e = kg().getEntity('mixed')!;
    expect(e.observations).toEqual(['file edited']);
    const history = e.metadata?.replaced_history as Array<{ observations: string[] }>;
    expect(history.at(-1)!.observations).toEqual(['from the file', 'added by hand']);
  });

  it('P1: a renamed file is one replace, not a replace plus a false "missing"', () => {
    const dir = makeDir({ 'A.md': note('x1', 'X', 'fact', 'x body') });
    ingestNoteDirectory({ trusted: false, dir });
    fs.renameSync(path.join(dir, 'A.md'), path.join(dir, 'B.md'));
    const moved = ingestNoteDirectory({ trusted: false, dir });
    // A move with the bytes intact updates the path only: no new version.
    expect(moved).toMatchObject({ replaced: [], repathed: ['x1'], markedMissing: [] });
    expect(kg().getEntity('x1')!.tags).not.toContain(NOTE_FILE_MISSING_TAG);
    const settled = ingestNoteDirectory({ trusted: false, dir });
    expect(settled).toMatchObject({ replaced: [], unchanged: 1 });
    expect(kg().getEntity('x1')!.metadata?.replaced_history).toBeUndefined();
    expect((kg().getEntity('x1')!.metadata?.provenance as Record<string, unknown>).note_path).toBe('B.md');
  });

  it('P2-a: a duplicate-name file is fingerprinted too, so it does not eat the cap', () => {
    const dir = makeDir({
      'a.md': note('same', 'A', 'fact', 'a'),
      'b.md': note('same', 'B', 'fact', 'b'),
      'c.md': note('good_c', 'C', 'fact', 'c'),
    });
    for (let i = 0; i < 4; i++) ingestNoteDirectory({ trusted: false, dir, maxFiles: 1 });
    const last = ingestNoteDirectory({ trusted: false, dir, maxFiles: 1 });
    expect(kg().getEntity('good_c')).not.toBeNull();
    expect(last.more).toBe(0);
    expect(last.skipped.map((x) => x.path)).toContain('b.md');
  });

  it('P2-a: a duplicate reclaims the name once its owner is gone', () => {
    const dir = makeDir({
      'a.md': note('same2', 'A', 'fact', 'from a'),
      'b.md': note('same2', 'B', 'fact', 'from b'),
    });
    ingestNoteDirectory({ trusted: false, dir });
    ingestNoteDirectory({ trusted: false, dir });
    fs.rmSync(path.join(dir, 'a.md'));
    const r = ingestNoteDirectory({ trusted: false, dir });
    expect(r.replaced).toEqual(['same2']);
    expect(kg().getEntity('same2')!.observations).toEqual(['from b']);
    expect(kg().getEntity('same2')!.tags).not.toContain(NOTE_FILE_MISSING_TAG);
  });

  it('P2-a: when the owner renames its frontmatter name, the duplicate takes the old one', () => {
    const dir = makeDir({
      'a.md': note('same3', 'A', 'fact', 'from a'),
      'b.md': note('same3', 'B', 'fact', 'from b'),
    });
    ingestNoteDirectory({ trusted: false, dir });
    ingestNoteDirectory({ trusted: false, dir });
    fs.writeFileSync(path.join(dir, 'a.md'), note('renamed_a', 'A2', 'fact', 'from a, renamed'));
    const r = ingestNoteDirectory({ trusted: false, dir });
    expect(r.created).toEqual(['renamed_a']);
    expect(r.replaced).toEqual(['same3']);
    expect(kg().getEntity('same3')!.observations).toEqual(['from b']);
  });

  it('P3-a: no skip-cache row is left behind when nothing is skipped', () => {
    const dir = makeDir({ 'bad.md': 'no frontmatter\n' });
    const r = ingestNoteDirectory({ trusted: false, dir });
    expect(r.skipped).toHaveLength(1);
    const key = `note_ingest_skips:${r.dirId}`;
    const count = () => (getDatabase().prepare('SELECT COUNT(*) AS c FROM memesh_metadata WHERE key = ?').get(key) as { c: number }).c;
    expect(count()).toBe(1);
    fs.rmSync(path.join(dir, 'bad.md'));
    ingestNoteDirectory({ trusted: false, dir });
    expect(count()).toBe(0);
  });

  describe('name ownership — one rule (round-3 probes S1–S6)', () => {
    let bump = 0;
    // Write and move the mtime forward, so a same-size edit is never mistaken
    // for an unchanged file within one clock tick.
    const put = (dir: string, rel: string, content: string) => {
      fs.writeFileSync(path.join(dir, rel), content);
      const t = new Date(Date.now() + (bump += 1000));
      fs.utimesSync(path.join(dir, rel), t, t);
    };
    const mk = (sub: string, files: Record<string, string>) => {
      const dir = path.join(fixture.tmpDir, sub);
      fs.mkdirSync(dir, { recursive: true });
      for (const [rel, content] of Object.entries(files)) put(dir, rel, content);
      return dir;
    };
    const state = (name: string) => {
      const e = kg().getEntity(name);
      if (!e) return null;
      return {
        obs: e.observations,
        path: (e.metadata?.provenance as Record<string, unknown>).note_path,
        missing: e.tags.includes(NOTE_FILE_MISSING_TAG),
      };
    };
    const quiet = (dir: string) => {
      const r = ingestNoteDirectory({ trusted: false, dir });
      expect(r.created).toHaveLength(0);
      expect(r.replaced).toHaveLength(0);
      expect(r.repathed).toHaveLength(0);
      expect(r.markedMissing).toHaveLength(0);
      return r;
    };

    it('S1: an owner that renames its name hands the old name to the duplicate, then settles', () => {
      const dir = mk('s1', { 'a.md': note('same', 'A', 'fact', 'from a'), 'b.md': note('same', 'B', 'fact', 'from b') });
      ingestNoteDirectory({ trusted: false, dir });
      put(dir, 'a.md', note('other', 'A2', 'fact', 'from a2'));
      ingestNoteDirectory({ trusted: false, dir });
      quiet(dir);
      quiet(dir);
      expect(state('same')).toEqual({ obs: ['from b'], path: 'b.md', missing: false });
      expect(state('other')).toEqual({ obs: ['from a2'], path: 'a.md', missing: false });
    });

    it('S2: an owner that sorts LAST keeps its name when edited; its new content lands', () => {
      const dir = mk('s2', { 'z.md': note('same2', 'Z', 'fact', 'from z') });
      ingestNoteDirectory({ trusted: false, dir });
      put(dir, 'b.md', note('same2', 'B', 'fact', 'from b'));
      ingestNoteDirectory({ trusted: false, dir });
      put(dir, 'z.md', note('same2', 'Z', 'fact', 'from z EDITED'));
      const r = ingestNoteDirectory({ trusted: false, dir });
      expect(r.replaced).toEqual(['same2']);
      expect(r.skipped).toContainEqual({ path: 'b.md', reason: 'name "same2" already used by z.md in this directory' });
      quiet(dir);
      expect(state('same2')).toEqual({ obs: ['from z EDITED'], path: 'z.md', missing: false });
    });

    it('S3: an owner renamed on disk while a duplicate exists keeps the name (content hash)', () => {
      const dir = mk('s3', { 'a.md': note('same3', 'A', 'fact', 'from a'), 'b.md': note('same3', 'B', 'fact', 'from b') });
      ingestNoteDirectory({ trusted: false, dir });
      ingestNoteDirectory({ trusted: false, dir });
      fs.renameSync(path.join(dir, 'a.md'), path.join(dir, 'c.md'));
      const r = ingestNoteDirectory({ trusted: false, dir });
      expect(r).toMatchObject({ replaced: [], repathed: ['same3'], markedMissing: [] });
      quiet(dir);
      expect(state('same3')).toEqual({ obs: ['from a'], path: 'c.md', missing: false });
    });

    it('S3b: the same with the renamed owner sorting last', () => {
      const dir = mk('s3b', { 'a.md': note('same3b', 'A', 'fact', 'from a'), 'm.md': note('same3b', 'M', 'fact', 'from m') });
      ingestNoteDirectory({ trusted: false, dir });
      fs.renameSync(path.join(dir, 'a.md'), path.join(dir, 'z.md'));
      ingestNoteDirectory({ trusted: false, dir });
      quiet(dir);
      expect(state('same3b')).toEqual({ obs: ['from a'], path: 'z.md', missing: false });
    });

    it('S4: a file that renames its name away and back does not ping-pong; the name stays with its new owner', () => {
      const dir = mk('s4', { 'a.md': note('same4', 'A', 'fact', 'from a'), 'b.md': note('same4', 'B', 'fact', 'from b') });
      ingestNoteDirectory({ trusted: false, dir });
      put(dir, 'a.md', note('other4', 'A2', 'fact', 'a2'));
      ingestNoteDirectory({ trusted: false, dir });
      put(dir, 'a.md', note('same4', 'A3', 'fact', 'a3'));
      const r = ingestNoteDirectory({ trusted: false, dir });
      expect(r.skipped).toContainEqual({ path: 'a.md', reason: 'name "same4" already used by b.md in this directory' });
      expect(r.markedMissing).toEqual(['other4']);
      quiet(dir);
      quiet(dir);
      expect(state('same4')).toEqual({ obs: ['from b'], path: 'b.md', missing: false });
      expect(state('other4')!.missing).toBe(true);
    });

    it('S5: a file that changes its own name leaves the old memory tagged missing', () => {
      const dir = mk('s5', { 'a.md': note('old5', 'Old', 'fact', 'v1') });
      ingestNoteDirectory({ trusted: false, dir });
      put(dir, 'a.md', note('new5', 'New', 'fact', 'v2'));
      const r = ingestNoteDirectory({ trusted: false, dir });
      expect(r.created).toEqual(['new5']);
      expect(r.markedMissing).toEqual(['old5']);
      quiet(dir);
      expect(state('old5')).toEqual({ obs: ['v1'], path: 'a.md', missing: true });
      expect(state('new5')).toEqual({ obs: ['v2'], path: 'a.md', missing: false });
    });

    it('an edited owner past the per-run cap is not displaced by a duplicate read first', () => {
      const dir = mk('cap', { 'z.md': note('capname', 'Z', 'fact', 'from z') });
      ingestNoteDirectory({ trusted: false, dir });
      put(dir, 'a.md', note('capname', 'A', 'fact', 'from a'));
      put(dir, 'z.md', note('capname', 'Z', 'fact', 'from z edited'));
      const r = ingestNoteDirectory({ trusted: false, dir, maxFiles: 1 });
      expect(r.more).toBe(1);
      expect(r.replaced).toHaveLength(0);
      expect(r.skipped).toContainEqual({ path: 'a.md', reason: 'name "capname" belongs to z.md, which was not read this run' });
      ingestNoteDirectory({ trusted: false, dir, maxFiles: 1 });
      expect(state('capname')).toEqual({ obs: ['from z edited'], path: 'z.md', missing: false });
    });

    it('N7: a duplicate that arrives a run AFTER the rename still takes the name over', () => {
      const dir = mk('n7', { 'a.md': note('S7', 'A', 'fact', 'a') });
      ingestNoteDirectory({ trusted: false, dir });
      put(dir, 'a.md', note('T7', 'A2', 'fact', 'a renamed'));
      expect(ingestNoteDirectory({ trusted: false, dir }).markedMissing).toEqual(['S7']);
      // The newcomer appears only now, so the file that used to own S7 is not
      // read this run — but this run knows it declares T7.
      put(dir, 'b.md', note('S7', 'B', 'fact', 'from b'));
      const r = ingestNoteDirectory({ trusted: false, dir });
      expect(r.replaced).toEqual(['S7']);
      expect(state('S7')).toEqual({ obs: ['from b'], path: 'b.md', missing: false });
      quiet(dir);
      quiet(dir);
    });

    it('N8: the same when the file that let the name go is an unread, fingerprinted loser', () => {
      const dir = mk('n8', { 'q.md': note('S8', 'Q', 'fact', 'from q') });
      ingestNoteDirectory({ trusted: false, dir });
      // q.md moves to another name, which p.md owns — so q.md loses, is
      // fingerprinted, and S8 is left missing.
      put(dir, 'p.md', note('L8', 'P', 'fact', 'from p'));
      put(dir, 'q.md', note('L8', 'Q2', 'fact', 'from q now L8'));
      const moved = ingestNoteDirectory({ trusted: false, dir });
      expect(moved.created).toEqual(['L8']);
      expect(moved.markedMissing).toEqual(['S8']);
      expect(moved.skipped).toContainEqual({ path: 'q.md', reason: 'name "L8" already used by p.md in this directory' });

      // A newcomer claims S8 while q.md — still the recorded file — is not
      // read at all this run: its name is known from the skip fingerprint.
      put(dir, 'b.md', note('S8', 'B', 'fact', 'from b'));
      const r = ingestNoteDirectory({ trusted: false, dir });
      expect(r.skipped).toContainEqual({ path: 'q.md', reason: 'name "L8" already used by p.md in this directory' });
      expect(r.replaced).toEqual(['S8']);
      expect(state('S8')).toEqual({ obs: ['from b'], path: 'b.md', missing: false });
      quiet(dir);
    });

    it('N1d: two files of the same size and mtime that swap names are not both "unchanged"', () => {
      const dir = mk('n1d', { 'a.md': note('SWAPA', 'S', 'fact', 'aaa'), 'b.md': note('SWAPB', 'S', 'fact', 'bbb') });
      // Same size, and the same mtime — the whole fingerprint except the inode.
      const same = new Date(Date.now() - 10_000);
      fs.utimesSync(path.join(dir, 'a.md'), same, same);
      fs.utimesSync(path.join(dir, 'b.md'), same, same);
      expect(fs.statSync(path.join(dir, 'a.md')).size).toBe(fs.statSync(path.join(dir, 'b.md')).size);
      ingestNoteDirectory({ trusted: false, dir });
      expect(state('SWAPA')!.path).toBe('a.md');

      // Swap the two files, keeping both mtimes.
      fs.renameSync(path.join(dir, 'a.md'), path.join(dir, 'tmp.md'));
      fs.renameSync(path.join(dir, 'b.md'), path.join(dir, 'a.md'));
      fs.renameSync(path.join(dir, 'tmp.md'), path.join(dir, 'b.md'));
      fs.utimesSync(path.join(dir, 'a.md'), same, same);
      fs.utimesSync(path.join(dir, 'b.md'), same, same);

      const r = ingestNoteDirectory({ trusted: false, dir });
      expect(r.repathed.sort()).toEqual(['SWAPA', 'SWAPB']);
      expect(state('SWAPA')).toEqual({ obs: ['aaa'], path: 'b.md', missing: false });
      expect(state('SWAPB')).toEqual({ obs: ['bbb'], path: 'a.md', missing: false });
      quiet(dir);
    });

    it('N1d: a rename of the file only — repeated — does not evict the real history', () => {
      const dir = mk('mv', { 'v0.md': note('MV', 'V', 'fact', 'the one real body') });
      ingestNoteDirectory({ trusted: false, dir });
      put(dir, 'v0.md', note('MV', 'V2', 'fact', 'the second real body'));
      ingestNoteDirectory({ trusted: false, dir });
      for (let i = 0; i < 25; i++) {
        fs.renameSync(path.join(dir, i === 0 ? 'v0.md' : `mv${i - 1}.md`), path.join(dir, `mv${i}.md`));
        ingestNoteDirectory({ trusted: false, dir });
      }
      const history = kg().getEntity('MV')!.metadata?.replaced_history as Array<{ observations: string[] }>;
      expect(history).toHaveLength(1);
      expect(history[0].observations).toEqual(['the one real body']);
      expect(state('MV')).toEqual({ obs: ['the second real body'], path: 'mv24.md', missing: false });
    });

    it('N10b: an unparseable recorded file frees its name a run later, exactly as it does in the same run', () => {
      const dir = mk('n10b', { 'a.md': note('U10b', 'A', 'fact', 'from a') });
      ingestNoteDirectory({ trusted: false, dir });
      // The recorded file stops being a note at all.
      put(dir, 'a.md', 'no frontmatter any more\n');
      const broke = ingestNoteDirectory({ trusted: false, dir });
      expect(broke.skipped).toContainEqual({ path: 'a.md', reason: 'no frontmatter — a note file needs a `---` block with a name' });
      expect(broke.markedMissing).toEqual(['U10b']);

      // The newcomer arrives a run later, with a.md skipped by fingerprint.
      put(dir, 'b.md', note('U10b', 'B', 'fact', 'from b'));
      const r = ingestNoteDirectory({ trusted: false, dir });
      expect(r.replaced).toEqual(['U10b']);
      expect(state('U10b')).toEqual({ obs: ['from b'], path: 'b.md', missing: false });
      quiet(dir);
    });

    it('N11: a newcomer refused by the per-run cap still gets the name once it is freed', () => {
      const dir = mk('n11', { 'm.md': note('X11', 'M', 'fact', 'm v1') });
      ingestNoteDirectory({ trusted: false, dir, maxFiles: 1 });
      put(dir, 'a.md', note('X11', 'A', 'fact', 'from a'));
      put(dir, 'm.md', note('Y11', 'M2', 'fact', 'm renamed'));
      // a.md sorts first and uses the one read; m.md is left for later.
      const capped = ingestNoteDirectory({ trusted: false, dir, maxFiles: 1 });
      expect(capped.more).toBe(1);
      // Next run reads m.md: it declares Y11, so X11 loses its file.
      const renamed = ingestNoteDirectory({ trusted: false, dir, maxFiles: 1 });
      expect(renamed.created).toEqual(['Y11']);
      expect(renamed.markedMissing).toEqual(['X11']);
      // And now the newcomer must be able to claim the freed name.
      ingestNoteDirectory({ trusted: false, dir, maxFiles: 1 });
      ingestNoteDirectory({ trusted: false, dir, maxFiles: 1 });
      expect(state('X11')).toEqual({ obs: ['from a'], path: 'a.md', missing: false });
      expect(state('Y11')).toEqual({ obs: ['m renamed'], path: 'm.md', missing: false });
    });

    it('N11b: a freed name is given away even while the file that freed it is past the cap', () => {
      const dir = mk('n11b', { 'm.md': note('X11b', 'M', 'fact', 'm v1') });
      ingestNoteDirectory({ trusted: false, dir });
      put(dir, 'm.md', note('Y11b', 'M2', 'fact', 'm renamed'));
      expect(ingestNoteDirectory({ trusted: false, dir }).markedMissing).toEqual(['X11b']);
      // m.md changes again, so it is no longer "unchanged", and the newcomer
      // sorts first and takes the single read: this run cannot see what m.md
      // declares — but X11b is already nobody's, so the newcomer gets it.
      put(dir, 'm.md', note('Y11b', 'M3', 'fact', 'm edited again'));
      put(dir, 'a.md', note('X11b', 'A', 'fact', 'from a'));
      const r = ingestNoteDirectory({ trusted: false, dir, maxFiles: 1 });
      expect(r.more).toBe(1);
      expect(r.replaced).toEqual(['X11b']);
      expect(state('X11b')).toEqual({ obs: ['from a'], path: 'a.md', missing: false });
    });

    it('S6: the skip row follows the losers — gone when the dup takes over, back and gone again with the returning file', () => {
      const dir = mk('s6', { 'a.md': note('same6', 'A', 'fact', 'a'), 'b.md': note('same6', 'B', 'fact', 'b') });
      const key = `note_ingest_skips:${ingestNoteDirectory({ trusted: false, dir }).dirId}`;
      const row = () => getDatabase().prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(key) as { value: string } | undefined;
      expect(Object.keys(JSON.parse(row()!.value))).toEqual(['b.md']);
      fs.rmSync(path.join(dir, 'a.md'));
      expect(ingestNoteDirectory({ trusted: false, dir }).replaced).toEqual(['same6']);
      expect(row()).toBeUndefined();
      put(dir, 'a.md', note('same6', 'A', 'fact', 'a back'));
      ingestNoteDirectory({ trusted: false, dir });
      expect(Object.keys(JSON.parse(row()!.value))).toEqual(['a.md']);
      fs.rmSync(path.join(dir, 'a.md'));
      ingestNoteDirectory({ trusted: false, dir });
      expect(row()).toBeUndefined();
      expect(state('same6')).toEqual({ obs: ['b'], path: 'b.md', missing: false });
    });
  });
});

describe('note-ingest: the entity type follows the file — #324 C5', () => {
  it('a changed metadata.type updates the stored type, not only the title', () => {
    const dir = makeDir({ 'a.md': note('note_a', 'Alpha', 'feedback', 'Alpha body.') });
    ingestNoteDirectory({ trusted: false, dir });
    expect(kg().getEntity('note_a')!.type).toBe('feedback');

    fs.writeFileSync(path.join(dir, 'a.md'), note('note_a', 'Alpha revised', 'decision', 'Alpha body revised.'));
    const r = ingestNoteDirectory({ trusted: false, dir });
    expect(r.replaced).toEqual(['note_a']);
    const e = kg().getEntity('note_a')!;
    // The receipt already said `replaced`, and the title already followed the
    // file. The type did not: createEntity's INSERT OR IGNORE leaves it, and
    // the replace path cleared observations and tags without touching it — so
    // a note reclassified from feedback to decision kept answering as
    // feedback, to recall and to every type-filtered view.
    expect(e.type, 'the type did not follow the file').toBe('decision');
    expect(e.title).toBe('Alpha revised');
  });

  it('an unchanged type is not churned', () => {
    // Type is `pattern`, not `lesson`: #451 canonicalizes every lesson-family
    // type to `lesson_learned` on write, which would make "the type did not
    // change between ingests" indistinguishable from that unrelated
    // canonicalization. Any non-lesson type proves the same point.
    const dir = makeDir({ 'b.md': note('note_b', 'Beta', 'pattern', 'Beta body.') });
    ingestNoteDirectory({ trusted: false, dir });
    fs.writeFileSync(path.join(dir, 'b.md'), note('note_b', 'Beta', 'pattern', 'Beta body changed.'));
    ingestNoteDirectory({ trusted: false, dir });
    expect(kg().getEntity('note_b')!.type).toBe('pattern');
  });
});

describe('note-ingest: a refusal leaves a durable trace — #324 C3', () => {
  it('counts files refused THIS run, and the count goes to zero when nothing changed', () => {
    const dir = makeDir({
      'good.md': note('note_good', 'Good', 'decision', 'Good body.'),
      'nofm.md': '# no frontmatter here',
      'noname.md': '---\ndescription: "nameless"\n---\n\nbody\n',
    });
    const first = ingestNoteDirectory({ trusted: false, dir });
    expect(first.created).toEqual(['note_good']);
    expect(first.skipped).toHaveLength(2);
    // `skipped.length` sticks forever once a file is bad, so the hook cannot
    // use it to decide whether this run had anything to report. The caller
    // printed "note files were read and nothing new needed storing" over a
    // run that rejected two files.
    expect(first.refusedNow, 'two files were refused and nothing counted them').toBe(2);
    expect(summarizeNoteIngest(first)).toContain('2 newly refused');

    const second = ingestNoteDirectory({ trusted: false, dir });
    expect(second.skipped).toHaveLength(2);
    expect(second.refusedNow, 'the same two bad files are not news a second time').toBe(0);
    expect(summarizeNoteIngest(second)).not.toContain('newly refused');

    fs.writeFileSync(path.join(dir, 'third.md'), '# also no frontmatter');
    const third = ingestNoteDirectory({ trusted: false, dir });
    expect(third.skipped).toHaveLength(3);
    expect(third.refusedNow).toBe(1);
  });

  it('a refused symlink is news once, not on every run', () => {
    const dir = makeDir({ 'good.md': note('note_g', 'G', 'decision', 'G body.') });
    fs.symlinkSync(path.join(dir, 'good.md'), path.join(dir, 'link.md'));
    const first = ingestNoteDirectory({ trusted: false, dir });
    expect(first.skipped.map((s) => s.reason)).toEqual(['symlink refused']);
    expect(first.refusedNow).toBe(1);
    // Symlinks are collected before the read loop and were never
    // fingerprinted, so counting them naively says "1 newly refused" on
    // every Stop forever — the same stickiness, relocated.
    const second = ingestNoteDirectory({ trusted: false, dir });
    expect(second.skipped).toHaveLength(1);
    expect(second.refusedNow, 'the symlink was re-reported as new').toBe(0);
  });

  it('a run that stored nothing and refused nothing reports zero of both', () => {
    const dir = makeDir({ 'good.md': note('note_q', 'Q', 'decision', 'Q body.') });
    ingestNoteDirectory({ trusted: false, dir });
    const again = ingestNoteDirectory({ trusted: false, dir });
    expect(again.refusedNow).toBe(0);
    expect(again.created).toEqual([]);
    expect(again.replaced).toEqual([]);
  });
});

describe('note-ingest: a file over the observation cap is refused, not silently trimmed — #324 C6', () => {
  it('names the count instead of storing the first 100 and dropping the rest', () => {
    const body = Array.from({ length: 130 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n');
    const dir = makeDir({ 'big.md': note('note_big', 'Big', 'decision', body) });
    const r = ingestNoteDirectory({ trusted: false, dir });
    // This is a Stop-hook path: a silent drop is indistinguishable from
    // nothing happening. The transport rejects the same shape and names the
    // count; storing 100 with {"skipped":[],"more":0} told nobody that 30
    // paragraphs of the user's note were gone.
    expect(r.created, 'the over-cap file was stored anyway').toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].path).toBe('big.md');
    expect(r.skipped[0].reason).toContain('130');
    expect(r.skipped[0].reason).toContain('100');
    expect(r.refusedNow).toBe(1);
    expect(kg().getEntity('note_big')).toBeNull();
  });

  it('exactly at the cap is still stored', () => {
    const body = Array.from({ length: 100 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n');
    const dir = makeDir({ 'edge.md': note('note_edge', 'Edge', 'decision', body) });
    const r = ingestNoteDirectory({ trusted: false, dir });
    expect(r.created).toEqual(['note_edge']);
    expect(kg().getEntity('note_edge')!.observations).toHaveLength(100);
  });

  it('the refusal is fingerprinted, so the file is not re-read on every run', () => {
    const body = Array.from({ length: 130 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n');
    const dir = makeDir({ 'big.md': note('note_big2', 'Big', 'decision', body) });
    ingestNoteDirectory({ trusted: false, dir });
    const second = ingestNoteDirectory({ trusted: false, dir });
    expect(second.skipped).toHaveLength(1);
    expect(second.refusedNow).toBe(0);
  });
});

/**
 * An unreadable file is not "still holding its memory's name" — #324 C9.
 *
 * chmod is the only portable way to make a readable file unreadable, so
 * these cases are POSIX-and-not-root. Named, not silently skipped: on
 * Windows and as root the branch is exercised by no test here, and the
 * refund case below covers the same code path without permissions.
 */
const canDenyReads = process.platform !== 'win32' && (process.getuid?.() ?? 0) !== 0;

describe.skipIf(!canDenyReads)('note-ingest: an unreadable file marks its memory missing — #324 C9', () => {
  it('tags source:note-file:missing instead of leaving a memory pointed at a file it cannot read', () => {
    const dir = makeDir({ 'a.md': note('note_a', 'Alpha', 'decision', 'Alpha body.') });
    expect(ingestNoteDirectory({ trusted: false, dir }).created).toEqual(['note_a']);

    // The bytes change so the stat fingerprint does not fast-path it, then
    // the file becomes unreadable.
    fs.writeFileSync(path.join(dir, 'a.md'), note('note_a', 'Alpha', 'decision', 'Alpha body two.'));
    fs.chmodSync(path.join(dir, 'a.md'), 0o000);
    try {
      const r = ingestNoteDirectory({ trusted: false, dir });
      expect(r.skipped.map((x) => x.reason).join(' ')).toContain('unreadable');
      // The skip recorded no declared name, so the missing sweep saw the path
      // in presentRels and moved on: the one user-visible signal this module
      // has never appeared.
      expect(r.markedMissing, 'the memory was left pointing at a file nobody can read').toEqual(['note_a']);
      const tags = kg().getEntity('note_a')!.tags ?? [];
      expect(tags).toContain(NOTE_FILE_MISSING_TAG);
    } finally {
      fs.chmodSync(path.join(dir, 'a.md'), 0o644);
    }
  });

  it('the file coming back clears the missing tag', () => {
    const dir = makeDir({ 'b.md': note('note_b', 'Beta', 'decision', 'Beta body.') });
    ingestNoteDirectory({ trusted: false, dir });
    fs.writeFileSync(path.join(dir, 'b.md'), note('note_b', 'Beta', 'decision', 'Beta body two.'));
    fs.chmodSync(path.join(dir, 'b.md'), 0o000);
    ingestNoteDirectory({ trusted: false, dir });
    fs.chmodSync(path.join(dir, 'b.md'), 0o644);
    const back = ingestNoteDirectory({ trusted: false, dir });
    expect(back.replaced).toEqual(['note_b']);
    expect(kg().getEntity('note_b')!.tags ?? []).not.toContain(NOTE_FILE_MISSING_TAG);
  });

  it('an unreadable file does not spend a per-run cap slot a good file could use', () => {
    const dir = makeDir({
      'bad.md': note('note_bad', 'Bad', 'decision', 'Bad body.'),
      'good.md': note('note_good', 'Good', 'decision', 'Good body.'),
    });
    fs.chmodSync(path.join(dir, 'bad.md'), 0o000);
    try {
      // One slot, and `bad.md` sorts first. It sits after `read++`, so it
      // consumed the whole run's budget and `good.md` was never reached —
      // every run, forever, because the skip left no fingerprint either.
      const r = ingestNoteDirectory({ trusted: false, dir, maxFiles: 1 });
      expect(r.created, 'the unreadable file ate the only cap slot').toEqual(['note_good']);
      expect(r.more).toBe(0);
    } finally {
      fs.chmodSync(path.join(dir, 'bad.md'), 0o644);
    }
  });
});

describe('note-ingest: a name-level refusal is news once too — #324 C3', () => {
  it('a file whose memory was forgotten is not reported as newly refused every run', () => {
    const dir = makeDir({ 'a.md': note('note_arch', 'Alpha', 'decision', 'Alpha body.') });
    expect(ingestNoteDirectory({ trusted: false, dir }).created).toEqual(['note_arch']);
    forget({ name: 'note_arch' });

    const first = ingestNoteDirectory({ trusted: false, dir });
    expect(first.skipped.map((x) => x.reason).join(' ')).toContain('archived with forget');
    expect(first.refusedNow).toBe(1);

    // The three name-level refusals go through skipAll, which reports but
    // records no fingerprint — so without one they are new on every single
    // Stop, which is the stickiness refusedNow exists to remove.
    const second = ingestNoteDirectory({ trusted: false, dir });
    expect(second.skipped).toHaveLength(1);
    expect(second.refusedNow, 'the same refusal was announced again').toBe(0);
    const third = ingestNoteDirectory({ trusted: false, dir });
    expect(third.refusedNow).toBe(0);
  });

  it('the file is still re-read each run, so the refusal lifts when its cause does', () => {
    const dir = makeDir({ 'b.md': note('note_rev', 'Beta', 'decision', 'Beta body.') });
    ingestNoteDirectory({ trusted: false, dir });
    forget({ name: 'note_rev' });
    ingestNoteDirectory({ trusted: false, dir });
    ingestNoteDirectory({ trusted: false, dir });

    // Un-archived without the file changing. A fingerprint that drove the
    // phase-1 early skip would leave this file refused forever, which is the
    // trap the unreadable path (C9) documents.
    remember({ name: 'note_rev', type: 'decision', observations: ['Beta body.'] });
    const back = ingestNoteDirectory({ trusted: false, dir });
    expect(back.skipped, 'the file was never re-read after its memory came back').toHaveLength(0);
  });
});

describe('notes a private session named are held out by content', () => {
  let counter = 0;
  const dirWith = (files: Record<string, string>): string => {
    const dir = path.join(fixture.tmpDir, `held-notes-${++counter}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), content);
    return dir;
  };
  beforeEach(() => { fs.rmSync(path.join(getMemeshDirFromDbPath(), 'note-ingest-holds'), { recursive: true, force: true }); });
  const names = () => (getDatabase().prepare('SELECT name FROM entities').all() as Array<{ name: string }>).map((r) => r.name);
  const holdsDir = () => path.join(getMemeshDirFromDbPath(), 'note-ingest-holds');
  const observations = (name: string) => (getDatabase().prepare(
    'SELECT o.content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = ?').all(name) as Array<{ content: string }>).map((r) => r.content).join('|');

  it('skips the held content whichever other note changes and after a touch, and imports it once it differs', () => {
    const dir = dirWith({ 'other.md': note('note_other', 'Other', 'fact', 'Other body.'), 'secret.md': note('note_secret', 'Secret', 'fact', 'SECRET body.') });
    holdOutNoteFiles({ dir, sessionId: 'sess-1', paths: [path.join(dir, 'secret.md')] });
    expect(ingestNoteDirectory({ trusted: false, dir }).created).toEqual(['note_other']);
    expect(ingestNoteDirectory({ trusted: false, dir }).skipped).toEqual([{ path: 'secret.md', reason: expect.stringContaining('private session') }]);
    fs.writeFileSync(path.join(dir, 'other.md'), note('note_other', 'Other', 'fact', 'Other body changed.'));
    ingestNoteDirectory({ trusted: false, dir });
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(dir, 'secret.md'), later, later); // a touch does not release it
    ingestNoteDirectory({ trusted: false, dir });
    expect(names()).not.toContain('note_secret');
    fs.writeFileSync(path.join(dir, 'secret.md'), note('note_secret', 'Secret', 'fact', 'Rewritten later by someone else.'));
    expect(ingestNoteDirectory({ trusted: false, dir }).created).toEqual(['note_secret']);
    expect(observations('note_secret')).toContain('Rewritten later');
  });

  it('leaves an imported note alone when the session edited it: the old memory stays, and a later edit imports', () => {
    const dir = dirWith({ 'kept.md': note('note_kept', 'Kept', 'fact', 'Old body.') });
    ingestNoteDirectory({ trusted: false, dir });
    fs.writeFileSync(path.join(dir, 'kept.md'), note('note_kept', 'Kept', 'fact', 'Edited in the private session.'));
    holdOutNoteFiles({ dir, sessionId: 'sess-1', paths: [path.join(dir, 'kept.md')] });
    ingestNoteDirectory({ trusted: false, dir });
    expect(observations('note_kept')).toContain('Old body');
    expect(observations('note_kept')).not.toContain('private session');
    fs.writeFileSync(path.join(dir, 'kept.md'), note('note_kept', 'Kept', 'fact', 'Edited afterwards.'));
    ingestNoteDirectory({ trusted: false, dir });
    expect(observations('note_kept')).toContain('Edited afterwards');
  });

  it('does not touch a note that was imported with the same content', () => {
    const dir = dirWith({ 'same.md': note('note_same', 'Same', 'fact', 'Same body.') });
    ingestNoteDirectory({ trusted: false, dir });
    holdOutNoteFiles({ dir, sessionId: 'sess-1', paths: [path.join(dir, 'same.md')] });
    expect(ingestNoteDirectory({ trusted: false, dir }).markedMissing).toEqual([]);
    expect(names()).toContain('note_same');
    expect(observations('note_same')).toContain('Same body');
  });

  it('keeps each session\'s record apart: a second session\'s record does not replace the first', () => {
    const dir = dirWith({ 'one.md': note('note_one', 'One', 'fact', 'One.'), 'two.md': note('note_two', 'Two', 'fact', 'Two.') });
    holdOutNoteFiles({ dir, sessionId: 'sess-a', paths: [path.join(dir, 'one.md')] });
    holdOutNoteFiles({ dir, sessionId: 'sess-b', paths: [path.join(dir, 'two.md')] });
    expect(fs.readdirSync(holdsDir()).filter((f) => f.endsWith('.json')).sort()).toEqual(['sess-a.json', 'sess-b.json']);
    expect(ingestNoteDirectory({ trusted: false, dir }).created).toEqual([]);
  });

  it('imports nothing, and names the record, when a record cannot be read', () => {
    const dir = dirWith({ 'a.md': note('note_a', 'A', 'fact', 'A body.') });
    holdOutNoteFiles({ dir, sessionId: 'sess-a', paths: [] });
    fs.mkdirSync(holdsDir(), { recursive: true }); // a record that holds nothing is not kept, so the folder may not be there
    fs.writeFileSync(path.join(holdsDir(), 'sess-a.json'), '{ this is not json');
    let error: (Error & { code?: string }) | undefined;
    try { ingestNoteDirectory({ trusted: false, dir }); } catch (err) { error = err as Error; }
    expect(error?.code).toBe(NOTE_HOLDS_UNREADABLE);
    expect(error?.message).toContain('sess-a.json');
    expect(error?.message).toMatch(/not imported until it can be read/);
    expect(error?.message, 'never "delete it", which would let a private session\'s notes in (G09 F2)').not.toMatch(/delet/);
    expect(names()).not.toContain('note_a');
    fs.rmSync(path.join(holdsDir(), 'sess-a.json'));
    expect(ingestNoteDirectory({ trusted: false, dir }).created).toEqual(['note_a']);
  });

  it.each([
    ['a record that is a list', '[]'],
    ['a record with no firm part', '{}'],
    ['a hash that is not text', JSON.stringify({ firm: { someDir: { 'a.md': 7 } } })],
    ['a folder entry that is not an object', JSON.stringify({ firm: { someDir: [] } })],
    ['a tentative part that is incomplete', JSON.stringify({ firm: {}, tentative: { reason: 'x' } })],
  ])('imports nothing, and says which file, for %s', (_label, text) => {
    const dir = dirWith({ 'a.md': note('note_a', 'A', 'fact', 'A body.') });
    fs.mkdirSync(holdsDir(), { recursive: true });
    fs.writeFileSync(path.join(holdsDir(), 'sess-bad.json'), text);
    let error: (Error & { code?: string }) | undefined;
    try { ingestNoteDirectory({ trusted: false, dir }); } catch (err) { error = err as Error; }
    expect(error?.code).toBe(NOTE_HOLDS_UNREADABLE);
    expect(error?.message).toContain('sess-bad.json');
    expect(names()).not.toContain('note_a');
  });

  it('imports nothing when the holds folder cannot be read (a plain file sits where it should be)', () => {
    const dir = dirWith({ 'a.md': note('note_a', 'A', 'fact', 'A body.') });
    fs.rmSync(holdsDir(), { recursive: true, force: true });
    fs.writeFileSync(holdsDir(), 'a file where the folder should be');
    let error: (Error & { code?: string }) | undefined;
    try {
      try { ingestNoteDirectory({ trusted: false, dir }); } catch (err) { error = err as Error; }
      expect(error?.code).toBe(NOTE_HOLDS_DIR_UNREADABLE);
      expect(names()).not.toContain('note_a');
    } finally { fs.rmSync(holdsDir(), { force: true }); } // a failed assertion must not leave a file where later tests need the folder
  });

  it('holds a note under any other name or folder once it is held (a rename, a move into a subfolder, a copy)', () => {
    const dir = dirWith({ 'secret.md': note('note_secret', 'Secret', 'fact', 'SECRET body.') });
    holdOutNoteFiles({ dir, sessionId: 'sess-1', paths: [path.join(dir, 'secret.md')] });
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.renameSync(path.join(dir, 'secret.md'), path.join(dir, 'sub', 'renamed.md'));
    fs.copyFileSync(path.join(dir, 'sub', 'renamed.md'), path.join(dir, 'copy.md'));
    const run = ingestNoteDirectory({ trusted: false, dir });
    expect(run.created).toEqual([]);
    expect(run.skipped.map((x) => x.path).sort()).toEqual(['copy.md', 'sub/renamed.md']);
  });

  it('holds every note changed since a time, named or not, and imports a note that is older', () => {
    const dir = dirWith({ 'old.md': note('note_old', 'Old', 'fact', 'Old body.') });
    const since = Date.now() + 20;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
    fs.writeFileSync(path.join(dir, 'new.md'), note('note_new', 'New', 'fact', 'New body.'));
    expect(holdOutNoteFiles({ dir, sessionId: 'sess-1', paths: [], sinceMs: since })).toBe(1);
    expect(ingestNoteDirectory({ trusted: false, dir }).created).toEqual(['note_old']);
  });

  it.skipIf(!canDenyReads)('keeps out a note that could not be read when it was held, and holds its content once it can be read', () => {
    const dir = dirWith({ 'secret.md': note('note_secret', 'Secret', 'fact', 'SECRET body.') });
    const file = path.join(dir, 'secret.md');
    fs.chmodSync(file, 0o000);
    try {
      expect(holdOutNoteFiles({ dir, sessionId: 'sess-1', paths: [file] })).toBe(1);
    } finally { fs.chmodSync(file, 0o644); }
    expect(ingestNoteDirectory({ trusted: false, dir }).created).toEqual([]);
    expect(names()).not.toContain('note_secret');
    expect(JSON.stringify(JSON.parse(fs.readFileSync(path.join(holdsDir(), 'sess-1.json'), 'utf8')))).not.toContain('"?"'); // healed to its hash
    fs.writeFileSync(file, note('note_secret', 'Secret', 'fact', 'Rewritten, so new content.'));
    expect(ingestNoteDirectory({ trusted: false, dir }).created).toEqual(['note_secret']);
  });

  it('does not read a note over the size limit into memory to hold it', () => {
    const dir = dirWith({ 'big.md': 'x'.repeat(NOTE_FILE_MAX_BYTES + 1) });
    expect(holdOutNoteFiles({ dir, sessionId: 'sess-1', paths: [path.join(dir, 'big.md')] })).toBe(0);
  });

  it('never overwrites a session\'s own damaged hold record', () => {
    const dir = dirWith({ 'a.md': note('note_a', 'A', 'fact', 'A body.') });
    holdOutNoteFiles({ dir, sessionId: 'sess-1', paths: [path.join(dir, 'a.md')] });
    fs.writeFileSync(path.join(holdsDir(), 'sess-1.json'), '{ damaged');
    let error: (Error & { code?: string }) | undefined;
    try { holdOutNoteFiles({ dir, sessionId: 'sess-1', paths: [] }); } catch (err) { error = err as Error; }
    expect(error?.code).toBe(NOTE_HOLDS_UNREADABLE);
    expect(fs.readFileSync(path.join(holdsDir(), 'sess-1.json'), 'utf8')).toBe('{ damaged');
  });

  describe('holds kept out only because the session could not be checked', () => {
    const transcript = (rows: object[], name = 't.jsonl') => {
      const file = path.join(fixture.tmpDir, name);
      fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
      return file;
    };
    const quiet = { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } };
    const call = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'mcp__memesh__private_session', input: {} }] } };
    const hold = (dir: string, file: string) => holdOutNoteFiles({
      dir, sessionId: 'sess-1', paths: [path.join(dir, 'secret.md')], transcript: file,
      // The holds were recorded after every note here was written: none of them waits (a note changed after `holdsAt` would).
      tentative: { reason: 'unreadable', holdsAt: Date.now() + 1000 },
    });

    it('lets the note through once the session can be checked and is not private', () => {
      const dir = dirWith({ 'secret.md': note('note_secret', 'Secret', 'fact', 'Body.') });
      hold(dir, transcript([quiet]));
      expect(ingestNoteDirectory({ trusted: false, dir }).created).toEqual(['note_secret']);
      // Released, and the record held nothing else, so it is gone.
      expect(fs.existsSync(path.join(holdsDir(), 'sess-1.json'))).toBe(false);
    });

    it('makes the hold firm when the session turns out to be private', () => {
      const dir = dirWith({ 'secret.md': note('note_secret', 'Secret', 'fact', 'Body.') });
      hold(dir, transcript([quiet, call]));
      expect(ingestNoteDirectory({ trusted: false, dir }).created).toEqual([]);
      const record = JSON.parse(fs.readFileSync(path.join(holdsDir(), 'sess-1.json'), 'utf8'));
      expect(record.tentative).toBeUndefined();
      expect(Object.keys(record.firm)).toHaveLength(1);
    });

    it('keeps holding while the check still cannot be made, and says why', () => {
      const dir = dirWith({ 'secret.md': note('note_secret', 'Secret', 'fact', 'Body.') });
      // A transcript path that is a folder cannot be read: still unchecked. (A transcript that is not there is "no".)
      const folder = path.join(fixture.tmpDir, 'a-folder.jsonl');
      fs.mkdirSync(folder, { recursive: true });
      hold(dir, folder);
      const run = ingestNoteDirectory({ trusted: false, dir });
      expect(run.created).toEqual([]);
      expect(run.held.unchecked).toBe(1);
      expect(summarizeNoteHolds()).toMatchObject({ sessions: 1, notes: 1, unsettled: [{ reason: 'unreadable', kind: 'transient', notes: 1 }] });
    });
  });
});

describe('notes changed while a private session runs wait for it', () => {
  let counter = 0;
  const dirWith = (files: Record<string, string>): string => {
    const dir = path.join(fixture.tmpDir, `pending-notes-${++counter}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), content);
    return dir;
  };
  const at = (file: string, ms: number) => fs.utimesSync(file, new Date(ms), new Date(ms));
  const names = () => (getDatabase().prepare('SELECT name FROM entities').all() as Array<{ name: string }>).map((r) => r.name);
  const markersDir = () => path.join(getMemeshDirFromDbPath(), 'private-sessions');
  beforeEach(() => {
    fs.rmSync(markersDir(), { recursive: true, force: true });
    fs.rmSync(path.join(getMemeshDirFromDbPath(), 'note-ingest-holds'), { recursive: true, force: true });
  });

  const pause = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

  it('leaves a note changed since the marker alone, imports an older one, and imports it once the session has ended', () => {
    const dir = dirWith({ 'old.md': note('note_old', 'Old', 'fact', 'Old body.') });
    pause(30);
    const start = Date.now();
    markPrivateSession({ sessionId: 'sess-p', dirs: [dir], now: start });
    fs.writeFileSync(path.join(dir, 'fresh.md'), note('note_fresh', 'Fresh', 'fact', 'Fresh body.'));
    const first = ingestNoteDirectory({ trusted: false, dir });
    expect(first.created).toEqual(['note_old']);
    expect(first.pendingPrivate).toBe(1);
    expect(names()).not.toContain('note_fresh');
    expect(summarizeNoteIngest(first)).toContain("waiting for a private session's next Stop");
    endPrivateSession('sess-p');
    expect(ingestNoteDirectory({ trusted: false, dir }).created).toEqual(['note_fresh']);
  });

  it('waits for a note moved in after the marker even though its modification time is old (mv, cp -p, tar x, rsync -a, touch -t)', () => {
    const dir = dirWith({ 'other.md': note('note_other', 'Other', 'fact', 'Other body.') });
    pause(30);
    markPrivateSession({ sessionId: 'sess-p', dirs: [dir], now: Date.now() });
    fs.writeFileSync(path.join(dir, 'moved.md'), note('note_moved', 'Moved', 'fact', 'Moved body.'));
    at(path.join(dir, 'moved.md'), Date.now() - 3 * 24 * 3600 * 1000); // the old time a move or `cp -p` keeps
    const run = ingestNoteDirectory({ trusted: false, dir });
    expect(run.pendingPrivate).toBe(1);
    expect(names()).not.toContain('note_moved');
  });

  it('keeps the first start time when the marker is renewed, and lets a note the session named stay out after the marker ends', () => {
    const dir = dirWith({ 'named.md': note('note_named', 'Named', 'fact', 'Named body.') });
    const start = Date.now();
    markPrivateSession({ sessionId: 'sess-p', dirs: [dir], now: start });
    markPrivateSession({ sessionId: 'sess-p', dirs: [dir], now: start + 10_000 });
    const marker = JSON.parse(fs.readFileSync(path.join(markersDir(), 'sess-p.json'), 'utf8'));
    expect(marker).toMatchObject({ startedAt: start, updatedAt: start + 10_000 });
    expect(Object.keys(marker).sort()).toEqual(['dirs', 'holdsAt', 'projectsRoot', 'session', 'startedAt', 'updatedAt', 'v']);
    at(path.join(dir, 'named.md'), start + 5_000);
    holdOutNoteFiles({ dir, sessionId: 'sess-p', paths: [path.join(dir, 'named.md')] });
    endPrivateSession('sess-p');
    expect(ingestNoteDirectory({ trusted: false, dir }).created).toEqual([]);
    expect(names()).not.toContain('note_named');
  });

  it('ignores a marker of a folder under another projects root', () => {
    const dir = dirWith({ 'fresh.md': note('note_fresh', 'Fresh', 'fact', 'Fresh body.') });
    const other = path.join(fixture.tmpDir, 'elsewhere', 'project', 'memory');
    fs.mkdirSync(other, { recursive: true });
    markPrivateSession({ sessionId: 'sess-other', dirs: [other], now: Date.now() - 1000 });
    expect(ingestNoteDirectory({ trusted: false, dir }).created).toEqual(['note_fresh']);
  });

  it('does not release what a private session wrote when it has not been heard from past its time: those notes are held by content, once, up to its last activity', () => {
    const dir = dirWith({});
    markPrivateSession({ sessionId: 'sess-stale', dirs: [dir] });
    fs.writeFileSync(path.join(dir, 'written.md'), note('note_written', 'Written', 'fact', 'Written while private.'));
    renewPrivateSession('sess-stale', Date.now() + 1000); // its last sign of life comes after the note
    const later = Date.now() + PRIVATE_WINDOW_MS + 60_000; // the time the import runs: long after
    const first = ingestNoteDirectory({ trusted: false, dir, now: later });
    expect(first.created).toEqual([]);
    expect(first.held.private).toBe(1);
    expect(names()).not.toContain('note_written');
    expect(typeof JSON.parse(fs.readFileSync(path.join(markersDir(), 'sess-stale.json'), 'utf8')).finalizedAt).toBe('number');
    expect(summarizeNoteHolds().notes).toBe(1);
    expect(ingestNoteDirectory({ trusted: false, dir, now: later }).created).toEqual([]); // finalized once, and still held by content
  });

  it('does not hold, when it finalizes an idle session, a note written after that session\'s last activity (Q6_09 P2)', () => {
    const dir = dirWith({});
    const start = Date.now() - 2000;
    markPrivateSession({ sessionId: 'sess-quiet', dirs: [dir], now: start });
    fs.writeFileSync(path.join(dir, 'ordinary.md'), note('note_ordinary', 'Ordinary', 'fact', 'Written by an ordinary session after the private one went quiet.'));
    const run = ingestNoteDirectory({ trusted: false, dir, now: Date.now() + PRIVATE_WINDOW_MS + 60_000 });
    expect(run.created).toEqual(['note_ordinary']);
    expect(summarizeNoteHolds().notes).toBe(0);
  });

  describe('a marker past its time whose session is still writing its transcript', () => {
    const idleStart = () => Date.now() - PRIVATE_WINDOW_MS - 60_000;
    const transcriptAt = (file: string, ageMs: number) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{}\n');
      const t = new Date(Date.now() - ageMs);
      fs.utimesSync(file, t, t);
      return file;
    };

    it('is still live: a note written now waits, nothing is finalized', () => {
      const dir = dirWith({});
      const transcript = transcriptAt(path.join(fixture.tmpDir, 'live.jsonl'), 1000);
      markPrivateSession({ sessionId: 'sess-live', dirs: [dir], transcript, now: idleStart() });
      fs.writeFileSync(path.join(dir, 'new.md'), note('note_new', 'New', 'fact', 'Written by the live session.'));
      const run = ingestNoteDirectory({ trusted: false, dir });
      expect(run.pendingPrivate).toBe(1);
      expect(run.created).toEqual([]);
      expect(JSON.parse(fs.readFileSync(path.join(markersDir(), 'sess-live.json'), 'utf8')).finalized).toBeUndefined();
      expect(summarizeNoteHolds().notes).toBe(0);
    });

    it('is still live when only a subagent\'s transcript was written lately', () => {
      const dir = dirWith({});
      const transcript = transcriptAt(path.join(fixture.tmpDir, 'main.jsonl'), PRIVATE_WINDOW_MS + 3_600_000);
      transcriptAt(path.join(fixture.tmpDir, 'main', 'subagents', 'agent-a1.jsonl'), 1000);
      markPrivateSession({ sessionId: 'sess-sub', dirs: [dir], transcript, now: idleStart() });
      fs.writeFileSync(path.join(dir, 'new.md'), note('note_new', 'New', 'fact', 'Written while a subagent runs.'));
      expect(ingestNoteDirectory({ trusted: false, dir }).pendingPrivate).toBe(1);
    });

    it('is finalized once its transcripts are idle for that long too, and a note written after that is imported', () => {
      const dir = dirWith({});
      const old = PRIVATE_WINDOW_MS + 3_600_000;
      const transcript = transcriptAt(path.join(fixture.tmpDir, 'gone.jsonl'), old);
      transcriptAt(path.join(fixture.tmpDir, 'gone', 'subagents', 'agent-a1.jsonl'), old);
      markPrivateSession({ sessionId: 'sess-gone', dirs: [dir], transcript, now: Date.now() - 1000 });
      fs.writeFileSync(path.join(dir, 'written.md'), note('note_written', 'Written', 'fact', 'Written before it was found gone.'));
      const lastWrite = new Date(Date.now() + 1000); // its transcript was written last after the note
      fs.utimesSync(transcript, lastWrite, lastWrite);
      const later = Date.now() + old;
      expect(ingestNoteDirectory({ trusted: false, dir, now: later }).created).toEqual([]);
      expect(typeof JSON.parse(fs.readFileSync(path.join(markersDir(), 'sess-gone.json'), 'utf8')).finalizedAt).toBe('number');
      fs.writeFileSync(path.join(dir, 'later.md'), note('note_later', 'Later', 'fact', 'Someone else, after.'));
      fs.utimesSync(path.join(dir, 'later.md'), new Date(later - 1000), new Date(later - 1000));
      expect(ingestNoteDirectory({ trusted: false, dir, now: later }).created).toEqual(['note_later']);
    });

    it('is finalized when it does not know its transcript (a host with none), up to the marker\'s last renewal', () => {
      const dir = dirWith({});
      markPrivateSession({ sessionId: 'sess-unknown', dirs: [dir], now: Date.now() - 1000 });
      fs.writeFileSync(path.join(dir, 'written.md'), note('note_written', 'Written', 'fact', 'Body.'));
      renewPrivateSession('sess-unknown', Date.now() + 1000);
      expect(ingestNoteDirectory({ trusted: false, dir, now: Date.now() + PRIVATE_WINDOW_MS + 60_000 }).created).toEqual([]);
      expect(typeof JSON.parse(fs.readFileSync(path.join(markersDir(), 'sess-unknown.json'), 'utf8')).finalizedAt).toBe('number');
    });

    it('keeps its transcript path when the marker is renewed', () => {
      const dir = dirWith({});
      markPrivateSession({ sessionId: 'sess-p', dirs: [dir], transcript: '/some/where/t.jsonl', now: Date.now() - 1000 });
      renewPrivateSession('sess-p');
      markPrivateSession({ sessionId: 'sess-p', dirs: [dir] });
      expect(JSON.parse(fs.readFileSync(path.join(markersDir(), 'sess-p.json'), 'utf8')).transcript).toBe('/some/where/t.jsonl');
    });
  });

  it('renews a marker without moving its start, and does nothing for a session that has none', () => {
    const dir = dirWith({});
    expect(renewPrivateSession('sess-none')).toBe(false);
    const start = Date.now() - 1000;
    markPrivateSession({ sessionId: 'sess-p', dirs: [dir], now: start });
    expect(renewPrivateSession('sess-p', start + 5000)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(markersDir(), 'sess-p.json'), 'utf8'))).toMatchObject({ startedAt: start, updatedAt: start + 5000 });
  });

  it('writes a marker for a folder that does not exist yet, and waits for the first note once it does', () => {
    const parent = dirWith({});
    const dir = path.join(parent, 'memory');
    markPrivateSession({ sessionId: 'sess-p', dirs: [dir], now: Date.now() - 1000 });
    expect(JSON.parse(fs.readFileSync(path.join(markersDir(), 'sess-p.json'), 'utf8')).dirs).toEqual([path.join(fs.realpathSync(parent), 'memory')]);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'first.md'), note('note_first', 'First', 'fact', 'First note.'));
    expect(ingestNoteDirectory({ trusted: false, dir }).pendingPrivate).toBe(1);
    expect(names()).not.toContain('note_first');
  });

  it('imports nothing, and says what to delete, when a marker cannot be read', () => {
    const dir = dirWith({ 'a.md': note('note_a', 'A', 'fact', 'A body.') });
    markPrivateSession({ sessionId: 'sess-p', dirs: [dir] });
    fs.writeFileSync(path.join(markersDir(), 'sess-p.json'), '{ not json');
    let error: (Error & { code?: string }) | undefined;
    try { ingestNoteDirectory({ trusted: false, dir }); } catch (err) { error = err as Error; }
    expect(error?.code).toBe(NOTE_MARKERS_UNREADABLE);
    expect(error?.message).toContain('private-sessions/sess-p.json');
    expect(names()).not.toContain('note_a');
  });
});
