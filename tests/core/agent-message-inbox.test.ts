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
import { unreadMessageRefsFor, unreadInboxLines, unreadInboxLinesFor } from '../../src/core/agent-message-inbox.js';
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

/**
 * #514 (configured principal across threads): under Codex a host-accepted
 * delivery is quiet only in the thread it was queued into. The same
 * principal's NEXT thread, which never got that copy, is still reminded.
 */
describe('Feature: #514 a Codex host acceptance silences only the thread it was queued into', () => {
  useTestDatabase('memesh-inbox-codex-thread-');
  const T1 = '01a10000-0000-7000-8000-000000000001';
  const T2 = '01a10000-0000-7000-8000-000000000002';

  function send(key: string, extra: { intended_session?: string } = {}) {
    return sendAgentMessage(getDatabase(), {
      project: 'proj-a', sender: 'lead', recipient: 'p2-principal', target_kind: 'principal',
      idempotency_key: key, content_type: 'text/plain', payload: 'hello', ...extra,
    });
  }

  let generation = 0;
  // The accepting Codex companion is still running (a live lease): an
  // acceptance by a process that has since ended does not silence a reminder
  // (#514, tests/hooks/message-recipient-reminder.test.ts).
  function accept(deliveryId: string, receipt: Record<string, unknown>) {
    const db = getDatabase();
    generation += 1;
    const suffix = `${deliveryId}-${Object.keys(receipt).length}`;
    db.prepare(`INSERT OR IGNORE INTO agent_principals (project, principal_id, activation_event_sequence) VALUES ('proj-a', 'p2-principal', 0)`).run();
    db.prepare(`INSERT OR IGNORE INTO agent_session_instances (project, session_instance_id, principal_id, adapter_kind) VALUES ('proj-a', ?, 'p2-principal', 'codex-cli-queue')`).run(T1);
    db.prepare(`INSERT INTO agent_session_connections (connection_id, project, principal_id, session_instance_id, generation, adapter_kind, router_instance_id, lease_expires_at_ms)
      VALUES (?, 'proj-a', 'p2-principal', ?, ?, 'codex-cli-queue', 'test-router', ?)`).run(`c-${suffix}`, T1, generation, Date.now() + 60_000);
    db.prepare(`INSERT INTO agent_dispatch_attempts (attempt_id, delivery_id, project, principal_id, session_instance_id, connection_id, generation, router_instance_id, attempt_number, result, completed_at)
      VALUES (?, ?, 'proj-a', 'p2-principal', ?, ?, ?, 'test-router', 1, 'adapter_returned', CURRENT_TIMESTAMP)`).run(`a-${suffix}`, deliveryId, T1, `c-${suffix}`, generation);
    db.prepare(`INSERT INTO agent_host_accepts (host_accept_id, attempt_id, delivery_id, adapter_kind, receipt_json) VALUES (?, ?, ?, 'codex-cli-queue', ?)`)
      .run(`h-${suffix}`, `a-${suffix}`, deliveryId, JSON.stringify(receipt));
  }

  const refs = (session: string | undefined, codex = true, recipient = 'p2-principal') =>
    unreadMessageRefsFor(getDatabase(), recipient, session, undefined, codex).map((r) => r.message_id);

  it('stays quiet in the thread the copy was queued into', () => {
    const sent = send('same-thread');
    accept(sent.delivery_id, { host: 'codex-cli', status: 'queued', thread_id: T1 });
    expect(refs(T1)).toEqual([]);
    expect(unreadInboxLinesFor(getDatabase(), 'p2-principal', T1, true)).toEqual([]);
  });

  it('#514 reminds again once the process that accepted it has ended, in the same thread and with no session', () => {
    const sent = send('ended-accepter');
    accept(sent.delivery_id, { host: 'codex-cli', status: 'queued', thread_id: T1 });
    expect(refs(T1)).toEqual([]);
    getDatabase().prepare("UPDATE agent_session_connections SET disconnected_at = CURRENT_TIMESTAMP WHERE connection_id LIKE ?").run(`c-${sent.delivery_id}%`);
    expect(refs(T1)).toEqual([sent.message_id]);
    expect(refs(undefined)).toEqual([sent.message_id]);
  });

  it('a notice-only acceptance does not silence the reminder, even while its accepter is live', () => {
    const sent = send('notice-live');
    accept(sent.delivery_id, { host: 'codex-cli', status: 'queued', thread_id: T1, content: 'notice' });
    expect(refs(T1)).toEqual([sent.message_id]);
  });

  it('reminds the same principal in a different thread, which never got that copy', () => {
    const sent = send('other-thread');
    accept(sent.delivery_id, { host: 'codex-cli', status: 'queued', thread_id: T1 });
    expect(refs(T2)).toEqual([sent.message_id]);
    expect(unreadInboxLinesFor(getDatabase(), 'p2-principal', T2, true)).toHaveLength(1);
  });

  it('never shows it to a foreign principal', () => {
    const sent = send('foreign');
    accept(sent.delivery_id, { host: 'codex-cli', status: 'queued', thread_id: T1 });
    expect(refs(T2, true, 'someone-else')).toEqual([]);
  });

  it('keeps a message meant for T1 out of T2 (intended_session unchanged)', () => {
    const sent = send('intended', { intended_session: T1 });
    accept(sent.delivery_id, { host: 'codex-cli', status: 'queued', thread_id: T1 });
    expect(refs(T2)).toEqual([]);
  });

  it('goes quiet everywhere once the recipient records intake', () => {
    const sent = send('intaken');
    accept(sent.delivery_id, { host: 'codex-cli', status: 'queued', thread_id: T1 });
    recordAgentReceipt(getDatabase(), {
      project: 'proj-a', recipient: 'p2-principal', message_id: sent.message_id,
      receipt_kind: 'intake', intake_state: 'ingested', actor: 'p2-principal', idempotency_key: 'intake-1',
    });
    expect(refs(T2)).toEqual([]);
    expect(refs(T1)).toEqual([]);
  });

  it('treats an acceptance that names no thread, or an unknown session, as this thread (quiet, as before)', () => {
    const legacy = send('legacy');
    accept(legacy.delivery_id, { channel: 'test' });
    expect(refs(T2)).toEqual([]);
    const known = send('no-session');
    accept(known.delivery_id, { host: 'codex-cli', status: 'queued', thread_id: T1 });
    expect(refs(undefined)).toEqual([]);
  });

  describe('a notice-only acceptance (the Codex queue carries no body) keeps reminding until intake', () => {
    const notice = { host: 'codex-cli', status: 'queued', thread_id: T1, content: 'notice' };

    it('reminds in the thread it was queued into, another thread, and an unknown session', () => {
      const sent = send('notice-everywhere');
      accept(sent.delivery_id, notice);
      expect(refs(T1)).toEqual([sent.message_id]);
      expect(refs(T2)).toEqual([sent.message_id]);
      expect(refs(undefined)).toEqual([sent.message_id]);
      expect(unreadInboxLinesFor(getDatabase(), 'p2-principal', T1, true)).toHaveLength(1);
      expect(unreadInboxLinesFor(getDatabase(), 'p2-principal', undefined, true)).toHaveLength(1);
    });

    it('keeps intended_session and the principal boundary, and no line carries the body', () => {
      const sent = send('notice-intended', { intended_session: T1 });
      accept(sent.delivery_id, notice);
      expect(refs(T1)).toEqual([sent.message_id]);
      expect(refs(T2)).toEqual([]);
      expect(refs(T1, true, 'someone-else')).toEqual([]);
      const lines = unreadInboxLinesFor(getDatabase(), 'p2-principal', T1, true);
      expect(lines).toHaveLength(1);
      expect(lines.join('\n')).not.toContain('hello');
    });

    it('goes quiet everywhere once the recipient records intake', () => {
      const sent = send('notice-intaken');
      accept(sent.delivery_id, notice);
      recordAgentReceipt(getDatabase(), {
        project: 'proj-a', recipient: 'p2-principal', message_id: sent.message_id,
        receipt_kind: 'intake', intake_state: 'ingested', actor: 'p2-principal', idempotency_key: 'intake-notice',
      });
      expect(refs(T1)).toEqual([]);
      expect(refs(T2)).toEqual([]);
      expect(refs(undefined)).toEqual([]);
    });
  });

  it('leaves Claude Code reminding as before (no host-accept filter outside Codex)', () => {
    const sent = send('claude');
    accept(sent.delivery_id, { host: 'codex-cli', status: 'queued', thread_id: T1 });
    expect(refs(T1, false)).toEqual([sent.message_id]);
  });
});

// The project in the waiting line goes through the shared JSON-literal formatter: unlike a bare JSON.stringify, it
// also escapes U+2028/U+2029, which many readers treat as line breaks.
describe('the waiting line keeps a project with line separators on one line', () => {
  it('prints the project as one escaped literal that decodes back to the exact project', () => {
    const project = 'sep\u2028line\u2029para';
    for (const kind of ['principal', 'session'] as const) {
      const [line] = unreadInboxLines(1, project, 'claude-r', true, kind);
      expect(line, kind).not.toMatch(/[\u2028\u2029]/);
      const m = line.match(/in project ("(?:[^"\\]|\\.)*")/);
      expect(m, line).not.toBeNull();
      expect(JSON.parse(m![1])).toBe(project);
    }
  });
});
