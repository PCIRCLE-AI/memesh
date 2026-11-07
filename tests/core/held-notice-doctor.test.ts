import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/core/doctor.js';
import { sendAgentMessage } from '../../src/core/agent-messaging.js';
import { getDatabase } from '../../src/db.js';
import { useTestDatabase } from '../helpers/db-fixture.js';
import { registerAgentSession } from '../helpers/agent-session-fixture.js';

const dbHandle = useTestDatabase('memesh-held-notice-doctor-');
const project = 'private-doctor-project';

function doctor() {
  return runDoctor({
    packageRoot: process.cwd(),
    packageVersion: 'test',
    openDatabaseImpl: () => getDatabase(),
    closeDatabaseImpl: () => undefined,
    isDatabaseOpenImpl: () => true,
    getConfigPathImpl: () => path.join(dbHandle.tmpDir, 'config.json'),
    getUpdateCheckImpl: async () => ({ checkSucceeded: true, updateAvailable: false }) as never,
    getCurrentInstallChannelImpl: () => 'npm-global',
    getInstallChannelSupportImpl: () => ({ label: 'npm global', canSelfUpdate: false }) as never,
    nativeBindingProbeImpl: () => ({ ok: true }),
    resolveShellMemeshImpl: () => null,
  });
}

/** One principal message plus the dispatch attempt the router would have recorded for it. */
function attempt(key: string, failureCode: string | null, ageDays = 0, accepted = false) {
  const db = getDatabase();
  const session = registerAgentSession(project, 'bob', { adapterKind: 'claude-inbox' });
  const sent = sendAgentMessage(db, { project, sender: 'alice', recipient: 'bob', idempotency_key: key, content_type: 'text/plain', payload: 'hi' });
  const connection = db.prepare('SELECT connection_id FROM agent_session_connections WHERE session_instance_id = ?').get(session) as { connection_id: string };
  const stamp = `datetime('now', '-${ageDays} days')`;
  db.prepare(`INSERT INTO agent_dispatch_attempts (attempt_id, delivery_id, project, principal_id, session_instance_id, connection_id, generation, router_instance_id, attempt_number, result, failure_code, completed_at, created_at) VALUES (?, ?, ?, 'bob', ?, ?, 1, 'router', 1, ?, ?, ${stamp}, ${stamp})`).run(`attempt-${key}`, sent.delivery_id, project, session, connection.connection_id, accepted ? 'adapter_returned' : 'adapter_rejected', failureCode);
  if (accepted) db.prepare(`INSERT INTO agent_host_accepts (host_accept_id, attempt_id, delivery_id, adapter_kind, receipt_json) VALUES (?, ?, ?, 'claude-inbox', '{}')`).run(`accept-${key}`, `attempt-${key}`, sent.delivery_id);
  return { deliveryId: sent.delivery_id, session, messageId: sent.message_id };
}

/** A later attempt for the same delivery, as the router makes each time a host registers again. */
function anotherAttempt(first: { deliveryId: string; session: string }, failureCode: string, attemptNumber: number) {
  const db = getDatabase();
  const connection = db.prepare('SELECT connection_id FROM agent_session_connections WHERE session_instance_id = ?').get(first.session) as { connection_id: string };
  db.prepare(`INSERT INTO agent_dispatch_attempts (attempt_id, delivery_id, project, principal_id, session_instance_id, connection_id, generation, router_instance_id, attempt_number, result, failure_code, completed_at) VALUES (?, ?, ?, 'bob', ?, ?, 1, 'router', ?, 'adapter_rejected', ?, CURRENT_TIMESTAMP)`)
    .run(`attempt-${first.deliveryId}-${attemptNumber}`, first.deliveryId, project, first.session, connection.connection_id, attemptNumber, failureCode);
}

describe('doctor: notices that never reached a conversation', () => {
  const row = async () => (await doctor()).checks.find((check) => check.id === 'held-notices');

  it('adds no row when no notice was left unconfirmed', async () => {
    attempt('other-failure', 'host_outcome_timeout');
    expect(await row()).toBeUndefined();
  });

  it('warns, counts the unconfirmed messages and names both ways out, without naming the project', async () => {
    attempt('held-1', 'notice_not_confirmed');
    attempt('held-2', 'notice_not_confirmed');
    const found = await row();
    expect(found?.status).toBe('warn');
    expect(found?.summary).toMatch(/2 message/);
    expect(found?.fix).toMatch(/crossSessionInbound.*accept/);
    expect(found?.fix).toMatch(/Channel/);
    expect(JSON.stringify(found)).not.toContain(project);
  });

  it('counts a notice Claude Code is holding for its user, and says MeMesh cannot see a denial', async () => {
    attempt('held-for-user', 'notice_held');
    const found = await row();
    expect(found?.status).toBe('warn');
    expect(found?.summary).toMatch(/1 message/);
    expect(found?.summary).toMatch(/approve or deny.*cannot see whether the user denied/i);
  });

  it('names every cause of an unconfirmed notice, not only a hold', async () => {
    attempt('unconfirmed', 'notice_not_confirmed');
    const summary = (await row())?.summary ?? '';
    expect(summary).toMatch(/holding the notice/i);
    expect(summary).toMatch(/busy or has stopped/i);
    expect(summary).toMatch(/dropped the notice/i);
  });

  it('counts a message under its latest attempt only: held then unreadable shows in one row, not two', async () => {
    const first = attempt('held-then-unreadable', 'notice_held');
    anotherAttempt(first, 'transcript_unavailable', 2);
    expect(await row()).toBeUndefined();
    const found = (await doctor()).checks.find((check) => check.id === 'unreadable-transcripts');
    expect(found?.summary).toMatch(/^1 message\(s\)/);
  });

  it('takes the latest attempt of each message on its own: a message tried once and one tried twice, both held, are two messages', async () => {
    attempt('tried-once', 'notice_held');
    const twice = attempt('tried-twice', 'notice_held');
    anotherAttempt(twice, 'notice_held', 2);
    expect((await row())?.summary).toMatch(/^2 message\(s\)/);
    // A message whose own latest attempt differs is judged by that one, whatever the other messages' numbers are.
    const other = attempt('latest-differs', 'notice_held');
    anotherAttempt(other, 'host_outcome_timeout', 2);
    expect((await row())?.summary).toMatch(/^2 message\(s\)/);
  });

  it('stops reporting a held message whose latest attempt failed some other way, and reports one whose latest is held again', async () => {
    const settled = attempt('held-then-timeout', 'notice_held');
    anotherAttempt(settled, 'host_outcome_timeout', 2);
    const again = attempt('timeout-then-held', 'host_outcome_timeout');
    expect(await row()).toBeUndefined();
    anotherAttempt(again, 'notice_held', 2);
    expect((await row())?.summary).toMatch(/^1 message\(s\)/);
  });

  it('says so, and does not crash, when the attempts cannot be read (both rows)', async () => {
    attempt('unreadable-db', 'notice_held');
    getDatabase().exec('DROP TABLE agent_host_accepts');
    const checks = (await doctor()).checks;
    for (const id of ['held-notices', 'unreadable-transcripts']) {
      const found = checks.find((check) => check.id === id);
      expect(found?.status).toBe('warn');
      expect(found?.summary).toMatch(/^Could not read the message dispatch attempts: .*agent_host_accepts/);
    }
  });

  it('adds no row when the dispatch attempts table does not exist yet', async () => {
    getDatabase().exec('DROP TABLE agent_host_accepts; DROP TABLE agent_dispatch_attempts');
    const checks = (await doctor()).checks;
    expect(checks.find((check) => check.id === 'held-notices')).toBeUndefined();
    expect(checks.find((check) => check.id === 'unreadable-transcripts')).toBeUndefined();
  });

  it('counts a message once however many times its notice was tried', async () => {
    const first = attempt('retried', 'notice_held');
    anotherAttempt(first, 'notice_held', 2); anotherAttempt(first, 'notice_held', 3);
    expect((await row())?.summary).toMatch(/^1 message\(s\)/);
  });

  it.each(['intake', 'ack', 'disposition'] as const)('stops reporting a message once the agent has recorded %s for it, and keeps reporting the one still waiting', async kind => {
    const handled = attempt(`handled-${kind}`, 'notice_held');
    const waiting = attempt(`waiting-${kind}`, 'notice_held');
    expect((await row())?.summary).toMatch(/^2 message\(s\)/);
    const detail = kind === 'intake' ? { intake_state: 'ingested', detail: {} } : kind === 'disposition' ? { disposition: 'completed', detail: {} } : { acknowledged: true, detail: {} };
    getDatabase().prepare(`INSERT INTO agent_message_receipts (receipt_id, message_id, project, recipient, receipt_kind, actor, idempotency_key, request_hash, detail_json) VALUES (?, ?, ?, 'bob', ?, 'bob', 'k', 'h', ?)`).run(`r-${kind}`, handled.messageId, project, kind, JSON.stringify(detail));
    expect((await row())?.summary).toMatch(/^1 message\(s\)/);
    getDatabase().prepare(`INSERT INTO agent_message_receipts (receipt_id, message_id, project, recipient, receipt_kind, actor, idempotency_key, request_hash, detail_json) VALUES (?, ?, ?, 'bob', ?, 'bob', 'k2', 'h2', ?)`).run(`r2-${kind}`, waiting.messageId, project, kind, JSON.stringify(detail));
    expect(await row()).toBeUndefined();
  });

  it('adds a separate row when MeMesh could not read the Claude Code conversation record, with the cause and what to check', async () => {
    attempt('no-transcript-1', 'transcript_not_found');
    attempt('no-transcript-2', 'transcript_unavailable');
    expect(await row()).toBeUndefined();
    const found = (await doctor()).checks.find((check) => check.id === 'unreadable-transcripts');
    expect(found?.status).toBe('warn');
    expect(found?.summary).toMatch(/^2 message\(s\)/);
    expect(found?.summary).toMatch(/could not read.*conversation record.*could not tell whether the notice arrived/i);
    expect(found?.fix).toMatch(/CLAUDE_CONFIG_DIR/);
    expect(found?.fix).toMatch(/MEMESH_PROJECT_ROOT/);
    expect(found?.fix).toMatch(/CLAUDE_PROJECT_DIR/);
    expect(JSON.stringify(found)).not.toContain(project);
  });

  it('ignores a notice that was confirmed later and one older than seven days', async () => {
    attempt('later-accepted', 'notice_not_confirmed', 0, true);
    attempt('old', 'notice_not_confirmed', 9);
    expect(await row()).toBeUndefined();
  });
});
