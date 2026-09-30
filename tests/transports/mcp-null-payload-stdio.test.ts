/**
 * #553 over the real stdio server: the packaged MCP bundle accepts a message
 * `payload: null` on `send`, returns it on `fetch`, and still refuses a send
 * with no payload and a payload on a non-send action.
 */
import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { removeTempDir } from '../helpers/temp-dir.js';

it('#553 the packaged MCP server sends and fetches a null payload', async () => {
  const server = fileURLToPath(new URL('../../dist/mcp/server.js', import.meta.url));
  const runtime = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-mcp-null-payload-')));
  const env = {
    HOME: runtime, USERPROFILE: runtime, MEMESH_DIR: runtime,
    MEMESH_DB_PATH: path.join(runtime, 'memory.db'),
    MEMESH_AUTO_UPDATE: '0',
    PATH: path.dirname(process.execPath),
  };
  const client = new Client({ name: 'null-payload-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [server], cwd: runtime, env, stderr: 'pipe' });
  const call = async (args: Record<string, unknown>) => {
    const response = await client.callTool({ name: 'message', arguments: args }, undefined, { timeout: 30000 });
    const content = response.content as Array<{ type: string; text?: string }>;
    return { isError: response.isError === true, text: content[0]?.text ?? '' };
  };
  const base = { project: 'p553', sender: 'agent-a', recipient: 'agent-b', content_type: 'application/json' };
  try {
    await client.connect(transport);

    const sent = await call({ action: 'send', ...base, idempotency_key: 'k-null', payload: null });
    expect(sent.isError, sent.text).toBe(false);
    const { message_id } = JSON.parse(sent.text) as { message_id: string };

    const fetched = await call({ action: 'fetch', project: 'p553', recipient: 'agent-b', message_id });
    expect(fetched.isError, fetched.text).toBe(false);
    const body = JSON.parse(fetched.text) as Record<string, unknown>;
    expect(body).toHaveProperty('payload');
    expect(body.payload).toBeNull();

    const missing = await call({ action: 'send', ...base, idempotency_key: 'k-missing' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('payload');

    const onFetch = await call({ action: 'fetch', project: 'p553', recipient: 'agent-b', message_id, payload: null });
    expect(onFetch.isError).toBe(true);
    expect(onFetch.text).toContain('payload');
  } finally {
    await client.close();
    removeTempDir(runtime);
  }
}, 60000);
