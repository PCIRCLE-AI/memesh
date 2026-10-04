/**
 * MCP `project` on remember, learn and recall: a string names the project,
 * `false` means a memory that belongs to no project. A default recall searches
 * the bound project (if any), memories with no project and global ones, and
 * says which; a write never reaches a memory another project, or no project,
 * owns.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { handleTool } from '../../src/mcp/tools.js';
import { RECALL_RESPONSE_MAX_BYTES, agentRecallEnvelope, capRecallForAgent } from '../../src/core/recall-agent-view.js';
import type { Entity } from '../../src/core/types.js';
import { filler } from '../helpers/recall-size-fixture.js';

const bound = (project: string) => ({ projectBinding: { project } });
const tagsOf = (name: string) => (getDatabase().prepare(
  'SELECT t.tag FROM tags t JOIN entities e ON e.id = t.entity_id WHERE e.name = ? ORDER BY t.tag',
).all(name) as Array<{ tag: string }>).map(t => t.tag);
const rowOf = (name: string) => JSON.stringify({
  row: getDatabase().prepare('SELECT type, status, namespace, metadata FROM entities WHERE name = ?').get(name),
  observations: getDatabase().prepare('SELECT o.content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = ? ORDER BY o.id').all(name),
  tags: tagsOf(name),
});
const recall = async (args: Record<string, unknown>, context?: ReturnType<typeof bound>) => {
  const result = await handleTool('recall', args, undefined, undefined, context);
  expect(result.isError, result.content[0].text).toBeUndefined();
  return JSON.parse(result.content[0].text);
};
const names = (parsed: { entities: Array<{ name: string }> }) => parsed.entities.map(e => e.name).sort();

let dir: string;
let previousMemeshDir: string | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-mcp-project-scope-'));
  previousMemeshDir = process.env.MEMESH_DIR;
  process.env.MEMESH_DIR = dir;
  openDatabase(path.join(dir, 'kg.db'));
});
afterEach(() => {
  closeDatabase();
  if (previousMemeshDir === undefined) delete process.env.MEMESH_DIR;
  else process.env.MEMESH_DIR = previousMemeshDir;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('a memory with no project (project: false)', () => {
  it('is written without a binding, carries no project tag, defaults to personal, and is found by recall', async () => {
    const r = await handleTool('remember', { name: 'pref-tabs', type: 'preference', observations: ['wombat prefers tabs'], tags: ['topic:style'], project: false });
    expect(r.isError, r.content[0].text).toBeUndefined();
    expect(tagsOf('pref-tabs')).toEqual(['topic:style']);
    expect((getDatabase().prepare('SELECT namespace FROM entities WHERE name = ?').get('pref-tabs') as { namespace: string }).namespace).toBe('personal');

    const learned = await handleTool('learn', { error: 'wombat lesson boom', fix: 'wombat lesson fix', project: false });
    expect(learned.isError, learned.content[0].text).toBeUndefined();
    const lesson = JSON.parse(learned.content[0].text).name as string;
    expect(lesson).toMatch(/^lesson-no-project-/);
    expect(tagsOf(lesson).some(t => t.startsWith('project:'))).toBe(false);

    const unbound = await recall({ query: 'wombat' });
    expect(names(unbound)).toEqual([lesson, 'pref-tabs'].sort());
    expect(unbound.entities.every((e: { projects: unknown }) => JSON.stringify(e.projects) === '[]')).toBe(true);
    expect(unbound.scope).toEqual({ project: null, searched: 'memories with no project, and global memories (no project is bound to this session)' });

    const explicit = await recall({ query: 'wombat', project: false }, bound('A'));
    expect(names(explicit)).toEqual([lesson, 'pref-tabs'].sort());
    expect(explicit.scope).toEqual({ project: null, searched: 'memories with no project, and global memories' });
  });
});

describe('updating a memory with no project', () => {
  it('project: false corrects it in place from a bound session, keeping its namespace and tags and adding no project', async () => {
    const created = await handleTool('remember', { name: 'pref-indent', type: 'preference', observations: ['indent with tabs'], tags: ['topic:style'], namespace: 'team', project: false });
    expect(created.isError, created.content[0].text).toBeUndefined();
    const replaced = await handleTool('remember', { name: 'pref-indent', observations: ['indent with two spaces'], replace: true, project: false }, undefined, undefined, bound('A'));
    expect(replaced.isError, replaced.content[0].text).toBeUndefined();
    const appended = await handleTool('remember', { name: 'pref-indent', type: 'preference', observations: ['except in Makefiles'], project: false }, undefined, undefined, bound('A'));
    expect(appended.isError, appended.content[0].text).toBeUndefined();

    const row = getDatabase().prepare('SELECT type, namespace FROM entities WHERE name = ?').get('pref-indent');
    expect(row).toEqual({ type: 'preference', namespace: 'team' });
    expect(tagsOf('pref-indent')).toEqual(['topic:style']);
    const observations = (getDatabase().prepare('SELECT o.content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = ? ORDER BY o.id').all('pref-indent') as Array<{ content: string }>).map(o => o.content);
    expect(observations).toEqual(['indent with two spaces', 'except in Makefiles']);
    // An omitted project from the bound session is a project write: refused, nothing changes.
    const before = rowOf('pref-indent');
    const refused = await handleTool('remember', { name: 'pref-indent', type: 'preference', observations: ['tabs again'] }, undefined, undefined, bound('A'));
    expect(refused.isError).toBe(true);
    expect(rowOf('pref-indent')).toBe(before);
  });
});

describe('an ordinary project session', () => {
  it('files an omitted project under the bound one, and a default recall sees its own, no-project and global memories only', async () => {
    await handleTool('remember', { name: 'a-fact', type: 'fact', observations: ['okapi of A'] }, undefined, undefined, bound('A'));
    expect(tagsOf('a-fact')).toEqual(['project:A']);
    await handleTool('remember', { name: 'b-fact', type: 'fact', observations: ['okapi of B'] }, undefined, undefined, bound('B'));
    await handleTool('remember', { name: 'loose', type: 'fact', observations: ['okapi with no project'], project: false });
    await handleTool('remember', { name: 'everywhere', type: 'fact', observations: ['okapi for all'], namespace: 'global' }, undefined, undefined, bound('C'));

    const fromB = await recall({ query: 'okapi' }, bound('B'));
    expect(names(fromB)).toEqual(['b-fact', 'everywhere', 'loose']);
    expect(Object.fromEntries(fromB.entities.map((e: { name: string; projects: unknown }) => [e.name, e.projects])))
      .toEqual({ 'b-fact': ['B'], everywhere: ['C'], loose: [] });
    expect(fromB.scope).toEqual({ project: 'B', searched: 'project B, memories with no project, and global memories' });
  });
});

describe('an explicit project tag in a bound session', () => {
  it('files a new memory under the tag\'s project, not the bound one', async () => {
    const r = await handleTool('remember', { name: 'tagged-b', type: 'fact', observations: ['numbat of B'], tags: ['project:B'] }, undefined, undefined, bound('A'));
    expect(r.isError, r.content[0].text).toBeUndefined();
    expect(tagsOf('tagged-b')).toEqual(['project:B']);
  });
});

describe('recall selectors', () => {
  beforeEach(async () => {
    await handleTool('remember', { name: 'a-fact', type: 'fact', observations: ['quokka of A'], project: 'A' });
    await handleTool('remember', { name: 'b-fact', type: 'fact', observations: ['quokka of B'], project: 'B' });
    await handleTool('remember', { name: 'loose', type: 'fact', observations: ['quokka with no project'], project: false });
    await handleTool('remember', { name: 'everywhere', type: 'fact', observations: ['quokka for all'], namespace: 'global', project: 'C' });
  });

  it('project: "A" returns A, no-project and global, never B — bound elsewhere or not bound at all', async () => {
    expect(names(await recall({ query: 'quokka', project: 'A' }, bound('B')))).toEqual(['a-fact', 'everywhere', 'loose']);
    expect(names(await recall({ query: 'quokka', project: 'A' }))).toEqual(['a-fact', 'everywhere', 'loose']);
  });

  it('project: false returns no-project and global only', async () => {
    expect(names(await recall({ query: 'quokka', project: false }, bound('A')))).toEqual(['everywhere', 'loose']);
  });

  it('a binding that is set but cannot be resolved is refused with its reason; only an unbound session falls back', async () => {
    const broken = { projectBinding: { error: 'workspace_unavailable' as const, reason: 'MEMESH_PROJECT_ROOT is not an existing absolute directory: "/nope".' } };
    const refused = await handleTool('recall', { query: 'quokka' }, undefined, undefined, broken);
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/^workspace_unavailable: MEMESH_PROJECT_ROOT is not an existing absolute directory/);
    const ambiguous = await handleTool('recall', { query: 'quokka' }, undefined, undefined, { projectBinding: { error: 'workspace_ambiguous' as const, reason: 'roots disagree.' } });
    expect(ambiguous.isError).toBe(true);
    const unbound = await recall({ query: 'quokka' }, { projectBinding: { error: 'workspace_unavailable' as const, reason: 'No project is bound.', unbound: true as const } } as never);
    expect(names(unbound)).toEqual(['everywhere', 'loose']);
    // An explicit project still needs no binding, even a broken one.
    expect(names(await recall({ query: 'quokka', project: false }, broken as never))).toEqual(['everywhere', 'loose']);
  });

  it('project with tag or cross_project is refused, not silently narrowed', async () => {
    for (const extra of [{ tag: 'project:B' }, { cross_project: true }]) {
      for (const project of ['A', false]) {
        const r = await handleTool('recall', { query: 'quokka', project, ...extra }, undefined, undefined, bound('A'));
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toMatch(/one selector/);
      }
    }
  });
});

describe('ownership: a write never reaches a memory it does not own', () => {
  it('refuses another project\'s name or supersedes target, by argument or tag, and changes nothing', async () => {
    await handleTool('remember', { name: 'a-decision', type: 'decision', observations: ['aardvark of A'] }, undefined, undefined, bound('A'));
    const before = rowOf('a-decision');
    const attempts: Array<Record<string, unknown>> = [
      { name: 'a-decision', type: 'decision', observations: ['bandicoot'], project: 'B' },
      { name: 'a-decision', type: 'decision', observations: ['bandicoot'], tags: ['project:B'] },
      { name: 'a-decision', type: 'decision', observations: ['bandicoot'], project: false },
      { name: 'b-decision', type: 'decision', observations: ['bandicoot'], relations: [{ to: 'a-decision', type: 'supersedes' }], project: 'B' },
      { name: 'b-decision', type: 'decision', observations: ['bandicoot'], relations: [{ to: 'a-decision', type: 'supersedes' }], tags: ['project:B'] },
      { name: 'n-decision', type: 'decision', observations: ['bandicoot'], relations: [{ to: 'a-decision', type: 'supersedes' }], project: false },
    ];
    for (const args of attempts) {
      const r = await handleTool('remember', args, undefined, undefined, bound('B'));
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.content[0].text).toMatch(/"a-decision"/);
    }
    expect(rowOf('a-decision')).toBe(before);
    expect(getDatabase().prepare("SELECT name FROM entities WHERE name IN ('b-decision','n-decision')").all()).toEqual([]);
  });

  it('refuses a contradictory project argument and tag, and two project tags', async () => {
    for (const args of [
      { name: 'x', type: 'fact', observations: ['y'], project: 'A', tags: ['project:B'] },
      { name: 'x', type: 'fact', observations: ['y'], project: false, tags: ['project:B'] },
      { name: 'x', type: 'fact', observations: ['y'], tags: ['project:A', 'project:B'] },
    ]) {
      const r = await handleTool('remember', args, undefined, undefined, bound('A'));
      expect(r.isError, JSON.stringify(args)).toBe(true);
    }
    expect(getDatabase().prepare("SELECT name FROM entities WHERE name = 'x'").all()).toEqual([]);
  });

  it('a project write onto an untagged legacy memory is refused; the memory stays findable as no-project', async () => {
    new KnowledgeGraph(getDatabase()).createEntity('legacy', 'fact', { observations: ['capybara legacy'] });
    const before = rowOf('legacy');
    const r = await handleTool('remember', { name: 'legacy', type: 'fact', observations: ['capybara new'] }, undefined, undefined, bound('A'));
    expect(r.isError).toBe(true);
    expect(rowOf('legacy')).toBe(before);

    for (const context of [bound('A'), undefined]) {
      const found = await recall({ query: 'capybara' }, context);
      expect(found.entities.map((e: { name: string; projects: unknown }) => [e.name, e.projects])).toEqual([['legacy', []]]);
    }
  });
});

describe('labels survive the response cap', () => {
  it('a memory in two projects lists both, even when the tag cap hides the one asked for', async () => {
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('multi', 'note', { observations: ['gecko in two projects'], tags: ['project:A', 'project:B'] });
    kg.createEntity('multi-capped', 'note', { observations: ['gecko capped'], tags: [...Array.from({ length: 50 }, (_, i) => `a${filler(`t${i}`, 190)}`), 'project:A', 'project:B'] });
    for (const parsed of [await recall({ query: 'gecko', project: 'B' }), await recall({ query: 'gecko' }, bound('B'))]) {
      const byName = Object.fromEntries(parsed.entities.map((e: { name: string; projects: string[]; tags: string[] }) => [e.name, e]));
      expect(byName.multi.projects).toEqual(['A', 'B']);
      expect(byName['multi-capped'].projects).toEqual(['A', 'B']);
      expect(byName['multi-capped'].tags).not.toContain('project:B');
    }
  });

  it('a project tag dropped by the tag cap still labels the memory', async () => {
    // The project tag sorts last, behind ~10 KB of other tags, so the 8 KB
    // tag budget drops it from the visible tags.
    const tags = [...Array.from({ length: 50 }, (_, i) => `a${filler(`t${i}`, 190)}`), 'project:zz-last'];
    new KnowledgeGraph(getDatabase()).createEntity('tag-heavy', 'note', { observations: ['emu tag heavy'], tags });
    const parsed = await recall({ query: 'emu', project: 'zz-last' });
    expect(parsed.entities).toHaveLength(1);
    expect(parsed.entities[0].truncated.tags.total).toBe(51);
    expect(parsed.entities[0].tags).not.toContain('project:zz-last');
    expect(parsed.entities[0].projects).toEqual(['zz-last']);
  });

  it('the labels and scope are counted inside the 32 KB response cap', async () => {
    for (let i = 0; i < 6; i++) {
      new KnowledgeGraph(getDatabase()).createEntity(`emu-big-${i}`, 'note', {
        observations: Array.from({ length: 30 }, (_, j) => `emu ${filler(`e${i}o${j}`, 400)}`),
        tags: ['project:zz-last'],
      });
    }
    const result = await handleTool('recall', { query: 'emu', project: 'zz-last', limit: 6 });
    expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(RECALL_RESPONSE_MAX_BYTES);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.entities_omitted.total).toBe(6);
    expect(parsed.scope.project).toBe('zz-last');
    expect(parsed.entities.every((e: { projects: string[] }) => e.projects.join() === 'zz-last')).toBe(true);
  });

  it('a scope that would overflow the unscoped response makes the cap drop an entity instead', () => {
    const entities = Array.from({ length: 12 }, (_, i) => ({
      name: `n${i}`, type: 'note', observations: [filler(`o${i}`, 2500)], tags: ['project:p'],
    })) as unknown as Entity[];
    const input = { entities, conflicts: [], retrieval: { mode: 'fts', degraded: false, truncated: false } } as unknown as Parameters<typeof capRecallForAgent>[0];
    const labelled = capRecallForAgent(input, { project: 'p', searched: '' });
    const room = RECALL_RESPONSE_MAX_BYTES - Buffer.byteLength(JSON.stringify(agentRecallEnvelope(labelled)));
    // A scope longer than the room left: counted, it costs an entity; not counted, it overflows.
    const scoped = capRecallForAgent(input, { project: 'p', searched: 'x'.repeat(room + 1) });
    expect(Buffer.byteLength(JSON.stringify(agentRecallEnvelope(scoped)))).toBeLessThanOrEqual(RECALL_RESPONSE_MAX_BYTES);
    expect(scoped.entities.length).toBeLessThan(labelled.entities.length);
  });
});
