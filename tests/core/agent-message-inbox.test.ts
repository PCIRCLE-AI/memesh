/**
 * #490: the waiting-message lookup used by stop-message-gate,
 * user-prompt-intent and session-start (all three, through
 * `waitingMessageRefs`/`waitingMessageLines` in scripts/hooks/_shared.js)
 * resolves exactly one recipient — the principal. A `target_kind: "session"`
 * delivery is addressed to the HOST's own `session_instance_id`, a different
 * string, so it was never found. This exercises the widened query directly
 * against `src/core/agent-message-inbox.ts` (no hook process, no generated
 * mirror needed) — see tests/hooks/message-recipient-reminder.test.ts and
 * tests/hooks/stop-message-gate.test.ts for the end-to-end hook-level proof.
 */
import { describe, it, expect } from 'vitest';
import { getDatabase } from '../../src/db.js';
import { sendAgentMessage, recordAgentReceipt } from '../../src/core/agent-messaging.js';
import { unreadMessageRefsFor, unreadInboxLinesFor } from '../../src/core/agent-message-inbox.js';
import { useTestDatabase } from '../helpers/db-fixture.js';
import { registerAgentSession, sendSessionTargetedMessage } from '../helpers/agent-session-fixture.js';

describe('Feature: #490 a session-targeted delivery is found under its principal, only while live', () => {
  useTestDatabase('memesh-inbox-session-target-');

  it('matches a session-targeted delivery whose session is live under the resolved principal', () => {
    const sessionId = registerAgentSession('proj-a', 'claude-principal');
    const sent = sendSessionTargetedMessage('proj-a', sessionId, 'k1');

    const refs = unreadMessageRefsFor(getDatabase(), 'claude-principal');
    expect(refs).toEqual([{ project: 'proj-a', message_id: sent.message_id }]);

    const lines = unreadInboxLinesFor(getDatabase(), 'claude-principal');
    // Exactly one reminder line — the size pin that makes the `toEqual([])`
    // cases below mean "nothing matched" rather than "nothing can match".
    expect(lines).toHaveLength(1);
    expect(lines.join('\n')).toContain(JSON.stringify(sessionId));
    expect(lines.join('\n')).toContain('target_kind');
    expect(lines.join('\n')).toContain('"session"');
  });

  it('does NOT match once that session has disconnected — no nagging about a dead session', () => {
    const sessionId = registerAgentSession('proj-a', 'claude-principal', { disconnected: true });
    sendSessionTargetedMessage('proj-a', sessionId, 'k2');

    expect(unreadMessageRefsFor(getDatabase(), 'claude-principal')).toEqual([]);
    expect(unreadInboxLinesFor(getDatabase(), 'claude-principal')).toEqual([]);
  });

  it('does NOT match once that session\'s lease has expired', () => {
    const sessionId = registerAgentSession('proj-a', 'claude-principal', { leaseExpiresAtMs: Date.now() - 1000 });
    sendSessionTargetedMessage('proj-a', sessionId, 'k3');

    expect(unreadMessageRefsFor(getDatabase(), 'claude-principal')).toEqual([]);
    expect(unreadInboxLinesFor(getDatabase(), 'claude-principal')).toEqual([]);
  });

  it('does NOT match a live session registered under a DIFFERENT principal', () => {
    const sessionId = registerAgentSession('proj-a', 'someone-elses-principal');
    sendSessionTargetedMessage('proj-a', sessionId, 'k4');

    expect(unreadMessageRefsFor(getDatabase(), 'claude-principal')).toEqual([]);
    expect(unreadInboxLinesFor(getDatabase(), 'claude-principal')).toEqual([]);
  });

  it('still matches an ordinary principal-target delivery exactly as before (no regression)', () => {
    const sent = sendAgentMessage(getDatabase(), {
      project: 'proj-a',
      sender: 'codex-reviewer',
      recipient: 'claude-principal',
      idempotency_key: 'k5',
      payload: { text: 'review is done' },
      content_type: 'application/json',
    });

    expect(unreadMessageRefsFor(getDatabase(), 'claude-principal')).toEqual([
      { project: 'proj-a', message_id: sent.message_id },
    ]);
    const lines = unreadInboxLinesFor(getDatabase(), 'claude-principal');
    expect(lines.join('\n')).toContain('1 message waiting for "claude-principal"');
    expect(lines.join('\n')).not.toContain('target_kind');
  });

  it('stops matching once intake is recorded for the session-targeted delivery, keyed by the session id', () => {
    const sessionId = registerAgentSession('proj-a', 'claude-principal');
    const sent = sendSessionTargetedMessage('proj-a', sessionId, 'k6');

    recordAgentReceipt(getDatabase(), {
      project: 'proj-a',
      recipient: sessionId,
      message_id: sent.message_id,
      actor: sessionId,
      idempotency_key: `intake-${sent.message_id}`,
      receipt_kind: 'intake',
      intake_state: 'ingested',
    });

    expect(unreadMessageRefsFor(getDatabase(), 'claude-principal')).toEqual([]);
  });

  // Only a missing deliveries table means "never messaged". Deliveries without
  // the session tables the #490 match joins is a half-migrated database, and
  // it is raised so the hook records an error rather than "nothing waiting".
  it('raises, rather than reports an empty inbox, when the session tables are missing', () => {
    sendAgentMessage(getDatabase(), {
      project: 'proj-a',
      sender: 'codex-reviewer',
      recipient: 'claude-principal',
      idempotency_key: 'k7',
      payload: { text: 'review is done' },
      content_type: 'application/json',
    });
    getDatabase().exec('DROP TABLE agent_session_connections; DROP TABLE agent_session_instances;');

    expect(() => unreadMessageRefsFor(getDatabase(), 'claude-principal')).toThrow(/no such table: agent_session_instances/);
    expect(() => unreadInboxLinesFor(getDatabase(), 'claude-principal')).toThrow(/no such table: agent_session_instances/);
  });
});
