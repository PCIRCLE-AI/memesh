import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { executeAgentMessageAction } from '../../src/transports/agent-messaging.js';
import { expectValidHookOutput } from '../helpers/hook-output-contract.js';
import { removeTempDir } from '../helpers/temp-dir.js';

// Claude Code has no live channel by default, so a session that never
// polls never learns a message is waiting. This Stop hook blocks the stop
// once per waiting message id not yet blocked for in THIS session, whether
// or not a host_accept row exists (host_accept is not proof of delivery —
// docs/platforms/agent-messaging.md), and never blocks again for the same id.
describe('Feature: the Claude Code Stop message gate blocks once per waiting message id', () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-stop-gate-'));
    dbPath = path.join(tmp, 'graph.db');
    openDatabase(dbPath);
  });

  afterEach(() => {
    closeDatabase();
    removeTempDir(tmp);
  });

  type SentMessage = { message_id: string; delivery_id: string; project: string; recipient: string };

  async function send(recipient: string, project = 'gate-room'): Promise<SentMessage> {
    return executeAgentMessageAction(getDatabase(), {
      action: 'send',
      project,
      sender: 'codex-reviewer',
      recipient,
      idempotency_key: `k-${randomUUID()}`,
      payload: { text: 'review is done' },
      content_type: 'application/json',
    }, { transport: 'mcp', sourceHost: 'test-host' }) as Promise<SentMessage>;
  }

  async function intake(message: SentMessage): Promise<void> {
    await executeAgentMessageAction(getDatabase(), {
      action: 'intake',
      project: message.project,
      recipient: message.recipient,
      message_id: message.message_id,
      intake_state: 'fetched',
      idempotency_key: `intake-${message.message_id}`,
    }, { transport: 'mcp', sourceHost: 'test-host' });
  }

  /**
   * A real `host_accept` row, through the same FK chain the router itself
   * writes (copied from tests/transports/agent-messaging.test.ts's own
   * `seedHostAccept` — the repo's sanctioned way to produce one in a test,
   * rather than a narrower hand-rolled insert).
   */
  function seedHostAccept(message: SentMessage): void {
    const suffix = randomUUID();
    const sessionId = `session-${suffix}`;
    const connectionId = `connection-${suffix}`;
    const attemptId = `attempt-${suffix}`;
    const hostAcceptId = `host-accept-${suffix}`;
    getDatabase().transaction(() => {
      getDatabase().prepare(`
        INSERT OR IGNORE INTO agent_principals (project, principal_id, activation_event_sequence)
        VALUES (?, ?, 0)
      `).run(message.project, message.recipient);
      getDatabase().prepare(`
        INSERT INTO agent_session_instances (project, session_instance_id, principal_id, adapter_kind)
        VALUES (?, ?, ?, 'test-adapter')
      `).run(message.project, sessionId, message.recipient);
      getDatabase().prepare(`
        INSERT INTO agent_session_connections (
          connection_id, project, principal_id, session_instance_id, generation,
          adapter_kind, router_instance_id, lease_expires_at_ms
        ) VALUES (?, ?, ?, ?, 1, 'test-adapter', 'test-router', ?)
      `).run(connectionId, message.project, message.recipient, sessionId, Date.now() + 60_000);
      getDatabase().prepare(`
        INSERT INTO agent_dispatch_attempts (
          attempt_id, delivery_id, project, principal_id, session_instance_id,
          connection_id, generation, router_instance_id, attempt_number, result, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, 'test-router', 1, 'adapter_returned', CURRENT_TIMESTAMP)
      `).run(attemptId, message.delivery_id, message.project, message.recipient, sessionId, connectionId);
      getDatabase().prepare(`
        INSERT INTO agent_host_accepts (host_accept_id, attempt_id, delivery_id, adapter_kind, receipt_json)
        VALUES (?, ?, ?, 'test-adapter', '{"channel":"test"}')
      `).run(hostAcceptId, attemptId, message.delivery_id);
    }).immediate();
  }

  function runGate(
    inputOverrides: Record<string, unknown> = {},
    envOverrides: Record<string, string | undefined> = {},
  ) {
    const input = {
      session_id: 's-gate-1',
      cwd: tmp,
      hook_event_name: 'Stop',
      stop_hook_active: false,
      ...inputOverrides,
    };
    const result = spawnSync('node', [path.resolve('scripts/hooks/stop-message-gate.js')], {
      input: JSON.stringify(input),
      env: {
        ...process.env,
        HOME: tmp,
        MEMESH_DB_PATH: dbPath,
        MEMESH_RECIPIENT: 'gate-principal',
        MEMESH_HOOK_HOST: 'claude-code',
        ...envOverrides,
      },
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(result.status, `stop-message-gate exited ${result.status}\nstderr:\n${result.stderr}`).toBe(0);
    return result;
  }

  const ledgerText = (): string => fs.readFileSync(path.join(tmp, 'hook-outcomes.jsonl'), 'utf8');
  const ledger = () =>
    ledgerText().trim().split('\n')
      .map((line) => JSON.parse(line) as { hook: string; outcome: string; reason?: string })
      .filter((record) => record.hook === 'stop-message-gate');

  it('blocks once with the reason, for a delivery that has host_accept but no intake', async () => {
    const message = await send('gate-principal');
    seedHostAccept(message);

    const result = runGate();

    const parsed = expectValidHookOutput(result.stdout, 'stop-message-gate').parsed as
      { decision: string; reason: string } | undefined;
    expect(parsed?.decision).toBe('block');
    expect(parsed?.reason).toContain('1 message waiting for "gate-principal"');
    expect(parsed?.reason).toContain('Poll, fetch and record intake');
    expect(ledger().map((r) => r.outcome)).toContain('notified');
  });

  it('does not block again on the next Stop for the same id', async () => {
    const message = await send('gate-principal');
    seedHostAccept(message);
    runGate();

    const second = runGate();

    expect(second.stdout).toBe('');
    expect(ledger().at(-1)?.outcome).toBe('skipped');
  });

  it('does not block when stop_hook_active is true, and does not consume the id — a later real Stop still blocks', async () => {
    const message = await send('gate-principal');
    seedHostAccept(message);

    const activeRun = runGate({ stop_hook_active: true });
    expect(activeRun.stdout).toBe('');

    const realRun = runGate({ stop_hook_active: false });
    const parsed = JSON.parse(realRun.stdout) as { decision: string };
    expect(parsed.decision).toBe('block');
  });

  it('does not block once intake has been recorded', async () => {
    const message = await send('gate-principal');
    seedHostAccept(message);
    await intake(message);

    const result = runGate();

    expect(result.stdout).toBe('');
  });

  it('blocks again for a NEW message that arrives after the first block', async () => {
    const first = await send('gate-principal');
    seedHostAccept(first);
    const firstBlock = runGate();
    expect(JSON.parse(firstBlock.stdout).decision).toBe('block');

    // No host_accept for the second one — irrelevant to whether it blocks.
    await send('gate-principal');
    const secondBlock = runGate();

    const parsed = JSON.parse(secondBlock.stdout) as { decision: string; reason: string };
    expect(parsed.decision).toBe('block');
    expect(parsed.reason).toContain('2 messages waiting for "gate-principal"');
  });

  it('does not block under Codex, even with a matching waiting message', async () => {
    const message = await send('gate-principal');
    seedHostAccept(message);

    const result = runGate({}, { MEMESH_HOOK_HOST: 'codex' });

    expect(result.stdout).toBe('');
    expect(ledger().at(-1)?.reason).toContain('not running under Claude Code');
  });

  it('does nothing when there is no database yet', () => {
    const noDbPath = path.join(tmp, 'no-such-graph.db');

    const result = runGate({}, { MEMESH_DB_PATH: noDbPath });

    expect(result.stdout).toBe('');
  });

  it('does nothing without a usable session_id', async () => {
    const message = await send('gate-principal');
    seedHostAccept(message);

    const result = runGate({ session_id: '' });

    expect(result.stdout).toBe('');
  });

  // A read failure inside the inbox query returns `[]` from both
  // waitingMessageRefs/waitingMessageLines (their own recordFailure already
  // fired), which is bit-for-bit identical to "genuinely nothing waiting" —
  // so without a flag, the gate went on to ALSO record
  // `skipped: nothingWaitingForGate`, contradicting the `error` record it
  // had just made in the same run.
  it('records only the read error, never a contradictory "nothing waiting" skip', async () => {
    const message = await send('gate-principal');
    seedHostAccept(message);
    getDatabase().exec('ALTER TABLE agent_message_receipts RENAME TO agent_message_receipts_gone');

    const result = runGate();

    expect(result.stdout).toBe('');
    const records = ledger();
    expect(records.some((r) => r.outcome === 'error' && r.reason?.startsWith('inbox:'))).toBe(true);
    expect(records.some((r) => r.outcome === 'skipped' && r.reason?.includes('no messages are waiting'))).toBe(false);
  });
});
