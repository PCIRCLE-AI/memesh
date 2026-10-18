import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema, ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MemeshDatabase } from '../src/storage/sqlite.js';

it('the actual MCP process preserves native forms and saves pane drafts without another form', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-form-runtime-'));
  const workspace = fs.realpathSync(dir);
  // Keep the detached update checker from holding this fixture's cwd on Windows.
  fs.writeFileSync(path.join(workspace, 'config.json'), JSON.stringify({ updateCheck: false }));
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
    expect(fs.readdirSync(workspace).filter(name => name.startsWith('last-fresh-refresh.'))).toEqual([]);
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

      // Desktop can report form capability yet cancel it immediately. Pane drafts need no form.
      accept = false;
      const beforePane = row();
      const prepared = await client.callTool({ name: 'remember', arguments: { name: 'ui-note', editor: { action: 'prepare' } } });
      expect(prepared.isError, JSON.stringify(prepared)).not.toBe(true);
      const draft = JSON.parse((prepared.content as { text: string }[])[0].text);
      expect(draft.memory.observations).toEqual(['Saved paragraph']);
      expect(row()).toEqual(beforePane);
      const paneSaved = await client.callTool({ name: 'remember', arguments: {
        name: 'ui-note', editor: { action: 'save', revision: draft.revision, title: 'Pane title', observations: ['Pane paragraph'] },
      } });
      expect(paneSaved.isError, JSON.stringify(paneSaved)).not.toBe(true);
      expect(JSON.stringify(paneSaved)).toContain('Pane paragraph');
      expect(row()).toMatchObject({ title: 'Pane title' });
      expect(db.prepare('SELECT content FROM observations').all()).toEqual([{ content: 'Pane paragraph' }]);
      expect(JSON.stringify(await client.callTool({ name: 'recall', arguments: { query: 'Pane' } }))).toContain('Pane paragraph');
      expect(forms).toBe(2);
    } finally { db.close(); }
  } finally {
    await client.close();
    await transport.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
