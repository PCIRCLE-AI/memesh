import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { journeyEnv } from '../../src/core/doctor-journey.js';

const packageRoot = path.resolve('.');
const probe = path.join(packageRoot, 'dist/transports/cli/doctor-message-probe.js');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function run(root: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-capability-wire-'));
  roots.push(home);
  const env = journeyEnv(home);
  env.NODE_OPTIONS = `--import=${pathToFileURL(path.join(packageRoot, 'scripts/lib/account-home-preload.mjs')).href}`;
  fs.mkdirSync(env.MEMESH_DIR!, { mode: 0o700 });
  fs.writeFileSync(path.join(env.MEMESH_DIR!, 'config.json'), JSON.stringify({ updateCheck: false, autoUpdate: 'off' }));
  const result = spawnSync(process.execPath, [probe, root], { cwd: home, env, encoding: 'utf8', timeout: 10000 });
  expect(result.error).toBeUndefined();
  expect(() => process.kill(result.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  return result;
}
it('the compiled probe imports adapters and reads the real MCP four-action schema over stdio', () => {
  const result = run(packageRoot);
  expect(result.status, result.stderr).toBe(0);
});

it.each(['stale-ten', 'missing-read'])('the compiled probe rejects %s schema from a real stdio MCP server', (kind) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-capability-stale-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'dist/host-adapters'), { recursive: true });
  for (const name of ['codex-app-server', 'claude-channel', 'acp-client']) fs.writeFileSync(path.join(root, `dist/host-adapters/${name}.js`), '');
  fs.mkdirSync(path.join(root, 'dist/mcp'));
  const schema = kind === 'stale-ten'
    ? { type: 'object', properties: { action: { enum: ['send', 'poll', 'discover', 'fetch', 'intake', 'ack', 'disposition', 'activation', 'receipts', 'status'] } } }
    : { type: 'object', oneOf: ['discover', 'send', 'status'].map(action => ({ type: 'object', properties: { action: { const: action } } })) };
  const sdk = (file: string) => pathToFileURL(path.join(packageRoot, 'node_modules/@modelcontextprotocol/sdk/dist/esm', file)).href;
  fs.writeFileSync(path.join(root, 'dist/mcp/server.js'), `
    import { Server } from ${JSON.stringify(sdk('server/index.js'))};
    import { StdioServerTransport } from ${JSON.stringify(sdk('server/stdio.js'))};
    import { ListToolsRequestSchema } from ${JSON.stringify(sdk('types.js'))};
    const server = new Server({ name: 'synthetic-stale-capability', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'message', inputSchema: ${JSON.stringify(schema)} }] }));
    await server.connect(new StdioServerTransport());
  `);
  const result = run(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('AssertionError');
});
