import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { AgentRouter, AGENT_ROUTER_PROTOCOL_VERSION, sendAgentRouterRequest } from '../../src/core/agent-router.js';
import { getProjectName } from '../../src/core/paths.js';
import { connectRouterHost, type RouterHostConnection } from '../../src/host-runtime/router-client.js';

const server = fileURLToPath(new URL('../../dist/mcp/server.js', import.meta.url));
const version = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version as string;
const session = 'ab23cd45-6789-4abc-8def-0123456789ab';
const clients: Client[] = [];
const connections: RouterHostConnection[] = [];
let router: AgentRouter | undefined;
let directory = '';

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const connection of connections.splice(0)) await connection.close();
  await router?.stop();
  router = undefined;
  closeDatabase();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

async function setup() {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pres-')));
  fs.chmodSync(directory, 0o700);
  const socket = path.join(directory, 'r.sock');
  const db = openDatabase(path.join(directory, 'memory.db'));
  fs.writeFileSync(path.join(directory, 'agent-router.token'), 'test-presence-token\n', { mode: 0o600 });
  router = new AgentRouter({
    db, socket_path: socket, memesh_version: version,
    adapters: ['claude-inbox', 'claude-channel'].map(kind => ({
      kind, authenticate: registration => registration.auth_token === 'test-presence-token',
    })),
  });
  await router.start();
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(workspace);
  const project = getProjectName(workspace);
  async function discover(selectedProject = project) {
    return (await sendAgentRouterRequest(socket, {
      version: AGENT_ROUTER_PROTOCOL_VERSION, type: 'discover', request_id: randomUUID(),
      project: selectedProject, limit: 50, hops: 0,
    })).cards as Array<Record<string, unknown>>;
  }
  async function start(extra: Record<string, string> = {}, clientName = 'claude-code', roots: string[] = [workspace]) {
    const client = new Client({ name: clientName, version: '1' }, { capabilities: { roots: {} } });
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: roots.map(root => ({ uri: pathToFileURL(root).href })) }));
    clients.push(client);
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [server], cwd: directory, stderr: 'pipe',
      env: {
        HOME: directory, USERPROFILE: directory, MEMESH_DIR: directory,
        MEMESH_DB_PATH: path.join(directory, 'memory.db'), MEMESH_ROUTER_SOCKET: socket,
        MEMESH_AUTO_UPDATE: '0', PATH: path.dirname(process.execPath),
        CLAUDE_CODE_SESSION_ID: session, ...extra,
      },
    }));
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    return client;
  }
  async function channel() {
    const connection = await connectRouterHost({
      socket_path: socket, auth_token: 'test-presence-token',
      identity: { project, principal_id: 'claude-code', session_instance_id: session, adapter_kind: 'claude-channel' },
      deliver: async () => ({ status: 'queued' }),
    });
    connections.push(connection);
  }
  return { db, start, discover, project, channel, workspace };
}

describe.skipIf(process.platform === 'win32')('ordinary Claude MCP presence without Channel', () => {
  it('registers the exact session/project, supports inbox fallback and goes offline when stdio closes', async () => {
    const f = await setup();
    const client = await f.start();
    await vi.waitFor(async () => expect(await f.discover()).toEqual([
      expect.objectContaining({ session_id: session, principal_id: 'claude-code', host_kind: 'claude', project: f.project, active: true }),
    ]), { timeout: 4000 });
    expect(await f.discover('another-project')).toEqual([]);
    const sent = await client.callTool({ name: 'message', arguments: {
      action: 'send', project: f.project, sender: 'sender', recipient: session,
      target_kind: 'session', fallback_to_principal: true, idempotency_key: 'presence-fallback', payload: 'test notice',
    } });
    expect(sent.isError).not.toBe(true);
    const result = JSON.parse((sent.content as Array<{ text: string }>)[0].text);
    expect(result).toMatchObject({ recipient: 'claude-code', target_kind: 'principal', intended_session: session });
    const intake = await client.callTool({ name: 'message', arguments: {
      action: 'intake', project: f.project, recipient: 'claude-code', message_id: result.message_id,
      intake_state: 'ingested', idempotency_key: 'presence-intake',
    } });
    expect(intake.isError).not.toBe(true);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM agent_host_accepts').get()).toEqual({ n: 0 });
    await client.close();
    clients.splice(clients.indexOf(client), 1);
    await vi.waitFor(async () => expect(await f.discover()).toEqual([]));
  });

  it.each([true, false])('uses only a valid owner-private existing identity (valid=%s)', async valid => {
    const f = await setup();
    const hosts = path.join(directory, 'hosts');
    fs.mkdirSync(hosts, { mode: 0o700 });
    fs.writeFileSync(path.join(hosts, 'claude.json'), valid ? '{"principal_id":"claude-custom"}' : '{bad-json', { mode: 0o600 });
    await f.start();
    if (valid) await vi.waitFor(async () => expect(await f.discover()).toEqual([
      expect.objectContaining({ principal_id: 'claude-custom', session_id: session }),
    ]));
    else {
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(await f.discover()).toEqual([]);
    }
  });

  it.each(['before', 'after'])('keeps a single real Channel registration when Channel starts %s MCP', async (order) => {
    const f = await setup();
    if (order === 'before') await f.channel();
    await f.start();
    if (order === 'after') {
      await vi.waitFor(async () => expect(await f.discover()).toHaveLength(1));
      await f.channel();
    }
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(await f.discover()).toEqual([expect.objectContaining({ session_id: session, host_kind: 'claude' })]);
    expect(f.db.prepare("SELECT adapter_kind FROM agent_session_connections WHERE disconnected_at IS NULL AND lease_expires_at_ms > ?")
      .all(Date.now())).toEqual([{ adapter_kind: 'claude-channel' }]);
  });

  it.each([
    ['another host', {}, 'codex', undefined],
    ['missing session', { CLAUDE_CODE_SESSION_ID: '' }, 'claude-code', undefined],
    ['disabled recipient', { MEMESH_RECIPIENT: '' }, 'claude-code', undefined],
    ['no workspace', {}, 'claude-code', []],
  ] as const)('does not invent Claude presence for %s and keeps memory tools available', async (_label, env, name, roots) => {
    const f = await setup();
    const client = await f.start(env, name, roots ? [...roots] : undefined);
    const result = await client.callTool({ name: 'recall', arguments: { query: '', project: f.project } });
    expect(result.isError).not.toBe(true);
    expect(await f.discover()).toEqual([]);
  });
});
