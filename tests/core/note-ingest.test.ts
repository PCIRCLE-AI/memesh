// #324 piece C: note-file ingestion.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { remember, forget } from '../../src/core/operations.js';
import {
  ingestNoteDirectory,
  parseFrontmatter,
  NOTE_FILE_TAG,
  NOTE_FILE_MISSING_TAG,
  summarizeNoteIngest,
} from '../../src/core/note-ingest.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

const fixture = useTestDatabase('memesh-note-ingest-');
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
    expect(fm.data.description).toBe('KT wants: "no squash"'.replace(/"/g, '"'));
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
    const r = ingestNoteDirectory({ dir, project: 'proj' });
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

  it('re-import of unchanged files is a no-op; editing one replaces that entity only', () => {
    const dir = makeDir({
      'a.md': note('note_a', 'Alpha', 'decision', 'old alpha text'),
      'b.md': note('note_b', 'Beta', 'lesson', 'beta text'),
    });
    ingestNoteDirectory({ dir });
    const again = ingestNoteDirectory({ dir });
    expect(again).toMatchObject({ created: [], replaced: [], unchanged: 2 });

    fs.writeFileSync(path.join(dir, 'a.md'), note('note_a', 'Alpha v2', 'decision', 'new alpha text'));
    const third = ingestNoteDirectory({ dir });
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
    ingestNoteDirectory({ dir });
    fs.renameSync(path.join(dir, 'a.md'), path.join(fixture.tmpDir, 'a.md.away'));

    const r = ingestNoteDirectory({ dir });
    expect(r.markedMissing).toEqual(['note_a']);
    const a = kg().getEntity('note_a')!;
    expect(a.archived).toBeUndefined();
    expect(a.tags).toContain(NOTE_FILE_MISSING_TAG);
    // Idempotent: a second run does not report it again.
    expect(ingestNoteDirectory({ dir }).markedMissing).toEqual([]);

    fs.renameSync(path.join(fixture.tmpDir, 'a.md.away'), path.join(dir, 'a.md'));
    ingestNoteDirectory({ dir });
    expect(kg().getEntity('note_a')!.tags).not.toContain(NOTE_FILE_MISSING_TAG);
  });

  it('refuses symlinks, even ones pointing at a valid note', () => {
    const outside = path.join(fixture.tmpDir, 'outside.md');
    fs.writeFileSync(outside, note('evil', 'Outside', 'fact', 'outside text'));
    const dir = makeDir({ 'a.md': note('note_a', 'Alpha', 'decision', 'alpha') });
    fs.symlinkSync(outside, path.join(dir, 'link.md'));
    const r = ingestNoteDirectory({ dir });
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
    const r = ingestNoteDirectory({ dir, maxBytes: 1024 });
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
    const first = ingestNoteDirectory({ dir, maxFiles: 1 });
    expect(first).toMatchObject({ created: ['n1'], more: 2 });
    // Unchanged files are recognised by their stat fingerprint and do not use
    // up the cap, so the next run reaches the next file.
    const second = ingestNoteDirectory({ dir, maxFiles: 1 });
    expect(second).toMatchObject({ created: ['n2'], unchanged: 1, more: 1 });
    expect(ingestNoteDirectory({ dir, maxFiles: 1 })).toMatchObject({ created: ['n3'], unchanged: 2, more: 0 });
  });

  it('a file past the cap is still on disk: its memory is not tagged missing', () => {
    const dir = makeDir({
      '1.md': note('n1', 'One', 'fact', 'one'),
      '2.md': note('n2', 'Two', 'fact', 'two'),
    });
    ingestNoteDirectory({ dir });
    fs.writeFileSync(path.join(dir, '1.md'), note('n1', 'One v2', 'fact', 'one changed'));
    fs.writeFileSync(path.join(dir, '2.md'), note('n2', 'Two v2', 'fact', 'two changed'));
    const capped = ingestNoteDirectory({ dir, maxFiles: 1 });
    expect(capped).toMatchObject({ replaced: ['n1'], more: 1, markedMissing: [] });
    expect(kg().getEntity('n2')!.tags).not.toContain(NOTE_FILE_MISSING_TAG);
  });

  it('never overwrites a memory that did not come from a note file', () => {
    remember({ name: 'shared_name', type: 'decision', observations: ['hand-written'] });
    const dir = makeDir({ 'a.md': note('shared_name', 'From file', 'decision', 'file text') });
    const r = ingestNoteDirectory({ dir });
    expect(r.created).toEqual([]);
    expect(r.skipped[0].reason).toMatch(/did not come from a note file/);
    expect(kg().getEntity('shared_name')!.observations).toEqual(['hand-written']);
  });

  it('does not undo a forget', () => {
    const dir = makeDir({ 'a.md': note('note_a', 'Alpha', 'decision', 'alpha') });
    ingestNoteDirectory({ dir });
    forget({ name: 'note_a' });
    fs.writeFileSync(path.join(dir, 'a.md'), note('note_a', 'Alpha v2', 'decision', 'alpha two'));
    const r = ingestNoteDirectory({ dir });
    expect(r.skipped[0].reason).toMatch(/archived with forget/);
    expect(kg().getEntity('note_a')!.archived).toBe(true);
  });

  it('redacts credential-shaped text from the file body', () => {
    const secret = ['Bearer', 'placeholderplaceholder1234'].join(' ');
    const dir = makeDir({ 'a.md': note('note_a', 'Alpha', 'decision', `curl -H "${secret}"`) });
    ingestNoteDirectory({ dir });
    expect(kg().getEntity('note_a')!.observations.join(' ')).not.toContain('placeholderplaceholder');
  });

  it('throws on a directory that does not exist', () => {
    expect(() => ingestNoteDirectory({ dir: path.join(fixture.tmpDir, 'nope') })).toThrow();
  });

  it('F1: an unusable file is remembered by fingerprint, so it neither eats the cap nor starves real notes', () => {
    const dir = makeDir({
      '0-bad.md': '# no frontmatter here\n',
      '1-good.md': note('good_note', 'Good', 'fact', 'good body'),
    });
    const first = ingestNoteDirectory({ dir, maxFiles: 1 });
    expect(first.created).toHaveLength(0);
    expect(first.more).toBe(1);
    expect(first.skipped[0].path).toBe('0-bad.md');

    const second = ingestNoteDirectory({ dir, maxFiles: 1 });
    expect(second.created).toEqual(['good_note']);
    // Still reported — but from the fingerprint, without using the cap.
    expect(second.skipped.map((x) => x.path)).toContain('0-bad.md');
    expect(second.more).toBe(0);

    // Editing the bad file makes it eligible for a real read again.
    fs.writeFileSync(path.join(dir, '0-bad.md'), note('fixed_note', 'Fixed', 'fact', 'now valid'));
    expect(ingestNoteDirectory({ dir, maxFiles: 1 }).created).toEqual(['fixed_note']);
  });

  it('F3: two files with the same frontmatter name do not take turns replacing one memory', () => {
    const dir = makeDir({
      'a.md': note('dup_name', 'From A', 'fact', 'text a'),
      'b.md': note('dup_name', 'From B', 'fact', 'text b'),
    });
    const r = ingestNoteDirectory({ dir });
    expect(r.created).toEqual(['dup_name']);
    expect(r.skipped).toContainEqual({ path: 'b.md', reason: 'name "dup_name" already used by a.md in this directory' });
    const again = ingestNoteDirectory({ dir });
    expect(again.replaced).toHaveLength(0);
    expect(kg().getEntity('dup_name')!.observations).toEqual(['text a']);
    expect(kg().getEntity('dup_name')!.metadata?.replaced_history).toBeUndefined();
  });

  it('F3: the owner of a name keeps it even when a later-added duplicate sorts first', () => {
    const dir = makeDir({ 'b.md': note('dup2', 'Owner', 'fact', 'owner text') });
    ingestNoteDirectory({ dir });
    fs.writeFileSync(path.join(dir, 'a.md'), note('dup2', 'Intruder', 'fact', 'intruder text'));
    const r = ingestNoteDirectory({ dir });
    expect(r.replaced).toHaveLength(0);
    expect(r.skipped).toContainEqual({ path: 'a.md', reason: 'name "dup2" already used by b.md in this directory' });
    expect(kg().getEntity('dup2')!.observations).toEqual(['owner text']);
  });

  it('F4: the frontmatter name gets the same hygiene as the body', () => {
    const secret = ['Bearer', 'placeholderplaceholder1234'].join(' ');
    const dir = makeDir({ 'a.md': note(`leak ${secret}`, 'Alpha', 'fact', 'alpha') });
    const r = ingestNoteDirectory({ dir });
    expect(r.created).toHaveLength(1);
    expect(r.created[0]).not.toContain('placeholderplaceholder');
    expect(r.created[0]).toContain('***REDACTED***');
  });

  it('F5: a file change keeps tags a person added and the first project tag', () => {
    const dir = makeDir({ 'a.md': note('tagged', 'Alpha', 'fact', 'alpha') });
    ingestNoteDirectory({ dir, project: 'first' });
    remember({ name: 'tagged', type: 'fact', tags: ['topic:auth'] });
    fs.writeFileSync(path.join(dir, 'a.md'), note('tagged', 'Alpha v2', 'fact', 'alpha two'));
    ingestNoteDirectory({ dir, project: 'second' });
    expect(kg().getEntity('tagged')!.tags.sort()).toEqual([NOTE_FILE_TAG, 'project:first', 'topic:auth'].sort());
  });

  it('a note-file memory that a manual remember appended to: the next file change replaces the appended line (kept in history)', () => {
    const dir = makeDir({ 'a.md': note('mixed', 'Alpha', 'fact', 'from the file') });
    ingestNoteDirectory({ dir });
    remember({ name: 'mixed', type: 'fact', observations: ['added by hand'] });
    fs.writeFileSync(path.join(dir, 'a.md'), note('mixed', 'Alpha v2', 'fact', 'file edited'));
    ingestNoteDirectory({ dir });
    const e = kg().getEntity('mixed')!;
    expect(e.observations).toEqual(['file edited']);
    const history = e.metadata?.replaced_history as Array<{ observations: string[] }>;
    expect(history.at(-1)!.observations).toEqual(['from the file', 'added by hand']);
  });

  it('P1: a renamed file is one replace, not a replace plus a false "missing"', () => {
    const dir = makeDir({ 'A.md': note('x1', 'X', 'fact', 'x body') });
    ingestNoteDirectory({ dir });
    fs.renameSync(path.join(dir, 'A.md'), path.join(dir, 'B.md'));
    const moved = ingestNoteDirectory({ dir });
    // A move with the bytes intact updates the path only: no new version.
    expect(moved).toMatchObject({ replaced: [], repathed: ['x1'], markedMissing: [] });
    expect(kg().getEntity('x1')!.tags).not.toContain(NOTE_FILE_MISSING_TAG);
    const settled = ingestNoteDirectory({ dir });
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
    for (let i = 0; i < 4; i++) ingestNoteDirectory({ dir, maxFiles: 1 });
    const last = ingestNoteDirectory({ dir, maxFiles: 1 });
    expect(kg().getEntity('good_c')).not.toBeNull();
    expect(last.more).toBe(0);
    expect(last.skipped.map((x) => x.path)).toContain('b.md');
  });

  it('P2-a: a duplicate reclaims the name once its owner is gone', () => {
    const dir = makeDir({
      'a.md': note('same2', 'A', 'fact', 'from a'),
      'b.md': note('same2', 'B', 'fact', 'from b'),
    });
    ingestNoteDirectory({ dir });
    ingestNoteDirectory({ dir });
    fs.rmSync(path.join(dir, 'a.md'));
    const r = ingestNoteDirectory({ dir });
    expect(r.replaced).toEqual(['same2']);
    expect(kg().getEntity('same2')!.observations).toEqual(['from b']);
    expect(kg().getEntity('same2')!.tags).not.toContain(NOTE_FILE_MISSING_TAG);
  });

  it('P2-a: when the owner renames its frontmatter name, the duplicate takes the old one', () => {
    const dir = makeDir({
      'a.md': note('same3', 'A', 'fact', 'from a'),
      'b.md': note('same3', 'B', 'fact', 'from b'),
    });
    ingestNoteDirectory({ dir });
    ingestNoteDirectory({ dir });
    fs.writeFileSync(path.join(dir, 'a.md'), note('renamed_a', 'A2', 'fact', 'from a, renamed'));
    const r = ingestNoteDirectory({ dir });
    expect(r.created).toEqual(['renamed_a']);
    expect(r.replaced).toEqual(['same3']);
    expect(kg().getEntity('same3')!.observations).toEqual(['from b']);
  });

  it('P3-a: no skip-cache row is left behind when nothing is skipped', () => {
    const dir = makeDir({ 'bad.md': 'no frontmatter\n' });
    const r = ingestNoteDirectory({ dir });
    expect(r.skipped).toHaveLength(1);
    const key = `note_ingest_skips:${r.dirId}`;
    const count = () => (getDatabase().prepare('SELECT COUNT(*) AS c FROM memesh_metadata WHERE key = ?').get(key) as { c: number }).c;
    expect(count()).toBe(1);
    fs.rmSync(path.join(dir, 'bad.md'));
    ingestNoteDirectory({ dir });
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
      const r = ingestNoteDirectory({ dir });
      expect(r.created).toHaveLength(0);
      expect(r.replaced).toHaveLength(0);
      expect(r.repathed).toHaveLength(0);
      expect(r.markedMissing).toHaveLength(0);
      return r;
    };

    it('S1: an owner that renames its name hands the old name to the duplicate, then settles', () => {
      const dir = mk('s1', { 'a.md': note('same', 'A', 'fact', 'from a'), 'b.md': note('same', 'B', 'fact', 'from b') });
      ingestNoteDirectory({ dir });
      put(dir, 'a.md', note('other', 'A2', 'fact', 'from a2'));
      ingestNoteDirectory({ dir });
      quiet(dir);
      quiet(dir);
      expect(state('same')).toEqual({ obs: ['from b'], path: 'b.md', missing: false });
      expect(state('other')).toEqual({ obs: ['from a2'], path: 'a.md', missing: false });
    });

    it('S2: an owner that sorts LAST keeps its name when edited; its new content lands', () => {
      const dir = mk('s2', { 'z.md': note('same2', 'Z', 'fact', 'from z') });
      ingestNoteDirectory({ dir });
      put(dir, 'b.md', note('same2', 'B', 'fact', 'from b'));
      ingestNoteDirectory({ dir });
      put(dir, 'z.md', note('same2', 'Z', 'fact', 'from z EDITED'));
      const r = ingestNoteDirectory({ dir });
      expect(r.replaced).toEqual(['same2']);
      expect(r.skipped).toContainEqual({ path: 'b.md', reason: 'name "same2" already used by z.md in this directory' });
      quiet(dir);
      expect(state('same2')).toEqual({ obs: ['from z EDITED'], path: 'z.md', missing: false });
    });

    it('S3: an owner renamed on disk while a duplicate exists keeps the name (content hash)', () => {
      const dir = mk('s3', { 'a.md': note('same3', 'A', 'fact', 'from a'), 'b.md': note('same3', 'B', 'fact', 'from b') });
      ingestNoteDirectory({ dir });
      ingestNoteDirectory({ dir });
      fs.renameSync(path.join(dir, 'a.md'), path.join(dir, 'c.md'));
      const r = ingestNoteDirectory({ dir });
      expect(r).toMatchObject({ replaced: [], repathed: ['same3'], markedMissing: [] });
      quiet(dir);
      expect(state('same3')).toEqual({ obs: ['from a'], path: 'c.md', missing: false });
    });

    it('S3b: the same with the renamed owner sorting last', () => {
      const dir = mk('s3b', { 'a.md': note('same3b', 'A', 'fact', 'from a'), 'm.md': note('same3b', 'M', 'fact', 'from m') });
      ingestNoteDirectory({ dir });
      fs.renameSync(path.join(dir, 'a.md'), path.join(dir, 'z.md'));
      ingestNoteDirectory({ dir });
      quiet(dir);
      expect(state('same3b')).toEqual({ obs: ['from a'], path: 'z.md', missing: false });
    });

    it('S4: a file that renames its name away and back does not ping-pong; the name stays with its new owner', () => {
      const dir = mk('s4', { 'a.md': note('same4', 'A', 'fact', 'from a'), 'b.md': note('same4', 'B', 'fact', 'from b') });
      ingestNoteDirectory({ dir });
      put(dir, 'a.md', note('other4', 'A2', 'fact', 'a2'));
      ingestNoteDirectory({ dir });
      put(dir, 'a.md', note('same4', 'A3', 'fact', 'a3'));
      const r = ingestNoteDirectory({ dir });
      expect(r.skipped).toContainEqual({ path: 'a.md', reason: 'name "same4" already used by b.md in this directory' });
      expect(r.markedMissing).toEqual(['other4']);
      quiet(dir);
      quiet(dir);
      expect(state('same4')).toEqual({ obs: ['from b'], path: 'b.md', missing: false });
      expect(state('other4')!.missing).toBe(true);
    });

    it('S5: a file that changes its own name leaves the old memory tagged missing', () => {
      const dir = mk('s5', { 'a.md': note('old5', 'Old', 'fact', 'v1') });
      ingestNoteDirectory({ dir });
      put(dir, 'a.md', note('new5', 'New', 'fact', 'v2'));
      const r = ingestNoteDirectory({ dir });
      expect(r.created).toEqual(['new5']);
      expect(r.markedMissing).toEqual(['old5']);
      quiet(dir);
      expect(state('old5')).toEqual({ obs: ['v1'], path: 'a.md', missing: true });
      expect(state('new5')).toEqual({ obs: ['v2'], path: 'a.md', missing: false });
    });

    it('an edited owner past the per-run cap is not displaced by a duplicate read first', () => {
      const dir = mk('cap', { 'z.md': note('capname', 'Z', 'fact', 'from z') });
      ingestNoteDirectory({ dir });
      put(dir, 'a.md', note('capname', 'A', 'fact', 'from a'));
      put(dir, 'z.md', note('capname', 'Z', 'fact', 'from z edited'));
      const r = ingestNoteDirectory({ dir, maxFiles: 1 });
      expect(r.more).toBe(1);
      expect(r.replaced).toHaveLength(0);
      expect(r.skipped).toContainEqual({ path: 'a.md', reason: 'name "capname" belongs to z.md, which was not read this run' });
      ingestNoteDirectory({ dir, maxFiles: 1 });
      expect(state('capname')).toEqual({ obs: ['from z edited'], path: 'z.md', missing: false });
    });

    it('N7: a duplicate that arrives a run AFTER the rename still takes the name over', () => {
      const dir = mk('n7', { 'a.md': note('S7', 'A', 'fact', 'a') });
      ingestNoteDirectory({ dir });
      put(dir, 'a.md', note('T7', 'A2', 'fact', 'a renamed'));
      expect(ingestNoteDirectory({ dir }).markedMissing).toEqual(['S7']);
      // The newcomer appears only now, so the file that used to own S7 is not
      // read this run — but this run knows it declares T7.
      put(dir, 'b.md', note('S7', 'B', 'fact', 'from b'));
      const r = ingestNoteDirectory({ dir });
      expect(r.replaced).toEqual(['S7']);
      expect(state('S7')).toEqual({ obs: ['from b'], path: 'b.md', missing: false });
      quiet(dir);
      quiet(dir);
    });

    it('N8: the same when the file that let the name go is an unread, fingerprinted loser', () => {
      const dir = mk('n8', { 'q.md': note('S8', 'Q', 'fact', 'from q') });
      ingestNoteDirectory({ dir });
      // q.md moves to another name, which p.md owns — so q.md loses, is
      // fingerprinted, and S8 is left missing.
      put(dir, 'p.md', note('L8', 'P', 'fact', 'from p'));
      put(dir, 'q.md', note('L8', 'Q2', 'fact', 'from q now L8'));
      const moved = ingestNoteDirectory({ dir });
      expect(moved.created).toEqual(['L8']);
      expect(moved.markedMissing).toEqual(['S8']);
      expect(moved.skipped).toContainEqual({ path: 'q.md', reason: 'name "L8" already used by p.md in this directory' });

      // A newcomer claims S8 while q.md — still the recorded file — is not
      // read at all this run: its name is known from the skip fingerprint.
      put(dir, 'b.md', note('S8', 'B', 'fact', 'from b'));
      const r = ingestNoteDirectory({ dir });
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
      ingestNoteDirectory({ dir });
      expect(state('SWAPA')!.path).toBe('a.md');

      // Swap the two files, keeping both mtimes.
      fs.renameSync(path.join(dir, 'a.md'), path.join(dir, 'tmp.md'));
      fs.renameSync(path.join(dir, 'b.md'), path.join(dir, 'a.md'));
      fs.renameSync(path.join(dir, 'tmp.md'), path.join(dir, 'b.md'));
      fs.utimesSync(path.join(dir, 'a.md'), same, same);
      fs.utimesSync(path.join(dir, 'b.md'), same, same);

      const r = ingestNoteDirectory({ dir });
      expect(r.repathed.sort()).toEqual(['SWAPA', 'SWAPB']);
      expect(state('SWAPA')).toEqual({ obs: ['aaa'], path: 'b.md', missing: false });
      expect(state('SWAPB')).toEqual({ obs: ['bbb'], path: 'a.md', missing: false });
      quiet(dir);
    });

    it('N1d: a rename of the file only — repeated — does not evict the real history', () => {
      const dir = mk('mv', { 'v0.md': note('MV', 'V', 'fact', 'the one real body') });
      ingestNoteDirectory({ dir });
      put(dir, 'v0.md', note('MV', 'V2', 'fact', 'the second real body'));
      ingestNoteDirectory({ dir });
      for (let i = 0; i < 25; i++) {
        fs.renameSync(path.join(dir, i === 0 ? 'v0.md' : `mv${i - 1}.md`), path.join(dir, `mv${i}.md`));
        ingestNoteDirectory({ dir });
      }
      const history = kg().getEntity('MV')!.metadata?.replaced_history as Array<{ observations: string[] }>;
      expect(history).toHaveLength(1);
      expect(history[0].observations).toEqual(['the one real body']);
      expect(state('MV')).toEqual({ obs: ['the second real body'], path: 'mv24.md', missing: false });
    });

    it('N10b: an unparseable recorded file frees its name a run later, exactly as it does in the same run', () => {
      const dir = mk('n10b', { 'a.md': note('U10b', 'A', 'fact', 'from a') });
      ingestNoteDirectory({ dir });
      // The recorded file stops being a note at all.
      put(dir, 'a.md', 'no frontmatter any more\n');
      const broke = ingestNoteDirectory({ dir });
      expect(broke.skipped).toContainEqual({ path: 'a.md', reason: 'no frontmatter — a note file needs a `---` block with a name' });
      expect(broke.markedMissing).toEqual(['U10b']);

      // The newcomer arrives a run later, with a.md skipped by fingerprint.
      put(dir, 'b.md', note('U10b', 'B', 'fact', 'from b'));
      const r = ingestNoteDirectory({ dir });
      expect(r.replaced).toEqual(['U10b']);
      expect(state('U10b')).toEqual({ obs: ['from b'], path: 'b.md', missing: false });
      quiet(dir);
    });

    it('N11: a newcomer refused by the per-run cap still gets the name once it is freed', () => {
      const dir = mk('n11', { 'm.md': note('X11', 'M', 'fact', 'm v1') });
      ingestNoteDirectory({ dir, maxFiles: 1 });
      put(dir, 'a.md', note('X11', 'A', 'fact', 'from a'));
      put(dir, 'm.md', note('Y11', 'M2', 'fact', 'm renamed'));
      // a.md sorts first and uses the one read; m.md is left for later.
      const capped = ingestNoteDirectory({ dir, maxFiles: 1 });
      expect(capped.more).toBe(1);
      // Next run reads m.md: it declares Y11, so X11 loses its file.
      const renamed = ingestNoteDirectory({ dir, maxFiles: 1 });
      expect(renamed.created).toEqual(['Y11']);
      expect(renamed.markedMissing).toEqual(['X11']);
      // And now the newcomer must be able to claim the freed name.
      ingestNoteDirectory({ dir, maxFiles: 1 });
      ingestNoteDirectory({ dir, maxFiles: 1 });
      expect(state('X11')).toEqual({ obs: ['from a'], path: 'a.md', missing: false });
      expect(state('Y11')).toEqual({ obs: ['m renamed'], path: 'm.md', missing: false });
    });

    it('N11b: a freed name is given away even while the file that freed it is past the cap', () => {
      const dir = mk('n11b', { 'm.md': note('X11b', 'M', 'fact', 'm v1') });
      ingestNoteDirectory({ dir });
      put(dir, 'm.md', note('Y11b', 'M2', 'fact', 'm renamed'));
      expect(ingestNoteDirectory({ dir }).markedMissing).toEqual(['X11b']);
      // m.md changes again, so it is no longer "unchanged", and the newcomer
      // sorts first and takes the single read: this run cannot see what m.md
      // declares — but X11b is already nobody's, so the newcomer gets it.
      put(dir, 'm.md', note('Y11b', 'M3', 'fact', 'm edited again'));
      put(dir, 'a.md', note('X11b', 'A', 'fact', 'from a'));
      const r = ingestNoteDirectory({ dir, maxFiles: 1 });
      expect(r.more).toBe(1);
      expect(r.replaced).toEqual(['X11b']);
      expect(state('X11b')).toEqual({ obs: ['from a'], path: 'a.md', missing: false });
    });

    it('S6: the skip row follows the losers — gone when the dup takes over, back and gone again with the returning file', () => {
      const dir = mk('s6', { 'a.md': note('same6', 'A', 'fact', 'a'), 'b.md': note('same6', 'B', 'fact', 'b') });
      const key = `note_ingest_skips:${ingestNoteDirectory({ dir }).dirId}`;
      const row = () => getDatabase().prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(key) as { value: string } | undefined;
      expect(Object.keys(JSON.parse(row()!.value))).toEqual(['b.md']);
      fs.rmSync(path.join(dir, 'a.md'));
      expect(ingestNoteDirectory({ dir }).replaced).toEqual(['same6']);
      expect(row()).toBeUndefined();
      put(dir, 'a.md', note('same6', 'A', 'fact', 'a back'));
      ingestNoteDirectory({ dir });
      expect(Object.keys(JSON.parse(row()!.value))).toEqual(['a.md']);
      fs.rmSync(path.join(dir, 'a.md'));
      ingestNoteDirectory({ dir });
      expect(row()).toBeUndefined();
      expect(state('same6')).toEqual({ obs: ['b'], path: 'b.md', missing: false });
    });
  });
});

describe('note-ingest: the entity type follows the file — #324 C5', () => {
  it('a changed metadata.type updates the stored type, not only the title', () => {
    const dir = makeDir({ 'a.md': note('note_a', 'Alpha', 'feedback', 'Alpha body.') });
    ingestNoteDirectory({ dir });
    expect(kg().getEntity('note_a')!.type).toBe('feedback');

    fs.writeFileSync(path.join(dir, 'a.md'), note('note_a', 'Alpha revised', 'decision', 'Alpha body revised.'));
    const r = ingestNoteDirectory({ dir });
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
    const dir = makeDir({ 'b.md': note('note_b', 'Beta', 'lesson', 'Beta body.') });
    ingestNoteDirectory({ dir });
    fs.writeFileSync(path.join(dir, 'b.md'), note('note_b', 'Beta', 'lesson', 'Beta body changed.'));
    ingestNoteDirectory({ dir });
    expect(kg().getEntity('note_b')!.type).toBe('lesson');
  });
});

describe('note-ingest: a refusal leaves a durable trace — #324 C3', () => {
  it('counts files refused THIS run, and the count goes to zero when nothing changed', () => {
    const dir = makeDir({
      'good.md': note('note_good', 'Good', 'decision', 'Good body.'),
      'nofm.md': '# no frontmatter here',
      'noname.md': '---\ndescription: "nameless"\n---\n\nbody\n',
    });
    const first = ingestNoteDirectory({ dir });
    expect(first.created).toEqual(['note_good']);
    expect(first.skipped).toHaveLength(2);
    // `skipped.length` sticks forever once a file is bad, so the hook cannot
    // use it to decide whether this run had anything to report. The caller
    // printed "note files were read and nothing new needed storing" over a
    // run that rejected two files.
    expect(first.refusedNow, 'two files were refused and nothing counted them').toBe(2);
    expect(summarizeNoteIngest(first)).toContain('2 newly refused');

    const second = ingestNoteDirectory({ dir });
    expect(second.skipped).toHaveLength(2);
    expect(second.refusedNow, 'the same two bad files are not news a second time').toBe(0);
    expect(summarizeNoteIngest(second)).not.toContain('newly refused');

    fs.writeFileSync(path.join(dir, 'third.md'), '# also no frontmatter');
    const third = ingestNoteDirectory({ dir });
    expect(third.skipped).toHaveLength(3);
    expect(third.refusedNow).toBe(1);
  });

  it('a refused symlink is news once, not on every run', () => {
    const dir = makeDir({ 'good.md': note('note_g', 'G', 'decision', 'G body.') });
    fs.symlinkSync(path.join(dir, 'good.md'), path.join(dir, 'link.md'));
    const first = ingestNoteDirectory({ dir });
    expect(first.skipped.map((s) => s.reason)).toEqual(['symlink refused']);
    expect(first.refusedNow).toBe(1);
    // Symlinks are collected before the read loop and were never
    // fingerprinted, so counting them naively says "1 newly refused" on
    // every Stop forever — the same stickiness, relocated.
    const second = ingestNoteDirectory({ dir });
    expect(second.skipped).toHaveLength(1);
    expect(second.refusedNow, 'the symlink was re-reported as new').toBe(0);
  });

  it('a run that stored nothing and refused nothing reports zero of both', () => {
    const dir = makeDir({ 'good.md': note('note_q', 'Q', 'decision', 'Q body.') });
    ingestNoteDirectory({ dir });
    const again = ingestNoteDirectory({ dir });
    expect(again.refusedNow).toBe(0);
    expect(again.created).toEqual([]);
    expect(again.replaced).toEqual([]);
  });
});

describe('note-ingest: a file over the observation cap is refused, not silently trimmed — #324 C6', () => {
  it('names the count instead of storing the first 100 and dropping the rest', () => {
    const body = Array.from({ length: 130 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n');
    const dir = makeDir({ 'big.md': note('note_big', 'Big', 'decision', body) });
    const r = ingestNoteDirectory({ dir });
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
    const r = ingestNoteDirectory({ dir });
    expect(r.created).toEqual(['note_edge']);
    expect(kg().getEntity('note_edge')!.observations).toHaveLength(100);
  });

  it('the refusal is fingerprinted, so the file is not re-read on every run', () => {
    const body = Array.from({ length: 130 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n');
    const dir = makeDir({ 'big.md': note('note_big2', 'Big', 'decision', body) });
    ingestNoteDirectory({ dir });
    const second = ingestNoteDirectory({ dir });
    expect(second.skipped).toHaveLength(1);
    expect(second.refusedNow).toBe(0);
  });
});
