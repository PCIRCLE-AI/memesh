/**
 * Sessions of one principal share its inbox. A caller that names a session registered under a
 * different principal is not a recipient of that principal's messages, and every action that
 * records or reads something about a message refuses it, in the words used for a message that
 * does not exist (`poll`, which has no message to name, shows an empty inbox instead).
 *
 * This is cooperative, not a security boundary. It only applies to a caller that names a
 * registered session id (the MCP server and the CLI take it from the host's environment). A
 * caller with no session id, such as a plain HTTP request, or with an id nobody registered, is
 * not refused, and any local process can read the database file directly. The point is that a
 * user's own sessions do not touch each other's messages by mistake. The one read open to someone
 * other than the recipient is `status`, which the message's sender may use for what it sent (never
 * the payload or the receipts).
 */
import { describe, it, expect } from 'vitest';
import { getDatabase } from '../../src/db.js';
import { AgentMessageAccessError, readAgentMessageReceipts, sendAgentMessage } from '../../src/core/agent-messaging.js';
import { getAgentMessageStorageReport } from '../../src/core/agent-message-storage.js';
import { executeAgentMessageAction } from '../../src/transports/agent-messaging.js';
import { hostSessionFromEnv } from '../../src/core/host-session.js';
import { useTestDatabase } from '../helpers/db-fixture.js';
import { registerAgentSession, sendSessionTargetedMessage } from '../helpers/agent-session-fixture.js';

useTestDatabase('memesh-receipt-principal-');
const project = 'receipt-principal';
const carolSession = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const carolAfterClear = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const bobSession = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type Subject = { name: string; recipient: string; kind: 'principal' | 'session'; messageId: string };

function subjects(key: string): Subject[] {
  const principal = sendAgentMessage(getDatabase(), { project, sender: 'alice', recipient: 'bob', idempotency_key: `p-${key}`, content_type: 'text/plain', payload: 'for bob' });
  const session = sendSessionTargetedMessage(project, bobSession, `s-${key}`);
  return [
    { name: 'a message to bob', recipient: 'bob', kind: 'principal', messageId: principal.message_id },
    { name: 'a message to bob\'s session', recipient: bobSession, kind: 'session', messageId: session.message_id },
  ];
}

const READS = ['status', 'fetch', 'receipts'];
const baseInput = (subject: Subject, action: string, key: string) => ({
  action, project, recipient: subject.recipient, message_id: subject.messageId,
  ...(READS.includes(action) ? {} : { idempotency_key: key }),
  ...(action === 'intake' ? { intake_state: 'ingested' } : {}),
  ...(action === 'disposition' ? { disposition: 'accepted' } : {}),
  ...(action === 'activation' ? { activation: 'woken' } : {}),
  ...(action === 'fetch' ? { target_kind: subject.kind } : {}),
});
const call = (input: Record<string, unknown>, hostSession?: string) =>
  executeAgentMessageAction(getDatabase(), input, { transport: 'mcp', sourceHost: 'test', ...(hostSession ? { hostSession } : {}) });
const missing = (subject: Subject) => `Agent message ${subject.messageId} is not available to recipient ${subject.recipient} in project ${project}.`;
const messageOf = async (pending: Promise<unknown>) => { try { await pending; return 'RESOLVED'; } catch (error) { return (error as Error).message; } };
const ACTIONS = ['intake', 'ack', 'disposition', 'activation', 'status', 'fetch', 'receipts'];

function setup() {
  registerAgentSession(project, 'carol', { sessionId: carolSession, adapterKind: 'claude-channel' });
  registerAgentSession(project, 'bob', { sessionId: bobSession, adapterKind: 'claude-channel' });
}

describe('actions on a message and the caller session\'s principal', () => {
  it.each(ACTIONS)('%s: a session of another principal is refused like a missing message, for a principal message and for a session message', async action => {
    setup();
    for (const subject of subjects(`refuse-${action}`)) {
      const input = baseInput(subject, action, `k-${action}-${subject.kind}`);
      await expect(call(input, carolSession), subject.name).rejects.toThrow(AgentMessageAccessError);
      await expect(call(input, carolSession), subject.name).rejects.toThrow(missing(subject));
    }
  });

  it('keeps a session message to its own session: another session of the same principal may not ack, intake, answer or activate it', async () => {
    setup();
    registerAgentSession(project, 'bob', { sessionId: 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2', adapterKind: 'claude-channel' });
    const [, sessionMessage] = subjects('same-principal');
    for (const action of ['intake', 'ack', 'disposition', 'activation']) {
      for (const caller of ['b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2', 'B2B2B2B2-B2B2-4B2B-8B2B-B2B2B2B2B2B2']) {
        await expect(call(baseInput(sessionMessage, action, `sp-${action}-${caller.length}-${caller[0]}`), caller), `${action} as ${caller}`).rejects.toThrow(/intended_for_other_session/);
      }
    }
    expect(readAgentMessageReceipts(getDatabase(), { project, recipient: bobSession, message_id: sessionMessage.messageId })).toHaveLength(0);
  });

  it('holds a message meant for one session to that session whatever case its id is written in, for every receipt', async () => {
    const sb = 'b7b7b7b7-b7b7-4b7b-8b7b-b7b7b7b7b7b7'; const sb2 = 'b8b8b8b8-b8b8-4b8b-8b8b-b8b8b8b8b8b8';
    registerAgentSession(project, 'bob', { sessionId: sb, adapterKind: 'claude-channel' });
    registerAgentSession(project, 'bob', { sessionId: sb2, adapterKind: 'claude-channel' });
    const sent = sendAgentMessage(getDatabase(), { project, sender: 'alice', recipient: 'bob', intended_session: sb, idempotency_key: 'case-intended', content_type: 'text/plain', payload: 'for SB' });
    const subject: Subject = { name: 'a message meant for SB', recipient: 'bob', kind: 'principal', messageId: sent.message_id };
    for (const action of ['intake', 'ack', 'disposition', 'activation']) {
      await expect(call(baseInput(subject, action, `up-other-${action}`), sb2.toUpperCase()), `${action} by the other session in capitals`).rejects.toThrow(/intended_for_other_session/);
    }
    expect(readAgentMessageReceipts(getDatabase(), { project, recipient: 'bob', message_id: sent.message_id })).toHaveLength(0);
    for (const action of ['intake', 'ack', 'activation', 'disposition']) {
      await expect(call(baseInput(subject, action, `up-own-${action}`), sb.toUpperCase()), `${action} by SB in capitals`).resolves.toBeDefined();
    }
  });

  it('accepts the meant session\'s ack and activation after /clear (its new id), in capitals, and from a caller that names no session', async () => {
    const sb = 'b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9b9'; const sbAfterClear = 'bababaaa-baba-4aba-8aba-bababababaaa';
    registerAgentSession(project, 'bob', { sessionId: sb, adapterKind: 'claude-channel' });
    getDatabase().prepare('INSERT INTO agent_session_aliases (session_id, previous_session_id, created_at_ms) VALUES (?, ?, ?)').run(sbAfterClear, sb, Date.now());
    const sent = (key: string) => sendAgentMessage(getDatabase(), { project, sender: 'alice', recipient: 'bob', intended_session: sb, idempotency_key: key, content_type: 'text/plain', payload: 'for SB' });
    const subject = (key: string): Subject => ({ name: key, recipient: 'bob', kind: 'principal', messageId: sent(key).message_id });
    const cleared = subject('after-clear'); const upper = subject('upper-ack'); const unnamed = subject('no-session');
    expect(await call(baseInput(cleared, 'ack', 'c-1'), sbAfterClear)).toMatchObject({ receipt_kind: 'ack' });
    expect(await call(baseInput(cleared, 'activation', 'c-2'), sbAfterClear)).toMatchObject({ receipt_kind: 'host_activation' });
    expect(await call(baseInput(upper, 'ack', 'u-1'), sbAfterClear.toUpperCase())).toMatchObject({ receipt_kind: 'ack' });
    expect(await call(baseInput(unnamed, 'ack', 'n-1'))).toMatchObject({ receipt_kind: 'ack' });
  });

  it('lets a sender whose sender name is not its principal look up what it sent, through the session that sent it (also after /clear)', async () => {
    const sa = 'a7a7a7a7-a7a7-4a7a-8a7a-a7a7a7a7a7a7'; const saAfterClear = 'a8a8a8a8-a8a8-4a8a-8a8a-a8a8a8a8a8a8';
    registerAgentSession(project, 'alice', { sessionId: sa, adapterKind: 'claude-channel' });
    getDatabase().prepare('INSERT INTO agent_session_aliases (session_id, previous_session_id, created_at_ms) VALUES (?, ?, ?)').run(saAfterClear, sa, Date.now());
    setup();
    const sent = await call({ action: 'send', project, sender: 'implementation-agent', recipient: 'bob', idempotency_key: 'by-label', payload: 'x' }, sa) as { message_id: string };
    const subject: Subject = { name: 'a message sent under a label', recipient: 'bob', kind: 'principal', messageId: sent.message_id };
    expect(await call(baseInput(subject, 'status', 'x'), sa)).toMatchObject({ status: 'queued' });
    expect(await call(baseInput(subject, 'status', 'x'), saAfterClear)).toMatchObject({ status: 'queued' });
    // The alias is found whichever way either id is written.
    expect(await call(baseInput(subject, 'status', 'x'), saAfterClear.toUpperCase())).toMatchObject({ status: 'queued' });
    expect(await call(baseInput(subject, 'status', 'x'), sa.toUpperCase())).toMatchObject({ status: 'queued' });
    await expect(call(baseInput(subject, 'status', 'x'), carolSession)).rejects.toThrow(missing(subject));
    await expect(call(baseInput(subject, 'fetch', 'x'), sa)).rejects.toThrow(missing(subject));
  });

  it('answers the same intake key again with the same receipt, from another session or after /clear, instead of a conflict', async () => {
    registerAgentSession(project, 'bob', { sessionId: bobSession, adapterKind: 'claude-channel' });
    registerAgentSession(project, 'bob', { sessionId: 'b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3', adapterKind: 'claude-channel' });
    const [principalMessage] = subjects('same-key');
    const first = await call(baseInput(principalMessage, 'intake', 'intake-same'), bobSession) as { receipt_id: string };
    const again = await call(baseInput(principalMessage, 'intake', 'intake-same'), 'b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3') as { receipt_id: string };
    const withoutSession = await call(baseInput(principalMessage, 'intake', 'intake-same')) as { receipt_id: string };
    expect(again.receipt_id).toBe(first.receipt_id);
    expect(withoutSession.receipt_id).toBe(first.receipt_id);
  });

  it('does not let two registrations that differ only in case stand for each other: a session is judged by its own exact id first', async () => {
    registerAgentSession(project, 'carol', { sessionId: 'EEEEEEEE-eeee-4eee-8eee-eeeeeeeeeeee', adapterKind: 'claude-channel' });
    registerAgentSession(project, 'bob', { sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', adapterKind: 'claude-channel' });
    const toCarol = sendAgentMessage(getDatabase(), { project, sender: 'alice', recipient: 'carol', idempotency_key: 'case-twins', content_type: 'text/plain', payload: 'for carol' });
    const subject: Subject = { name: 'a message to carol', recipient: 'carol', kind: 'principal', messageId: toCarol.message_id };
    await expect(call(baseInput(subject, 'fetch', 'x'), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')).rejects.toThrow(missing(subject));
    expect(await call(baseInput(subject, 'fetch', 'x'), 'EEEEEEEE-eeee-4eee-8eee-eeeeeeeeeeee')).toMatchObject({ message_id: toCarol.message_id });
  });

  it('polling shows a principal\'s events only to that principal\'s sessions: a session of another principal sees none', async () => {
    setup();
    subjects('poll');
    const poll = async (session?: string) => (await call({ action: 'poll', project, recipient: 'bob' }, session) as { events: unknown[] }).events;
    expect(await poll(bobSession)).toHaveLength(1);
    expect(await poll(undefined)).toHaveLength(1);
    expect(await poll(carolSession)).toHaveLength(0);
    // The waiting form of poll is held to the same rule.
    const waited = await call({ action: 'poll', project, recipient: 'bob', wait_ms: 30 }, carolSession) as { events: unknown[] };
    expect(waited.events).toHaveLength(0);
  });

  it('keeps a message\'s content when another session of the principal, writing its id in capitals, tries to finish a message sent to one session', async () => {
    const sb = 'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc'; const sb2 = 'bdbdbdbd-bdbd-4bdb-8bdb-bdbdbdbdbdbd';
    registerAgentSession(project, 'bob', { sessionId: sb, adapterKind: 'claude-channel' });
    registerAgentSession(project, 'bob', { sessionId: sb2, adapterKind: 'claude-channel' });
    const sent = sendSessionTargetedMessage(project, sb, 'keep-content');
    const subject: Subject = { name: 'a message sent to SB', recipient: sb, kind: 'session', messageId: sent.message_id };
    await expect(call(baseInput(subject, 'ack', 'k-ack'), sb2.toUpperCase())).rejects.toThrow(/intended_for_other_session/);
    await expect(call(baseInput(subject, 'disposition', 'k-done'), sb2.toUpperCase())).rejects.toThrow(/intended_for_other_session/);
    getDatabase().prepare("UPDATE agent_message_receipts SET created_at = '2020-01-01 00:00:00'").run();
    // Neither refused call finished the message: it is still unresolved, not terminal.
    expect(getAgentMessageStorageReport(getDatabase(), {})).toMatchObject({ terminal_retained_message_count: 0, protected_unresolved_message_count: 1 });
    expect(await call(baseInput(subject, 'fetch', 'x'), sb)).toMatchObject({ payload: { text: 'review is done' } });
  });

  it('refuses a caller whose id is only an alias of a session registered under another principal (after /clear)', async () => {
    setup();
    getDatabase().prepare('INSERT INTO agent_session_aliases (session_id, previous_session_id, created_at_ms) VALUES (?, ?, ?)').run(carolAfterClear, carolSession, Date.now());
    for (const subject of subjects('alias')) {
      for (const action of ['ack', 'status', 'fetch']) {
        await expect(call(baseInput(subject, action, `alias-${action}-${subject.kind}`), carolAfterClear), `${action} ${subject.name}`).rejects.toThrow(missing(subject));
      }
    }
  });

  it('records nothing for a refused caller, and still serves the recipient, a caller with no session id and one nobody registered', async () => {
    setup();
    const [principalMessage, sessionMessage] = subjects('control');
    for (const subject of [principalMessage, sessionMessage]) {
      for (const action of ['intake', 'ack', 'disposition', 'activation']) {
        await expect(call(baseInput(subject, action, `refused-${action}-${subject.kind}`), carolSession)).rejects.toThrow(AgentMessageAccessError);
      }
      expect(readAgentMessageReceipts(getDatabase(), { project, recipient: subject.recipient, message_id: subject.messageId })).toHaveLength(0);
    }
    expect(await call(baseInput(principalMessage, 'ack', 'own-1'), bobSession)).toMatchObject({ receipt_kind: 'ack' });
    expect(await call(baseInput(sessionMessage, 'ack', 'own-2'), bobSession)).toMatchObject({ receipt_kind: 'ack' });
    expect(await call(baseInput(principalMessage, 'ack', 'none-1'))).toMatchObject({ receipt_kind: 'ack' });
    expect(await call(baseInput(principalMessage, 'disposition', 'unreg-1'), 'dddddddd-dddd-4ddd-8ddd-dddddddddddd')).toMatchObject({ receipt_kind: 'disposition' });
    // The recipient already acked and recorded a disposition above, so the message counts as handed to the agent.
    expect(await call(baseInput(principalMessage, 'status', 'x'), bobSession)).toMatchObject({ status: 'handed_to_agent' });
    expect(await call(baseInput(principalMessage, 'fetch', 'x'))).toMatchObject({ message_id: principalMessage.messageId });
    expect(readAgentMessageReceipts(getDatabase(), { project, recipient: principalMessage.recipient, message_id: principalMessage.messageId })).toHaveLength(3);
  });

  it('answers a refused call about a session message exactly as it answers one about a message that does not exist', async () => {
    setup();
    const [, sessionMessage] = subjects('same-words');
    const unknown: Subject = { ...sessionMessage, messageId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' };
    for (const action of ['intake', 'ack', 'disposition', 'activation', 'status', 'fetch', 'receipts']) {
      const refused = await messageOf(call(baseInput(sessionMessage, action, `sw-${action}`), carolSession));
      const absent = await messageOf(call(baseInput(unknown, action, `sw-${action}-absent`), carolSession));
      expect(refused, action).not.toBe('RESOLVED');
      expect(refused.replaceAll(sessionMessage.messageId, 'ID'), action).toBe(absent.replaceAll(unknown.messageId, 'ID'));
    }
  });

  it('looks a caller\'s session up only in the message\'s own project: an id registered elsewhere is unknown here and is not refused', async () => {
    setup();
    registerAgentSession('some-other-project', 'dave', { sessionId: 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4', adapterKind: 'claude-channel' });
    const [principalMessage] = subjects('elsewhere');
    expect(await call(baseInput(principalMessage, 'status', 'x'), 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4')).toMatchObject({ status: 'queued' });
  });

  it('keeps a message meant for one session to that session: another session of the same principal may not ack it or record an activation, and cannot move its status on', async () => {
    const sb = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b5b5'; const sb2 = 'b6b6b6b6-b6b6-4b6b-8b6b-b6b6b6b6b6b6';
    registerAgentSession(project, 'bob', { sessionId: sb, adapterKind: 'claude-channel' });
    registerAgentSession(project, 'bob', { sessionId: sb2, adapterKind: 'claude-channel' });
    const sent = sendAgentMessage(getDatabase(), { project, sender: 'alice', recipient: 'bob', intended_session: sb, idempotency_key: 'meant-for-sb', content_type: 'text/plain', payload: 'for SB' });
    const subject: Subject = { name: 'a message meant for SB', recipient: 'bob', kind: 'principal', messageId: sent.message_id };
    for (const action of ['ack', 'activation']) {
      await expect(call(baseInput(subject, action, `sb2-${action}`), sb2), action).rejects.toThrow(/intended_for_other_session/);
    }
    expect(await call(baseInput(subject, 'status', 'x'), sb2)).toMatchObject({ status: 'queued' });
    expect(await call(baseInput(subject, 'fetch', 'x'), sb2)).toMatchObject({ message_id: sent.message_id });
    // The meant session, a caller with no session id (HTTP) and the router itself (no session) still can.
    expect(await call(baseInput(subject, 'ack', 'sb-own'), sb)).toMatchObject({ receipt_kind: 'ack' });
    expect(await call(baseInput(subject, 'activation', 'http-activation'))).toMatchObject({ receipt_kind: 'host_activation' });
    expect(await call(baseInput(subject, 'status', 'x'), sb2)).toMatchObject({ status: 'handed_to_agent' });
  });

  it('lets a sender look up the status of what it sent, but not read the payload or the receipts, and keeps third parties out', async () => {
    const alice = 'a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a9';
    registerAgentSession(project, 'alice', { sessionId: alice, adapterKind: 'claude-channel' });
    setup();
    const [principalMessage] = subjects('by-alice');
    expect(await call(baseInput(principalMessage, 'status', 'x'), alice)).toMatchObject({ status: 'queued' });
    for (const action of ['fetch', 'receipts']) {
      await expect(call(baseInput(principalMessage, action, 'x'), alice), action).rejects.toThrow(missing(principalMessage));
    }
    await expect(call(baseInput(principalMessage, 'status', 'x'), carolSession)).rejects.toThrow(missing(principalMessage));
  });

  it('is not bypassed by writing a registered session id in capitals', async () => {
    setup();
    for (const subject of subjects('upper')) {
      for (const action of ['ack', 'status', 'fetch', 'receipts']) {
        await expect(call(baseInput(subject, action, `up-${action}-${subject.kind}`), carolSession.toUpperCase()), `${action} ${subject.name}`).rejects.toThrow(missing(subject));
      }
    }
  });

  it('matches a session registered in capitals however the caller writes its id', async () => {
    registerAgentSession(project, 'carol', { sessionId: carolSession.toUpperCase(), adapterKind: 'claude-channel' });
    registerAgentSession(project, 'bob', { sessionId: bobSession, adapterKind: 'claude-channel' });
    const [principalMessage] = subjects('registered-upper');
    for (const caller of [carolSession, carolSession.toUpperCase()]) {
      await expect(call(baseInput(principalMessage, 'status', 'x'), caller), caller).rejects.toThrow(missing(principalMessage));
    }
  });

  it('accepts the recipient\'s own session when the principal is registered in decomposed (NFD) form', async () => {
    const nfd = 'jose\u0301';
    registerAgentSession(project, nfd, { sessionId: 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0', adapterKind: 'claude-channel' });
    const sent = sendAgentMessage(getDatabase(), { project, sender: 'alice', recipient: 'jos\u00e9', idempotency_key: 'nfd-1', content_type: 'text/plain', payload: 'for josé' });
    const subject: Subject = { name: 'a message to josé', recipient: 'jos\u00e9', kind: 'principal', messageId: sent.message_id };
    for (const action of ['intake', 'ack', 'status', 'fetch']) {
      await expect(call(baseInput(subject, action, `nfd-${action}`), 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0'), action).resolves.toBeDefined();
    }
  });

  it('judges the twin of a session registered in other letters by its own registration: a message to bob is not open to carol\'s uppercase twin', async () => {
    registerAgentSession(project, 'bob', { sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', adapterKind: 'claude-channel' });
    registerAgentSession(project, 'carol', { sessionId: 'EEEEEEEE-EEEE-4EEE-8EEE-EEEEEEEEEEEE', adapterKind: 'claude-channel' });
    const sent = sendAgentMessage(getDatabase(), { project, sender: 'alice', recipient: 'bob', idempotency_key: 'twin-n1', content_type: 'text/plain', payload: 'bob only' });
    const subject: Subject = { name: 'a message to bob', recipient: 'bob', kind: 'principal', messageId: sent.message_id };
    for (const action of ['fetch', 'ack', 'receipts']) {
      await expect(call(baseInput(subject, action, `twin-${action}`), 'EEEEEEEE-EEEE-4EEE-8EEE-EEEEEEEEEEEE'), action).rejects.toThrow(missing(subject));
    }
    expect((await call({ action: 'poll', project, recipient: 'bob' }, 'EEEEEEEE-EEEE-4EEE-8EEE-EEEEEEEEEEEE') as { events: unknown[] }).events).toHaveLength(0);
    expect(await call(baseInput(subject, 'fetch', 'x'), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')).toMatchObject({ payload: 'bob only' });
    // A registration written in other letters than the id the caller uses still names that session when nothing matches exactly.
    expect(await call(baseInput(subject, 'fetch', 'x'), 'eeeeeeee-eeee-4eee-8eee-EEEEEEEEEEEE')).toBeDefined();
  });

  it('serves the recipient session itself however it writes its id: a message to a session, answered by that session in capitals', async () => {
    setup();
    const [, sessionMessage] = subjects('own-session-upper');
    const upper = bobSession.toUpperCase();
    for (const action of ['intake', 'ack', 'disposition', 'activation', 'status', 'fetch', 'receipts']) {
      await expect(call(baseInput(sessionMessage, action, `own-up-${action}`), upper), action).resolves.toBeDefined();
    }
  });

  it('refuses a caller with no session id a disposition for a message meant for one session, as it does an intake, but not an ack or an activation', async () => {
    const sb = 'b7b7b7b7-b7b7-4b7b-8b7b-b7b7b7b7b7b7';
    registerAgentSession(project, 'bob', { sessionId: sb, adapterKind: 'claude-channel' });
    const sent = sendAgentMessage(getDatabase(), { project, sender: 'alice', recipient: 'bob', intended_session: sb, idempotency_key: 'strict-kinds', content_type: 'text/plain', payload: 'for SB' });
    const subject: Subject = { name: 'a message meant for SB', recipient: 'bob', kind: 'principal', messageId: sent.message_id };
    for (const action of ['intake', 'disposition']) {
      await expect(call(baseInput(subject, action, `nosession-${action}`)), action).rejects.toThrow(/intended_for_other_session/);
    }
    for (const action of ['ack', 'activation']) {
      await expect(call(baseInput(subject, action, `nosession-${action}`)), action).resolves.toBeDefined();
    }
  });

  it('lets a session poll the inbox of its own session id as well as its principal\'s, and lets an unregistered id poll', async () => {
    const own = registerAgentSession(project, 'bob', { sessionId: 'b8b8b8b8-b8b8-4b8b-8b8b-b8b8b8b8b8b8', adapterKind: 'claude-channel' });
    sendSessionTargetedMessage(project, own, 'poll-own-session');
    subjects('poll-extra');
    const poll = async (recipient: string, session?: string) => (await call({ action: 'poll', project, recipient }, session) as { events: unknown[] }).events.length;
    expect(await poll(own, own), 'its own session inbox').toBe(1);
    expect(await poll(own, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'), 'an id nobody registered').toBe(1);
    expect(await poll('bob', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'), 'an id nobody registered, principal inbox').toBeGreaterThan(0);
  });

  it('answers a refused poll with the same kind of cursor as an inbox that is really empty', async () => {
    setup();
    subjects('cursor-shape');
    const cursorOf = async (recipient: string, session?: string) => ((await call({ action: 'poll', project, recipient }, session)) as { next_cursor: string }).next_cursor;
    const refused = await cursorOf('bob', carolSession);
    const empty = await cursorOf('nobody-ever-sent-here');
    expect(refused).not.toBe('');
    expect(refused.length).toBe(empty.length);
  });

  it('shows a sender the status of a message it sent to a session, and no payload', async () => {
    const reviewer = 'a8a8a8a8-a8a8-4a8a-8a8a-a8a8a8a8a8a8';
    registerAgentSession(project, 'codex-reviewer', { sessionId: reviewer, adapterKind: 'claude-channel' });
    setup();
    const [, sessionMessage] = subjects('sender-session-message');
    const status = await call(baseInput(sessionMessage, 'status', 'x'), reviewer) as Record<string, unknown>;
    expect(status).toMatchObject({ status: 'queued' });
    expect(status).not.toHaveProperty('payload');
    expect(JSON.stringify(status)).not.toContain('review is done');
  });

  it('treats two registrations that differ only in case as two sessions: a message meant for one is not open to the other', async () => {
    registerAgentSession(project, 'bob', { sessionId: 'session-t', adapterKind: 'claude-channel' });
    registerAgentSession(project, 'bob', { sessionId: 'SESSION-T', adapterKind: 'claude-channel' });
    const sent = sendAgentMessage(getDatabase(), { project, sender: 'alice', recipient: 'bob', intended_session: 'session-t', idempotency_key: 'twin-intake', content_type: 'text/plain', payload: 'for session-t' });
    const subject: Subject = { name: 'a message meant for session-t', recipient: 'bob', kind: 'principal', messageId: sent.message_id };
    await expect(call(baseInput(subject, 'intake', 'twin-upper'), 'SESSION-T')).rejects.toThrow(/intended_for_other_session/);
    expect(await call(baseInput(subject, 'intake', 'twin-lower'), 'session-t')).toMatchObject({ receipt_kind: 'intake' });
  });

  it('refuses a session id with a non-ASCII character at send and in the environment', async () => {
    expect(() => sendAgentMessage(getDatabase(), { project, sender: 'alice', recipient: 'bob', intended_session: 'sess\u00c9-1', idempotency_key: 'ascii-1', content_type: 'text/plain', payload: 'x' })).toThrow(/only ASCII/);
    expect(() => sendAgentMessage(getDatabase(), { project, sender: 'alice', recipient: 'sess\u00c9-2', target_kind: 'session', idempotency_key: 'ascii-2', content_type: 'text/plain', payload: 'x' })).toThrow(/only ASCII/);
    expect(hostSessionFromEnv({ CLAUDE_CODE_SESSION_ID: 'sess\u00c9-3' })).toBeUndefined();
    expect(hostSessionFromEnv({ CLAUDE_CODE_SESSION_ID: 'ascii-session-4' })).toBe('ascii-session-4');
  });

  it('answers a send again with the same key as the same message however the meant session is registered by then', async () => {
    const send = () => sendAgentMessage(getDatabase(), { project, sender: 'alice', recipient: 'bob', intended_session: 'UNREG-Session-1', idempotency_key: 'retry-after-register', content_type: 'text/plain', payload: 'x' });
    const first = send();
    registerAgentSession(project, 'bob', { sessionId: 'UNREG-Session-1', adapterKind: 'claude-channel' });
    expect(send().message_id).toBe(first.message_id);
    // A message stored with the id in capitals (as before ids were normalised) is answered the same way.
    const stored = sendAgentMessage(getDatabase(), { project, sender: 'alice', recipient: 'bob', intended_session: 'b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9b9', idempotency_key: 'retry-legacy', content_type: 'text/plain', payload: 'y' });
    getDatabase().prepare('UPDATE agent_message_deliveries SET intended_session = ? WHERE message_id = ?').run('B9B9B9B9-B9B9-4B9B-8B9B-B9B9B9B9B9B9', stored.message_id);
    const again = sendAgentMessage(getDatabase(), { project, sender: 'alice', recipient: 'bob', intended_session: 'b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9b9', idempotency_key: 'retry-legacy', content_type: 'text/plain', payload: 'y' });
    expect(again.message_id).toBe(stored.message_id);
  });

  it('finds a /clear alias however the unregistered id is written, in both directions', async () => {
    const old = 'dadadada-dada-4ada-8ada-dadadadadada'; const fresh = 'dbdbdbdb-dbdb-4bdb-8bdb-dbdbdbdbdbdb';
    // Only the new id is registered (under carol); the old one is known only through the alias.
    registerAgentSession(project, 'carol', { sessionId: fresh, adapterKind: 'claude-channel' });
    registerAgentSession(project, 'bob', { sessionId: bobSession, adapterKind: 'claude-channel' });
    getDatabase().prepare('INSERT INTO agent_session_aliases (session_id, previous_session_id, created_at_ms) VALUES (?, ?, ?)').run(fresh, old, Date.now());
    const [principalMessage] = subjects('alias-case');
    for (const caller of [old, old.toUpperCase(), fresh.toUpperCase()]) {
      await expect(call(baseInput(principalMessage, 'status', 'x'), caller), caller).rejects.toThrow(missing(principalMessage));
    }
    // Only the old id is registered (under carol); the new id, written in capitals, is known through the alias.
    const old2 = 'dcdcdcdc-dcdc-4cdc-8cdc-dcdcdcdcdcdc'; const fresh2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddd01';
    registerAgentSession(project, 'carol', { sessionId: old2, adapterKind: 'claude-channel' });
    getDatabase().prepare('INSERT INTO agent_session_aliases (session_id, previous_session_id, created_at_ms) VALUES (?, ?, ?)').run(fresh2, old2, Date.now());
    await expect(call(baseInput(principalMessage, 'status', 'x'), fresh2.toUpperCase())).rejects.toThrow(missing(principalMessage));
  });

  it('records which session made each receipt, or that there was none, and returns it with the receipts', async () => {
    setup();
    const [principalMessage] = subjects('actor');
    await call(baseInput(principalMessage, 'ack', 'actor-1'), bobSession);
    await call(baseInput(principalMessage, 'disposition', 'actor-2'));
    const rows = await call(baseInput(principalMessage, 'receipts', 'x')) as Array<{ receipt_kind: string; detail?: { caller_session?: string | null } }>;
    expect(rows.find((row) => row.receipt_kind === 'ack')?.detail?.caller_session).toBe(bobSession);
    expect(rows.find((row) => row.receipt_kind === 'disposition')?.detail?.caller_session).toBeNull();
  });
});
