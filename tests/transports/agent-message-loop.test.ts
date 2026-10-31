import { describe, expect, it } from 'vitest';
import { getDatabase } from '../../src/db.js';
import { sendAgentMessage } from '../../src/core/agent-messaging.js';
import { executeAgentMessageAction } from '../../src/transports/agent-messaging.js';
import { useTestDatabase } from '../helpers/db-fixture.js';
import { registerAgentSession } from '../helpers/agent-session-fixture.js';
import { handleTool } from '../../src/transports/mcp/handlers.js';
import { app } from '../../src/transports/http/server.js';
import { spawnSync } from 'node:child_process';

const database = useTestDatabase('memesh-loop-transport-');
const project = 'loop-transport';
const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const a2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const context = (hostSession?: string) => ({ transport: 'mcp' as const, sourceHost: 'claude-code', hostSession });
const counts = () => Object.fromEntries(['agent_messages', 'agent_message_deliveries', 'agent_message_events', 'agent_message_idempotency']
  .map(table => [table, (getDatabase().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n]));
const send = (key: string, overrides: Record<string, unknown> = {}, session = a) => executeAgentMessageAction(getDatabase(), {
  action: 'send', project, sender: 'alice', recipient: 'bob', idempotency_key: key, payload: 'hello', ...overrides,
}, context(session), { sendRouterRequest: async () => ({ delivered: false }) });
const alias = () => getDatabase().prepare('INSERT INTO agent_session_aliases (session_id, previous_session_id, created_at_ms) VALUES (?, ?, ?)').run(a2, a, Date.now());

describe('loop guard transport identities', () => {
  it('counts reversed session recipients and aliases together, and retries across clear', async () => {
    alias();
    const first = await send('retry', { intended_session: b }) as { message_id: string };
    const beforeRetry = counts();
    expect(await send('retry', { intended_session: b }, a2)).toMatchObject({ message_id: first.message_id });
    expect(counts()).toEqual(beforeRetry);
    const stored = getDatabase().prepare('SELECT provenance_json FROM agent_messages WHERE message_id = ?').get(first.message_id) as { provenance_json: string };
    expect(JSON.parse(stored.provenance_json)).toMatchObject({ sender_session: a });
    for (let i = 1; i < 30; i++) {
      if (i % 2) sendAgentMessage(getDatabase(), { project, sender: 'bob', recipient: a2, target_kind: 'session', idempotency_key: `pair-${i}`, payload: 'hello', content_type: 'text/plain', provenance: { transport: 'mcp', source_host: 'claude-code', sender_session: b } });
      else await send(`pair-${i}`, { intended_session: b });
    }
    const before = counts();
    await expect(send('pair-31', { intended_session: b }, a2)).rejects.toMatchObject({ code: 'conversation_loop_suspected' });
    expect(counts()).toEqual(before);
  });

  it('keeps sessions under the same principal and principal names in separate namespaces', async () => {
    for (let i = 0; i < 30; i++) await send(`a-${i}`, { intended_session: b });
    await expect(send('different-session', { intended_session: b }, a2)).resolves.toBeDefined();
    await expect(executeAgentMessageAction(getDatabase(), { action: 'send', project, sender: a, recipient: 'bob', intended_session: b, idempotency_key: 'principal-same-name', payload: 'hello' }, context())).resolves.toBeDefined();
  });

  it('retries a legacy message without sender session metadata', async () => {
    const original = sendAgentMessage(getDatabase(), { project, sender: 'alice', sender_host: 'claude-code', recipient: 'bob', idempotency_key: 'legacy', payload: 'hello', content_type: 'text/plain', provenance: { transport: 'mcp', source_host: 'claude-code' } });
    const legacyRow = getDatabase().prepare('SELECT provenance_json FROM agent_messages WHERE message_id = ?').get(original.message_id) as { provenance_json: string };
    expect(JSON.parse(legacyRow.provenance_json)).not.toHaveProperty('sender_session');
    const before = counts();
    expect(await send('legacy')).toMatchObject({ message_id: original.message_id });
    expect(counts()).toEqual(before);
  });

  it('counts thirty fallback sends once each and rejects the next without rows', async () => {
    registerAgentSession(project, 'bob', { sessionId: b, adapterKind: 'claude-channel', disconnected: true });
    const options = { recipient: b, target_kind: 'session', fallback_to_principal: true };
    const first = await send('fallback-0', options) as { message_id: string; fallback: { from: { message_id: string } } };
    const row = getDatabase().prepare('SELECT provenance_json FROM agent_messages WHERE message_id = ?').get(first.message_id) as { provenance_json: string };
    expect(JSON.parse(row.provenance_json)).toMatchObject({ sender_session: a, fallback_of_message_id: first.fallback.from.message_id });
    for (let i = 1; i < 30; i++) await send(`fallback-${i}`, options);
    const before = counts();
    expect(before.agent_messages).toBe(60);
    await expect(send('fallback-31', options)).rejects.toMatchObject({ code: 'conversation_loop_suspected' });
    expect(counts()).toEqual(before);
  });

  it('does not allow public metadata or skip flags to bypass the limit', async () => {
    for (let i = 0; i < 30; i++) await send(`public-${i}`);
    const before = counts();
    for (const field of [{ fallback_of_message_id: 'forged' }, { skip: true }, { provenance: { sender_session: a2, fallback_of_message_id: 'forged' } }]) {
      await expect(send('public-31', field)).rejects.toThrow(/Unrecognized key/);
    }
    expect(counts()).toEqual(before);
  });

  it('shows the loop error through MCP, HTTP and the source CLI', async () => {
    for (let i = 0; i < 30; i++) sendAgentMessage(getDatabase(), { project, sender: 'out-a', recipient: 'out-b', idempotency_key: `out-${i}`, payload: 'hello', content_type: 'text/plain' });
    const input = { action: 'send', project, sender: 'out-a', recipient: 'out-b', idempotency_key: 'out-31', payload: 'hello' };
    const mcp = await handleTool('message', input, 'cli');
    expect(mcp.isError).toBe(true);
    expect(mcp.content[0].text).toContain('conversation_loop_suspected');
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>(resolve => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing HTTP port');
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      const body = await response.json() as { error: string; errorCode: string };
      expect(body.error).toContain('conversation_loop_suspected');
      expect(body.errorCode).toBe('operation.failed');
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    const loader = `import { createServer } from 'vite'; const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } }); try { const { runCli } = await server.ssrLoadModule('/src/transports/cli/cli.ts'); await runCli([process.argv[0], 'memesh', ...process.argv.slice(1)]); } finally { await server.close(); }`;
    const cli = spawnSync(process.execPath, ['--input-type=module', '--eval', loader, 'message', 'send', '--project', project, '--sender', 'out-a', '--recipient', 'out-b', '--idempotency-key', 'out-31', '--payload-stdin'], { encoding: 'utf8', input: 'hello', env: { ...process.env, MEMESH_DB_PATH: database.dbPath, MEMESH_AUTO_CAPTURE: 'false' } });
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain('conversation_loop_suspected');
  });
});
