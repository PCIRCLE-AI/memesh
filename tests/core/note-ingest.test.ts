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

  it('skips .git and node_modules, oversized files, and reports files past the cap without tagging them missing', () => {
    const dir = makeDir({
      '1.md': note('n1', 'One', 'fact', 'one'),
      '2.md': note('n2', 'Two', 'fact', 'two'),
      '.git/x.md': note('git_note', 'Git', 'fact', 'git'),
      'node_modules/y.md': note('nm_note', 'NM', 'fact', 'nm'),
      'big.md': note('big', 'Big', 'fact', 'x'.repeat(2000)),
    });
    const first = ingestNoteDirectory({ dir, maxBytes: 1024 });
    expect(first.skipped).toContainEqual({ path: 'big.md', reason: 'larger than 1 KB' });
    expect(kg().getEntity('git_note')).toBeNull();
    expect(kg().getEntity('nm_note')).toBeNull();

    // Cap of 1: `1.md` is processed, `2.md` is past the cap.
    const capped = ingestNoteDirectory({ dir, maxFiles: 1, maxBytes: 1024 });
    expect(capped.more).toBe(2); // 2.md and big.md sort after 1.md
    // A file past the cap is still on disk: its memory must not be tagged missing.
    expect(capped.markedMissing).toEqual([]);
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
});
