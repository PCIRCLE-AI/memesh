import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTempDir } from '../helpers/temp-dir.js';

const captured = vi.hoisted(() => ({ routerStarts: [] as string[] }));
vi.mock('node:child_process', async original => {
  const real = await original<typeof import('node:child_process')>();
  return { ...real, spawn: (...args: Parameters<typeof real.spawn>) => {
    const argv = Array.isArray(args[1]) ? args[1] : [];
    if (args[0] === process.execPath && argv[0]?.replaceAll('\\', '/').endsWith('/dist/host-runtime/router.js')) {
      captured.routerStarts.push(argv[0]);
      throw new Error('Retired router must not start');
    }
    return real.spawn(...args);
  } };
});

describe('retired HTTP messaging never starts the packaged router', () => {
  let home: string, data: string, url: string;
  let server: Server | undefined;
  let closeDatabase: (() => void) | undefined;
  beforeEach(async () => {
    captured.routerStarts = [];
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-retired-http-')));
    data = path.join(home, 'data');
    vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('MEMESH_DIR', data); vi.stubEnv('MEMESH_DB_PATH', path.join(data, 'graph.db'));
    vi.stubEnv('MEMESH_ROUTER_SOCKET', path.join(home, 'router.sock'));
    vi.stubEnv('MEMESH_AUTO_UPDATE', 'off');
    const db = await import('../../dist/db.js');
    closeDatabase = db.closeDatabase;
    db.openDatabase(path.join(data, 'graph.db'));
    const { app } = await import('../../dist/transports/http/server.js');
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server!.once('listening', resolve));
    url = 'http://127.0.0.1:' + (server.address() as import('node:net').AddressInfo).port + '/v1/message';
  });
  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    closeDatabase?.(); vi.unstubAllEnvs(); removeTempDir(home);
  });
  async function discover() {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'discover', project: 'retired-router' }) });
    const body = await response.json() as { errorCode: string };
    expect(response.status).toBe(410); expect(body.errorCode).toBe('route.retired');
  }
  function noRuntime() {
    expect(captured.routerStarts).toEqual([]);
    expect(fs.existsSync(path.join(data, 'agent-router.token'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'router.sock'))).toBe(false);
  }
  it('returns a retirement response without starting a router', async () => {
    await discover(); noRuntime();
  });
  it('does not start a router for concurrent requests either', async () => {
    await Promise.all([discover(), discover(), discover()]); noRuntime();
  });
  it('does not inspect or overwrite stale router state', async () => {
    const stale = path.join(home, 'stale-state');
    fs.writeFileSync(stale, 'not a socket', { mode: 0o600 });
    vi.stubEnv('MEMESH_ROUTER_SOCKET', stale);
    await discover(); noRuntime();
    expect(fs.readFileSync(stale, 'utf8')).toBe('not a socket');
  });
});
