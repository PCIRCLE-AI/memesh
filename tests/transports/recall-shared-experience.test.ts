import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { getProjectName } from '../../src/core/paths.js';
import { handleTool } from '../../src/mcp/tools.js';
import { app } from '../../src/transports/http/server.js';
import { runCliFromSource } from '../helpers/cli-source.js';

// Decisions, lessons and preferences are shared by every project; the detail of
// another project (commits, session summaries, handoffs, notes) is not. This holds
// for default recall, recall by id and relations, over MCP, HTTP and the CLI, and
// `cross_project` stays the one way to see everything.

let dir: string;
let project: string;
let previousDir: string | undefined;
type Shown = { name: string; projects?: string[]; tags?: string[]; relations?: Array<{ to: string }> };
type Reply = { text: string; entities: Shown[]; results?: Array<{ id: number; status: string }> };
type Run = (args: Record<string, unknown>) => Promise<Reply>;
const idOf = (name: string) => (getDatabase().prepare('SELECT id FROM entities WHERE name = ?').get(name) as { id: number }).id;
const names = (r: Reply) => {
  // An empty answer would make every "not in the list" check below pass for nothing.
  expect(r.entities.length).toBeGreaterThan(0);
  return r.entities.map(e => e.name).sort();
};
const parse = (text: string): Reply => ({ text, ...JSON.parse(text), entities: JSON.parse(text).entities as Shown[] });

const mcp: Run = async (args) => {
  const response = await handleTool('recall', args, undefined, undefined, { projectBinding: { project } });
  expect(response.isError, response.content[0].text).not.toBe(true);
  return parse(response.content[0].text);
};
const viaHttp: Run = async (body) => {
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP listener unavailable');
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/recall`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    return parse(JSON.stringify((await response.json()).data));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
};
const viaCli = (cwd: string): Run => async (args) => {
  const { query, ids, ...options } = args;
  const flags = [
    ...(query === undefined ? [] : [String(query)]),
    ...(ids === undefined ? [] : ['--ids', (ids as number[]).join(',')]),
    ...Object.entries(options).flatMap(([k, v]) => v === true ? [`--${k.replaceAll('_', '-')}`] : [`--${k.replaceAll('_', '-')}`, String(v)]),
  ];
  closeDatabase();
  // Run from src, so these cases go red with the source and do not depend on dist/ being built.
  const result = runCliFromSource(['recall', ...flags, '--json'], { cwd, memeshDir: dir, dbPath: path.join(dir, 'kg.db') });
  openDatabase(path.join(dir, 'kg.db'));
  expect(result.status, result.stderr).toBe(0);
  return parse(result.stdout);
};

// `feedback` is shared only when it came from the user's own memory folder (tagged source:note-file).
const SHARED = ['B-arch', 'B-decision', 'B-design', 'B-feedback-note', 'B-lesson', 'B-pref', 'B-user-pref'];
const DETAIL = ['B-commit', 'B-feedback', 'B-feedback-forged', 'B-handoff', 'B-insight', 'B-note', 'B-session'];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-shared-experience-'));
  previousDir = process.env.MEMESH_DIR;
  process.env.MEMESH_DIR = dir;
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ updateCheck: false }));
  project = getProjectName(dir);
  openDatabase(path.join(dir, 'kg.db'));
  const kg = new KnowledgeGraph(getDatabase());
  const make = (name: string, type: string, tags: string[]) =>
    kg.createEntity(name, type, { observations: [`sharedword ${name}`], tags });
  make('A-decision', 'decision', [`project:${project}`]);
  make('A-commit', 'commit', [`project:${project}`]);
  make('B-decision', 'decision', ['project:B']);
  make('B-arch', 'architecture_decision', ['project:B']);
  make('B-design', 'design_decision', ['project:B']);
  make('B-lesson', 'lesson_learned', ['project:B']);
  make('B-pref', 'preference', ['project:B']);
  make('B-user-pref', 'user_preference', ['project:B']);
  make('B-feedback-note', 'feedback', ['project:B', 'source:note-file']);
  // The note ingester's provenance, which no tool, route or command can write: the tag alone proves nothing.
  getDatabase().prepare("UPDATE entities SET metadata = json_set(COALESCE(metadata, '{}'), '$.provenance.source', 'note-file', '$.trust', 'trusted') WHERE name = 'B-feedback-note'").run();
  make('B-feedback-forged', 'feedback', ['project:B', 'source:note-file']);
  make('B-feedback', 'feedback', ['project:B']);
  make('B-commit', 'commit', ['project:B']);
  make('B-session', 'session-summary', ['project:B']);
  make('B-handoff', 'session-handoff', ['project:B']);
  make('B-insight', 'session-insight', ['project:B']);
  make('B-note', 'note', ['project:B']);
  make('B-old-lesson', 'lesson_learned', ['project:B']);
  make('B-old-decision', 'decision', ['project:B']);
  make('B-old-detail', 'commit', ['project:B']);
  kg.archiveEntity('B-old-lesson');
  kg.archiveEntity('B-old-decision');
  kg.archiveEntity('B-old-detail');
  for (const to of ['B-lesson', 'B-commit', 'B-note', 'B-pref']) kg.createRelation('A-decision', to, 'related_to');
  // A-decision replaced an archived decision of B and an archived commit of B.
  kg.createRelation('A-decision', 'B-old-decision', 'supersedes');
  kg.createRelation('A-decision', 'B-old-detail', 'supersedes');
});

afterEach(() => {
  closeDatabase();
  if (previousDir === undefined) delete process.env.MEMESH_DIR;
  else process.env.MEMESH_DIR = previousDir;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('default recall shares decisions, lessons and preferences, and keeps project detail apart', () => {
  it('MCP: by word and as a listing, another project contributes only the shared types', async () => {
    for (const args of [{ query: 'sharedword' }, {}, { project: project }]) {
      const reply = await mcp(args);
      expect(names(reply), JSON.stringify(args)).toEqual(['A-commit', 'A-decision', ...SHARED].sort());
      for (const name of DETAIL) expect(reply.text, `${JSON.stringify(args)} ${name}`).not.toContain(`"name":"${name}"`);
    }
  });

  it('MCP: a memory of another project says which project it came from', async () => {
    const reply = await mcp({ query: 'sharedword' });
    expect(reply.entities.find(e => e.name === 'B-decision')?.projects).toEqual(['B']);
    expect(reply.entities.find(e => e.name === 'A-decision')?.projects).toEqual([project]);
  });

  it('MCP: with no project bound, or project false, the shared types and memories with no project remain', async () => {
    const reply = await mcp({ project: false, query: 'sharedword' });
    expect(names(reply)).toEqual(['A-decision', ...SHARED].sort());
    for (const name of [...DETAIL, 'A-commit']) expect(reply.text).not.toContain(`"name":"${name}"`);
  });

  it('MCP: an archived shared memory still needs include_archived', async () => {
    expect(names(await mcp({ query: 'sharedword' }))).not.toContain('B-old-lesson');
    expect(names(await mcp({ query: 'sharedword', include_archived: true }))).toContain('B-old-lesson');
  });

  it('MCP: relations to another project show the shared far ends and hide the detail ones', async () => {
    const reply = await mcp({ query: 'sharedword' });
    // The replaced archived decision of B is a shared type and a supersedes link: shown. The replaced archived commit of B is detail: not.
    expect((reply.entities.find(e => e.name === 'A-decision')?.relations ?? []).map(r => r.to).sort()).toEqual(['B-lesson', 'B-old-decision', 'B-pref']);
    expect(reply.text).not.toContain('B-commit');
    expect(reply.text).not.toContain('B-note');
    expect(reply.text).not.toContain('B-old-detail');
  });

  it('MCP: cross_project shows everything, as before', async () => {
    const reply = await mcp({ cross_project: true, query: 'sharedword' });
    expect(names(reply)).toEqual(['A-commit', 'A-decision', ...SHARED, ...DETAIL].sort());
  });
});

describe('recall by id', () => {
  const surfaces: Array<[string, () => Run]> = [['MCP', () => mcp], ['CLI', () => viaCli(dir)]];
  for (const [surface, run] of surfaces) {
    it(`${surface}: a shared memory of another project is found, its detail is unavailable`, async () => {
      const ids = ['B-decision', 'B-lesson', 'B-pref', 'B-commit', 'B-session', 'B-handoff'].map(idOf);
      const reply = await run()({ ids });
      expect(reply.results?.map(r => r.status)).toEqual(['found', 'found', 'found', 'unavailable', 'unavailable', 'unavailable']);
      expect(names(reply)).toEqual(['B-decision', 'B-lesson', 'B-pref']);
      for (const name of ['B-commit', 'B-session', 'B-handoff']) expect(reply.text).not.toContain(name);
    });
  }
  it('HTTP has no project binding: an ID reaches a memory of any project, as a word search does, and says which project it is', async () => {
    const ids = ['B-decision', 'B-commit', 'B-session', 'A-commit'].map(idOf);
    const reply = await viaHttp({ ids });
    expect(reply.results?.map(r => r.status)).toEqual(['found', 'found', 'found', 'found']);
    expect(names(reply)).toEqual(['A-commit', 'B-commit', 'B-decision', 'B-session']);
    expect(reply.entities.find(e => e.name === 'B-commit')?.tags).toContain('project:B');
    // The same memory is found by a word search over HTTP.
    expect(names(await viaHttp({ query: 'sharedword' }))).toContain('B-commit');
  });
  it('CLI and MCP: relations of a recalled memory show shared far ends only', async () => {
    for (const run of [mcp, viaCli(dir)]) {
      const reply = await run({ ids: [idOf('A-decision')] });
      expect((reply.entities[0].relations ?? []).map(r => r.to).sort()).toEqual(['B-lesson', 'B-old-decision', 'B-pref']);
    }
  });
});

describe('the CLI and HTTP keep their wide searches', () => {
  it('cross_project over HTTP and the CLI still returns every project', async () => {
    for (const run of [viaHttp, viaCli(dir)]) {
      const reply = await run({ cross_project: true, query: 'sharedword' });
      expect(names(reply)).toEqual(['A-commit', 'A-decision', ...SHARED, ...DETAIL].sort());
    }
  });
});
