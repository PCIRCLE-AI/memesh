import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { handleTool } from '../../src/mcp/tools.js';
import { app } from '../../src/transports/http/server.js';

// A recall scoped to one project must not name a memory of another project as
// the far end of a relation. A foreign end looks the same as one that does not
// exist, on every recall route, unless the caller asked for cross_project.

const cli = path.resolve('dist/transports/cli/cli.js');
let dir: string;
let previousDir: string | undefined;
const bound = { projectBinding: { project: 'A' } };
const idOf = (name: string) => (getDatabase().prepare('SELECT id FROM entities WHERE name = ?').get(name) as { id: number }).id;
type Shown = { name: string; relations?: Array<{ from: string; to: string; type: string }> };
type Run = (args: Record<string, unknown>) => Promise<{ text: string; entities: Shown[] }>;
const targets = (entities: Shown[], name: string) => {
  // The memory must have been recalled at all, or an empty relation list proves nothing.
  expect(entities.map(e => e.name)).toContain(name);
  expect(entities.length).toBeGreaterThan(0);
  return (entities.find(e => e.name === name)?.relations ?? []).map(r => r.to).sort();
};

const mcpWith = (binding: { projectBinding: { project: string } } | undefined): Run => async (args) => {
  const response = await handleTool('recall', args, undefined, undefined, binding);
  expect(response.isError, response.content[0].text).not.toBe(true);
  return { text: response.content[0].text, entities: JSON.parse(response.content[0].text).entities as Shown[] };
};
const mcp = mcpWith(bound);
const mcpUnbound = mcpWith(undefined);
const viaCli: Run = async (args) => {
  const { query, ...options } = args;
  const flags = [
    ...(query === undefined ? [] : [String(query)]),
    ...Object.entries(options).flatMap(([k, v]) => v === true ? [`--${k.replaceAll('_', '-')}`] : [`--${k.replaceAll('_', '-')}`, String(v)]),
  ];
  closeDatabase();
  const result = spawnSync(process.execPath, [cli, 'recall', ...flags, '--json'], {
    cwd: dir, encoding: 'utf8', timeout: 30000,
    env: { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, MEMESH_DIR: dir, MEMESH_DB_PATH: path.join(dir, 'kg.db'), MEMESH_AUTO_CAPTURE: 'false' },
  });
  openDatabase(path.join(dir, 'kg.db'));
  expect(result.status, result.stderr).toBe(0);
  return { text: result.stdout, entities: JSON.parse(result.stdout).entities as Shown[] };
};
const viaHttp: Run = async (body) => {
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP listener unavailable');
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/recall`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    const data = (await response.json()).data;
    return { text: JSON.stringify(data), entities: data.entities as Shown[] };
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-recall-boundary-'));
  previousDir = process.env.MEMESH_DIR;
  process.env.MEMESH_DIR = dir;
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ updateCheck: false }));
  openDatabase(path.join(dir, 'kg.db'));
  const kg = new KnowledgeGraph(getDatabase());
  const make = (name: string, tags: string[], extra: { namespace?: 'global' | 'team' } = {}) =>
    kg.createEntity(name, 'note', { observations: [`boundary ${name}`], tags, ...extra });
  make('A-memory', ['project:A', 'shared']);
  make('A-other', ['project:A']);
  make('A-archived', ['project:A']);
  make('A-team', ['project:A'], { namespace: 'team' });
  make('B-memory', ['project:B']);
  make('B-archived', ['project:B']);
  make('A-new', ['project:A']);
  make('A-old', ['project:A']);
  make('B-old', ['project:B']);
  make('loose', []);
  make('global-from-B', ['project:B'], { namespace: 'global' });
  kg.archiveEntity('A-archived');
  kg.archiveEntity('B-archived');
  kg.archiveEntity('A-old');
  kg.archiveEntity('B-old');
  for (const to of ['B-memory', 'B-archived', 'A-other', 'A-archived', 'A-team', 'loose', 'global-from-B']) kg.createRelation('A-memory', to, 'related_to');
  // An archived memory of A with links out: one to B, one inside A.
  kg.createRelation('A-archived', 'B-memory', 'related_to');
  kg.createRelation('A-archived', 'A-other', 'related_to');
  // A memory with no project, linking to both projects and to a global memory.
  for (const to of ['B-memory', 'A-memory', 'global-from-B']) kg.createRelation('loose', to, 'related_to');
  // A newer memory replacing an archived one of its own project and one of B, and linked to another archived one.
  kg.createRelation('A-new', 'A-old', 'supersedes');
  kg.createRelation('A-new', 'B-old', 'supersedes');
  kg.createRelation('A-new', 'A-archived', 'related_to');
  // The other direction: a foreign memory pointing at A-memory.
  kg.createRelation('B-memory', 'A-memory', 'contradicts');
});

afterEach(() => {
  closeDatabase();
  if (previousDir === undefined) delete process.env.MEMESH_DIR;
  else process.env.MEMESH_DIR = previousDir;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const VISIBLE = ['A-other', 'A-team', 'global-from-B', 'loose'];

describe('recall does not name another project as a relation endpoint', () => {
  const surfaces: Array<[string, Run]> = [['MCP', mcp], ['HTTP', viaHttp], ['CLI', viaCli]];

  for (const [surface, run] of surfaces) {
    it(`${surface}: a project-tag recall by query shows only endpoints visible in that project`, async () => {
      const { text, entities } = await run({ tag: 'project:A', query: 'boundary' });
      expect(targets(entities, 'A-memory')).toEqual(VISIBLE);
      expect(text).not.toContain('B-memory');
      expect(text).not.toContain('B-archived');
    });
    it(`${surface}: a project-tag listing (no query) shows only endpoints visible in that project`, async () => {
      const { text, entities } = await run({ tag: 'project:A' });
      expect(targets(entities, 'A-memory')).toEqual(VISIBLE);
      expect(text).not.toContain('B-memory');
    });
    it(`${surface}: include_archived brings back archived endpoints of the same project only`, async () => {
      const { text, entities } = await run({ tag: 'project:A', query: 'boundary', include_archived: true });
      expect(targets(entities, 'A-memory')).toEqual(['A-archived', ...VISIBLE].sort());
      expect(text).not.toContain('B-memory');
      expect(text).not.toContain('B-archived');
    });
    it(`${surface}: cross_project narrows nothing, archived endpoints included, without include_archived`, async () => {
      const { entities } = await run({ cross_project: true, query: 'boundary' });
      expect(targets(entities, 'A-memory')).toEqual(['A-archived', 'B-archived', 'B-memory', ...VISIBLE].sort());
    });
    it(`${surface}: a project-tag recall keeps a supersedes link to an archived memory of the same project only`, async () => {
      const { text, entities } = await run({ tag: 'project:A', query: 'boundary' });
      expect(targets(entities, 'A-new')).toEqual(['A-old']);
      expect(text).not.toContain('B-old');
    });
    it(`${surface}: an archived memory shown with include_archived does not name another project either`, async () => {
      const { text, entities } = await run({ tag: 'project:A', query: 'boundary', include_archived: true });
      expect(targets(entities, 'A-archived')).toEqual(['A-other']);
      expect(targets(entities, 'A-new')).toEqual(['A-archived', 'A-old']);
      expect(text).not.toContain('B-old');
      expect(text).not.toContain('B-memory');
    });
    it(`${surface}: cross_project is the explicit way to see every endpoint`, async () => {
      const { entities } = await run({ cross_project: true, query: 'boundary', include_archived: true });
      expect(targets(entities, 'A-memory')).toEqual(['A-archived', 'B-archived', 'B-memory', ...VISIBLE].sort());
    });
  }

  // CLI and HTTP have no project binding: a recall with no selector searches every
  // project, but the archived and namespace rules of a recall still hold.
  for (const [surface, run] of surfaces.slice(1)) {
    it(`${surface}: a recall with no selector and no query hides archived endpoints`, async () => {
      const { text, entities } = await run({});
      expect(targets(entities, 'A-memory')).toEqual(['B-memory', ...VISIBLE].sort());
      expect(text).not.toContain('B-archived');
    });
    it(`${surface}: the namespace filter hides endpoints of another namespace with no query and with one`, async () => {
      for (const args of [{ namespace: 'personal' }, { namespace: 'personal', query: 'boundary' }]) {
        const { entities } = await run(args);
        expect(targets(entities, 'A-memory'), JSON.stringify(args)).toEqual(['A-other', 'B-memory', 'loose']);
      }
    });
  }

  it('MCP: with no project bound, or project false, only memories with no project and global ones are endpoints', async () => {
    const cases: Array<[string, Run, Record<string, unknown>]> = [
      ['unbound', mcpUnbound, { query: 'boundary' }],
      ['unbound listing', mcpUnbound, {}],
      ['project false', mcp, { project: false, query: 'boundary' }],
      ['project false listing', mcp, { project: false }],
    ];
    for (const [name, run, args] of cases) {
      const { text, entities } = await run(args);
      expect(targets(entities, 'loose'), name).toEqual(['global-from-B']);
      expect(text, name).not.toContain('B-memory');
    }
  });

  it('MCP: a tag that is not a project tag does not narrow by project', async () => {
    for (const args of [{ tag: 'shared', query: 'boundary' }, { tag: 'shared' }]) {
      const { entities } = await mcp(args);
      expect(targets(entities, 'A-memory'), JSON.stringify(args)).toEqual(['B-memory', ...VISIBLE].sort());
    }
  });

  it('core: an empty tag next to a project scope is no tag, for the relations as for the search', () => {
    const kg = new KnowledgeGraph(getDatabase());
    for (const query of ['boundary', undefined]) {
      const { entities } = kg.searchWithFacts(query, { tag: '', projectScope: 'project:A', scopeRelations: true });
      const shown = entities.find(e => e.name === 'A-memory');
      expect(shown, String(query)).toBeDefined();
      expect((shown!.relations ?? []).map(r => r.to).sort(), String(query)).toEqual(VISIBLE);
    }
  });

  it('MCP: the default recall of a bound session shows only endpoints visible in its project', async () => {
    for (const args of [{ query: 'boundary' }, {}, { project: 'A', query: 'boundary' }]) {
      const { text, entities } = await mcp(args);
      expect(targets(entities, 'A-memory'), JSON.stringify(args)).toEqual(VISIBLE);
      expect(text, JSON.stringify(args)).not.toContain('B-memory');
    }
  });

  it('MCP: a relation that only points INTO a recalled memory from a foreign one is not shown', async () => {
    // Leave B-memory -> A-memory as the only link between them, so the only way to
    // show it is to read relations from their far (to) side.
    getDatabase().prepare('DELETE FROM relations WHERE from_entity_id = ? AND to_entity_id IN (?, ?)').run(idOf('A-memory'), idOf('B-memory'), idOf('B-archived'));
    const { text, entities } = await mcp({ query: 'boundary', include_archived: true });
    expect(targets(entities, 'A-memory')).toEqual(['A-archived', ...VISIBLE].sort());
    expect(text).not.toContain('B-memory');
    expect(text).not.toContain('contradicts');
    expect(JSON.parse(text).conflicts).toBeUndefined();
  });

  it('MCP: a namespace filter hides endpoints of another namespace', async () => {
    const { entities } = await mcp({ query: 'boundary', namespace: 'personal' });
    expect(targets(entities, 'A-memory')).toEqual(['A-other', 'loose']);
  });

  it('ids recall keeps the same rule (regression guard)', async () => {
    const { entities, text } = await mcp({ ids: [idOf('A-memory')] });
    expect(targets(entities, 'A-memory')).toEqual(VISIBLE);
    expect(text).not.toContain('B-memory');
  });

  it('a foreign endpoint reads the same as a missing one', async () => {
    const withForeign = await mcp({ query: 'boundary' });
    getDatabase().prepare("DELETE FROM entities WHERE name IN ('B-memory','B-archived')").run();
    const withoutForeign = await mcp({ query: 'boundary' });
    expect(targets(withForeign.entities, 'A-memory')).toEqual(targets(withoutForeign.entities, 'A-memory'));
  });
});
