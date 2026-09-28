import { randomUUID } from 'crypto';
import { getDatabase } from '../../src/db.js';
import { sendAgentMessage } from '../../src/core/agent-messaging.js';

/**
 * Registers a session instance and its connection row — the same shape
 * agent-router.ts writes — so a `target_kind: "session"` delivery can be
 * matched against real "is this session live" state (#490). Live by default;
 * `disconnected` or a past `leaseExpiresAtMs` makes it dead.
 */
export function registerAgentSession(
  project: string,
  principalId: string,
  overrides: { disconnected?: boolean; leaseExpiresAtMs?: number } = {},
): string {
  const sessionId = `session-${randomUUID()}`;
  const db = getDatabase();
  db.prepare(`
    INSERT OR IGNORE INTO agent_principals (project, principal_id, activation_event_sequence)
    VALUES (?, ?, 0)
  `).run(project, principalId);
  db.prepare(`
    INSERT INTO agent_session_instances (project, session_instance_id, principal_id, adapter_kind)
    VALUES (?, ?, ?, 'test-adapter')
  `).run(project, sessionId, principalId);
  db.prepare(`
    INSERT INTO agent_session_connections (
      connection_id, project, principal_id, session_instance_id, generation,
      adapter_kind, router_instance_id, lease_expires_at_ms, disconnected_at
    ) VALUES (?, ?, ?, ?, 1, 'test-adapter', 'test-router', ?, ?)
  `).run(
    `connection-${randomUUID()}`, project, principalId, sessionId,
    overrides.leaseExpiresAtMs ?? Date.now() + 60_000,
    overrides.disconnected ? new Date().toISOString() : null,
  );
  return sessionId;
}

/** Sends a `target_kind: "session"` delivery addressed to `sessionId`. */
export function sendSessionTargetedMessage(project: string, sessionId: string, idempotencyKey: string) {
  return sendAgentMessage(getDatabase(), {
    project,
    sender: 'codex-reviewer',
    recipient: sessionId,
    target_kind: 'session',
    idempotency_key: idempotencyKey,
    payload: { text: 'review is done' },
    content_type: 'application/json',
  });
}
