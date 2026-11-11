/**
 * A checkout is filed under several ids (getProjectIds) and reads all of them. A write of
 * its project may add to a memory it stored under an earlier id, which keeps its one
 * project tag; a write of another project is still refused (memory-mutation.ts).
 */
import { describe, it, expect } from 'vitest';
import { getDatabase } from '../../src/db.js';
import { remember } from '../../src/core/operations.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

useTestDatabase('memesh-mutation-ids-');

const OLD = 'widgets~11111111111111111111111111111111';
const NOW = 'widgets~22222222222222222222222222222222';
const OTHER = 'gadgets~33333333333333333333333333333333';
const projectTags = (name: string) => (getDatabase().prepare(
  "SELECT t.tag FROM tags t JOIN entities e ON e.id = t.entity_id WHERE e.name = ? AND t.tag LIKE 'project:%' ORDER BY t.tag",
).all(name) as Array<{ tag: string }>).map((r) => r.tag);
const observations = (name: string) => (getDatabase().prepare(
  'SELECT o.content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = ? ORDER BY o.id',
).all(name) as Array<{ content: string }>).map((r) => r.content);

describe('a write of a checkout\'s project onto what it stored under an earlier id', () => {
  it('adds to it, and it keeps the one project tag it has', () => {
    remember({ name: 'plan', type: 'fact', observations: ['first'], project: OLD });
    remember({ name: 'plan', type: 'fact', observations: ['second'], project: NOW, projectIds: [NOW, OLD] });
    expect(observations('plan')).toEqual(['first', 'second']);
    expect(projectTags('plan')).toEqual([`project:${OLD}`]);
  });

  it('replaces it in place, keeping its project tag', () => {
    remember({ name: 'plan', type: 'fact', observations: ['first'], project: OLD });
    remember({ name: 'plan', type: 'fact', observations: ['rewritten'], project: NOW, projectIds: [NOW, OLD], replace: true });
    expect(observations('plan')).toEqual(['rewritten']);
    expect(projectTags('plan')).toEqual([`project:${OLD}`]);
  });

  it('without the checkout\'s ids, or with ids that do not include the write\'s project, it is still refused', () => {
    remember({ name: 'plan', type: 'fact', observations: ['first'], project: OLD });
    expect(() => remember({ name: 'plan', type: 'fact', observations: ['x'], project: NOW })).toThrow(/belongs to project:widgets~1111/);
    expect(() => remember({ name: 'plan', type: 'fact', observations: ['x'], project: NOW, projectIds: [OLD] })).toThrow(/belongs to project:widgets~1111/);
    expect(projectTags('plan')).toEqual([`project:${OLD}`]);
  });

  it('another project\'s memory is still refused', () => {
    remember({ name: 'plan', type: 'fact', observations: ['first'], project: OTHER });
    expect(() => remember({ name: 'plan', type: 'fact', observations: ['x'], project: NOW, projectIds: [NOW, OLD] })).toThrow(/belongs to project:gadgets/);
    expect(observations('plan')).toEqual(['first']);
  });
});
