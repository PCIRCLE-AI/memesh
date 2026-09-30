/**
 * #518: a message router started before an upgrade keeps running the old code.
 * A host connecting to it must notice: a router from before versions were
 * reported is refused with a restart instruction, a versioned router older
 * than the host steps aside so the installed version starts, and a router
 * newer than the host is used as is.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../../src/db.js';
import { AGENT_ROUTER_PROTOCOL_VERSION, AgentRouter } from '../../src/core/agent-router.js';
import { connectRouterHost, type RouterHostConnection } from '../../src/host-runtime/router-client.js';
import { memeshPackageVersion } from '../../src/host-runtime/package-version.js';

const routers: AgentRouter[] = [];
const servers: net.Server[] = [];
let connection: RouterHostConnection | undefined;
let tempDir: string | undefined;

afterEach(async () => {
  await connection?.close();
  connection = undefined;
  for (const router of routers.splice(0)) await router.stop();
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  closeDatabase();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function setup() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-router-version-'));
  fs.chmodSync(tempDir, 0o700);
  const db = openDatabase(path.join(tempDir, 'messages.db'));
  return { db, socketPath: path.join(tempDir, 'router.sock') };
}

function makeRouter(
  db: ReturnType<typeof openDatabase>,
  socketPath: string,
  memeshVersion: string,
  onSuperseded?: () => void,
): AgentRouter {
  return new AgentRouter({
    db,
    socket_path: socketPath,
    memesh_version: memeshVersion,
    ...(onSuperseded ? { on_superseded: onSuperseded } : {}),
    adapters: [{ kind: 'codex-app-server', authenticate: value => value.auth_token === 'token' }],
  });
}

function connect(socketPath: string, startRouter: () => Promise<void>, attempts = 10) {
  return connectRouterHost({
    socket_path: socketPath,
    auth_token: 'token',
    identity: {
      project: 'project-a', principal_id: 'principal-a',
      session_instance_id: 'session-a', adapter_kind: 'codex-app-server',
    },
    deliver: async () => ({ host: 'fixture', status: 'queued' }),
    resilience: {
      initial_retry_ms: 10, max_retry_ms: 20, retry_jitter: 0,
      initial_attempts: attempts, start_router: startRouter,
    },
  });
}

/** Answers a register the way a router from before #518 does. */
async function startLegacyRouter(socketPath: string, answer: 'rejects-version-field' | 'omits-version'): Promise<void> {
  const server = net.createServer(socket => {
    socket.once('data', chunk => {
      const request = JSON.parse(chunk.toString('utf8').trim()) as Record<string, unknown>;
      const frame = answer === 'rejects-version-field' && 'memesh_version' in request
        ? {
          version: AGENT_ROUTER_PROTOCOL_VERSION, request_id: '', ok: false,
          error: { code: 'unexpected_field', message: 'Router frame contains unsupported field memesh_version.' },
        }
        : {
          version: AGENT_ROUTER_PROTOCOL_VERSION, request_id: request.request_id, ok: true,
          result: { connection_id: 'connection-1', generation: 1, lease_ms: 60_000, drain_scheduled: true },
        };
      socket.write(`${JSON.stringify(frame)}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  fs.chmodSync(socketPath, 0o600);
}

describe.skipIf(process.platform === 'win32')('Feature: #518 an old router after an upgrade', () => {
  it('the installed version is read from the package', () => {
    const version = memeshPackageVersion();
    const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as { version: string };
    expect(version).toBe(pkg.version);
    expect(version.length).toBeGreaterThan(0);
  });

  it('a router reports its version when a host registers', async () => {
    const { db, socketPath } = setup();
    const router = makeRouter(db, socketPath, memeshPackageVersion());
    await router.start();
    routers.push(router);
    connection = await connect(socketPath, async () => undefined, 1);
    expect(connection.router_version).toBe(memeshPackageVersion());
  });

  it('a router from before versions were reported is refused with a restart instruction', async () => {
    const { socketPath } = setup();
    await startLegacyRouter(socketPath, 'rejects-version-field');
    await expect(connect(socketPath, async () => undefined, 1)).rejects.toMatchObject({
      code: 'router_outdated',
      message: expect.stringContaining('pkill -f dist/host-runtime/router.js'),
    });
  });

  it('a router that answers without a version is treated as outdated', async () => {
    const { socketPath } = setup();
    await startLegacyRouter(socketPath, 'omits-version');
    await expect(connect(socketPath, async () => undefined, 1)).rejects.toMatchObject({ code: 'router_outdated' });
  });

  it('an older versioned router steps aside and the installed version takes over', async () => {
    const { db, socketPath } = setup();
    const onSuperseded = vi.fn(() => { void old.stop(); });
    const old = makeRouter(db, socketPath, '1.0.0', onSuperseded);
    await old.start();
    routers.push(old);

    const startRouter = vi.fn(async () => {
      const current = makeRouter(db, socketPath, memeshPackageVersion());
      await current.start();
      routers.push(current);
    });
    connection = await connect(socketPath, startRouter);

    expect(onSuperseded).toHaveBeenCalledTimes(1);
    expect(connection.router_version).toBe(memeshPackageVersion());
  });

  it('an older router started again soon after stepping aside refuses to start', async () => {
    const { db, socketPath } = setup();
    const old = makeRouter(db, socketPath, '1.0.0', () => { void old.stop(); });
    await old.start();
    routers.push(old);
    const startRouter = async () => {
      const current = makeRouter(db, socketPath, memeshPackageVersion());
      await current.start();
      routers.push(current);
    };
    connection = await connect(socketPath, startRouter);
    await connection.close();
    connection = undefined;
    for (const router of routers.splice(0)) await router.stop();

    await expect(makeRouter(db, socketPath, '1.0.0').start()).rejects.toMatchObject({ code: 'router_superseded' });
    const same = makeRouter(db, socketPath, memeshPackageVersion());
    await same.start();
    routers.push(same);
  });

  it('a router newer than the host is used as is', async () => {
    const { db, socketPath } = setup();
    const onSuperseded = vi.fn();
    const router = makeRouter(db, socketPath, '999.0.0', onSuperseded);
    await router.start();
    routers.push(router);
    connection = await connect(socketPath, async () => undefined, 1);
    expect(connection.router_version).toBe('999.0.0');
    expect(onSuperseded).not.toHaveBeenCalled();
  });
});
