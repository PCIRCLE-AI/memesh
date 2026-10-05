import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { executeAgentMessageAction } from '../../src/transports/agent-messaging.js';
import { expectValidHookOutput } from '../helpers/hook-output-contract.js';
import { removeTempDir } from '../helpers/temp-dir.js';
import { registerAgentSession, sendSessionTargetedMessage } from '../helpers/agent-session-fixture.js';

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

  it('a session id longer than 128 characters is skipped with a recorded reason, not processed', async () => {
    const message = await send('gate-principal');
    seedHostAccept(message);

    const result = runGate({ session_id: 'a'.repeat(129) });

    expect(result.stdout.trim()).toBe('');
    expect(ledger().at(-1)).toMatchObject({ outcome: 'skipped', reason: expect.stringContaining('no usable session_id') });
  });

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

  // #492: stop_hook_active only means "a Stop hook blocked the prior turn" —
  // it does not say THIS gate was the one that blocked it. A message that
  // arrives while a DIFFERENT Stop hook (e.g. a verify-receipt gate) is
  // holding the block chain open must still be surfaced once. (Contract
  // change from the old behaviour, which skipped unconditionally whenever
  // stop_hook_active was true — see the replaced test this one supersedes.)
  it('blocks even when stop_hook_active is true, for a message this gate has never blocked for', async () => {
    const message = await send('gate-principal');
    seedHostAccept(message);

    const result = runGate({ stop_hook_active: true });

    const parsed = JSON.parse(result.stdout) as { decision: string; reason: string };
    expect(parsed.decision).toBe('block');
    expect(parsed.reason).toContain('1 message waiting for "gate-principal"');
  });

  // The "do not re-block" guarantee now comes from the per-session blocked-id
  // ledger alone (not from stop_hook_active), so it must hold when
  // stop_hook_active is true too — otherwise this case would be
  // indistinguishable, from the ledger's own reason text, from the case above.
  it('does not block again when stop_hook_active is true and this gate already blocked for these ids', async () => {
    const message = await send('gate-principal');
    seedHostAccept(message);
    const firstBlock = runGate({ stop_hook_active: false });
    expect(JSON.parse(firstBlock.stdout).decision).toBe('block');

    const result = runGate({ stop_hook_active: true });

    expect(result.stdout).toBe('');
    expect(ledger().at(-1)?.outcome).toBe('skipped');
    expect(ledger().at(-1)?.reason).toContain('already blocked');
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

  // #497: every session of the principal shares this inbox; a message meant
  // for session A blocks A's Stop and not B's, and B's intake (refused) does
  // not clear A's. A message meant for nobody in particular blocks both.
  describe('#497 a message meant for one session', () => {
    const SESSION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const SESSION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    async function sendIntended(session: string): Promise<SentMessage> {
      return executeAgentMessageAction(getDatabase(), {
        action: 'send', project: 'gate-room', sender: 'codex-lead', recipient: 'gate-principal',
        intended_session: session, idempotency_key: `k-${randomUUID()}`,
        payload: { text: 'for one session' }, content_type: 'application/json',
      }, { transport: 'mcp', sourceHost: 'test-host' }) as Promise<SentMessage>;
    }

    it('step 3: blocks A\'s Stop and not B\'s', async () => {
      await sendIntended(SESSION_A);

      const asB = runGate({ session_id: SESSION_B });
      expect(asB.stdout).toBe('');
      expect(ledger().at(-1)).toMatchObject({ outcome: 'skipped' });

      const asA = runGate({ session_id: SESSION_A });
      const parsed = expectValidHookOutput(asA.stdout, 'stop-message-gate').parsed as { decision: string } | undefined;
      expect(parsed?.decision).toBe('block');
    });

    it('step 4: B\'s refused intake leaves A blocked', async () => {
      const message = await sendIntended(SESSION_A);
      await expect(executeAgentMessageAction(getDatabase(), {
        action: 'intake', project: message.project, recipient: message.recipient, message_id: message.message_id,
        intake_state: 'ingested', idempotency_key: `intake-${message.message_id}`,
      }, { transport: 'mcp', sourceHost: 'test-host', hostSession: SESSION_B }))
        .rejects.toMatchObject({ code: 'intended_for_other_session' });

      const asA = runGate({ session_id: SESSION_A });
      expect((expectValidHookOutput(asA.stdout, 'stop-message-gate').parsed as { decision: string }).decision).toBe('block');
    });

    it('step 5: a plain principal message blocks both A and B', async () => {
      await send('gate-principal');

      for (const session of [SESSION_A, SESSION_B]) {
        const result = runGate({ session_id: session });
        expect((expectValidHookOutput(result.stdout, 'stop-message-gate').parsed as { decision: string }).decision).toBe('block');
      }
    });
  });

  // #566: the exact-session form of #497. A message sent to live session A
  // with target_kind "session" blocks A's Stop, and not the Stop of another
  // live session B of the same principal.
  it('#566 an exact-session message blocks only the session it is for', () => {
    const SESSION_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const SESSION_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    registerAgentSession('gate-room', 'gate-principal', { sessionId: SESSION_A });
    registerAgentSession('gate-room', 'gate-principal', { sessionId: SESSION_B });
    sendSessionTargetedMessage('gate-room', SESSION_A, `k-${randomUUID()}`);

    const asB = runGate({ session_id: SESSION_B });
    expect(asB.stdout).toBe('');
    expect(ledger().at(-1)).toMatchObject({ outcome: 'skipped' });

    const asA = runGate({ session_id: SESSION_A });
    expect((expectValidHookOutput(asA.stdout, 'stop-message-gate').parsed as { decision: string }).decision).toBe('block');
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

  // #490's match joins agent_session_instances and agent_session_connections.
  // A database with deliveries but without those tables is half-migrated, not
  // empty: it is an error, never "nothing waiting".
  it('records a half-migrated database (no session tables) as an error, never "nothing waiting"', async () => {
    await send('gate-principal');
    getDatabase().exec('DROP TABLE agent_session_connections; DROP TABLE agent_session_instances;');

    const result = runGate();

    expect(result.stdout).toBe('');
    const records = ledger();
    expect(records.some((r) => r.outcome === 'error' && r.reason?.startsWith('inbox:'))).toBe(true);
    expect(records.some((r) => r.outcome === 'skipped' && r.reason?.includes('no messages are waiting'))).toBe(false);
  });

  // The ledger alone bounds re-blocking now that stop_hook_active is not a
  // skip (#492), so it is written before the block. When it cannot be
  // written, a Stop already continuing a block must not block again, or
  // every Stop would block forever.
  it('does not keep blocking when its ledger cannot be written', async () => {
    const message = await send('gate-principal');
    seedHostAccept(message);
    // A non-empty directory where the ledger file goes: every write fails.
    fs.mkdirSync(path.join(tmp, 'stop-message-gate', 's-gate-1.json', 'occupied'), { recursive: true });

    const first = runGate({ stop_hook_active: false });
    expect(JSON.parse(first.stdout).decision).toBe('block');

    const continuing = runGate({ stop_hook_active: true });

    expect(continuing.stdout).toBe('');
    expect(ledger().filter((r) => r.outcome === 'error' && r.reason?.startsWith('state:'))).toHaveLength(2);
  });

  // A block nobody saw must not count as delivered: when the host has closed
  // stdout, the ids written ahead to the ledger are taken back out, so the
  // next Stop still blocks for them. The test closes the pipe's only reader
  // before the gate has started, so the gate's write fails with EPIPE. (Not
  // run on Windows, where this has not been checked.)
  it.skipIf(process.platform === 'win32')('takes the ids back out of its ledger when the host closed stdout', async () => {
    const message = await send('gate-principal');
    seedHostAccept(message);
    const child = spawn(process.execPath, [path.resolve('scripts/hooks/stop-message-gate.js')], {
      env: { ...process.env, HOME: tmp, MEMESH_DB_PATH: dbPath, MEMESH_RECIPIENT: 'gate-principal', MEMESH_HOOK_HOST: 'claude-code' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    child.stdout.destroy();
    child.stdin.end(JSON.stringify({ session_id: 's-gate-1', cwd: tmp, hook_event_name: 'Stop', stop_hook_active: false }));
    await new Promise((resolve) => child.on('close', resolve));
    expect(ledger().at(-1)?.reason).toContain('host closed the pipe');

    const next = runGate();

    expect(JSON.parse(next.stdout).decision).toBe('block');
  });

  // #490: a `target_kind: "session"` delivery is addressed to the host's own
  // session_instance_id, not the resolved principal (`MEMESH_RECIPIENT` here).
  // The Stop gate must find it too, through the same widened lookup as the
  // reminder hooks (tests/hooks/message-recipient-reminder.test.ts), and only
  // while that session is live. The gate runs in the addressed session: since
  // #566 another session of the same principal is not reminded of it.
  describe('Feature: #490 the Stop gate also blocks for a session-targeted message, only while live', () => {
    it('blocks for a session-targeted message addressed to a LIVE session under the resolved principal', async () => {
      const sessionId = registerAgentSession('gate-room', 'gate-principal');
      sendSessionTargetedMessage('gate-room', sessionId, 'session-gate-k1');

      const result = runGate({ session_id: sessionId });

      const parsed = expectValidHookOutput(result.stdout, 'stop-message-gate').parsed as
        { decision: string; reason: string } | undefined;
      expect(parsed?.decision).toBe('block');
      expect(parsed?.reason).toContain(`the live session ${JSON.stringify(sessionId)}`);
      expect(parsed?.reason).toContain('target_kind "session"');
    });

    it('does NOT block for a session-targeted message once that session has disconnected', async () => {
      const sessionId = registerAgentSession('gate-room', 'gate-principal', { disconnected: true });
      sendSessionTargetedMessage('gate-room', sessionId, 'session-gate-k2');

      const result = runGate({ session_id: sessionId });

      expect(result.stdout).toBe('');
    });
  });
});
