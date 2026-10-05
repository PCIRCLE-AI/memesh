/**
 * A remember the transport binds to a project (`RememberInput.project`): the
 * memory is tagged with that project, and a write onto a name that belongs to
 * another project, or to no project, is refused before anything is written.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { remember } from '../../src/core/operations.js';

let dir: string;
const counts = () => Object.fromEntries(['entities', 'observations', 'tags', 'entities_fts', 'relations'].map(t =>
  [t, (getDatabase().prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n]));
// Everything a refused write could change on the memory it names, read back.
const snapshot = (name: string) => JSON.stringify({
  row: getDatabase().prepare('SELECT type, title, metadata, status, confidence, namespace FROM entities WHERE name = ?').get(name),
  observations: getDatabase().prepare('SELECT o.content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = ? ORDER BY o.id').all(name),
  tags: tagsOf(name),
  counts: counts(),
});
const keywordHits = (word: string) => (getDatabase().prepare(
  'SELECT e.name FROM entities_fts f JOIN entities e ON e.id = f.rowid WHERE entities_fts MATCH ?',
).all(word) as Array<{ name: string }>).map(r => r.name);
const tagsOf = (name: string) => (getDatabase().prepare(
  'SELECT t.tag FROM tags t JOIN entities e ON e.id = t.entity_id WHERE e.name = ? ORDER BY t.tag',
).all(name) as Array<{ tag: string }>).map(t => t.tag);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-remember-bound-'));
  openDatabase(path.join(dir, 'kg.db'));
});
afterEach(() => {
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('remember bound to a project', () => {
  it('tags a new memory with the bound project and keeps the caller tags', () => {
    remember({ name: 'shared-name', type: 'fact', observations: ['from A'], tags: ['topic:x'], project: 'A' });
    expect(tagsOf('shared-name')).toEqual(['project:A', 'topic:x']);
  });

  it('appends to and replaces its own project memory', () => {
    remember({ name: 'mine', type: 'fact', observations: ['one'], tags: ['topic:x'], project: 'A' });
    remember({ name: 'mine', type: 'fact', observations: ['two'], project: 'A' });
    remember({ name: 'mine', type: 'fact', observations: ['three'], replace: true, project: 'A' });
    const obs = (getDatabase().prepare('SELECT o.content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = ?')
      .all('mine') as Array<{ content: string }>).map(o => o.content);
    expect(obs).toEqual(['three']);
    expect(tagsOf('mine')).toEqual(['project:A', 'topic:x']);
  });

  it('appends to a memory that already belongs to several projects, from any project it lists', () => {
    new KnowledgeGraph(getDatabase()).createEntity('shared-legacy', 'fact', { observations: ['from both'], tags: ['project:A', 'project:B'] });
    remember({ name: 'shared-legacy', type: 'fact', observations: ['added by A'], project: 'A' });
    remember({ name: 'shared-legacy', type: 'fact', observations: ['added by B'], project: 'B' });
    const obs = (getDatabase().prepare('SELECT o.content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = ? ORDER BY o.id')
      .all('shared-legacy') as Array<{ content: string }>).map(o => o.content);
    expect(obs).toEqual(['from both', 'added by A', 'added by B']);
    expect(tagsOf('shared-legacy')).toEqual(['project:A', 'project:B']);
  });

  it('refuses a name another project holds, and writes nothing', () => {
    remember({ name: 'shared-name', type: 'fact', title: 'A title', observations: ['aardvark from A'], tags: ['topic:a'], project: 'A' });
    const before = snapshot('shared-name');
    expect(() => remember({ name: 'shared-name', type: 'decision', title: 'B title', observations: ['bandicoot from B'], tags: ['topic:b'], project: 'B' }))
      .toThrow(/"shared-name".*project:A.*project B/s);
    expect(snapshot('shared-name')).toBe(before);
    expect(() => remember({ name: 'shared-name', type: 'decision', observations: ['bandicoot again'], replace: true, project: 'B' }))
      .toThrow(/project:A/);
    expect(snapshot('shared-name')).toBe(before);
    expect(() => remember({ name: 'shared-name', note: 'Bandicoot note\n\nbandicoot body', project: 'B' }))
      .toThrow(/project:A/);
    expect(snapshot('shared-name')).toBe(before);
    expect(tagsOf('shared-name')).toHaveLength(2);
    expect(keywordHits('aardvark')).toEqual(['shared-name']);
    expect(keywordHits('bandicoot')).toEqual([]);
  });

  it('refuses a legacy memory with no project tag, and writes nothing, under an argument or a tag; a no-project write still reaches it', () => {
    new KnowledgeGraph(getDatabase()).createEntity('legacy-name', 'fact', { observations: ['old capybara'] });
    const before = snapshot('legacy-name');
    let message = '';
    try { remember({ name: 'legacy-name', type: 'fact', observations: ['new text'], project: 'A' }); } catch (e) { message = String(e); }
    expect(message).toMatch(/"legacy-name".*no project tag/s);
    expect(message).not.toContain('new text');
    expect(snapshot('legacy-name')).toBe(before);
    expect(() => remember({ name: 'legacy-name', type: 'fact', observations: ['replaced text'], replace: true, project: 'A' }))
      .toThrow(/no project tag/);
    expect(snapshot('legacy-name')).toBe(before);
    expect(keywordHits('capybara')).toEqual(['legacy-name']);
    expect(keywordHits('replaced')).toEqual([]);
    // A project tag is the same declaration as the argument, with the same check.
    expect(() => remember({ name: 'legacy-name', type: 'fact', observations: ['tagged text'], tags: ['project:A'] }))
      .toThrow(/no project tag/);
    expect(snapshot('legacy-name')).toBe(before);
    // The memory stays reachable as what it is: a memory with no project.
    remember({ name: 'legacy-name', type: 'fact', observations: ['new text'], project: null });
    expect(tagsOf('legacy-name')).toEqual([]);
    expect(keywordHits('new')).toEqual(['legacy-name']);
  });

  it('refuses a supersedes relation that would archive another project\'s memory, and writes nothing', () => {
    remember({ name: 'a-decision', type: 'decision', why: 'a fixture for project scope; revisit if scope rules change', observations: ['aardvark choice of A'], project: 'A' });
    const before = snapshot('a-decision');
    expect(() => remember({ name: 'b-decision', type: 'decision', why: 'a fixture for project scope; revisit if scope rules change', observations: ['bandicoot choice of B'], relations: [{ to: 'a-decision', type: 'supersedes' }], project: 'B' }))
      .toThrow(/"a-decision".*project:A.*project B/s);
    expect(snapshot('a-decision')).toBe(before);
    expect(JSON.parse(snapshot('b-decision')).row).toBeUndefined();
    expect(keywordHits('aardvark')).toEqual(['a-decision']);
    expect(keywordHits('bandicoot')).toEqual([]);
    // Within its own project a bound write still supersedes.
    remember({ name: 'a-decision-2', type: 'decision', why: 'a fixture for project scope; revisit if scope rules change', observations: ['newer aardvark'], relations: [{ to: 'a-decision', type: 'supersedes' }], project: 'A' });
    expect(JSON.parse(snapshot('a-decision')).row.status).toBe('archived');
  });

  it('without a bound project, remember is unchanged', () => {
    remember({ name: 'plain', type: 'fact', observations: ['x'] });
    expect(tagsOf('plain')).toEqual([]);
  });
});
