/**
 * Over the real stdio server: `project: null` is a blank (Gemini CLI fills
 * blanks with null), so it behaves as an omitted project — the bound project
 * when the session has one, a refusal when it does not. `project: false` is a
 * memory with no project and needs no binding.
 */
import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getProjectName } from '../../src/core/paths.js';
import { removeTempDir } from '../helpers/temp-dir.js';

const server = fileURLToPath(new URL('../../dist/mcp/server.js', import.meta.url));

async function withServer(runtime: string, projectRoot: string | undefined, fn: (call: (name: string, args: Record<string, unknown>) => Promise<{ isError: boolean; text: string }>) => Promise<void>) {
  const env: Record<string, string> = {
    HOME: runtime, USERPROFILE: runtime, MEMESH_DIR: runtime,
    MEMESH_DB_PATH: path.join(runtime, 'memory.db'),
    MEMESH_AUTO_UPDATE: '0',
    PATH: path.dirname(process.execPath),
    ...(projectRoot ? { MEMESH_PROJECT_ROOT: projectRoot } : {}),
  };
  const client = new Client({ name: 'project-null-false-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [server], cwd: runtime, env, stderr: 'pipe' });
  try {
    await client.connect(transport);
    await fn(async (name, args) => {
      const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
      const content = response.content as Array<{ type: string; text?: string }>;
      return { isError: response.isError === true, text: content[0]?.text ?? '' };
    });
  } finally {
    await client.close();
  }
}

it('project: null is a blank, project: false is no project — over stdio, bound and unbound', async () => {
  const runtime = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-mcp-project-null-')));
  const projectRoot = path.join(runtime, 'proj-null-false');
  fs.mkdirSync(projectRoot);
  const project = getProjectName(projectRoot);
  try {
    await withServer(runtime, projectRoot, async (call) => {
      const bound = await call('remember', { name: 'bound-null', type: 'fact', observations: ['ibis bound'], project: null });
      expect(bound.isError, bound.text).toBe(false);
      const loose = await call('remember', { name: 'bound-false', type: 'fact', observations: ['ibis loose'], project: false });
      expect(loose.isError, loose.text).toBe(false);
      const found = JSON.parse((await call('recall', { query: 'ibis', project: null })).text);
      expect(Object.fromEntries(found.entities.map((e: { name: string; projects: unknown }) => [e.name, e.projects])))
        .toEqual({ 'bound-null': [project], 'bound-false': [] });
      expect(found.scope.project).toBe(project);
    });

    await withServer(runtime, undefined, async (call) => {
      const refused = await call('remember', { name: 'unbound-null', type: 'fact', observations: ['ibis refused'], project: null });
      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(/^workspace_unavailable: .*project: false/);
      const learnRefused = await call('learn', { error: 'ibis boom', fix: 'ibis fix', project: null });
      expect(learnRefused.isError).toBe(true);

      const loose = await call('remember', { name: 'unbound-false', type: 'fact', observations: ['ibis unbound loose'], project: false });
      expect(loose.isError, loose.text).toBe(false);
      const learned = await call('learn', { error: 'ibis lesson boom', fix: 'ibis lesson fix', project: false });
      expect(learned.isError, learned.text).toBe(false);

      const contradictory = await call('remember', { name: 'x', type: 'fact', observations: ['y'], project: false, tags: [`project:${project}`] });
      expect(contradictory.isError).toBe(true);
      const twoSelectors = await call('recall', { query: 'ibis', project: false, cross_project: true });
      expect(twoSelectors.isError).toBe(true);

      const found = JSON.parse((await call('recall', { query: 'ibis' })).text);
      expect(found.entities.map((e: { name: string }) => e.name).sort())
        .toEqual(['bound-false', JSON.parse(learned.text).name, 'unbound-false'].sort());
      expect(found.scope.project).toBeNull();
    });

    // A launch root that is set but does not exist is not "unbound": recall is refused with the reason.
    await withServer(runtime, path.join(runtime, 'missing-root'), async (call) => {
      const refused = await call('recall', { query: 'ibis' });
      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(/^workspace_unavailable: MEMESH_PROJECT_ROOT is not an existing absolute directory/);
      const explicit = await call('recall', { query: 'ibis', project: false });
      expect(explicit.isError, explicit.text).toBe(false);
    });
  } finally {
    removeTempDir(runtime);
  }
}, 90000);
