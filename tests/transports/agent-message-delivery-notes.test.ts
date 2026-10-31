import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { getDatabase } from '../../src/db.js';
import { executeAgentMessageAction, type AgentMessageTransportDependencies } from '../../src/transports/agent-messaging.js';
import { handleTool } from '../../src/transports/mcp/handlers.js';
import { app } from '../../src/transports/http/server.js';
import { useTestDatabase } from '../helpers/db-fixture.js';
import { registerAgentSession } from '../helpers/agent-session-fixture.js';

const fixture = useTestDatabase('memesh-delivery-note-');
const project = 'note-project';
const session = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const base = { action: 'send', project, sender: 'alice', recipient: 'bob', idempotency_key: 'one', payload: 'hello' };
const context = { transport: 'mcp' as const, sourceHost: 'test-host' };
const refused = { sendRouterRequest: async () => ({ delivered: false }) };
type Result = { message_id: string; delivery_note: string; fallback?: { from: { message_id: string } } };
const send = (input: Record<string, unknown> = {}, dependencies: AgentMessageTransportDependencies = refused) => executeAgentMessageAction(getDatabase(), { ...base, ...input }, context, dependencies) as Promise<Result>;

describe('delivery explanations', () => {
  it('explains stored principal delivery and same-key retry without exposing the internal hint', async () => {
    const first = await send();
    expect(first.delivery_note).toMatch(/stored.*bob.*not.*read.*accepted/i);
    expect(first).not.toHaveProperty('reused');
    const retry = await send();
    expect(retry.message_id).toBe(first.message_id);
    expect(retry.delivery_note).toMatch(/previous.*message_id.*no new message.*notification.*again/i);
    expect(retry).not.toHaveProperty('reused');
    await expect(send({ reused: true })).rejects.toThrow(/Unrecognized key/);
  });
  it('reports exact adapter acceptance without claiming model read or acceptance', async () => {
    registerAgentSession(project, 'bob', { sessionId: session, adapterKind: 'claude-channel' });
    const result = await send({ recipient: session, target_kind: 'session' }, { sendRouterRequest: async (_socket, request) => {
      if (request.type !== 'notify') throw new Error('expected notify');
      const db = getDatabase();
      const connection = db.prepare('SELECT connection_id FROM agent_session_connections WHERE session_instance_id = ?').get(session) as { connection_id: string };
      db.prepare(`INSERT INTO agent_dispatch_attempts (attempt_id, delivery_id, project, principal_id, session_instance_id, connection_id, generation, router_instance_id, attempt_number, result, completed_at) VALUES ('attempt', ?, ?, 'bob', ?, ?, 1, 'router', 1, 'adapter_returned', CURRENT_TIMESTAMP)`).run(request.delivery_id, project, session, connection.connection_id);
      db.prepare(`INSERT INTO agent_host_accepts (host_accept_id, attempt_id, delivery_id, adapter_kind, receipt_json) VALUES ('accept', 'attempt', ?, 'claude-channel', '{}')`).run(request.delivery_id);
      return { delivered: true };
    } });
    expect(result.delivery_note).toMatch(/claude-channel.*accepted.*not.*model.*read.*accepted/i);
    expect(result).not.toHaveProperty('reused');
    const retry = await send({ recipient: session, target_kind: 'session' });
    expect(retry.message_id).toBe(result.message_id);
    expect(retry.delivery_note).toMatch(/previous.*message_id.*no new message.*notification.*again/i);
    expect(retry).toHaveProperty('native_delivery');
    expect(retry).not.toHaveProperty('reused');
  });
  it('distinguishes first fallback after a refused exact retry from fallback retry', async () => {
    registerAgentSession(project, 'bob', { sessionId: session, adapterKind: 'claude-channel', disconnected: true });
    const input = { recipient: session, target_kind: 'session' };
    await expect(send(input)).rejects.toMatchObject({ code: 'recipient_unavailable', message: expect.stringMatching(/not confirm.*may.*already.*stopped.*disconnected.*refused.*full.*preserved.*fallback_to_principal/i) });
    const first = await send({ ...input, fallback_to_principal: true });
    expect(first.fallback).toBeDefined();
    expect(first.delivery_note).toMatch(/stored.*bob.*not.*read.*accepted/i);
    expect(first).not.toHaveProperty('reused');
    const retry = await send(input);
    expect(retry.message_id).toBe(first.message_id);
    expect(retry.delivery_note).toMatch(/previous.*message_id.*no new message.*notification.*again/i);
    expect(retry).not.toHaveProperty('reused');
  });
  it('gives router and oversized native errors a reason and next step', async () => {
    await expect(send({ recipient: session, target_kind: 'session' }, { sendRouterRequest: async () => { throw new Error('offline'); } })).rejects.toMatchObject({ code: 'router_unreachable', message: expect.stringMatching(/router.*preserved.*start|router.*start.*preserved/i) });
    const { AgentNativeMessageTooLargeError } = await import('../../src/core/agent-messaging.js');
    expect(new AgentNativeMessageTooLargeError().message).toMatch(/native_message_too_large.*exceeds.*preserved.*shorten.*new idempotency key/i);
  });
  it('explains the quota failure without storing any message effects', async () => {
    const previous = process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES;
    process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES = '0';
    try {
      await expect(send()).rejects.toMatchObject({ code: 'storage_quota_exceeded', message: expect.stringMatching(/quota exceeded.*review.*quota.*retry/i) });
      for (const table of ['agent_messages', 'agent_message_deliveries', 'agent_message_events', 'agent_message_idempotency']) {
        expect(getDatabase().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      }
    } finally {
      if (previous === undefined) delete process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES;
      else process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES = previous;
    }
  });
  it('exposes the explanation in MCP, HTTP and source CLI', async () => {
    const mcp = await handleTool('message', { ...base, idempotency_key: 'mcp' }, 'cli');
    expect(mcp.content[0].text).toMatch(/delivery_note.*stored.*not.*read/i);
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>(resolve => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing HTTP port');
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...base, idempotency_key: 'http' }) });
      expect(JSON.stringify(await response.json())).toMatch(/delivery_note.*stored.*not.*read/i);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    const loader = `import { createServer } from 'vite'; const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } }); try { const { runCli } = await server.ssrLoadModule('/src/transports/cli/cli.ts'); await runCli([process.argv[0], 'memesh', ...process.argv.slice(1)]); } finally { await server.close(); }`;
    const cli = spawnSync(process.execPath, ['--input-type=module', '--eval', loader, 'message', 'send', '--project', project, '--sender', 'alice', '--recipient', 'bob', '--idempotency-key', 'cli', '--payload-stdin'], { encoding: 'utf8', input: 'hello', env: { ...process.env, MEMESH_DB_PATH: fixture.dbPath, MEMESH_AUTO_CAPTURE: 'false' } });
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout).toMatch(/delivery_note.*stored.*not.*read/i);
    // Each successful entrypoint must have stored its own message, not just printed a note.
    expect(getDatabase().prepare('SELECT message_id FROM agent_messages').all()).toHaveLength(3);
  });
});
