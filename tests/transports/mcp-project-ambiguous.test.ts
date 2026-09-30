/**
 * #527: under Codex the plugin's MCP server is started with its working
 * directory set to the plugin root (Codex resolves the manifest's `"cwd": "."`
 * against the plugin root), so "the current directory's project" is MeMesh's
 * own directory, not the user's workspace. When the server's cwd is MeMesh's
 * own package or plugin root, a call that would DEFAULT the project (learn,
 * task_state, briefing) is refused instead of filed under the wrong project.
 * Spawns the built server, because the cwd is the thing under test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(PACKAGE_ROOT, 'dist', 'mcp', 'server.js');

let tmp = '';
const clients: Client[] = [];

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-mcp-ambiguous-')); });
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function connect(cwd: string, extraEnv: Record<string, string> = {}, server: string = SERVER): Promise<Client> {
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const client = new Client({ name: 'codex', version: 'test' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [server],
    cwd,
    env: { PATH: process.env.PATH!, HOME: home, USERPROFILE: home, MEMESH_DIR: path.join(home, '.memesh'), ...extraEnv },
    stderr: 'pipe',
  }));
  clients.push(client);
  return client;
}

const call = (c: Client, name: string, args: Record<string, unknown>) => c.callTool({ name, arguments: args }) as Promise<{
  isError?: boolean; content: Array<{ text?: string }>;
}>;
const text = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? '';

const DEFAULTING: Array<[string, Record<string, unknown>]> = [
  ['learn', { error: 'e', fix: 'f' }],
  ['task_state', {}],
  ['task_state', { goal: 'g' }],
  ['briefing', {}],
];

describe('#527 MCP server started in MeMesh\'s own directory', () => {
  it.each(DEFAULTING)('%s %j without a project is refused with a one-line error naming `project`', async (tool, args) => {
    const c = await connect(PACKAGE_ROOT);
    const r = await call(c, tool, args);
    expect(r.isError).toBe(true);
    const msg = text(r);
    expect(msg).toMatch(/`project`/);
    expect(msg).toMatch(/SessionStart/);
    expect(msg.split('\n').filter((l) => l.trim()).length).toBe(1);
  });

  it('accepts the same calls once a project is passed', async () => {
    const c = await connect(PACKAGE_ROOT);
    expect((await call(c, 'learn', { error: 'e', fix: 'f', project: 'ws-a' })).isError).toBeUndefined();
    expect((await call(c, 'task_state', { project: 'ws-a', goal: 'g' })).isError).toBeUndefined();
    expect((await call(c, 'task_state', { project: 'ws-a' })).isError).toBeUndefined();
    expect((await call(c, 'briefing', { project: 'ws-a' })).isError).toBeUndefined();
  });

  it('is decided by the real directory: a symlink to the package root is refused too', async () => {
    const link = path.join(tmp, 'link-to-root');
    fs.symlinkSync(PACKAGE_ROOT, link);
    const c = await connect(link);
    expect((await call(c, 'task_state', {})).isError).toBe(true);
  });

  it('a workspace that is another MeMesh checkout (package.json named @pcircle/memesh) is NOT refused: only the running server\'s own root is', async () => {
    const checkout = fs.mkdtempSync(path.join(tmp, 'checkout-'));
    fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ name: '@pcircle/memesh' }));
    const c = await connect(checkout);
    expect((await call(c, 'learn', { error: 'e', fix: 'f' })).isError).toBeUndefined();
    expect((await call(c, 'task_state', {})).isError).toBeUndefined();
  });

  it('a server run from a copy of the package is refused when its cwd is that copy\'s own root', async () => {
    const copy = fs.mkdtempSync(path.join(tmp, 'installed-'));
    fs.mkdirSync(path.join(copy, 'dist'));
    fs.cpSync(path.join(PACKAGE_ROOT, 'dist', 'mcp'), path.join(copy, 'dist', 'mcp'), { recursive: true });
    fs.writeFileSync(path.join(copy, 'package.json'), JSON.stringify({ name: '@pcircle/memesh', version: '0.0.0', type: 'module' }));
    fs.symlinkSync(path.join(PACKAGE_ROOT, 'node_modules'), path.join(copy, 'node_modules'));
    const c = await connect(copy, {}, path.join(copy, 'dist', 'mcp', 'server.js'));
    expect((await call(c, 'task_state', {})).isError).toBe(true);
    expect((await call(c, 'task_state', { project: 'ws-a' })).isError).toBeUndefined();
  });

  it('a workspace with some other package.json is not refused', async () => {
    const ws = fs.mkdtempSync(path.join(tmp, 'other-'));
    fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'my-app' }));
    const c = await connect(ws);
    expect((await call(c, 'task_state', {})).isError).toBeUndefined();
  });

  it.each(['CLAUDE_PLUGIN_ROOT', 'PLUGIN_ROOT'])('a cwd equal to %s is refused', async (variable) => {
    const pluginRoot = fs.mkdtempSync(path.join(tmp, 'plugin-'));
    const c = await connect(pluginRoot, { [variable]: pluginRoot });
    expect((await call(c, 'task_state', {})).isError).toBe(true);
    expect((await call(c, 'task_state', { project: 'ws-a' })).isError).toBeUndefined();
  });
});

describe('#527 MCP server started in a workspace (Claude Code)', () => {
  it.each(DEFAULTING)('%s %j without a project still works, as before', async (tool, args) => {
    const workspace = fs.mkdtempSync(path.join(tmp, 'workspace-'));
    const c = await connect(workspace, { CLAUDE_PLUGIN_ROOT: PACKAGE_ROOT });
    const r = await call(c, tool, args);
    expect(r.isError, text(r)).toBeUndefined();
  });
});
