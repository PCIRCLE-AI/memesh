/**
 * G-dead: a sender reads `receipts` and, on the host_accept fact, sees whether
 * the session the message was accepted for is still live and whether intake was
 * recorded. Observed at read time from existing tables; nothing is stored.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getDatabase } from '../../src/db.js';
import { recordAgentReceipt, sendAgentMessage } from '../../src/core/agent-messaging.js';
import { executeAgentMessageAction } from '../../src/transports/agent-messaging.js';
import { useTestDatabase } from '../helpers/db-fixture.js';
import { sendIntendedPrincipalMessage, sendSessionTargetedMessage } from '../helpers/agent-session-fixture.js';

const PROJECT = 'dead-proj';
const PRINCIPAL = 'dead-principal';
const context = { transport: 'mcp' as const, sourceHost: 'sender-host' };

function register(sessionId: string) {
  const db = getDatabase();
  db.prepare(`INSERT OR IGNORE INTO agent_principals (project, principal_id, activation_event_sequence) VALUES (?, ?, 0)`)
    .run(PROJECT, PRINCIPAL);
  db.prepare(`INSERT INTO agent_session_instances (project, session_instance_id, principal_id, adapter_kind) VALUES (?, ?, ?, 'codex-cli-queue')`)
    .run(PROJECT, sessionId, PRINCIPAL);
  const connectionId = `connection-${randomUUID()}`;
  db.prepare(`
    INSERT INTO agent_session_connections (
      connection_id, project, principal_id, session_instance_id, generation,
      adapter_kind, router_instance_id, lease_expires_at_ms
    ) VALUES (?, ?, ?, ?, 1, 'codex-cli-queue', 'test-router', ?)
  `).run(connectionId, PROJECT, PRINCIPAL, sessionId, Date.now() + 60_000);
  return connectionId;
}

function accept(deliveryId: string, sessionId: string, connectionId: string) {
  const db = getDatabase();
  const attemptId = `attempt-${randomUUID()}`;
  db.prepare(`
    INSERT INTO agent_dispatch_attempts (
      attempt_id, delivery_id, project, principal_id, session_instance_id,
      connection_id, generation, router_instance_id, attempt_number, result, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 'test-router', 1, 'adapter_returned', CURRENT_TIMESTAMP)
  `).run(attemptId, deliveryId, PROJECT, PRINCIPAL, sessionId, connectionId);
  db.prepare(`INSERT INTO agent_host_accepts (host_accept_id, attempt_id, delivery_id, adapter_kind, receipt_json) VALUES (?, ?, ?, 'test-adapter', ?)`)
    .run(`host-accept-${randomUUID()}`, attemptId, deliveryId, JSON.stringify({ host: 'test', status: 'queued', thread_id: sessionId }));
}

async function hostAcceptFact(recipient: string, messageId: string) {
  const facts = await executeAgentMessageAction(getDatabase(), {
    action: 'receipts', project: PROJECT, recipient, message_id: messageId,
  }, context) as Array<Record<string, unknown>>;
  const fact = facts.find((f) => f.receipt_kind === 'host_accept');
  if (!fact) throw new Error('no host_accept fact');
  return fact;
}

const disconnect = (connectionId: string) => getDatabase()
  .prepare('UPDATE agent_session_connections SET disconnected_at = CURRENT_TIMESTAMP WHERE connection_id = ?').run(connectionId);
const expireLease = (connectionId: string) => getDatabase()
  .prepare('UPDATE agent_session_connections SET lease_expires_at_ms = ? WHERE connection_id = ?').run(Date.now() - 1, connectionId);

describe('G-dead: receipts show whether the accepted session is still live, observed at read time', () => {
  useTestDatabase('memesh-delivery-state-');

  it('session target: live and pending, then not_live once disconnected, then recorded after intake', async () => {
    const s1 = 'session-s1';
    const connection = register(s1);
    const sent = sendSessionTargetedMessage(PROJECT, s1, 'dead-1');
    accept(sent.delivery_id, s1, connection);

    const live = await hostAcceptFact(s1, sent.message_id);
    expect(live.delivery_state).toEqual({
      observed_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), intake: 'pending', target_session: 'live', session: s1,
    });
    expect(live.receipt).toEqual({ host: 'test', status: 'queued', thread_id: s1 });

    disconnect(connection);
    expect((await hostAcceptFact(s1, sent.message_id)).delivery_state)
      .toMatchObject({ intake: 'pending', target_session: 'not_live', session: s1 });

    recordAgentReceipt(getDatabase(), {
      project: PROJECT, recipient: s1, message_id: sent.message_id,
      receipt_kind: 'intake', intake_state: 'ingested', actor: s1, idempotency_key: 'intake-dead-1',
    });
    expect((await hostAcceptFact(s1, sent.message_id)).delivery_state)
      .toMatchObject({ intake: 'recorded', target_session: 'not_live' });
  });

  it('reads an expired lease as not_live', async () => {
    const s1 = 'session-lease';
    const connection = register(s1);
    const sent = sendSessionTargetedMessage(PROJECT, s1, 'dead-lease');
    accept(sent.delivery_id, s1, connection);
    expireLease(connection);
    expect((await hostAcceptFact(s1, sent.message_id)).delivery_state)
      .toMatchObject({ target_session: 'not_live', intake: 'pending' });
  });

  it('intended_session: live, then not_live; an unregistered intended session is unknown, never guessed dead', async () => {
    const s1 = 'session-intended';
    const connection = register(s1);
    const sent = sendIntendedPrincipalMessage(PROJECT, PRINCIPAL, s1, 'dead-intended');
    accept(sent.delivery_id, s1, connection);
    expect((await hostAcceptFact(PRINCIPAL, sent.message_id)).delivery_state)
      .toMatchObject({ target_session: 'live', session: s1 });
    disconnect(connection);
    expect((await hostAcceptFact(PRINCIPAL, sent.message_id)).delivery_state)
      .toMatchObject({ target_session: 'not_live', session: s1 });

    const other = register('session-accepting');
    const ghost = sendIntendedPrincipalMessage(PROJECT, PRINCIPAL, 'session-nobody-registered', 'dead-ghost');
    accept(ghost.delivery_id, 'session-accepting', other);
    expect((await hostAcceptFact(PRINCIPAL, ghost.message_id)).delivery_state)
      .toMatchObject({ target_session: 'unknown', session: 'session-nobody-registered' });
  });

  it('follows the session alias chain: an old id whose successor is live reads live', async () => {
    const oldId = 'session-before-clear';
    const oldConnection = register(oldId);
    const sent = sendSessionTargetedMessage(PROJECT, oldId, 'dead-alias');
    accept(sent.delivery_id, oldId, oldConnection);
    disconnect(oldConnection);
    register('session-after-clear');
    getDatabase().prepare('INSERT INTO agent_session_aliases (session_id, previous_session_id, created_at_ms) VALUES (?, ?, ?)')
      .run('session-after-clear', oldId, Date.now());
    expect((await hostAcceptFact(oldId, sent.message_id)).delivery_state)
      .toMatchObject({ target_session: 'live', session: oldId });
  });

  it('a principal message with no session restriction is not_applicable', async () => {
    const s1 = 'session-any';
    const connection = register(s1);
    const sent = sendAgentMessage(getDatabase(), {
      project: PROJECT, sender: 'lead', recipient: PRINCIPAL, target_kind: 'principal',
      idempotency_key: 'dead-plain', content_type: 'text/plain', payload: 'hello',
    });
    accept(sent.delivery_id, s1, connection);
    expect((await hostAcceptFact(PRINCIPAL, sent.message_id)).delivery_state)
      .toEqual({ observed_at: expect.any(String), intake: 'pending', target_session: 'not_applicable' });
  });

  it('still refuses another recipient\'s receipts', async () => {
    const s1 = 'session-scoped';
    const connection = register(s1);
    const sent = sendSessionTargetedMessage(PROJECT, s1, 'dead-scoped');
    accept(sent.delivery_id, s1, connection);
    await expect(executeAgentMessageAction(getDatabase(), {
      action: 'receipts', project: PROJECT, recipient: 'someone-else', message_id: sent.message_id,
    }, context)).rejects.toThrow(/not available to recipient someone-else/);
  });
});
