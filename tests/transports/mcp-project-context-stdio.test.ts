/**
 * Over the real stdio server: task_state with no `project` is bound by the
 * launch root (MEMESH_PROJECT_ROOT) or by the client's workspace root, and is
 * refused when neither binds it. The server runs in an unrelated directory, so
 * a pass cannot come from its own cwd.
 */
import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getProjectName } from '../../src/core/paths.js';
import { removeTempDir } from '../helpers/temp-dir.js';

const server = fileURLToPath(new URL('../../dist/mcp/server.js', import.meta.url));

async function session(runtime: string, extraEnv: Record<string, string>, roots: string[] | 'throws' | null) {
  const env = {
    HOME: runtime, USERPROFILE: runtime, MEMESH_DIR: runtime,
    MEMESH_DB_PATH: path.join(runtime, 'memory.db'),
    MEMESH_AUTO_UPDATE: '0',
    PATH: path.dirname(process.execPath),
    ...extraEnv,
  };
  const client = new Client({ name: 'project-context-test', version: '1' }, roots ? { capabilities: { roots: {} } } : undefined);
  if (roots === 'throws') client.setRequestHandler(ListRootsRequestSchema, async () => { throw new Error('roots unavailable'); });
  else if (roots) client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: roots.map(r => ({ uri: pathToFileURL(r).href })) }));
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(runtime, 'server-cwd-')));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], cwd, env, stderr: 'pipe' }));
  const tool = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
    return { isError: r.isError === true, text: (r.content as Array<{ text?: string }>)[0]?.text ?? '' };
  };
  const call = (args: Record<string, unknown>) => tool('task_state', args);
  return { client, call, tool };
}

it('task_state without a project follows the launch root, then the workspace root, and is refused when unbound', async () => {
  const runtime = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-mcp-ctx-')));
  const a = fs.realpathSync(fs.mkdtempSync(path.join(runtime, 'project-a-')));
  const b = fs.realpathSync(fs.mkdtempSync(path.join(runtime, 'project-b-')));
  try {
    const launched = await session(runtime, { MEMESH_PROJECT_ROOT: a }, null);
    try {
      const write = await launched.call({ goal: 'ship A' });
      expect(write.isError, write.text).toBe(false);
    } finally { await launched.client.close(); }

    const rooted = await session(runtime, {}, [b]);
    try {
      expect((await rooted.call({ goal: 'ship B' })).isError).toBe(false);
      // Read back by explicit project: each goal landed in its own project.
      expect(JSON.parse((await rooted.call({ project: getProjectName(a) })).text).state.goal).toBe('ship A');
      expect(JSON.parse((await rooted.call({ project: getProjectName(b) })).text).state.goal).toBe('ship B');
    } finally { await rooted.client.close(); }

    const unbound = await session(runtime, {}, null);
    try {
      const refused = await unbound.call({ goal: 'nowhere' });
      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(/^workspace_unavailable: /);
    } finally { await unbound.client.close(); }

    // Roots advertised but not returned: the launch root alone does not bind.
    const unreadable = await session(runtime, { MEMESH_PROJECT_ROOT: a }, 'throws');
    try {
      const refused = await unreadable.call({ goal: 'overwrite A' });
      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(/^workspace_unavailable: .*did not return them/);
      expect(JSON.parse((await unreadable.call({ project: getProjectName(a) })).text).state.goal).toBe('ship A');
    } finally { await unreadable.client.close(); }

    const conflicting = await session(runtime, { MEMESH_PROJECT_ROOT: a }, [b]);
    try {
      const refused = await conflicting.call({ goal: 'either' });
      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(/^workspace_ambiguous: .*MEMESH_PROJECT_ROOT/);
    } finally { await conflicting.client.close(); }
  } finally {
    removeTempDir(runtime);
  }
}, 120000);

it('learn and a default recall follow the bound project, survive a restart, and are refused when unbound', async () => {
  const runtime = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-mcp-ctx-')));
  const a = fs.realpathSync(fs.mkdtempSync(path.join(runtime, 'project-a-')));
  const b = fs.realpathSync(fs.mkdtempSync(path.join(runtime, 'project-b-')));
  const names = (text: string) => (JSON.parse(text).entities as Array<{ name: string }>).map(e => e.name).sort();
  try {
    const seed = await session(runtime, { MEMESH_PROJECT_ROOT: a }, null);
    try {
      for (const [name, extra] of [
        ['zebra-a', { tags: [`project:${getProjectName(a)}`] }],
        ['zebra-b', { tags: [`project:${getProjectName(b)}`] }],
        ['zebra-global', { namespace: 'global' }],
      ] as const) {
        const r = await seed.tool('remember', { name, type: 'fact', observations: [`${name} stripes`], ...extra });
        expect(r.isError, r.text).toBe(false);
      }
      const learned = await seed.tool('learn', { error: 'zebra lesson broke', fix: 'zebra lesson fixed' });
      expect(learned.isError, learned.text).toBe(false);
    } finally { await seed.client.close(); }

    // A new server process bound to A reads what the previous one wrote.
    const inA = await session(runtime, {}, [a]);
    try {
      const hits = names((await inA.tool('recall', { query: 'zebra' })).text);
      expect(hits.filter(n => !n.startsWith('lesson-'))).toEqual(['zebra-a', 'zebra-global']);
      expect(hits.some(n => n.startsWith(`lesson-${getProjectName(a)}-`))).toBe(true);
    } finally { await inA.client.close(); }

    const inB = await session(runtime, { MEMESH_PROJECT_ROOT: b }, null);
    try {
      expect(names((await inB.tool('recall', { query: 'zebra' })).text)).toEqual(['zebra-b', 'zebra-global']);
      // Blank selectors, as Gemini CLI sends them, take the same bound path.
      for (const blank of [{ tag: null, cross_project: null }, { tag: '' }]) {
        const r = await inB.tool('recall', { query: 'zebra', ...blank });
        expect(r.isError, r.text).toBe(false);
        expect(names(r.text)).toEqual(['zebra-b', 'zebra-global']);
      }
      expect(names((await inB.tool('recall', { query: 'zebra', tag: `project:${getProjectName(a)}` })).text)).toContain('zebra-a');
    } finally { await inB.client.close(); }

    const unbound = await session(runtime, {}, null);
    try {
      const all = () => unbound.tool('recall', { cross_project: true, include_archived: true, limit: 100 });
      const before = names((await all()).text);
      // Unbound, a default recall searches memories with no project and global ones, and says so.
      for (const blank of [{}, { tag: '' }]) {
        const recall = await unbound.tool('recall', { query: 'zebra', ...blank });
        expect(recall.isError, recall.text).toBe(false);
        expect(names(recall.text)).toEqual(['zebra-global']);
        expect(JSON.parse(recall.text).scope.project).toBeNull();
      }
      const learn = await unbound.tool('learn', { error: 'unbound lesson', fix: 'nowhere' });
      expect(learn.isError).toBe(true);
      expect(learn.text).toMatch(/^workspace_unavailable: .*MEMESH_PROJECT_ROOT/);
      expect(names((await all()).text)).toEqual(before);
    } finally { await unbound.client.close(); }
  } finally {
    removeTempDir(runtime);
  }
}, 120000);

it('remember with no tag files the memory under the bound project: found again in A after a restart, not in B, refused on a name A holds', async () => {
  const runtime = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-mcp-ctx-')));
  const a = fs.realpathSync(fs.mkdtempSync(path.join(runtime, 'project-a-')));
  const b = fs.realpathSync(fs.mkdtempSync(path.join(runtime, 'project-b-')));
  const entities = (text: string) => JSON.parse(text).entities as Array<{ name: string; tags: string[]; type: string; title: string | null; observations: string[]; metadata: unknown; confidence: number; namespace: string }>;
  try {
    const writeA = await session(runtime, { MEMESH_PROJECT_ROOT: a }, null);
    try {
      const r = await writeA.tool('remember', { name: 'okapi-decision', type: 'decision', why: 'a fixed choice for this case; revisit if it changes', observations: ['okapi stripes are for A'] });
      expect(r.isError, r.text).toBe(false);
    } finally { await writeA.client.close(); }

    // A new server process, bound to A by its workspace root this time.
    const readA = await session(runtime, {}, [a]);
    try {
      const hits = entities((await readA.tool('recall', { query: 'okapi' })).text);
      expect(hits.map(e => e.name)).toEqual(['okapi-decision']);
      expect(hits[0].tags).toContain(`project:${getProjectName(a)}`);
    } finally { await readA.client.close(); }

    const inB = await session(runtime, { MEMESH_PROJECT_ROOT: b }, null);
    try {
      expect(entities((await inB.tool('recall', { query: 'okapi' })).text)).toEqual([]);
      const across = entities((await inB.tool('recall', { query: 'okapi', cross_project: true })).text);
      expect(across).toHaveLength(1);
      expect(across.map(e => e.name)).toEqual(['okapi-decision']);
      expect(across[0].tags).toContain(`project:${getProjectName(a)}`);

      // Content only: reading through recall itself bumps access counts.
      const all = async () => entities((await inB.tool('recall', { cross_project: true, include_archived: true, limit: 100 })).text)
        .map(({ name, type, title, observations, tags, metadata, confidence, namespace }) => ({ name, type, title, observations, tags, metadata, confidence, namespace }));
      const before = JSON.stringify(await all());
      const refused = await inB.tool('remember', { name: 'okapi-decision', type: 'decision', why: 'a fixed choice for this case; revisit if it changes', observations: ['B writes over A'] });
      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(/"okapi-decision".*project:/s);
      expect(refused.text).not.toContain('okapi stripes');
      expect(JSON.stringify(await all())).toBe(before);
    } finally { await inB.client.close(); }

    const unbound = await session(runtime, {}, null);
    try {
      const refused = await unbound.tool('remember', { name: 'nowhere', type: 'fact', observations: ['x'] });
      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(/^workspace_unavailable: /);
    } finally { await unbound.client.close(); }
  } finally {
    removeTempDir(runtime);
  }
}, 120000);
