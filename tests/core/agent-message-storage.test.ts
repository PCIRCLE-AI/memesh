import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentMessageStorageQuotaExceededError,
  enforceAgentMessageStorageQuota,
  getAgentMessageStorageReport,
} from '../../src/core/agent-message-storage.js';
import {
  recordAgentAckFact,
  fetchAgentMessage,
  recordAgentReceipt,
  recordAgentWorkflowFact,
  sendAgentMessage,
  type SentAgentMessage,
} from '../../src/core/agent-messaging.js';
import { getDatabase } from '../../src/db.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

const dbHandle = useTestDatabase('memesh-agent-message-storage-');
const OLD = '2020-01-01 00:00:00';

afterEach(() => {
  expect(dbHandle.dbPath.endsWith('test.db')).toBe(true);
});

function send(payload: unknown = { body: 'payload' }): SentAgentMessage {
  return sendAgentMessage(getDatabase(), {
    project: 'storage-project',
    sender: 'sender',
    recipient: 'recipient',
    idempotency_key: `send-${Math.random().toString(36).slice(2)}`,
    content_type: 'application/json',
    payload: payload as { [key: string]: string },
  });
}

type DeliveryRef = Pick<SentAgentMessage, 'delivery_id' | 'message_id' | 'project' | 'recipient'>;

function additionalDelivery(message: SentAgentMessage, recipient: string): DeliveryRef {
  const deliveryId = randomUUID();
  getDatabase().transaction(() => {
    getDatabase().prepare(`
      INSERT INTO agent_message_deliveries (delivery_id, message_id, project, recipient, target_kind)
      VALUES (?, ?, ?, ?, 'principal')
    `).run(deliveryId, message.message_id, message.project, recipient);
    getDatabase().prepare(`
      INSERT INTO agent_message_events (event_id, message_id, delivery_id, project, recipient, event_kind)
      VALUES (?, ?, ?, ?, ?, 'available')
    `).run(randomUUID(), message.message_id, deliveryId, message.project, recipient);
  }).immediate();
  return { delivery_id: deliveryId, message_id: message.message_id, project: message.project, recipient };
}

function hostAccept(delivery: DeliveryRef): string {
  const suffix = randomUUID();
  const sessionId = `session-${suffix}`;
  const connectionId = `connection-${suffix}`;
  const attemptId = `attempt-${suffix}`;
  const hostAcceptId = `host-accept-${suffix}`;
  getDatabase().transaction(() => {
    getDatabase().prepare(`
      INSERT OR IGNORE INTO agent_principals (project, principal_id, activation_event_sequence)
      VALUES (?, ?, 0)
    `).run(delivery.project, delivery.recipient);
    getDatabase().prepare(`
      INSERT INTO agent_session_instances (project, session_instance_id, principal_id, adapter_kind)
      VALUES (?, ?, ?, 'test-adapter')
    `).run(delivery.project, sessionId, delivery.recipient);
    getDatabase().prepare(`
      INSERT INTO agent_session_connections (
        connection_id, project, principal_id, session_instance_id, generation,
        adapter_kind, router_instance_id, lease_expires_at_ms
      ) VALUES (?, ?, ?, ?, 1, 'test-adapter', 'test-router', ?)
    `).run(connectionId, delivery.project, delivery.recipient, sessionId, Date.now() + 60_000);
    getDatabase().prepare(`
      INSERT INTO agent_dispatch_attempts (
        attempt_id, delivery_id, project, principal_id, session_instance_id,
        connection_id, generation, router_instance_id, attempt_number, result, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 'test-router', 1, 'adapter_returned', CURRENT_TIMESTAMP)
    `).run(
      attemptId,
      delivery.delivery_id,
      delivery.project,
      delivery.recipient,
      sessionId,
      connectionId,
    );
    getDatabase().prepare(`
      INSERT INTO agent_host_accepts (host_accept_id, attempt_id, delivery_id, adapter_kind, receipt_json)
      VALUES (?, ?, ?, 'test-adapter', '{"accepted":true}')
    `).run(hostAcceptId, attemptId, delivery.delivery_id);
  }).immediate();
  return hostAcceptId;
}

function ack(delivery: DeliveryRef, idempotencyKey = `ack-${delivery.delivery_id}`): void {
  recordAgentAckFact(getDatabase(), {
    delivery_id: delivery.delivery_id,
    host_accept_id: hostAccept(delivery),
    actor: delivery.recipient,
    idempotency_key: idempotencyKey,
  });
}

function workflow(message: DeliveryRef, workflowState: string, createdAt = OLD): void {
  recordAgentWorkflowFact(getDatabase(), {
    delivery_id: message.delivery_id,
    actor: message.recipient,
    workflow_state: workflowState,
    idempotency_key: `workflow-${message.message_id}-${workflowState}`,
  });
  getDatabase().prepare(`
    UPDATE agent_workflow_facts SET created_at = ? WHERE delivery_id = ?
  `).run(createdAt, message.delivery_id);
}

function storedPayload(messageId: string): string {
  return (getDatabase().prepare(`
    SELECT payload_json FROM agent_messages WHERE message_id = ?
  `).get(messageId) as { payload_json: string }).payload_json;
}

function count(table: string): number {
  return (getDatabase().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function ageMessage(messageId: string): void {
  getDatabase().prepare("UPDATE agent_messages SET created_at = datetime('now', '-2 days') WHERE message_id = ?").run(messageId);
  getDatabase().prepare("UPDATE agent_message_deliveries SET created_at = datetime('now', '-2 days') WHERE message_id = ?").run(messageId);
}

describe('agent message storage report', () => {
  it('reconciles mixed lifecycle states without changing stored messages, receipts, or acknowledgements', () => {
    const terminal = send({ body: 'terminal' });
    const deferred = send({ body: 'offline-pending' });
    const ackOnly = send({ body: 'ack-only' });
    const expired = send({ body: 'past-its-day' });
    ack(terminal);
    workflow(terminal, 'completed');
    workflow(deferred, 'deferred');
    ack(ackOnly, 'ack-only');
    ageMessage(expired.message_id);

    const before = getDatabase().prepare(`
      SELECT message_id, payload_json, payload_tombstoned_at FROM agent_messages ORDER BY message_id
    `).all();
    const receiptsBefore = count('agent_message_receipts');
    const report = getAgentMessageStorageReport(getDatabase(), { databasePath: dbHandle.dbPath });

    expect(report).toMatchObject({
      message_count: 4,
      protected_unresolved_message_count: 2,
      terminal_retained_message_count: 1,
      expired_pending_message_count: 1,
      reconciled_message_count: 4,
      receipt_count: 0,
      ack_fact_count: 2,
      cursor_count: 0,
      principal_count: 1,
      session_instance_count: 2,
      session_connection_count: 2,
      presence_fact_count: 0,
      dispatch_attempt_count: 2,
      host_accept_count: 2,
    });
    expect(report.payload_bytes).toBeGreaterThan(0);
    expect(report.page_count).toBeGreaterThan(0);
    expect(report.page_size).toBeGreaterThan(0);
    expect(report.database_file_bytes).not.toBeNull();
    expect(getDatabase().prepare(`
      SELECT message_id, payload_json, payload_tombstoned_at FROM agent_messages ORDER BY message_id
    `).all()).toEqual(before);
    expect(count('agent_message_receipts')).toBe(receiptsBefore);
  });

  it('does not count a message past its day as unresolved, whatever its state', () => {
    const unresolved = send({ body: 'never answered' });
    expect(getAgentMessageStorageReport(getDatabase(), {})).toMatchObject({
      protected_unresolved_message_count: 1, expired_pending_message_count: 0,
    });
    ageMessage(unresolved.message_id);
    expect(getAgentMessageStorageReport(getDatabase(), {})).toMatchObject({
      protected_unresolved_message_count: 0, expired_pending_message_count: 1,
    });
  });

  it('retains ACK-without-terminal as unresolved; a terminal disposition on every delivery is terminal, with or without an ACK', () => {
    const completedWithoutAck = send({ body: 'completed-without-ack' });
    workflow(completedWithoutAck, 'completed');
    const ackWithoutTerminal = send({ body: 'ack-without-terminal' });
    ack(ackWithoutTerminal);
    const allDeliveriesReady = send({ body: 'all-deliveries-ready' });
    const secondDelivery = additionalDelivery(allDeliveriesReady, 'recipient-two');
    ack(allDeliveriesReady);
    workflow(allDeliveriesReady, 'completed');
    ack(secondDelivery);
    workflow(secondDelivery, 'completed');

    expect(getAgentMessageStorageReport(getDatabase(), {})).toMatchObject({
      message_count: 3,
      protected_unresolved_message_count: 1,
      terminal_retained_message_count: 2,
    });
  });

  it('tells a recipient who fetches a message whose content an earlier version removed so in words, and keeps the machine-readable marker', () => {
    const message = send({ body: 'will be removed' });
    // Earlier versions replaced the content of finished messages with a marker; this version deletes whole messages
    // after a day, but a database written by an earlier version can still hold such a row.
    const marker = JSON.stringify({ _agent_message_tombstone_v1: { algorithm: 'sha256', original_payload_bytes: 31, payload_sha256: 'a'.repeat(64) } });
    getDatabase().prepare('UPDATE agent_messages SET payload_json = ?, payload_tombstoned_at = CURRENT_TIMESTAMP WHERE message_id = ?').run(marker, message.message_id);
    const fetched = fetchAgentMessage(getDatabase(), { project: message.project, recipient: message.recipient, message_id: message.message_id });
    expect(fetched.note).toMatch(/past its retention period.*content was deleted/i);
    expect(JSON.stringify(fetched.payload)).toContain('_agent_message_tombstone_v1');
    const kept = send({ body: 'still here' });
    expect(fetchAgentMessage(getDatabase(), { project: kept.project, recipient: kept.recipient, message_id: kept.message_id })).not.toHaveProperty('note');
  });

  it('treats explicit inbox ACK and disposition receipts as one terminal delivery without requiring host push', () => {
    const inboxOnly = send({ body: 'fetched through MCP without host adapter' });
    for (const [kind, extra] of [['ack', {}], ['disposition', { disposition: 'completed' as const }]] as const) {
      recordAgentReceipt(getDatabase(), {
        project: inboxOnly.project, recipient: inboxOnly.recipient, message_id: inboxOnly.message_id,
        receipt_kind: kind, actor: inboxOnly.recipient, idempotency_key: `inbox-only-${kind}`, ...extra,
      } as Parameters<typeof recordAgentReceipt>[1]);
    }
    expect(getAgentMessageStorageReport(getDatabase(), {})).toMatchObject({
      protected_unresolved_message_count: 0,
      terminal_retained_message_count: 1,
      receipt_count: 2,
      ack_fact_count: 0,
      workflow_fact_count: 0,
    });
  });

  it('keeps a delivery unresolved when same-timestamp workflow sources disagree about terminal state', () => {
    const conflicted = send({ body: 'ambiguous latest timestamp' });
    ack(conflicted);
    workflow(conflicted, 'completed', OLD);
    recordAgentReceipt(getDatabase(), {
      project: conflicted.project, recipient: conflicted.recipient, message_id: conflicted.message_id,
      receipt_kind: 'disposition', disposition: 'deferred', actor: conflicted.recipient,
      idempotency_key: 'same-timestamp-deferred',
    });
    getDatabase().prepare('UPDATE agent_message_receipts SET created_at = ? WHERE message_id = ?')
      .run(OLD, conflicted.message_id);
    expect(getAgentMessageStorageReport(getDatabase(), {})).toMatchObject({
      protected_unresolved_message_count: 1, terminal_retained_message_count: 0,
    });
  });

  it('rejects an over-quota send budget atomically before later message effects', () => {
    const existing = send({ body: 'existing' });
    const used = getAgentMessageStorageReport(getDatabase(), {}).payload_bytes;
    const before = {
      messages: count('agent_messages'), deliveries: count('agent_message_deliveries'),
      events: count('agent_message_events'), idempotency: count('agent_message_idempotency'),
    };

    expect(() => getDatabase().transaction(() => {
      enforceAgentMessageStorageQuota(getDatabase(), { quotaBytes: used, additionalPayloadBytes: 1 });
      getDatabase().prepare(`INSERT INTO agent_messages (
        message_id, project, sender, recipient, content_type, privacy, payload_json, provenance_json
      ) VALUES ('must-not-exist', 'storage-project', 'sender', 'recipient', 'application/json', 'private', '{}', '{}')`).run();
    }).immediate()).toThrow(AgentMessageStorageQuotaExceededError);

    expect(count('agent_messages')).toBe(before.messages);
    expect(count('agent_message_deliveries')).toBe(before.deliveries);
    expect(count('agent_message_events')).toBe(before.events);
    expect(count('agent_message_idempotency')).toBe(before.idempotency);
    expect(storedPayload(existing.message_id)).toContain('existing');
    expect(() => enforceAgentMessageStorageQuota(getDatabase(), {
      quotaBytes: used + 1, additionalPayloadBytes: 1,
    })).not.toThrow();

    expect(() => sendAgentMessage(getDatabase(), {
      project: 'storage-project', sender: 'sender', recipient: 'recipient',
      idempotency_key: 'canonical-over-quota', content_type: 'application/json', payload: { body: 'blocked' },
    }, { storage_quota_bytes: used })).toThrow(AgentMessageStorageQuotaExceededError);
    expect(count('agent_messages')).toBe(before.messages);
    expect(count('agent_message_deliveries')).toBe(before.deliveries);
    expect(count('agent_message_events')).toBe(before.events);
    expect(count('agent_message_idempotency')).toBe(before.idempotency);
  });
});
