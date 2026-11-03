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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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
