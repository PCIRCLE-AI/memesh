/**
 * Over the real stdio server (the path an agent takes after SessionStart tells it to
 * "Pass project: <id>"): naming the session's own project reads what the checkout stored
 * before its remote was added, exactly like leaving `project` out, and may add to it.
 * Naming another project reads only that project. The server runs in an unrelated
 * directory, so a pass cannot come from its own cwd.
 */
import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getProjectIds, getProjectName, _clearProjectNameCache } from '../../src/core/paths.js';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { removeTempDir } from '../helpers/temp-dir.js';

const server = fileURLToPath(new URL('../../dist/mcp/server.js', import.meta.url));

async function session(runtime: string, root: string) {
  const env = {
    HOME: runtime, USERPROFILE: runtime, MEMESH_DIR: runtime,
    MEMESH_DB_PATH: path.join(runtime, 'memory.db'),
    MEMESH_AUTO_UPDATE: '0',
    MEMESH_PROJECT_ROOT: root,
    // `minimal` (the default) leaves the task state out of the briefing.
    MEMESH_BRIEFING: 'standard',
    PATH: process.env.PATH ?? path.dirname(process.execPath),
  };
  const client = new Client({ name: 'explicit-project-test', version: '1' });
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(runtime, 'server-cwd-')));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], cwd, env, stderr: 'pipe' }));
  const tool = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
    return { isError: r.isError === true, text: (r.content as Array<{ text?: string }>)[0]?.text ?? '' };
  };
  return { client, tool };
}

it('an explicit project that is the bound one reads and adds to what was stored before the remote; another project reads only its own', async () => {
  const runtime = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-mcp-explicit-')));
  const repo = path.join(runtime, 'widgets');
  fs.mkdirSync(repo);
  execFileSync('git', ['-C', repo, 'init', '-q']);
  const names = (text: string) => ((JSON.parse(text).entities ?? []) as Array<{ name: string }>).map(e => e.name);
  try {
    const before = await session(runtime, repo);
    try {
      const stored = await before.tool('remember', { name: 'widget-plan', type: 'fact', observations: ['Widget plan: ship the widget in May'] });
      expect(stored.isError, stored.text).toBe(false);
      expect((await before.tool('task_state', { goal: 'TASKGOALOLD' })).isError).toBe(false);
    } finally { await before.client.close(); }
    _clearProjectNameCache();
    const pathId = getProjectName(repo);

    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@gitlab.com:acme/widgets.git']);
    _clearProjectNameCache();
    const own = getProjectName(repo);
    expect(own).not.toBe(pathId);
    expect(getProjectIds(repo)).toContain(pathId);

    const after = await session(runtime, repo);
    try {
      // Leaving project out finds it (the baseline the explicit call must match).
      expect(names((await after.tool('recall', { query: 'Widget' })).text)).toContain('widget-plan');
      const explicit = await after.tool('recall', { query: 'Widget', project: own });
      expect(explicit.isError, explicit.text).toBe(false);
      expect(names(explicit.text)).toContain('widget-plan');

      const state = await after.tool('task_state', { project: own });
      expect(state.isError, state.text).toBe(false);
      expect(JSON.parse(state.text).state.goal).toBe('TASKGOALOLD');
      const briefing = await after.tool('briefing', { project: own });
      expect(briefing.isError, briefing.text).toBe(false);
      expect(briefing.text).toContain('TASKGOALOLD');

      // Readable, so it can be added to: the memory keeps the one project tag it has.
      const added = await after.tool('remember', { name: 'widget-plan', type: 'fact', observations: ['Widget plan: and a manual'], project: own });
      expect(added.isError, added.text).toBe(false);
      const unbound = await after.tool('remember', { name: 'widget-plan', type: 'fact', observations: ['Widget plan: and a poster'] });
      expect(unbound.isError, unbound.text).toBe(false);

      // Another project reads its own id only: not this checkout's.
      const other = await after.tool('recall', { query: 'Widget', project: 'gadgets~0123456789abcdef0123456789abcdef' });
      expect(other.isError, other.text).toBe(false);
      expect(names(other.text)).not.toContain('widget-plan');
      const otherState = await after.tool('task_state', { project: 'gadgets~0123456789abcdef0123456789abcdef' });
      expect(JSON.parse(otherState.text).state).toEqual({});
    } finally { await after.client.close(); }

    const db = new MemeshDatabase(path.join(runtime, 'memory.db'));
    try {
      const tags = (db.prepare("SELECT t.tag FROM tags t JOIN entities e ON e.id = t.entity_id WHERE e.name = 'widget-plan' AND t.tag LIKE 'project:%'").all() as Array<{ tag: string }>).map(r => r.tag);
      expect(tags).toEqual([`project:${pathId}`]);
      const obs = (db.prepare("SELECT o.content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = 'widget-plan' ORDER BY o.id").all() as Array<{ content: string }>).map(r => r.content);
      expect(obs).toEqual(['Widget plan: ship the widget in May', 'Widget plan: and a manual', 'Widget plan: and a poster']);
    } finally { db.close(); }
  } finally {
    removeTempDir(runtime);
  }
}, 120000);
