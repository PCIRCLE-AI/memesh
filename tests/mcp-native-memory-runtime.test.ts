import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema, ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MemeshDatabase } from '../src/storage/sqlite.js';

it('the actual MCP process negotiates a native form: cancel leaves data, submit saves and reads back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-form-runtime-'));
  const workspace = fs.realpathSync(dir);
  const env = { HOME: workspace, USERPROFILE: workspace, MEMESH_DIR: workspace, MEMESH_DB_PATH: path.join(workspace, 'memory.db'), PATH: path.dirname(process.execPath) };
  const client = new Client({ name: 'codex', version: 'native-form-fixture' }, { capabilities: { roots: {}, elicitation: { form: {} } } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(workspace).href }] }));
  let accept = false;
  let forms = 0;
  client.setRequestHandler(ElicitRequestSchema, async request => {
    forms++;
    expect(request.params.mode).toBe('form');
    expect(JSON.stringify(request.params)).toContain('Original paragraph');
    return accept ? { action: 'accept' as const, content: { title: 'Saved title', body: 'Saved paragraph' } } : { action: 'cancel' as const };
  });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/mcp/server.js')], cwd: workspace, env, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const seeded = await client.callTool({ name: 'remember', arguments: { name: 'ui-note', type: 'note', observations: ['Original paragraph'] } });
    expect(seeded.isError, JSON.stringify(seeded)).not.toBe(true);
    const db = new MemeshDatabase(env.MEMESH_DB_PATH, { readOnly: true });
    const row = () => db.prepare('SELECT title, metadata FROM entities WHERE name = ?').get('ui-note');
    try {
      const before = row();
      const cancelled = await client.callTool({ name: 'remember', arguments: { name: 'ui-note', interactive: true } });
      expect(cancelled.isError, JSON.stringify(cancelled)).not.toBe(true);
      expect(JSON.stringify(cancelled)).toContain('cancelled');
      expect(row()).toEqual(before);
      accept = true;
      const saved = await client.callTool({ name: 'remember', arguments: { name: 'ui-note', interactive: true } });
      expect(saved.isError, JSON.stringify(saved)).not.toBe(true);
      expect(JSON.stringify(saved)).toContain('Saved paragraph');
      expect(row()).toMatchObject({ title: 'Saved title' });
      expect(db.prepare('SELECT content FROM observations').all()).toEqual([{ content: 'Saved paragraph' }]);
      const recalled = await client.callTool({ name: 'recall', arguments: { query: 'Saved' } });
      expect(JSON.stringify(recalled)).toContain('Saved paragraph');
      expect(forms).toBe(2);
    } finally { db.close(); }
  } finally {
    await client.close();
    await transport.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
