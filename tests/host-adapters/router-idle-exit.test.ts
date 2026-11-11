import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase } from '../../src/db.js';
import { sendAgentMessage } from '../../src/core/agent-messaging.js';
import { executeAgentMessageAction } from '../../src/transports/agent-messaging.js';
import { readRouterIdleExit } from '../../src/host-runtime/router-idle.js';
import { registerAgentSession } from '../helpers/agent-session-fixture.js';
import { connectRouterHost, type RouterDelivery, type RouterHostConnection } from '../../src/host-runtime/router-client.js';

// The packaged router, started the way a host starts it. `npm run build` (part of `npm run verify`) produces it.
const routerJs = fileURLToPath(new URL('../../dist/host-runtime/router.js', import.meta.url));

describe.skipIf(process.platform === 'win32')('the packaged router ends itself when idle', () => {
  const children: ChildProcess[] = [];
  let host: RouterHostConnection | undefined;
  let base: string | undefined;

  afterEach(async () => {
    await host?.close().catch(() => undefined); host = undefined;
    for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGTERM');
    closeDatabase();
    if (base) fs.rmSync(base, { recursive: true, force: true });
    base = undefined;
  });

  function setup() {
    // Short path: a Unix socket path is limited to about 100 bytes.
    base = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'mri-')); fs.chmodSync(base, 0o700);
    const dataDir = path.join(base, 'data'); fs.mkdirSync(dataDir, { mode: 0o700 });
    const paths = { socket: path.join(base, 'r.sock'), token: path.join(dataDir, 'agent-router.token'), db: path.join(dataDir, 'knowledge-graph.db') };
    const env: NodeJS.ProcessEnv = {
      ...process.env, HOME: base, MEMESH_DB_PATH: paths.db, MEMESH_ROUTER_SOCKET: paths.socket, MEMESH_ROUTER_TOKEN_FILE: paths.token,
      MEMESH_ROUTER_IDLE_MS: '1500', MEMESH_ROUTER_IDLE_CHECK_MS: '100',
    };
    const startRouter = () => {
      const child = spawn(process.execPath, [routerJs], { env, stdio: 'ignore' });
      children.push(child);
      const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
      return { child, exited };
    };
    return { paths, env, startRouter };
  }

  const exists = (file: string) => fs.existsSync(file);

  it('exits 0, removes its socket and leaves a record of the idle exit when nothing connects', async () => {
    expect(exists(routerJs)).toBe(true);
    const { paths, startRouter } = setup();
    const started = Date.now();
    const { exited } = startRouter();
    await vi.waitFor(() => expect(exists(paths.socket)).toBe(true), { timeout: 10_000 });
    expect(await exited).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
    expect(exists(paths.socket)).toBe(false);
    // The hosts start the router with its output discarded, so the database is where the exit is recorded.
    const db = openDatabase(paths.db);
    expect(readRouterIdleExit(db)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }, 30_000);

  it('leaves no idle record when it is stopped by a signal', async () => {
    const { paths, startRouter } = setup();
    const { child, exited } = startRouter();
    await vi.waitFor(() => expect(exists(paths.socket)).toBe(true), { timeout: 10_000 });
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(readRouterIdleExit(openDatabase(paths.db))).toBeUndefined();
  }, 30_000);

  it('is started again by a sender that is not a host: a session send with fallback_to_principal still stores the principal copy after an idle exit', async () => {
    const { paths, startRouter } = setup();
    const previous = process.env.MEMESH_ROUTER_SOCKET;
    process.env.MEMESH_ROUTER_SOCKET = paths.socket;
    // The first router starts, idles out and records it; nothing is listening afterwards.
    const first = startRouter();
    await vi.waitFor(() => expect(exists(paths.socket)).toBe(true), { timeout: 10_000 });
    expect(await first.exited).toBe(0);
    expect(exists(paths.socket)).toBe(false);
    const db = openDatabase(paths.db);
    const session = registerAgentSession('idle-exit', 'bob', { sessionId: 'abababab-abab-4bab-8bab-abababababab', adapterKind: 'claude-channel', disconnected: true });
    let second: ReturnType<typeof startRouter> | undefined;
    try {
      const result = await executeAgentMessageAction(db, {
        action: 'send', project: 'idle-exit', sender: 'alice', recipient: session, target_kind: 'session',
        fallback_to_principal: true, idempotency_key: 'after-idle-exit', payload: 'hello',
      }, { transport: 'http', sourceHost: 'http' }, {
        // The contract of startRouterIfDown: true once a router is listening.
        startRouterIfDown: async () => {
          second = startRouter();
          await vi.waitFor(() => expect(exists(paths.socket)).toBe(true), { timeout: 10_000 });
          return true;
        },
      }) as { fallback?: unknown };
      expect(second, 'the sender started the router').toBeDefined();
      expect(result.fallback).toBeDefined();
      expect(db.prepare("SELECT COUNT(*) AS n FROM agent_message_deliveries WHERE project = 'idle-exit' AND target_kind = 'principal' AND recipient = 'bob'").get()).toEqual({ n: 1 });
    } finally {
      if (previous === undefined) delete process.env.MEMESH_ROUTER_SOCKET; else process.env.MEMESH_ROUTER_SOCKET = previous;
    }
  }, 60_000);

  it('stays while a host is connected, ends after it leaves, and the next host connection starts a new router that delivers waiting messages', async () => {
    const { paths, startRouter } = setup();
    const first = startRouter();
    await vi.waitFor(() => expect(exists(paths.socket) && exists(paths.token)).toBe(true), { timeout: 10_000 });
    const token = fs.readFileSync(paths.token, 'utf8').trim();
    const identity = { project: 'idle-exit', principal_id: 'agent', session_instance_id: 'session-1', adapter_kind: 'claude-inbox' };
    const deliver = vi.fn(async (_delivery: RouterDelivery) => ({ host: 'fixture', status: 'queued' }));
    let routerStarts = 0;
    host = await connectRouterHost({ socket_path: paths.socket, auth_token: token, identity, deliver, resilience: { start_router: () => { routerStarts += 1; } } });
    expect(routerStarts, 'the running router was found, not started again').toBe(0);

    // Well past the idle time: a connected host keeps the router alive.
    await new Promise(resolve => setTimeout(resolve, 3500));
    expect(first.child.exitCode).toBeNull();
    expect(exists(paths.socket)).toBe(true);

    await host.close(); host = undefined;
    expect(await first.exited).toBe(0);
    expect(exists(paths.socket)).toBe(false);

    // A message stored while no router is running, then a host that starts one when it connects.
    const db = openDatabase(paths.db);
    sendAgentMessage(db, { project: 'idle-exit', sender: 'alice', recipient: 'agent', idempotency_key: 'waiting', content_type: 'text/plain', payload: 'hello' });
    let second: ReturnType<typeof startRouter> | undefined;
    host = await connectRouterHost({
      socket_path: paths.socket, auth_token: token, identity: { ...identity, session_instance_id: 'session-2' }, deliver,
      resilience: { start_router: () => { second = startRouter(); } },
    });
    expect(second).toBeDefined();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(exists(paths.socket)).toBe(true);
  }, 60_000);
});
