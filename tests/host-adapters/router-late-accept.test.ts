/**
 * #532 item 4: a host that finishes a delivery after the router's delivery
 * timeout. The router reports the attempt as failed and drops the late
 * acceptance, so the next registration of the same session drains the same
 * delivery again and the host runs the work a second time. This pins the
 * behaviour a fix must change: one send, one execution.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../../src/db.js';
import { sendAgentMessage } from '../../src/core/agent-messaging.js';
import { AGENT_ROUTER_PROTOCOL_VERSION, AgentRouter, createAgentRouterNotifier } from '../../src/core/agent-router.js';
import { connectRouterHost, type RouterDelivery, type RouterHostConnection } from '../../src/host-runtime/router-client.js';
import { memeshPackageVersion } from '../../src/host-runtime/package-version.js';

let router: AgentRouter | undefined;
const connections: RouterHostConnection[] = [];
let tempDir: string | undefined;

afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
  await router?.stop();
  router = undefined;
  closeDatabase();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

// The router refuses to start on Windows (unsupported_secure_host_runtime).
describe.skipIf(process.platform === 'win32')('#532 a delivery the host finishes after the router timeout', () => {
  it('is executed once, not again after the session registers anew', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-late-accept-'));
    fs.chmodSync(tempDir, 0o700);
    const socketPath = path.join(tempDir, 'router.sock');
    const db = openDatabase(path.join(tempDir, 'messages.db'));
    router = new AgentRouter({
      db,
      socket_path: socketPath,
      memesh_version: memeshPackageVersion(),
      limits: { lease_ms: 2_000, delivery_timeout_ms: 150 },
      adapters: [{ kind: 'acp', authenticate: value => value.auth_token === 'token' }],
    });
    await router.start();

    // The real work the host does for a delivery, counted per delivery id.
    const executions: string[] = [];
    let finished!: () => void;
    const firstDone = new Promise<void>(resolve => { finished = resolve; });
    const slowDeliver = vi.fn(async (delivery: RouterDelivery) => {
      executions.push(delivery.delivery_id);
      await new Promise(resolve => setTimeout(resolve, 400)); // longer than delivery_timeout_ms
      finished();
      return { host: 'acp', accepted: true, stop_reason: 'end_turn' };
    });
    const identity = {
      project: 'project-a', principal_id: 'principal-a',
      session_instance_id: 'session-a', adapter_kind: 'acp',
    };
    connections.push(await connectRouterHost({
      socket_path: socketPath, auth_token: 'token', identity, deliver: slowDeliver,
      resilience: { initial_retry_ms: 10, max_retry_ms: 20, retry_jitter: 0 },
    }));

    // Exactly one message, one delivery.
    const sent = sendAgentMessage(db, {
      project: 'project-a', sender: 'sender-a', recipient: 'principal-a',
      idempotency_key: 'slow-work', payload: { text: 'do the work' }, content_type: 'application/json',
    });
    await Promise.resolve(createAgentRouterNotifier(socketPath).notify({
      project: sent.project, delivery_id: sent.delivery_id, event_id: sent.event_id,
      target_kind: sent.target_kind, target_id: sent.recipient,
    })).catch(() => undefined);

    // The router gives up first and records a failed attempt...
    await vi.waitFor(() => expect(db.prepare(
      'SELECT result, failure_code FROM agent_dispatch_attempts WHERE delivery_id = ? ORDER BY attempt_number',
    ).all(sent.delivery_id)).toEqual([{ result: 'adapter_rejected', failure_code: 'host_outcome_timeout' }]));
    // ...then the host finishes the work and sends its acceptance late.
    await firstDone;
    await new Promise(resolve => setTimeout(resolve, 100));
    const lateAccepts = (db.prepare('SELECT COUNT(*) AS n FROM agent_host_accepts WHERE delivery_id = ?')
      .get(sent.delivery_id) as { n: number }).n;

    // The same session registers again in a new host process (restart).
    await connections.shift()!.close();
    const restartedDeliver = vi.fn(async (delivery: RouterDelivery) => {
      executions.push(delivery.delivery_id);
      return { host: 'acp', accepted: true, stop_reason: 'end_turn' };
    });
    connections.push(await connectRouterHost({
      socket_path: socketPath, auth_token: 'token', identity, deliver: restartedDeliver,
      resilience: { initial_retry_ms: 10, max_retry_ms: 20, retry_jitter: 0 },
    }));
    await new Promise(resolve => setTimeout(resolve, 500)); // let the registration drain run

    const evidence = {
      deliveries: (db.prepare('SELECT COUNT(*) AS n FROM agent_message_deliveries').get() as { n: number }).n,
      attempts: db.prepare('SELECT attempt_number, result, failure_code FROM agent_dispatch_attempts WHERE delivery_id = ? ORDER BY attempt_number')
        .all(sent.delivery_id),
      lateAccepts,
      executions,
    };
    // Recorded for the report whatever the outcome.
    process.stdout.write(`LATE-ACCEPT-EVIDENCE ${JSON.stringify(evidence)}\n`);
    expect(evidence.deliveries).toBe(1);
    expect(executions).toEqual([sent.delivery_id]);
  });
});

/** The late path accepts exactly the timed-out attempt on its current connection, nothing else. */
// The router refuses to start on Windows (unsupported_secure_host_runtime).
describe.skipIf(process.platform === 'win32')('#532 late host acceptance guards', () => {
  async function timedOutAttempt() {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-late-guard-'));
    fs.chmodSync(tempDir, 0o700);
    const socketPath = path.join(tempDir, 'router.sock');
    const db = openDatabase(path.join(tempDir, 'messages.db'));
    router = new AgentRouter({
      db, socket_path: socketPath, memesh_version: memeshPackageVersion(),
      limits: { lease_ms: 5_000, delivery_timeout_ms: 100 },
      adapters: [{ kind: 'acp', authenticate: value => value.auth_token === 'token' }],
    });
    await router.start();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const executions: string[] = [];
    const connection = await connectRouterHost({
      socket_path: socketPath, auth_token: 'token',
      identity: { project: 'project-a', principal_id: 'principal-a', session_instance_id: 'session-a', adapter_kind: 'acp' },
      deliver: async (delivery: RouterDelivery) => {
        executions.push(delivery.delivery_id);
        await held;
        return { host: 'acp', accepted: true, stop_reason: 'end_turn' };
      },
      resilience: { initial_retry_ms: 10, max_retry_ms: 20, retry_jitter: 0 },
    });
    connections.push(connection);
    const sent = sendAgentMessage(db, {
      project: 'project-a', sender: 'sender-a', recipient: 'principal-a',
      idempotency_key: 'guarded', payload: { text: 'work' }, content_type: 'application/json',
    });
    await Promise.resolve(createAgentRouterNotifier(socketPath).notify({
      project: sent.project, delivery_id: sent.delivery_id, event_id: sent.event_id,
      target_kind: sent.target_kind, target_id: sent.recipient,
    })).catch(() => undefined);
    await vi.waitFor(() => expect(db.prepare('SELECT result FROM agent_dispatch_attempts WHERE delivery_id = ?')
      .get(sent.delivery_id)).toEqual({ result: 'adapter_rejected' }));
    const attemptId = (db.prepare('SELECT attempt_id FROM agent_dispatch_attempts WHERE delivery_id = ?')
      .get(sent.delivery_id) as { attempt_id: string }).attempt_id;
    const internals = router as unknown as {
      handleHostOutcome(request: Record<string, unknown>, socket: unknown): Record<string, unknown>;
      externalConnections: Map<string, unknown>;
    };
    const socket = internals.externalConnections.get(connection.connection_id);
    const valid = {
      version: AGENT_ROUTER_PROTOCOL_VERSION, type: 'host_accept', request_id: 'r', hops: 0,
      attempt_id: attemptId, delivery_id: sent.delivery_id,
      connection_id: connection.connection_id, generation: connection.generation,
      receipt: { host: 'acp', accepted: true, stop_reason: 'end_turn' },
    };
    const accepts = () => (db.prepare('SELECT COUNT(*) AS n FROM agent_host_accepts WHERE delivery_id = ?')
      .get(sent.delivery_id) as { n: number }).n;
    return { db, sent, connection, internals, socket, valid, accepts, release, executions };
  }

  it('refuses a late acceptance that does not match the timed-out attempt exactly', async () => {
    const t = await timedOutAttempt();
    const outcome = (change: Record<string, unknown>) => t.internals.handleHostOutcome({ ...t.valid, ...change }, t.socket);
    expect(outcome({ attempt_id: 'another-attempt' })).toEqual({ duplicate: false });
    expect(outcome({ delivery_id: 'another-delivery' })).toEqual({ duplicate: false });
    expect(outcome({ generation: t.connection.generation + 1 })).toEqual({ duplicate: false });
    expect(outcome({ connection_id: 'another-connection' })).toEqual({ duplicate: false });
    expect(outcome({ type: 'host_reject', failure_code: 'late' })).toEqual({ duplicate: false });
    t.db.prepare("UPDATE agent_dispatch_attempts SET failure_code = 'adapter_error' WHERE attempt_id = ?").run(t.valid.attempt_id);
    expect(outcome({})).toEqual({ duplicate: false }); // not a timeout
    expect(t.accepts()).toBe(0);
    t.release();
  });

  it('records the exact late acceptance once, keeps the timeout fact, and stays idempotent', async () => {
    const t = await timedOutAttempt();
    expect(t.internals.handleHostOutcome(t.valid, t.socket)).toEqual({ correlated: true });
    expect(t.internals.handleHostOutcome(t.valid, t.socket)).toEqual({ duplicate: true });
    expect(t.accepts()).toBe(1);
    expect(t.db.prepare('SELECT result, failure_code FROM agent_dispatch_attempts WHERE attempt_id = ?').get(t.valid.attempt_id))
      .toEqual({ result: 'adapter_rejected', failure_code: 'host_outcome_timeout' });
    t.release(); // the host's own late frame arrives too
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(t.accepts()).toBe(1);
    expect(t.executions).toEqual([t.sent.delivery_id]);
  });

  it('refuses a late acceptance once the connection is gone', async () => {
    const t = await timedOutAttempt();
    await connections.shift()!.close();
    await vi.waitFor(() => expect(t.internals.externalConnections.has(t.connection.connection_id)).toBe(false));
    expect(t.internals.handleHostOutcome(t.valid, t.socket)).toEqual({ duplicate: false });
    expect(t.accepts()).toBe(0);
    t.release();
  });
});

