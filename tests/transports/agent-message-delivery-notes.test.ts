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
  it('says whether the recipient has a live session when a principal message is stored', async () => {
    const none = await send({ idempotency_key: 'no-session' });
    expect(none.delivery_note).toMatch(/stored.*bob.*not.*read.*accepted.*no session of bob is connected now.*waits in the inbox/i);
    expect(none.delivery_note).not.toMatch(/delivered when|next connects/i);
    registerAgentSession(project, 'bob', { sessionId: session, adapterKind: 'claude-channel' });
    const live = await send({ idempotency_key: 'live-session' });
    expect(live.delivery_note).toMatch(/stored.*bob.*not.*read.*accepted.*a session of bob is connected now/i);
    expect(live.delivery_note).not.toMatch(/no session/i);
    registerAgentSession(project, 'dave', { sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', adapterKind: 'claude-channel', disconnected: true });
    expect((await send({ recipient: 'dave', idempotency_key: 'gone-session' })).delivery_note).toMatch(/no session of dave is connected now/i);
    registerAgentSession(project, 'erin', { sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', adapterKind: 'claude-channel', leaseExpiresAtMs: Date.now() - 1000 });
    expect((await send({ recipient: 'erin', idempotency_key: 'expired-lease' })).delivery_note).toMatch(/no session of erin is connected now/i);
  });
  it('counts only live sessions of the same project and the same recipient', async () => {
    registerAgentSession('another-project', 'bob', { sessionId: 'abababab-abab-4bab-8bab-abababababab', adapterKind: 'claude-channel' });
    registerAgentSession(project, 'carol', { sessionId: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd', adapterKind: 'claude-channel' });
    expect((await send({ idempotency_key: 'other-project' })).delivery_note).toMatch(/no session of bob is connected now/i);
    // The same session id live in another project must not make this project's offline session look connected.
    const shared = 'efefefef-efef-4fef-8fef-efefefefefef';
    registerAgentSession('another-project', 'bob', { sessionId: shared, adapterKind: 'claude-channel' });
    registerAgentSession(project, 'bob', { sessionId: shared, adapterKind: 'claude-channel', disconnected: true });
    const offline = (await send({ idempotency_key: 'other-project-intended', intended_session: shared })).delivery_note;
    expect(offline).toContain(`Session ${shared} is not connected now.`);
    // And a live session of another principal in this project does not count either.
    registerAgentSession(project, 'carol', { sessionId: 'dededede-dede-4ede-8ede-dededededede', adapterKind: 'claude-channel' });
    const foreign = (await send({ idempotency_key: 'other-principal-intended', intended_session: 'dededede-dede-4ede-8ede-dededededede' })).delivery_note;
    expect(foreign).not.toMatch(/connected now\.$/);
  });
  it('does not say a mistyped, unregistered or foreign intended session will take the message in', async () => {
    const typo = (await send({ idempotency_key: 'typo', intended_session: 'cccccccc-cccc-4ccc-8ccc-cccccccccc00' })).delivery_note;
    expect(typo).toContain('has not registered in this project, so MeMesh cannot tell whether it exists');
    expect(typo).not.toMatch(/next time it runs|is connected now/i);
    registerAgentSession(project, 'carol', { sessionId: 'dededede-dede-4ede-8ede-dededededede', adapterKind: 'claude-channel' });
    const foreign = (await send({ idempotency_key: 'foreign', intended_session: 'dededede-dede-4ede-8ede-dededededede' })).delivery_note;
    expect(foreign).toContain('is registered under carol, not bob, so it will not take this message in');
    expect(foreign).not.toMatch(/next time it runs|is connected now/i);
  });
  it('tells a send by handle to an offline session the same as one by intended_session', async () => {
    registerAgentSession(project, 'bob', { sessionId: session, adapterKind: 'claude-channel' });
    const gone = registerAgentSession(project, 'bob', { sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', adapterKind: 'claude-channel', disconnected: true });
    const byHandle = await executeAgentMessageAction(getDatabase(), { action: 'send', project, sender: 'alice', recipient_handle: 'note-project-claude-eeee', idempotency_key: 'by-handle', payload: 'hello' }, context, refused) as Result;
    expect(byHandle.delivery_note).toContain(`Session ${gone} is not connected now. Only it can take this message in, the next time it runs; no other session of bob will.`);
    expect(byHandle.delivery_note).not.toMatch(/A session of bob is connected now/i);
    const live = await executeAgentMessageAction(getDatabase(), { action: 'send', project, sender: 'alice', recipient_handle: 'note-project-claude-bbbb', idempotency_key: 'by-handle-live', payload: 'hello' }, context, refused) as Result;
    expect(live.delivery_note).toContain(`Session ${session} is connected now.`);
  });
  it('never promises delivery when a session next connects, in any kind of note', async () => {
    const notes: string[] = [];
    notes.push((await send({ idempotency_key: 'k-none' })).delivery_note);
    const live = registerAgentSession(project, 'bob', { sessionId: session, adapterKind: 'claude-channel' });
    const gone = registerAgentSession(project, 'bob', { sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', adapterKind: 'claude-channel', disconnected: true });
    notes.push((await send({ idempotency_key: 'k-live' })).delivery_note);
    notes.push((await send({ idempotency_key: 'k-intended-live', intended_session: live })).delivery_note);
    notes.push((await send({ idempotency_key: 'k-intended-gone', intended_session: gone })).delivery_note);
    notes.push((await send({ idempotency_key: 'k-typo', intended_session: 'cccccccc-cccc-4ccc-8ccc-cccccccccc00' })).delivery_note);
    registerAgentSession(project, 'carol', { sessionId: 'dededede-dede-4ede-8ede-dededededede', adapterKind: 'claude-channel' });
    notes.push((await send({ idempotency_key: 'k-foreign', intended_session: 'dededede-dede-4ede-8ede-dededededede' })).delivery_note);
    const handled = await executeAgentMessageAction(getDatabase(), { action: 'send', project, sender: 'alice', recipient_handle: 'note-project-claude-eeee', idempotency_key: 'k-handle', payload: 'hello' }, context, refused) as Result;
    notes.push(handled.delivery_note);
    const offlineSession = registerAgentSession(project, 'frank', { sessionId: '12121212-1212-4121-8121-121212121212', adapterKind: 'claude-channel', disconnected: true });
    const fallback = await send({ recipient: offlineSession, target_kind: 'session', fallback_to_principal: true, idempotency_key: 'k-fallback' }) as Result & { fallback: { note?: string } };
    notes.push(fallback.delivery_note, fallback.fallback.note ?? '');
    expect(notes).toHaveLength(9);
    for (const note of notes) expect(note, note).not.toMatch(/delivered when|next connects|when one .*connects|will be delivered/i);
  });
  it('keeps the fallback delivery_note apart from the fallback note about the intended session', async () => {
    const offline = registerAgentSession(project, 'bob', { sessionId: session, adapterKind: 'claude-channel', disconnected: true });
    const result = await send({ recipient: offline, target_kind: 'session', fallback_to_principal: true, idempotency_key: 'fb-offline' }) as Result & { fallback: { intended_session_connected: boolean; note?: string } };
    expect(result.delivery_note).toBe("Stored in bob's inbox. This does not mean the recipient has read or accepted it.");
    expect(result.fallback.intended_session_connected).toBe(false);
    expect(result.fallback.note).toBe(`Session ${offline} is not connected now. Only it can take this message in, the next time it runs; no other session of bob will. If it has ended for good, send to bob without intended_session instead.`);
    // Connected again (a new send the router still refuses): no note of its own, same delivery_note.
    getDatabase().prepare('UPDATE agent_session_connections SET disconnected_at = NULL, lease_expires_at_ms = ? WHERE session_instance_id = ?').run(Date.now() + 60_000, offline);
    const retry = await send({ recipient: offline, target_kind: 'session', fallback_to_principal: true, idempotency_key: 'fb-connected' }) as Result & { fallback: { intended_session_connected: boolean; note?: string } };
    expect(retry.delivery_note).toBe("Stored in bob's inbox. This does not mean the recipient has read or accepted it.");
    expect(retry.fallback.intended_session_connected).toBe(true);
    expect(retry.fallback).not.toHaveProperty('note');
  });
  it('tells a send meant for one offline session that only that session can take it, even when another session is live', async () => {
    const live = registerAgentSession(project, 'bob', { sessionId: session, adapterKind: 'claude-channel' });
    const gone = registerAgentSession(project, 'bob', { sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', adapterKind: 'claude-channel', disconnected: true });
    const offline = (await send({ idempotency_key: 'to-gone', intended_session: gone })).delivery_note;
    expect(offline).toContain(`Session ${gone} is not connected now. Only it can take this message in, the next time it runs; no other session of bob will.`);
    expect(offline).not.toMatch(/A session of bob is connected now/i);
    const online = (await send({ idempotency_key: 'to-live', intended_session: live })).delivery_note;
    expect(online).toContain(`Session ${live} is connected now.`);
    expect(online).not.toMatch(/not connected|no other session/i);
  });
  it('finds the intended session through its /clear aliases', async () => {
    const original = registerAgentSession(project, 'bob', { sessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', adapterKind: 'claude-channel' });
    const cleared = '99999999-9999-4999-8999-999999999999';
    getDatabase().prepare('INSERT INTO agent_session_aliases (session_id, previous_session_id, created_at_ms) VALUES (?, ?, ?)').run(cleared, original, Date.now());
    const note = (await send({ idempotency_key: 'to-cleared', intended_session: cleared })).delivery_note;
    expect(note).toContain(`Session ${cleared} is connected now.`);
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
