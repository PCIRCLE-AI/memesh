import { describe, it, expect } from 'vitest';
import { createExplicitLesson, inferErrorPattern, lessonSlug } from '../../src/core/lesson-engine.js';
import { getDatabase } from '../../src/db.js';
import { recall } from '../../src/core/operations.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

useTestDatabase('memesh-lesson-');

describe('createExplicitLesson', () => {
  it('marks explicit lessons (user-typed) as trusted', () => {
    // The `learn` MCP tool / createExplicitLesson path is user-supplied
    // text, so it remains `trusted` and IS surfaced at session-start.
    createExplicitLesson('manual error', 'manual fix', 'myapp', { severity: 'major' });
    const entities = recall({ tag: 'source:explicit' });
    expect(entities.length).toBeGreaterThanOrEqual(1);
    const meta = entities[0].metadata as { trust?: string } | undefined;
    expect(meta?.trust).toBe('trusted');
  });

  it('creates lesson from user input', () => {
    const result = createExplicitLesson('Test failure', 'Fixed assertion', 'myapp');
    expect(result.name).toContain('lesson-myapp-');

    const entities = recall({ tag: 'source:explicit' });
    expect(entities.length).toBe(1);
  });

  it('infers error pattern from description', () => {
    createExplicitLesson('TypeError: null is not an object', 'Added null check', 'myapp');
    const entities = recall({ tag: 'error-pattern:null-reference' });
    expect(entities.length).toBe(1);
  });
});

describe('Regression #241: explicit lessons are keyed on content, not on the error enum', () => {
  it('two unrelated lessons in one project become two entities', () => {
    const a = createExplicitLesson('A test fake answered from a flag it set itself instead of from the written body', 'Make the fake a store', 'proj');
    const b = createExplicitLesson('The shared secret pattern list has three consumers and one of them drops content', 'Enumerate consumers before editing the list', 'proj');
    expect(a.name).not.toBe(b.name);
    expect(a.name).toMatch(/^lesson-proj-/);
    expect(b.name).toMatch(/^lesson-proj-/);
    // Neither collapsed into the shared bucket.
    expect(a.name).not.toBe('lesson-proj-other');
    expect(b.name).not.toBe('lesson-proj-other');
  });

  it('resubmitting the same lesson still lands on the same entity and appends', () => {
    const first = createExplicitLesson('Widened the credential regex without a left boundary', 'Add \\b', 'proj');
    const again = createExplicitLesson('Widened the credential regex without a left boundary', 'Add \\b and a negative corpus', 'proj');
    expect(again.name).toBe(first.name);
    const db = getDatabase();
    const row = db.prepare('SELECT id FROM entities WHERE name = ?').get(first.name) as { id: number };
    const n = (db.prepare('SELECT COUNT(*) AS n FROM observations WHERE entity_id = ?').get(row.id) as { n: number }).n;
    expect(n).toBe(8); // two submissions x four fields
  });

  it('keeps lessons distinct when their first eight significant words match', () => {
    const shared = 'The shared parser must preserve every trusted project memory';
    const a = createExplicitLesson(`${shared} when importing a backup`, 'Keep import provenance', 'proj');
    const b = createExplicitLesson(`${shared} when rendering a briefing`, 'Keep render provenance', 'proj');

    expect(a.name).not.toBe(b.name);
    expect(a.name.replace(/-[0-9a-f]{8}$/, '')).toBe(b.name.replace(/-[0-9a-f]{8}$/, ''));
    const rows = getDatabase().prepare(
      "SELECT name FROM entities WHERE type = 'lesson_learned' AND name IN (?, ?)",
    ).all(a.name, b.name);
    expect(rows).toHaveLength(2);
  });

  it('lessonSlug is bounded and stable', () => {
    expect(lessonSlug('Null pointer in the auth path')).toBe('null-pointer-in-the-auth-path-78ea3cb2');
    expect(lessonSlug('  NULL pointer in the auth path  ')).toBe('null-pointer-in-the-auth-path-78ea3cb2');
    expect(lessonSlug('x'.repeat(500)).length).toBeLessThanOrEqual(80);
    expect(lessonSlug('!!!')).toBe('unspecified-e84c538e');
  });
});

describe('inferErrorPattern', () => {
  it('detects null-reference', () => {
    expect(inferErrorPattern('TypeError: Cannot read property of null')).toBe('null-reference');
    expect(inferErrorPattern('undefined is not a function')).toBe('null-reference');
  });

  it('detects type-error', () => {
    expect(inferErrorPattern('Type mismatch: string vs number')).toBe('type-error');
  });

  it('detects import-missing', () => {
    expect(inferErrorPattern('Module not found: ./utils')).toBe('import-missing');
  });

  it('detects config-error', () => {
    expect(inferErrorPattern('Missing environment variable')).toBe('config-error');
  });

  it('detects test-failure', () => {
    expect(inferErrorPattern('Test failed: assertion error')).toBe('test-failure');
  });

  it('defaults to other', () => {
    expect(inferErrorPattern('Something weird happened')).toBe('other');
  });
});
