import { describe, expect, it } from 'vitest';
import { getDatabase } from '../../src/db.js';
import { executeAgentMessageAction } from '../../src/transports/agent-messaging.js';
import { DatabaseSync } from 'node:sqlite';
import { sendAgentMessage } from '../../src/core/agent-messaging.js';
import { useTestDatabase } from '../helpers/db-fixture.js';
import { registerAgentSession } from '../helpers/agent-session-fixture.js';

const dbHandle = useTestDatabase('memesh-message-status-');
const project = 'status-project';
const context = { transport: 'mcp' as const, sourceHost: 'test-host' };
const act = (input: Record<string, unknown>) => executeAgentMessageAction(getDatabase(), input, context, { sendRouterRequest: async () => ({ delivered: false }) }) as Promise<any>;
const sendOne = async (key: string, extra: Record<string, unknown> = {}) =>
  (await act({ action: 'send', project, sender: 'alice', recipient: 'bob', idempotency_key: key, payload: 'hello', ...extra })) as { message_id: string; delivery_id: string };
const status = async (messageId: string) => act({ action: 'status', project, recipient: 'bob', message_id: messageId });

/** What the router writes after one dispatch attempt for the delivery. */
function recordAttempt(deliveryId: string, session: string, failureCode: string | null, accepted: boolean, adapterKind = 'claude-inbox') {
  const db = getDatabase();
  const connection = db.prepare('SELECT connection_id FROM agent_session_connections WHERE session_instance_id = ?').get(session) as { connection_id: string };
  db.prepare(`INSERT INTO agent_dispatch_attempts (attempt_id, delivery_id, project, principal_id, session_instance_id, connection_id, generation, router_instance_id, attempt_number, result, failure_code, completed_at) VALUES (?, ?, ?, 'bob', ?, ?, 1, 'router', 1, ?, ?, CURRENT_TIMESTAMP)`)
    .run(`attempt-${deliveryId}`, deliveryId, project, session, connection.connection_id, accepted ? 'adapter_returned' : 'adapter_rejected', failureCode);
  if (accepted) db.prepare(`INSERT INTO agent_host_accepts (host_accept_id, attempt_id, delivery_id, adapter_kind, receipt_json) VALUES (?, ?, ?, ?, '{}')`).run(`accept-${deliveryId}`, `attempt-${deliveryId}`, deliveryId, adapterKind);
}

describe('message status', () => {
  it('reports a stored message as queued, without claiming anything was shown or read', async () => {
    const sent = await sendOne('queued');
    const result = await status(sent.message_id);
    expect(result).toMatchObject({ message_id: sent.message_id, status: 'queued' });
    expect(result.note).toMatch(/stored in the inbox.*no notice has been confirmed/i);
    expect(result).not.toHaveProperty('last_failure');
    expect(JSON.stringify(result)).not.toMatch(/\bread by\b|has read it/i);
  });

  it('says a held notice reaches the session at its next prompt or turn end, and keeps the failure code', async () => {
    const session = registerAgentSession(project, 'bob', { adapterKind: 'claude-inbox' });
    const sent = await sendOne('held');
    recordAttempt(sent.delivery_id, session, 'notice_not_confirmed', false);
    const result = await status(sent.message_id);
    expect(result).toMatchObject({ status: 'queued', last_failure: 'notice_not_confirmed' });
    expect(result.note).toMatch(/not shown.*conversation.*next prompt or turn end/i);
  });

  it('explains a queued message meant for an unregistered or foreign session, and for a principal with no live session', async () => {
    const stranger = await sendOne('unregistered', { intended_session: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
    expect((await status(stranger.message_id)).note).toMatch(/not registered in this project.*check the id/i);
    const foreign = registerAgentSession(project, 'carol', { sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', adapterKind: 'claude-inbox', disconnected: true });
    const wrong = await sendOne('foreign', { intended_session: foreign });
    expect((await status(wrong.message_id)).note).toMatch(/is a session of carol; bob's notices do not reach it/i);
    const plain = await sendOne('no-session', { recipient: 'zed' });
    const zed = await act({ action: 'status', project, recipient: 'zed', message_id: plain.message_id });
    expect(zed.note).toMatch(/no notice has been confirmed.*no session of zed is connected now/i);
  });

  it.each([
    ['notice_held', /Claude Code is holding the notice for its user to approve or deny.*cannot see which.*next prompt or turn end/i],
    ['host_outcome_timeout', /may or may not have reached the session.*nothing confirms it/i],
    ['transcript_unavailable', /could not read the session's conversation record.*cannot tell whether the notice arrived/i],
    ['transcript_not_found', /could not read the session's conversation record.*cannot tell whether the notice arrived/i],
  ])('explains a queued message whose last attempt failed with %s without claiming it was not shown', async (code, expected) => {
    const session = registerAgentSession(project, 'bob', { adapterKind: 'claude-inbox' });
    const sent = await sendOne(`fail-${code}`);
    recordAttempt(sent.delivery_id, session, code, false);
    const result = await status(sent.message_id);
    expect(result).toMatchObject({ status: 'queued', last_failure: code });
    expect(result.note).toMatch(expected);
    expect(result.note).not.toMatch(/was not shown|not been shown/i);
  });

  it('says nothing about who is connected when the last delivery attempt failed, and says what is true of a session message whose session is not connected', async () => {
    const session = registerAgentSession(project, 'zed', { adapterKind: 'claude-inbox', disconnected: true });
    const sent = sendAgentMessage(getDatabase(), { project, sender: 'alice', recipient: 'zed', idempotency_key: 'failed-zed', content_type: 'text/plain', payload: 'x' });
    recordAttempt(sent.delivery_id, session, 'notice_held', false);
    const failed = await act({ action: 'status', project, recipient: 'zed', message_id: sent.message_id });
    expect(failed.note).toMatch(/holding the notice/);
    expect(failed.note).not.toMatch(/No session of zed is connected/);
    const sessionOnly = sendAgentMessage(getDatabase(), { project, sender: 'alice', recipient: session, target_kind: 'session', idempotency_key: 'to-offline-session', content_type: 'text/plain', payload: 'x' });
    const offline = await act({ action: 'status', project, recipient: session, message_id: sessionOnly.message_id });
    expect(offline.note).toMatch(/target session is not connected now.*delivered when it next connects/);
  });

  it('says a notice that was too large to send certainly was not sent, and that a Codex message waits for the agent to read it rather than for a prompt or turn end', async () => {
    const claude = registerAgentSession(project, 'bob', { adapterKind: 'claude-inbox' });
    const codex = registerAgentSession(project, 'bob', { adapterKind: 'codex-cli-queue' });
    const tooLarge = await sendOne('too-large'); recordAttempt(tooLarge.delivery_id, claude, 'frame_too_large', false);
    expect((await status(tooLarge.message_id)).note).toMatch(/too large to be sent.*was not delivered/i);
    const codexFailed = await sendOne('codex-timeout'); recordAttempt(codexFailed.delivery_id, codex, 'host_outcome_timeout', false, 'codex-cli-queue');
    const codexNote = (await status(codexFailed.message_id)).note as string;
    expect(codexNote).toMatch(/may or may not have reached/);
    expect(codexNote).not.toMatch(/next prompt or turn end/);
    const claudeFailed = await sendOne('claude-timeout'); recordAttempt(claudeFailed.delivery_id, claude, 'host_outcome_timeout', false);
    expect((await status(claudeFailed.message_id)).note).toMatch(/next prompt or turn end/);
  });

  it('reads whether the meant session is connected without regard to the case of its id, whichever side is in capitals', async () => {
    registerAgentSession(project, 'bob', { sessionId: 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1', adapterKind: 'claude-inbox' });
    const sent = await sendOne('upper-liveness', { intended_session: 'F1F1F1F1-F1F1-4F1F-8F1F-F1F1F1F1F1F1' });
    expect((await status(sent.message_id)).delivery_state).toMatchObject({ target_session: 'live' });
    registerAgentSession(project, 'bob', { sessionId: 'F2F2F2F2-F2F2-4F2F-8F2F-F2F2F2F2F2F2', adapterKind: 'claude-inbox' });
    const other = await sendOne('registered-upper', { intended_session: 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2' });
    expect((await status(other.message_id)).delivery_state).toMatchObject({ target_session: 'live' });
  });

  it('words the queued note for the host of the attempt that recorded the failure, not of a later attempt that recorded none', async () => {
    const claude = registerAgentSession(project, 'bob', { adapterKind: 'claude-inbox' });
    const codex = registerAgentSession(project, 'bob', { adapterKind: 'codex-cli-queue' });
    const sent = await sendOne('two-hosts');
    const db = getDatabase();
    const insert = (session: string, attemptNumber: number, failureCode: string | null) => {
      const connection = db.prepare('SELECT connection_id FROM agent_session_connections WHERE session_instance_id = ?').get(session) as { connection_id: string };
      db.prepare(`INSERT INTO agent_dispatch_attempts (attempt_id, delivery_id, project, principal_id, session_instance_id, connection_id, generation, router_instance_id, attempt_number, result, failure_code, completed_at) VALUES (?, ?, ?, 'bob', ?, ?, 1, 'router', ?, 'adapter_rejected', ?, CURRENT_TIMESTAMP)`)
        .run(`attempt-${attemptNumber}-${sent.delivery_id}`, sent.delivery_id, project, session, connection.connection_id, attemptNumber, failureCode);
    };
    insert(claude, 1, 'notice_held');
    insert(codex, 2, null);
    const result = await status(sent.message_id);
    expect(result.last_failure).toBe('notice_held');
    expect(result.note).toMatch(/next prompt or turn end/);
    expect(result.note).not.toMatch(/waits in the inbox until the recipient reads it/);
  });

  it('reports the failure of the latest rejected attempt, and ignores an attempt that ended some other way', async () => {
    const claude = registerAgentSession(project, 'bob', { adapterKind: 'claude-inbox' });
    const sent = await sendOne('latest-of-many');
    const db = getDatabase();
    const connection = db.prepare('SELECT connection_id FROM agent_session_connections WHERE session_instance_id = ?').get(claude) as { connection_id: string };
    const insert = (attemptNumber: number, result: string, failureCode: string | null) => db.prepare(`INSERT INTO agent_dispatch_attempts (attempt_id, delivery_id, project, principal_id, session_instance_id, connection_id, generation, router_instance_id, attempt_number, result, failure_code, completed_at) VALUES (?, ?, ?, 'bob', ?, ?, 1, 'router', ?, ?, ?, CURRENT_TIMESTAMP)`)
      .run(`attempt-multi-${attemptNumber}-${sent.delivery_id}`, sent.delivery_id, project, claude, connection.connection_id, attemptNumber, result, failureCode);
    insert(1, 'adapter_rejected', 'notice_held');
    insert(2, 'adapter_rejected', 'transcript_unavailable');
    expect((await status(sent.message_id)).last_failure).toBe('transcript_unavailable');
    insert(3, 'adapter_failed', 'host_outcome_timeout');
    expect((await status(sent.message_id)).last_failure, 'an attempt that did not end in a rejection is not the failure').toBe('transcript_unavailable');
  });

  it('says an offline registered session is not connected, not that it has not registered, when its id differs in case', async () => {
    registerAgentSession(project, 'bob', { sessionId: 'ABCDEF33-ABCD-4BCD-8BCD-ABCDEFABCDEF', adapterKind: 'claude-inbox', disconnected: true });
    const sent = await sendOne('offline-case', { intended_session: 'abcdef33-abcd-4bcd-8bcd-abcdefabcdef' });
    const note = (await status(sent.message_id)).note as string;
    expect(note).toMatch(/is not connected now/);
    expect(note).not.toMatch(/has not registered/);
  });

  it('counts an ack or a disposition as the agent having the message, even without intake', async () => {
    const acked = await sendOne('acked');
    await act({ action: 'ack', project, recipient: 'bob', message_id: acked.message_id, idempotency_key: 'ack-only' });
    expect(await status(acked.message_id)).toMatchObject({ status: 'handed_to_agent' });
    const done = await sendOne('completed');
    await act({ action: 'disposition', project, recipient: 'bob', message_id: done.message_id, idempotency_key: 'done-only', disposition: 'completed' });
    expect(await status(done.message_id)).toMatchObject({ status: 'handed_to_agent' });
  });

  it('says what a host accept means for the adapter that gave it: seen in a Claude conversation, but only handed over and queued by the Channel and by Codex', async () => {
    const session = registerAgentSession(project, 'bob', { adapterKind: 'claude-inbox' });
    const accepted = async (key: string, adapter: string) => {
      const sent = await sendOne(key);
      recordAttempt(sent.delivery_id, session, null, true, adapter);
      return (await status(sent.message_id)).note as string;
    };
    expect(await accepted('accepted-inbox', 'claude-inbox')).toMatch(/in the recipient's conversation/i);
    const channel = await accepted('accepted-channel', 'claude-channel');
    expect(channel).toMatch(/handed to the recipient's Claude Code Channel and queued.*does not see it shown there/i);
    expect(channel).not.toMatch(/in the recipient's conversation/i);
    const codex = await accepted('accepted-codex', 'codex-cli-queue');
    expect(codex).toMatch(/queued for the recipient's Codex thread.*does not see it shown there/i);
    expect(codex).not.toMatch(/in the recipient's conversation/i);
  });

  it('reports accepted only when a host accept exists', async () => {
    const session = registerAgentSession(project, 'bob', { adapterKind: 'claude-inbox' });
    const sent = await sendOne('accepted');
    recordAttempt(sent.delivery_id, session, null, true);
    const result = await status(sent.message_id);
    expect(result.status).toBe('accepted');
    expect(result.note).toMatch(/in the recipient's conversation.*has not recorded intake, an ack or a disposition/i);
  });

  it('reports handed_to_agent once the agent recorded intake, then replied once a reply links to it', async () => {
    const sent = await sendOne('handed');
    await act({ action: 'intake', project, recipient: 'bob', message_id: sent.message_id, idempotency_key: 'intake-1', intake_state: 'ingested' });
    expect((await status(sent.message_id)).status).toBe('handed_to_agent');
    await act({ action: 'send', project, sender: 'bob', recipient: 'alice', idempotency_key: 'reply-1', payload: 'done', reply_to: sent.message_id });
    expect((await status(sent.message_id)).status).toBe('replied');
  });

  it('does not count a message that links to this one but is not addressed back to its sender', async () => {
    const sent = await sendOne('side-note');
    await act({ action: 'send', project, sender: 'bob', recipient: 'someone-else', idempotency_key: 'side-1', payload: 'fyi', reply_to: sent.message_id });
    expect((await status(sent.message_id)).status).toBe('queued');
  });

  it('counts a reply only when the original recipient sent it: a third party linking to the message does not', async () => {
    const sent = await sendOne('third-party');
    await act({ action: 'send', project, sender: 'carol', recipient: 'alice', idempotency_key: 'tp-1', payload: 'unrelated', reply_to: sent.message_id });
    expect((await status(sent.message_id)).status).toBe('queued');
    await act({ action: 'send', project, sender: 'bob', recipient: 'alice', idempotency_key: 'tp-2', payload: 'the answer', reply_to: sent.message_id });
    expect((await status(sent.message_id)).status).toBe('replied');
  });

  it('counts a reply sent to the original sender\'s session, and one by the principal that owns the session the original was sent to', async () => {
    const aliceSession = registerAgentSession(project, 'alice', { sessionId: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1', adapterKind: 'claude-channel' });
    const bobSession = registerAgentSession(project, 'bob', { sessionId: 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1', adapterKind: 'claude-channel' });
    const toBob = await sendOne('to-bob');
    sendAgentMessage(getDatabase(), { project, sender: 'bob', recipient: aliceSession, target_kind: 'session', idempotency_key: 'reply-to-session', content_type: 'text/plain', payload: 'answer', reply_to: toBob.message_id });
    expect((await status(toBob.message_id)).status).toBe('replied');
    const toBobSession = sendAgentMessage(getDatabase(), { project, sender: 'alice', recipient: bobSession, target_kind: 'session', idempotency_key: 'to-bob-session', content_type: 'text/plain', payload: 'for the session' });
    const sessionStatus = (id: string) => act({ action: 'status', project, recipient: bobSession, message_id: id });
    sendAgentMessage(getDatabase(), { project, sender: 'carol', recipient: 'alice', idempotency_key: 'carol-no', content_type: 'text/plain', payload: 'x', reply_to: toBobSession.message_id });
    expect((await sessionStatus(toBobSession.message_id)).status).not.toBe('replied');
    sendAgentMessage(getDatabase(), { project, sender: 'bob', recipient: 'alice', idempotency_key: 'bob-yes', content_type: 'text/plain', payload: 'x', reply_to: toBobSession.message_id });
    expect((await sessionStatus(toBobSession.message_id)).status).toBe('replied');
  });

  it('is a plain read: it does not wait for another connection\'s write lock', async () => {
    const sent = await sendOne('lock-free');
    const other = new DatabaseSync(dbHandle.dbPath);
    getDatabase().pragma('busy_timeout = 250');
    other.exec('BEGIN IMMEDIATE');
    try {
      // With the other connection holding the write lock and this one waiting only 250 ms, a status that took
      // the write lock itself would fail with "database is locked"; a plain read returns.
      expect(await status(sent.message_id)).toMatchObject({ status: 'queued' });
    } finally { other.exec('ROLLBACK'); other.close(); }
  });

  it('does not report another project\'s reply as a reply', async () => {
    const sent = await sendOne('scoped');
    await act({ action: 'send', project: 'other-project', sender: 'bob', recipient: 'alice', idempotency_key: 'reply-x', payload: 'x', reply_to: sent.message_id });
    expect((await status(sent.message_id)).status).toBe('queued');
  });
});
