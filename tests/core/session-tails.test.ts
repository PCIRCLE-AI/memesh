import { afterEach, expect, it, vi } from 'vitest';
import { useTestDatabase } from '../helpers/db-fixture.js';
import { getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { selectBriefingPools } from '../../src/core/briefing-pools.js';
import { assembleBriefing } from '../../src/core/briefing.js';
import { setTaskState } from '../../src/core/task-state-store.js';

useTestDatabase('memesh-session-tails-');
afterEach(() => vi.unstubAllEnvs());
const project = 'tails-project';
function add(name: string, session: string, text: string, extra: { project?: string; role?: string; tags?: string[]; metadata?: Record<string, unknown> } = {}) {
  return new KnowledgeGraph(getDatabase()).createEntity(name, 'conversation', {
    observations: [text], tags: [`project:${extra.project ?? project}`, `session:${session}`, `role:${extra.role ?? 'assistant'}`, ...(extra.tags ?? [])],
    metadata: extra.metadata,
  });
}
const pools = (ids = [project]) => selectBriefingPools(getDatabase(), project, { projectIds: ids, projectLimit: 10, global: false, foreign: false });

it('takes the last eligible reply from each of three sessions, latest writes first even within one second', () => {
  add('first', 'a', 'first reply');
  add('second', 'b', 'second reply');
  add('third', 'c', 'third reply');
  add('fourth', 'd', 'fourth reply');
  add('last', 'a', 'OK');
  getDatabase().prepare("UPDATE observations SET created_at = '2026-11-13 00:00:00'").run();
  expect(pools().handoffs.map(r => r.text)).toEqual(['OK', 'fourth reply', 'third reply']);
  expect(getDatabase().prepare('SELECT count(*) AS n FROM entities').get()).toMatchObject({ n: 5 });
});

it('many replies in one session cannot crowd the other sessions out', () => {
  add('other', 'other', 'older session remains visible');
  add('third', 'third', 'another session');
  for (let i = 0; i < 410; i++) add(`many-${i}`, 'busy', `busy reply ${i}`);
  expect(pools().handoffs.map(r => r.sessionId)).toEqual(['busy', 'third', 'other']);
});

it('respects exact project/aliases, assistant roles, unambiguous session IDs, active status and trust', () => {
  add('alias', 'alias', 'eligible alias', { project: 'old-project-id' });
  add('trusted', 's', 'eligible older trusted reply');
  add('imported', 's', 'not automatic', { metadata: { trust: 'untrusted', provenance: { source: 'import' } } });
  add('foreign', 'foreign', 'foreign project', { project: 'another-project' });
  add('user', 'user', 'user is not a handoff', { role: 'user' });
  add('ambiguous', 'ambiguous', 'ambiguous session', { tags: ['session:someone-else'] });
  const archived = add('archived', 'archived', 'archived reply');
  getDatabase().prepare("UPDATE entities SET status = 'archived' WHERE id = ?").run(archived);
  expect(pools([project, 'old-project-id']).handoffs.map(r => r.text)).toEqual(['eligible older trusted reply', 'eligible alias']);
});

it('keeps legacy handoff records as ordinary memories and does not rewrite them', () => {
  const kg = new KnowledgeGraph(getDatabase());
  const old = kg.createEntity(`session-handoff:${project}`, 'session-handoff', { observations: ['old handoff retained'], tags: [`project:${project}`] });
  const before = getDatabase().prepare('SELECT * FROM entities WHERE id = ?').get(old);
  expect(pools().handoffs).toEqual([]);
  expect(pools().project.some(r => r.name === `session-handoff:${project}`)).toBe(true);
  expect(getDatabase().prepare('SELECT * FROM entities WHERE id = ?').get(old)).toEqual(before);
});

it('shows stated task state before the session tails at the default minimal level', () => {
  vi.stubEnv('MEMESH_BRIEFING', 'minimal');
  setTaskState({ project, patch: { goal: 'Finish the parser', next: 'Inspect the exact source' } });
  add('reply', 's', 'latest reply');
  const result = assembleBriefing(project);
  expect(result.text).toContain('Finish the parser');
  expect(result.text).toContain('latest reply');
  expect(result.text.indexOf('Finish the parser')).toBeLessThan(result.text.indexOf('Last reply from a recent session'));
  expect(result.hasHandoff).toBe(true);
});

it('keeps all three eligible session tails when the stated task fields use their supported length', () => {
  vi.stubEnv('MEMESH_BRIEFING', 'minimal');
  setTaskState({ project, patch: { goal: 'G'.repeat(300), next: 'N'.repeat(300), blocked: 'B'.repeat(300), done: 'D'.repeat(300) } });
  for (let i = 1; i <= 3; i++) add(`tail-${i}`, `session-${i}`, 'reply '.repeat(200) + `END-TAIL-${i}`);
  const result = assembleBriefing(project);
  for (let i = 1; i <= 3; i++) expect(result.text).toContain(`END-TAIL-${i}`);
  for (const value of ['G', 'N', 'B', 'D']) expect(result.text).toContain(value.repeat(300));
  expect(result.text).toContain('stated 20');
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(8000);
});

it('reports only actually rendered ranked memories after task and tails consume the opening budget', () => {
  vi.stubEnv('MEMESH_BRIEFING', 'minimal');
  for (let i = 0; i < 8; i++) new KnowledgeGraph(getDatabase()).createEntity(`decision-${i}`, 'decision', {
    observations: [`UNIQUE_MEMORY_${i} ${'知'.repeat(200)}`], tags: [`project:${project}`],
  });
  for (let i = 1; i <= 3; i++) add(`tail-${i}`, `session-${i}`, '- [decision] FAKE_MEMORY_ROW ' + '尾'.repeat(200) + `END-TAIL-${i}`);
  const shorter = assembleBriefing(project);
  setTaskState({ project, patch: { goal: '界'.repeat(300), next: '界'.repeat(300), blocked: '界'.repeat(300), done: '界'.repeat(300) } });
  const result = assembleBriefing(project);
  expect(result.hasTaskState).toBe(true); expect(result.hasHandoff).toBe(true); expect(result.empty).toBe(false);
  const shown = Array.from({ length: 8 }, (_, i) => `UNIQUE_MEMORY_${i}`).filter(marker => result.text.includes(marker));
  expect(result.entityCount).toBe(shown.length); expect(result.entityCount).toBeLessThan(shorter.entityCount);
  for (let i = 1; i <= 3; i++) expect(result.text).toContain(`END-TAIL-${i}`);
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(8000);
});
