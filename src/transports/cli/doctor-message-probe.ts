#!/usr/bin/env node

// Bundled with the CLI so a raw plugin cache needs no node_modules to probe
// its installed MCP server. Doctor owns the timeout and isolated environment.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = process.argv[2];
assert.ok(root, 'installed package root is required');
await Promise.all([
  import(pathToFileURL(root + '/dist/host-adapters/codex-app-server.js').href),
  import(pathToFileURL(root + '/dist/host-adapters/claude-channel.js').href),
  import(pathToFileURL(root + '/dist/host-adapters/acp-client.js').href),
]);
const client = new Client({ name: 'memesh-doctor-message-probe', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [root + '/dist/mcp/server.js'],
  env: process.env as Record<string, string>,
});
try {
  await client.connect(transport);
  const tool = (await client.listTools()).tools.find((candidate) => candidate.name === 'message');
  assert.ok(tool, 'installed MCP did not advertise message');
  const actions = (tool.inputSchema?.properties?.action as { enum?: unknown } | undefined)?.enum;
  assert.deepEqual(actions, ['send', 'poll', 'discover', 'fetch', 'intake', 'ack', 'disposition', 'activation', 'receipts']);
} finally {
  await client.close();
}
