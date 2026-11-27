/**
 * The anonymous install ID (`install.json`) is created by `memesh feedback`, never by the MCP server. This starts
 * the packaged server (dist/mcp/server.js) in a HOME where MeMesh has never run, makes it answer real calls, and
 * then looks for the file anywhere under that HOME. The calls matter: "nothing was created" proves nothing about
 * a server that never answered.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildIsolatedRuntimeEnv } from '../scripts/lib/isolated-env.mjs';

function everythingUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      found.push(path.relative(root, full));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return found;
}

describe('the packaged MCP server on a fresh HOME', () => {
  it('exits on an already closed stdin', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-mcp-empty-stdin-')));
    const env = buildIsolatedRuntimeEnv(process.env, {
      runtimeHome: home, memeshDir: path.join(home, 'data'), dbPath: path.join(home, 'data', 'graph.db'),
    });
    try {
      const result = spawnSync(process.execPath, [path.resolve('dist/mcp/server.js')], {
        cwd: home, env: { ...env, MEMESH_AUTO_UPDATE: 'off', MEMESH_SKIP_UPDATE_CHECK: '1' },
        input: '', encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL',
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);

  it('exits when empty stdin closes after startup', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-mcp-late-eof-')));
    const env = buildIsolatedRuntimeEnv(process.env, {
      runtimeHome: home, memeshDir: path.join(home, 'data'), dbPath: path.join(home, 'data', 'graph.db'),
    });
    try {
      const entry = pathToFileURL(path.resolve('dist/mcp/server.js')).href;
      // Keep stdin open past the startup turn, even on a slow child process.
      const child = spawn(process.execPath, ['--input-type=module', '-e',
        'await import(process.argv[1]); setImmediate(() => process.stdout.write("ready\\n"));', entry,
      ], {
        cwd: home, env: { ...env, MEMESH_AUTO_UPDATE: 'off', MEMESH_SKIP_UPDATE_CHECK: '1' },
        timeout: 10_000, killSignal: 'SIGKILL',
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.stdout.once('data', () => child.stdin.end());
      expect(await once(child, 'close'), stderr).toEqual([0, null]);
      expect(stdout).toBe('ready\n');
    } finally {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);

  it('answers buffered requests and persists the write before exiting on stdin EOF', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-mcp-buffered-stdin-')));
    const env = buildIsolatedRuntimeEnv(process.env, {
      runtimeHome: home, memeshDir: path.join(home, 'data'), dbPath: path.join(home, 'data', 'graph.db'),
    });
    try {
      const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'eof-fixture', version: '1' },
      } };
      const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
      const call = (name: string, args: Record<string, unknown>) => {
        const request = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } };
        const input = [initialize, initialized, request].map(message => JSON.stringify(message)).join('\n') + '\n';
        const result = spawnSync(process.execPath, [path.resolve('dist/mcp/server.js')], {
          cwd: home, env: { ...env, MEMESH_AUTO_UPDATE: 'off', MEMESH_SKIP_UPDATE_CHECK: '1' },
          input, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL',
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        const replies = result.stdout.trim().split('\n').map(line => JSON.parse(line));
        expect(replies.find(reply => reply.id === 1)).toMatchObject({ result: { serverInfo: { name: 'memesh' } } });
        const toolReply = replies.find(reply => reply.id === 2);
        expect(toolReply).toMatchObject({ result: { content: [{ type: 'text', text: expect.any(String) }] } });
        expect(toolReply.result.isError).not.toBe(true);
        return toolReply.result.content[0].text;
      };
      const name = 'buffered-eof-memory';
      const observation = 'stdin eof persistence';
      const stored = call('remember', { name, type: 'note', project: false, observations: [observation] });
      expect(JSON.parse(stored)).toMatchObject({ name, stored: true });
      const recalled = call('recall', { query: observation, project: false });
      expect(recalled).toContain(name);
      expect(recalled).toContain(observation);
    } finally {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);

  it('answers real calls and creates no install.json', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-mcp-fresh-home-')));
    // Config only so the detached update checker does not outlive the fixture; MEMESH_DIR is NOT set, so the
    // server resolves its folder from HOME exactly as a real install does.
    fs.mkdirSync(path.join(home, '.memesh'));
    fs.writeFileSync(path.join(home, '.memesh', 'config.json'), JSON.stringify({ updateCheck: false }));
    const env = { HOME: home, USERPROFILE: home, PATH: path.dirname(process.execPath), MEMESH_AUTO_CAPTURE: 'false', MEMESH_PROJECT_ROOT: home };
    const client = new Client({ name: 'fresh-home-fixture', version: '1' }, { capabilities: {} });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/mcp/server.js')], cwd: home, env, stderr: 'pipe' });
    try {
      await client.connect(transport);
      const stored = await client.callTool({ name: 'remember', arguments: { name: 'fresh-home-memory', type: 'note', observations: ['the server answered'] } });
      expect(stored.isError, JSON.stringify(stored)).not.toBe(true);
      const recalled = await client.callTool({ name: 'recall', arguments: { query: 'the server answered' } });
      expect(recalled.isError, JSON.stringify(recalled)).not.toBe(true);
      expect(JSON.stringify(recalled), 'the server did not answer with the memory it just stored').toContain('fresh-home-memory');
    } finally {
      await client.close();
      await transport.close();
    }
    const files = everythingUnder(home);
    expect(files.length, 'the server left nothing at all, not even its database: it did not run').toBeGreaterThan(0);
    expect(files.filter((f) => path.basename(f) === 'install.json'), 'the MCP server created an install ID').toEqual([]);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 60_000);
});
