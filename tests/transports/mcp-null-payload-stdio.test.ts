/** Packaged MCP: JSON-looking conversation body is text, not legacy JSON payload. */
import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ConversationMessages } from '../../src/core/conversation-messages.js';
import { buildIsolatedRuntimeEnv } from '../../scripts/lib/isolated-env.mjs';
import { removeTempDir } from '../helpers/temp-dir.js';

it('#553 packaged MCP preserves nulls inside text and rejects null or misplaced fields', async () => {
  const server = fileURLToPath(new URL('../../dist/mcp/server.js', import.meta.url));
  const runtime = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-mcp-null-payload-')));
  const store = new ConversationMessages({ file: path.join(runtime, 'messages.db'), machine: os.hostname() });
  try {
    for (const id of ['A', 'B', 'C']) store.register({ id, host: 'codex', machine: os.hostname(), pid: process.pid, wake: {} });
  } finally { store.close(); }
  const env = buildIsolatedRuntimeEnv({ PATH: path.dirname(process.execPath) }, { runtimeHome: runtime, memeshDir: runtime, dbPath: path.join(runtime, 'memory.db') });
  const client = new Client({ name: 'codex-mcp-client', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [server], cwd: runtime, env: { ...env, MEMESH_AUTO_UPDATE: 'off' }, stderr: 'pipe' });
  const call = async (args: Record<string, unknown>, session: string) => {
    const response = await client.callTool({ name: 'message', arguments: args, _meta: { threadId: session } }, undefined, { timeout: 30000 });
    const content = response.content as Array<{ type: string; text?: string }>;
    return { isError: response.isError === true, text: content[0]?.text ?? '' };
  };
  try {
    await client.connect(transport);
    const send = { action: 'send', recipient: 'B', kind: 'task' };
    for (const [args, field] of [
      [{ ...send, body: null }, 'body'],
      [send, 'body'],
      [{ ...send, body: 'valid', reply_to: null }, 'reply_to'],
      [{ ...send, body: 'valid', payload: null }, 'payload'],
    ] as const) {
      const rejected = await call(args, 'A');
      expect(rejected.isError).toBe(true);
      expect(rejected.text).toContain(field);
    }
    const before = await call({ action: 'status' }, 'A');
    expect(before.isError, before.text).toBe(false);
    expect(JSON.parse(before.text).messages).toEqual([]);

    const body = JSON.stringify({ a: null, nested: { b: null }, arr: [null, 3] });
    const sent = await call({ ...send, body }, 'A');
    expect(sent.isError, sent.text).toBe(false);
    const { message_id } = JSON.parse(sent.text) as { message_id: string };
    const wrong = await call({ action: 'read', message_id }, 'C');
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain('not addressed to this conversation');
    const extra = await call({ action: 'read', message_id, payload: null }, 'B');
    expect(extra.isError).toBe(true);
    expect(extra.text).toContain('payload');
    const afterRejectedReads = await call({ action: 'status', message_id }, 'A');
    expect(afterRejectedReads.isError, afterRejectedReads.text).toBe(false);
    expect(JSON.parse(afterRejectedReads.text).messages[0].events.map((event: { event: string }) => event.event)).toEqual(['queued']);
    const read = await call({ action: 'read', message_id }, 'B');
    expect(read.isError, read.text).toBe(false);
    expect(JSON.parse(read.text).message.body).toBe(body);
  } finally {
    await client.close();
    removeTempDir(runtime);
  }
}, 60000);
