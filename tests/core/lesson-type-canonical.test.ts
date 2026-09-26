// #451: a lesson is stored under one type, `lesson_learned`, whatever name the
// caller used for it. `lesson` and `mistake` meant the same thing and split
// the concept: the briefing's reserved lesson slot, `learn` and the dashboard
// use `lesson_learned`, while agents were taught `lesson`.
import { describe, it, expect } from 'vitest';
import { remember } from '../../src/core/operations.js';
import { canonicalEntityType } from '../../src/core/work-topology.js';
import { getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

useTestDatabase('memesh-lesson-type-');

const kg = () => new KnowledgeGraph(getDatabase());
const storedType = (name: string) =>
  (getDatabase().prepare('SELECT type FROM entities WHERE name = ?').get(name) as { type: string }).type;

describe('canonicalEntityType', () => {
  it('maps lesson and mistake to lesson_learned', () => {
    expect(canonicalEntityType('lesson')).toBe('lesson_learned');
    expect(canonicalEntityType('mistake')).toBe('lesson_learned');
    expect(canonicalEntityType('lesson_learned')).toBe('lesson_learned');
  });

  it('leaves every other type exactly as given', () => {
    for (const type of ['decision', 'note', 'lessons', 'Lesson', 'lesson-learned', 'bug_fix']) {
      expect(canonicalEntityType(type)).toBe(type);
    }
  });
});

describe('remember stores a lesson as lesson_learned (#451)', () => {
  it('type lesson is stored, and echoed, as lesson_learned', () => {
    const r = remember({ name: 'lesson-a', type: 'lesson', observations: ['gate on exit codes'] });
    expect(r.type).toBe('lesson_learned');
    expect(storedType('lesson-a')).toBe('lesson_learned');
  });

  it('type mistake is stored as lesson_learned', () => {
    remember({ name: 'mistake-a', type: 'mistake', observations: ['piped grep hid the exit code'] });
    expect(storedType('mistake-a')).toBe('lesson_learned');
  });

  it('the note form with type lesson is stored as lesson_learned', () => {
    const r = remember({ note: 'Read the exit code, not a grep', type: 'lesson', name: 'note-lesson' });
    expect(r.type).toBe('lesson_learned');
    expect(storedType('note-lesson')).toBe('lesson_learned');
  });

  it('replace on a memory an older version stored as lesson moves it to lesson_learned', () => {
    // An older plugin sharing the same database can still write `lesson`.
    getDatabase().prepare('INSERT INTO entities (name, type) VALUES (?, ?)').run('old-lesson', 'lesson');
    remember({ name: 'old-lesson', type: 'lesson', observations: ['rewritten'], replace: true });
    expect(storedType('old-lesson')).toBe('lesson_learned');
  });

  it('other types are stored exactly as given', () => {
    remember({ name: 'a-decision', type: 'decision', observations: ['use sqlite'] });
    remember({ name: 'a-lessons', type: 'lessons', observations: ['plural is a different type'] });
    expect(storedType('a-decision')).toBe('decision');
    expect(storedType('a-lessons')).toBe('lessons');
  });
});

describe('every createEntity writer stores a lesson as lesson_learned (#451)', () => {
  it('import, note ingest and the memory tool go through createEntity, which canonicalizes', () => {
    kg().createEntity('imported-lesson', 'lesson', { observations: ['from an older export'] });
    kg().createEntity('imported-mistake', 'mistake', { observations: ['from an older export'] });
    expect(storedType('imported-lesson')).toBe('lesson_learned');
    expect(storedType('imported-mistake')).toBe('lesson_learned');
  });
});

describe('listByType canonicalizes the requested type (#451)', () => {
  // GET /api/entities?type= (src/transports/http/server.ts) calls
  // KnowledgeGraph.listByType directly with the query string's `type`
  // value. After the migration renames existing rows, `?type=lesson` or
  // `?type=mistake` must still find them under their new `lesson_learned`
  // type, not silently return nothing.
  it('kg.listByType("lesson") returns lesson_learned rows', () => {
    kg().createEntity('lesson-for-listing', 'lesson_learned', { observations: ['gate on exit codes'] });
    const results = kg().listByType('lesson');
    expect(results.map((e) => e.name)).toContain('lesson-for-listing');
  });

  it('kg.listByType("mistake") also returns lesson_learned rows', () => {
    kg().createEntity('mistake-for-listing', 'lesson_learned', { observations: ['piped grep hid the exit code'] });
    const results = kg().listByType('mistake');
    expect(results.map((e) => e.name)).toContain('mistake-for-listing');
  });

  it('an unrelated type still returns nothing extra', () => {
    kg().createEntity('decision-for-listing', 'decision', { observations: ['use sqlite'] });
    const results = kg().listByType('decision');
    expect(results.map((e) => e.name)).toContain('decision-for-listing');
    expect(kg().listByType('lesson').map((e) => e.name)).not.toContain('decision-for-listing');
  });
});
