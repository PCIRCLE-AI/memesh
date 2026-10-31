import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { getDatabase } from '../../src/db.js';
import { executeAgentMessageAction } from '../../src/transports/agent-messaging.js';
import { handleTool } from '../../src/transports/mcp/handlers.js';
import { MessageSchema } from '../../src/transports/schemas.js';
import { useTestDatabase } from '../helpers/db-fixture.js';
import { registerAgentSession } from '../helpers/agent-session-fixture.js';

const fixture = useTestDatabase('memesh-message-handles-');
const project = 'my-project~abc';
const session = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa0d1';
const handle = 'my-project-claude-a0d1';
const base = { action: 'send', project, sender: 'sender', idempotency_key: 'key', payload: 'hello' };
const ctx = { transport: 'mcp' as const, sourceHost: 'test-host' };
const counts = () => Object.fromEntries(['agent_messages', 'agent_message_deliveries', 'agent_message_events', 'agent_message_idempotency'].map(t => [t, (getDatabase().prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]));
const send = (input: Record<string, unknown>) => executeAgentMessageAction(getDatabase(), { ...base, ...input }, ctx, { sendRouterRequest: async () => ({ delivered: false }) });
const row = () => getDatabase().prepare('SELECT m.recipient, d.target_kind, d.intended_session FROM agent_messages m JOIN agent_message_deliveries d ON d.message_id = m.message_id').get();

describe('recipient handles', () => {
  it('resolves an offline Claude session to its principal and intended session in durable rows', async () => {
    registerAgentSession(project, 'claude-p', { sessionId: session, adapterKind: 'claude-channel', disconnected: true });
    await expect(send({ recipient_handle: handle })).resolves.toMatchObject({ recipient: 'claude-p', target_kind: 'principal', intended_session: session });
    expect(row()).toEqual({ recipient: 'claude-p', target_kind: 'principal', intended_session: session });
    expect(counts()).toEqual({ agent_messages: 1, agent_message_deliveries: 1, agent_message_events: 1, agent_message_idempotency: 1 });
    expect(getDatabase().prepare('SELECT message_id FROM agent_messages').all()).toHaveLength(1);
  });

  it.each([['codex-app-server', 'codex'], ['acp', 'gemini']])('routes %s to exact session before deciding native acceptance', async (adapter, host) => {
    registerAgentSession(project, 'other-p', { sessionId: session, adapterKind: adapter });
    await expect(send({ recipient_handle: `my-project-${host}-a0d1` })).rejects.toMatchObject({ code: 'recipient_unavailable' });
    expect(row()).toEqual({ recipient: session, target_kind: 'session', intended_session: null });
    expect(counts()).toEqual({ agent_messages: 1, agent_message_deliveries: 1, agent_message_events: 1, agent_message_idempotency: 1 });
  });

  it('rejects a missing handle without writes and ignores registrations in other projects', async () => {
    registerAgentSession('elsewhere~abc', 'other', { sessionId: session, adapterKind: 'claude-channel' });
    await expect(send({ recipient_handle: handle })).rejects.toMatchObject({ code: 'handle_not_found', message: expect.stringMatching(/handle_not_found.*(discover|available)/i) });
    expect(counts()).toEqual({ agent_messages: 0, agent_message_deliveries: 0, agent_message_events: 0, agent_message_idempotency: 0 });
  });
  it('rejects colliding handles without choosing the first session or writing rows', async () => {
    registerAgentSession(project, 'claude-p', { sessionId: session, adapterKind: 'claude-channel' });
    registerAgentSession(project, 'claude-p', { sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccca0d1', adapterKind: 'claude-channel' });
    await expect(send({ recipient_handle: handle })).rejects.toMatchObject({ code: 'handle_ambiguous', message: expect.stringMatching(/handle_ambiguous.*session/i) });
    expect(counts()).toEqual({ agent_messages: 0, agent_message_deliveries: 0, agent_message_events: 0, agent_message_idempotency: 0 });
  });

  it('requires exactly one send recipient field and leaves other actions unchanged', () => {
    expect(MessageSchema.safeParse({ ...base }).success).toBe(false);
    expect(MessageSchema.safeParse({ ...base, recipient: 'bob', recipient_handle: handle }).success).toBe(false);
    expect(MessageSchema.safeParse({ action: 'poll', project }).success).toBe(false);
    expect(MessageSchema.safeParse({ action: 'poll', project, recipient_handle: handle }).success).toBe(false);
  });

  it('rejects conflicting explicit target and intended session before writing', async () => {
    registerAgentSession(project, 'claude-p', { sessionId: session, adapterKind: 'claude-channel' });
    await expect(send({ recipient_handle: handle, intended_session: 'another-session' })).rejects.toThrow(/intended_session.*does not match/);
    await expect(send({ recipient_handle: handle, target_kind: 'session' })).rejects.toThrow(/target_kind.*does not match/);
    await expect(send({ recipient_handle: handle, fallback_to_principal: true })).rejects.toThrow(/fallback_to_principal.*only valid/);
    expect(counts()).toEqual({ agent_messages: 0, agent_message_deliveries: 0, agent_message_events: 0, agent_message_idempotency: 0 });
  });

  it('accepts a generated handle longer than the recipient limit', async () => {
    const longProject = 'p'.repeat(200);
    registerAgentSession(longProject, 'claude-p', { sessionId: session, adapterKind: 'claude-channel', disconnected: true });
    await expect(send({ project: longProject, recipient_handle: `${longProject}-claude-a0d1` })).resolves.toMatchObject({ recipient: 'claude-p', intended_session: session });
    expect(counts().agent_messages).toBe(1);
  });

  it('does not interpret a literal recipient that looks like a handle', async () => {
    registerAgentSession(project, 'claude-p', { sessionId: session, adapterKind: 'claude-channel' });
    await expect(send({ recipient: handle })).resolves.toMatchObject({ recipient: handle, target_kind: 'principal', intended_session: null });
    expect(row()).toEqual({ recipient: handle, target_kind: 'principal', intended_session: null });
    expect(counts().agent_messages).toBe(1);
  });

  it('resolves an offline handle through MCP', async () => {
    registerAgentSession(project, 'claude-p', { sessionId: session, adapterKind: 'claude-channel', disconnected: true });
    const result = await handleTool('message', { ...base, recipient_handle: handle, idempotency_key: 'mcp' }, 'cli');
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ recipient: 'claude-p', target_kind: 'principal', intended_session: session });
    expect(counts().agent_messages).toBe(1);
  });
  it('resolves the same offline handle through the source CLI', () => {
    registerAgentSession(project, 'claude-p', { sessionId: session, adapterKind: 'claude-channel', disconnected: true });
    const loader = `import { createServer } from 'vite'; const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } }); try { const { runCli } = await server.ssrLoadModule('/src/transports/cli/cli.ts'); await runCli([process.argv[0], 'memesh', ...process.argv.slice(1)]); } finally { await server.close(); }`;
    const cli = spawnSync(process.execPath, ['--input-type=module', '--eval', loader, 'message', 'send', '--project', project, '--sender', 'sender', '--recipient-handle', handle, '--idempotency-key', 'cli', '--payload-stdin'], { encoding: 'utf8', input: 'hello', env: { ...process.env, MEMESH_DB_PATH: fixture.dbPath, MEMESH_AUTO_CAPTURE: 'false' } });
    expect(cli.status, cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({ recipient: 'claude-p', target_kind: 'principal', intended_session: session });
    expect(counts()).toEqual({ agent_messages: 1, agent_message_deliveries: 1, agent_message_events: 1, agent_message_idempotency: 1 });
  });
});
