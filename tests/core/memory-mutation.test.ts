/**
 * A checkout is filed under several ids (getProjectIds) and reads all of them. A write of
 * its project may add to a memory it stored under an earlier id, which keeps its one
 * project tag; another project gets a qualified name rather than changing it.
 */
import { describe, it, expect } from 'vitest';
import { getDatabase } from '../../src/db.js';
import { remember, forget } from '../../src/core/operations.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { resolveProjectMemoryName } from '../../src/storage/memory-mutation.js';
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
  it('stores the same requested name for two projects and resolves subsequent writes locally', () => {
    const first = remember({ name: 'build-cmd', type: 'fact', observations: ['project one'], project: OLD });
    const second = remember({ name: 'build-cmd', type: 'fact', observations: ['project two'], project: OTHER });
    expect(first.stored).toBe(true);
    expect(second.stored).toBe(true);
    expect(second.name).not.toBe(first.name);
    expect(remember({ name: 'build-cmd', observations: ['second append'], project: OTHER }).name).toBe(second.name);
    expect(observations(first.name)).toEqual(['project one']);
    expect(observations(second.name)).toEqual(['project two', 'second append']);
    expect(projectTags(first.name)).toEqual([`project:${OLD}`]);
    expect(projectTags(second.name)).toEqual([`project:${OTHER}`]);
  });

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

  it('without valid checkout ids, the old project row is not adopted', () => {
    remember({ name: 'plan', type: 'fact', observations: ['first'], project: OLD });
    const second = remember({ name: 'plan', type: 'fact', observations: ['x'], project: NOW, projectIds: [OLD] });
    expect(second.name).toBe(`plan@${NOW}`);
    expect(projectTags(second.name)).toEqual([`project:${NOW}`]);
    expect(observations('plan')).toEqual(['first']);
    expect(projectTags('plan')).toEqual([`project:${OLD}`]);
  });

  it('append, replace, relations and forget stay in the requested project', () => {
    remember({ name: 'plan', type: 'fact', observations: ['first'], project: OTHER });
    const own = remember({ name: 'plan', type: 'fact', observations: ['x'], project: NOW, projectIds: [NOW, OLD] });
    expect(own.name).toBe(`plan@${NOW}`);
    remember({ name: 'plan', observations: ['local replacement'], replace: true, project: NOW });
    expect(observations(own.name)).toEqual(['local replacement']);
    remember({ name: 'plan', observations: ['remove me'], project: NOW });
    expect(forget({ name: 'plan', observation: 'remove me', project: NOW })).toMatchObject({ observation_removed: true, name: own.name });
    expect(observations(own.name)).toEqual(['local replacement']);
    const related = remember({ name: 'dependent', type: 'fact', observations: ['dependent'], project: NOW, relations: [{ to: 'plan', type: 'relates_to' }] });
    expect(getDatabase().prepare('SELECT to_entity_id FROM relations WHERE from_entity_id=?').get(related.entityId)).toEqual({ to_entity_id: own.entityId });
    expect(forget({ name: 'plan', project: NOW })).toMatchObject({ archived: true, name: own.name });
    expect(new KnowledgeGraph(getDatabase()).getEntity('plan')?.archived).not.toBe(true);
    expect(observations('plan')).toEqual(['first']);
    expect(forget({ name: 'plan', project: OTHER })).toMatchObject({ archived: true, name: 'plan' });
  });

  it('finds a qualified name under a previous checkout id and keeps the tag', () => {
    remember({ name: 'plan', type: 'fact', observations: ['foreign'], project: OTHER });
    const own = remember({ name: 'plan', type: 'fact', observations: ['old'], project: OLD });
    const updated = remember({ name: 'plan', observations: ['new'], project: NOW, projectIds: [NOW, OLD] });
    expect(updated.name).toBe(own.name);
    expect(projectTags(own.name)).toEqual([`project:${OLD}`]);
    expect(observations(own.name)).toEqual(['old', 'new']);
  });

  it('does not guess scope or overwrite an occupied foreign qualified name', () => {
    remember({ name: 'plan', type: 'fact', observations: ['foreign'], project: OTHER });
    remember({ name: `plan@${NOW}`, type: 'fact', observations: ['occupied'], project: OTHER });
    expect(resolveProjectMemoryName(getDatabase(), 'plan', undefined)).toBe('plan');
    const kg = new KnowledgeGraph(getDatabase());
    const before = [kg.getEntity('plan'), kg.getEntity(`plan@${NOW}`)];
    const own = remember({ name: 'plan', type: 'fact', observations: ['x'], project: NOW });
    expect(own.name).toBe(`plan@${NOW}~2`);
    expect(remember({ name: 'plan', observations: ['append'], project: NOW }).name).toBe(own.name);
    expect(observations(own.name)).toEqual(['x', 'append']);
    expect(remember({ name: 'plan', observations: ['replacement'], replace: true, project: NOW }).name).toBe(own.name);
    const related = remember({ name: 'dependent', type: 'fact', observations: ['x'], project: NOW, relations: [{ to: 'plan', type: 'relates_to' }] });
    expect(getDatabase().prepare('SELECT to_entity_id FROM relations WHERE from_entity_id=?').get(related.entityId)).toEqual({ to_entity_id: own.entityId });
    expect(forget({ name: 'plan', project: NOW })).toMatchObject({ archived: true, name: own.name });
    expect([kg.getEntity('plan'), kg.getEntity(`plan@${NOW}`)]).toEqual(before);
    expect(() => remember({ name: 'plan', type: 'fact', observations: ['x'], project: null })).toThrow(/without a project/);
    expect(() => forget({ name: `plan@${NOW}`, project: NOW })).toThrow(/belongs/);
    expect(observations('plan')).toEqual(['foreign']);
  });

  it('keeps legacy default-project append unfiled', () => {
    remember({ name: 'legacy', type: 'fact', observations: ['old'], project: null });
    expect(remember({ name: 'legacy', observations: ['new'], project: NOW, projectIsDefault: true }).name).toBe('legacy');
    expect(projectTags('legacy')).toEqual([]);
    expect(observations('legacy')).toEqual(['old', 'new']);
    expect(forget({ name: 'legacy', observation: 'new', project: NOW }).observation_removed).toBe(true);
    expect(observations('legacy')).toEqual(['old']);
  });

  it('finds a secondary name across holes and checkout aliases without accepting noncanonical suffixes', () => {
    remember({ name: 'plan', type: 'fact', observations: ['foreign'], project: OTHER });
    remember({ name: `plan@${OLD}~02`, type: 'fact', observations: ['literal'], project: OLD });
    const own = remember({ name: `plan@${OLD}~3`, type: 'fact', observations: ['local'], project: OLD });
    expect(remember({ name: 'plan', observations: ['append'], project: NOW, projectIds: [NOW, OLD] }).name).toBe(own.name);
    expect(observations(`plan@${OLD}~02`)).toEqual(['literal']);
    expect(observations(own.name)).toEqual(['local', 'append']);
  });

  it('supersedes only the local namesake', () => {
    remember({ name: 'choice', type: 'fact', observations: ['foreign'], project: OTHER });
    const own = remember({ name: 'choice', type: 'fact', observations: ['local'], project: NOW });
    remember({ name: 'new-choice', type: 'fact', observations: ['new'], project: NOW, relations: [{ to: 'choice', type: 'supersedes' }] });
    const kg = new KnowledgeGraph(getDatabase());
    expect(kg.getEntity(own.name)?.archived).toBe(true);
    expect(kg.getEntity('choice')?.archived).not.toBe(true);
    expect(observations('choice')).toEqual(['foreign']);
  });
});
