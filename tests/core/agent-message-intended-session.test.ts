/**
 * #497: every Claude session in one project shares one principal. A message
 * meant for session A that reaches that principal (the fallback after a
 * refused `target_kind: "session"` send) carries `intended_session`, and:
 *   - only A is told it is waiting (B is not, and neither is a caller that
 *     cannot say which session it is);
 *   - only A can record intake or a disposition for it;
 *   - a plain principal message still reaches every session.
 * The hook-level and router-level halves live in
 * tests/hooks/stop-message-gate.test.ts, tests/hooks/message-recipient-reminder.test.ts
 * and tests/core/agent-router.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { closeDatabase, getDatabase, openDatabase } from '../../src/db.js';
import {
  AgentIdempotencyConflictError,
  recordAgentReceipt,
  sendAgentMessage,
} from '../../src/core/agent-messaging.js';
import {
  unreadDeliveryCount,
  unreadInboxLinesFor,
  unreadMessageRefsFor,
} from '../../src/core/agent-message-inbox.js';
import { useTestDatabase } from '../helpers/db-fixture.js';
import { registerAgentSession, sendIntendedPrincipalMessage } from '../helpers/agent-session-fixture.js';

const PROJECT = 'proj-497';
const PRINCIPAL = 'claude-proj-497-1';
const SESSION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function waitingFor(session?: string) {
  const db = getDatabase();
  return {
    refs: unreadMessageRefsFor(db, PRINCIPAL, session).length,
    lines: unreadInboxLinesFor(db, PRINCIPAL, session).length,
    count: unreadDeliveryCount(db, PROJECT, PRINCIPAL, session),
  };
}

function receipt(
  messageId: string,
  kind: 'intake' | 'disposition',
  callerSession: string | undefined,
) {
  const base = {
    project: PROJECT,
    recipient: PRINCIPAL,
    message_id: messageId,
    actor: PRINCIPAL,
    idempotency_key: `${kind}-${messageId}-${callerSession ?? 'none'}`,
    caller_session: callerSession,
  };
  return kind === 'intake'
    ? recordAgentReceipt(getDatabase(), { ...base, receipt_kind: 'intake', intake_state: 'ingested' })
    : recordAgentReceipt(getDatabase(), { ...base, receipt_kind: 'disposition', disposition: 'accepted' });
}

describe('Feature: #497 a principal message meant for one session reaches only that session', () => {
  const handle = useTestDatabase('memesh-intended-session-');

  it('step 3: counts it as waiting for A only — not for B, not for a caller with no session id', () => {
    sendIntendedPrincipalMessage(PROJECT, PRINCIPAL, SESSION_A, 'k-step3');

    expect(waitingFor(SESSION_A)).toEqual({ refs: 1, lines: 1, count: 1 });
    expect(waitingFor(SESSION_B)).toEqual({ refs: 0, lines: 0, count: 0 });
    // No session id: count only what is meant for nobody in particular.
    expect(waitingFor(undefined)).toEqual({ refs: 0, lines: 0, count: 0 });
  });

  it('step 5: a plain principal message (no intended session) still waits for every session', () => {
    sendAgentMessage(getDatabase(), {
      project: PROJECT, sender: 'codex-lead', recipient: PRINCIPAL,
      idempotency_key: 'k-plain', payload: 'for everyone', content_type: 'text/plain',
    });

    expect(waitingFor(SESSION_A)).toEqual({ refs: 1, lines: 1, count: 1 });
    expect(waitingFor(SESSION_B)).toEqual({ refs: 1, lines: 1, count: 1 });
    expect(waitingFor(undefined)).toEqual({ refs: 1, lines: 1, count: 1 });
  });

  it('step 4: B cannot record intake for it, and A still has it waiting', () => {
    const sent = sendIntendedPrincipalMessage(PROJECT, PRINCIPAL, SESSION_A, 'k-step4');

    expect(() => receipt(sent.message_id, 'intake', SESSION_B)).toThrow(
      expect.objectContaining({ code: 'intended_for_other_session' }),
    );
    expect(() => receipt(sent.message_id, 'intake', SESSION_B)).toThrow(SESSION_A);
    expect(waitingFor(SESSION_A)).toEqual({ refs: 1, lines: 1, count: 1 });

    receipt(sent.message_id, 'intake', SESSION_A);
    expect(waitingFor(SESSION_A)).toEqual({ refs: 0, lines: 0, count: 0 });
  });

  it('refuses intake from a caller that cannot say which session it is (HTTP, dashboard)', () => {
    const sent = sendIntendedPrincipalMessage(PROJECT, PRINCIPAL, SESSION_A, 'k-nosession');

    expect(() => receipt(sent.message_id, 'intake', undefined)).toThrow(
      expect.objectContaining({ code: 'intended_for_other_session' }),
    );
    // The error says what to do: Codex does not pass its thread id to MCP.
    expect(() => receipt(sent.message_id, 'intake', undefined)).toThrow(
      /CLAUDE_CODE_SESSION_ID \/ CODEX_THREAD_ID.*memesh message intake/,
    );
    expect(waitingFor(SESSION_A).refs).toBe(1);
  });

  it('refuses a disposition from B and accepts one from A', () => {
    const sent = sendIntendedPrincipalMessage(PROJECT, PRINCIPAL, SESSION_A, 'k-disposition');

    expect(() => receipt(sent.message_id, 'disposition', SESSION_B)).toThrow(
      expect.objectContaining({ code: 'intended_for_other_session' }),
    );
    expect(receipt(sent.message_id, 'disposition', SESSION_A)).toMatchObject({ receipt_kind: 'disposition' });
  });

  it('leaves intake of a plain principal message open to any session, or none', () => {
    const sent = sendAgentMessage(getDatabase(), {
      project: PROJECT, sender: 'codex-lead', recipient: PRINCIPAL,
      idempotency_key: 'k-plain-intake', payload: 'for everyone', content_type: 'text/plain',
    });

    expect(receipt(sent.message_id, 'intake', SESSION_B)).toMatchObject({ receipt_kind: 'intake' });
    expect(receipt(sent.message_id, 'intake', undefined)).toMatchObject({ receipt_kind: 'intake' });
  });

  it('stores intended_session on the delivery and returns it from send', () => {
    const sent = sendIntendedPrincipalMessage(PROJECT, PRINCIPAL, SESSION_A, 'k-stored');

    expect(sent.intended_session).toBe(SESSION_A);
    expect(getDatabase().prepare(
      'SELECT intended_session FROM agent_message_deliveries WHERE delivery_id = ?',
    ).get(sent.delivery_id)).toEqual({ intended_session: SESSION_A });
  });

  it('refuses intended_session on a session-targeted send', () => {
    expect(() => sendAgentMessage(getDatabase(), {
      project: PROJECT, sender: 'codex-lead', recipient: SESSION_A, target_kind: 'session',
      intended_session: SESSION_A, idempotency_key: 'k-bad', payload: 'x', content_type: 'text/plain',
    })).toThrow(/intended_session/);
  });

  it('refuses to name a session registered by a host that cannot say which session it is (acp), and stores nothing', () => {
    // Nothing on that host could ever record intake: it would wait forever.
    registerAgentSession(PROJECT, PRINCIPAL, { sessionId: SESSION_B, adapterKind: 'acp' });

    expect(() => sendIntendedPrincipalMessage(PROJECT, PRINCIPAL, SESSION_B, 'k-acp'))
      .toThrow(/"acp".*Only Claude Code sessions and Codex CLI threads/);
    expect(getDatabase().prepare('SELECT COUNT(*) AS n FROM agent_message_deliveries').get()).toEqual({ n: 0 });
    expect(getDatabase().prepare('SELECT COUNT(*) AS n FROM agent_messages').get()).toEqual({ n: 0 });
  });

  it('allows a registered Claude channel session, a registered Codex CLI thread, and an unregistered id', () => {
    const codexThread = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    registerAgentSession(PROJECT, PRINCIPAL, { sessionId: SESSION_A, adapterKind: 'claude-channel' });
    registerAgentSession(PROJECT, PRINCIPAL, { sessionId: codexThread, adapterKind: 'codex-cli-queue' });

    expect(sendIntendedPrincipalMessage(PROJECT, PRINCIPAL, SESSION_A, 'k-claude').intended_session).toBe(SESSION_A);
    expect(sendIntendedPrincipalMessage(PROJECT, PRINCIPAL, codexThread, 'k-codex').intended_session).toBe(codexThread);
    expect(sendIntendedPrincipalMessage(PROJECT, PRINCIPAL, SESSION_B, 'k-unregistered').intended_session).toBe(SESSION_B);
  });

  it('refuses a codex-app-server session: it registers a configured id, not the thread id', () => {
    registerAgentSession(PROJECT, PRINCIPAL, { sessionId: SESSION_B, adapterKind: 'codex-app-server' });

    expect(() => sendIntendedPrincipalMessage(PROJECT, PRINCIPAL, SESSION_B, 'k-app-server'))
      .toThrow(/"codex-app-server"/);
  });

  it('treats a retry that changes intended_session as an idempotency conflict', () => {
    sendIntendedPrincipalMessage(PROJECT, PRINCIPAL, SESSION_A, 'k-retry');

    expect(() => sendIntendedPrincipalMessage(PROJECT, PRINCIPAL, SESSION_B, 'k-retry'))
      .toThrow(AgentIdempotencyConflictError);
    expect(() => sendAgentMessage(getDatabase(), {
      project: PROJECT, sender: 'codex-lead', recipient: PRINCIPAL,
      idempotency_key: 'k-retry', payload: { text: 'work instruction for one session' }, content_type: 'application/json',
    })).toThrow(AgentIdempotencyConflictError);
  });

  it('migration: a database from before the column gains it, and its old deliveries count for every session', () => {
    const db = getDatabase();
    const old = sendAgentMessage(db, {
      project: PROJECT, sender: 'codex-lead', recipient: PRINCIPAL,
      idempotency_key: 'k-old', payload: 'from before 497', content_type: 'text/plain',
    });
    // Turn this database back into the pre-#497 shape.
    db.exec('DROP INDEX IF EXISTS idx_agent_message_deliveries_intended');
    db.exec('ALTER TABLE agent_message_deliveries DROP COLUMN intended_session');
    closeDatabase();

    openDatabase(handle.dbPath);

    const columns = (getDatabase().prepare('PRAGMA table_info(agent_message_deliveries)').all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(columns).toContain('intended_session');
    expect(getDatabase().prepare(
      'SELECT intended_session FROM agent_message_deliveries WHERE delivery_id = ?',
    ).get(old.delivery_id)).toEqual({ intended_session: null });
    expect(waitingFor(SESSION_A).refs).toBe(1);
    expect(waitingFor(SESSION_B).refs).toBe(1);
    expect(waitingFor(undefined).refs).toBe(1);
  });

  it('a read-only hook on a not-yet-migrated database still counts every delivery instead of failing', () => {
    const db = getDatabase();
    sendAgentMessage(db, {
      project: PROJECT, sender: 'codex-lead', recipient: PRINCIPAL,
      idempotency_key: 'k-unmigrated', payload: 'no column yet', content_type: 'text/plain',
    });
    db.exec('DROP INDEX IF EXISTS idx_agent_message_deliveries_intended');
    db.exec('ALTER TABLE agent_message_deliveries DROP COLUMN intended_session');

    // No reopen: hooks open read-only and never migrate.
    expect(waitingFor(SESSION_A)).toEqual({ refs: 1, lines: 1, count: 1 });
    expect(waitingFor(undefined)).toEqual({ refs: 1, lines: 1, count: 1 });
  });
});
