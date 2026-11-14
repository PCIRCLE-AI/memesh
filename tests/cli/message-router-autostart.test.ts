// The retained HTTP discover path starts the real packaged router when needed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { removeTempDir } from '../helpers/temp-dir.js';

const captured = vi.hoisted(() => ({ children: [] as Array<{ child: ChildProcess; pid: number | undefined; argv: string[]; started: number; exited: boolean }>, witness: [] as ChildProcess[] }));

vi.mock('node:child_process', async importOriginal => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return { ...real, spawn: (...args: Parameters<typeof real.spawn>) => {
    const child = real.spawn(...args);
    const argv = Array.isArray(args[1]) ? args[1] : [];
    if (args[0] === process.execPath && argv[0] === '-e' && argv[1] === 'process.exit(0)') captured.witness.push(child);
    if (args[0] === process.execPath && argv.length === 1 && argv[0].endsWith('/dist/host-runtime/router.js')) {
      const record = { child, pid: child.pid, argv: [...argv], started: Date.now(), exited: false };
      captured.children.push(record);
      child.once('exit', () => { record.exited = true; });
    }
    return child;
  } };
});

describe('legacy HTTP discover starts the packaged router', () => {
  let home: string;
  let socket: string;
  let server: Server;
  let attempted: boolean;
  let verifiedPreSpawn: boolean;
  let closeDatabase: () => void;

  beforeEach(async () => {
    captured.children.length = 0;
    captured.witness.length = 0;
    attempted = false;
    verifiedPreSpawn = false;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'router-'));
    socket = path.join(home, 'r.sock');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('MEMESH_DIR', path.join(home, 'data'));
    vi.stubEnv('MEMESH_DB_PATH', path.join(home, 'graph.db'));
    vi.stubEnv('MEMESH_ROUTER_SOCKET', socket);
    const db = await import('../../dist/db.js');
    closeDatabase = db.closeDatabase;
    db.openDatabase(path.join(home, 'graph.db'));
    const { app } = await import('../../dist/transports/http/server.js');
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
  });

  afterEach(async () => {
    let clean = !attempted || captured.children.length > 0 || verifiedPreSpawn;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const record of captured.children) {
      if (!record.exited && record.child.exitCode === null && record.child.signalCode === null) {
        const exited = new Promise<boolean>(resolve => {
          const timer = setTimeout(() => resolve(false), 3000);
          record.child.once('exit', () => { clearTimeout(timer); resolve(true); });
        });
        record.child.kill('SIGTERM');
        if (!await exited) clean = false;
      }
      console.info('router cleanup', JSON.stringify({ pid: record.pid, exited: record.exited, exitCode: record.child.exitCode, signalCode: record.child.signalCode }));
    }
    closeDatabase();
    vi.unstubAllEnvs();
    if (clean) removeTempDir(home);
    expect(clean, `router child status unknown; fixture retained at ${home}`).toBe(true);
  });

  async function discover() {
    attempted = true;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/message`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'discover', project: 'demo' }),
    });
    const body = await response.json();
    const errorCode = typeof body === 'object' && body !== null && 'errorCode' in body ? body.errorCode : null;
    const kind = (p: string) => fs.existsSync(p) ? (fs.lstatSync(p).isSocket() ? 'socket' : fs.lstatSync(p).isFile() ? 'file' : 'other') : 'absent';
    console.info('router response', JSON.stringify({ status: response.status, errorCode, captured: captured.children.length, graph: kind(path.join(home, 'graph.db')), socket: kind(process.env.MEMESH_ROUTER_SOCKET!) }));
    return { status: response.status, body };
  }

  it('starts a real router on the private socket, then answers', async () => {
    const witness = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    expect(captured.witness).toEqual([witness]);
    expect(await new Promise<number | null>(resolve => witness.once('exit', resolve))).toBe(0);
    expect(fs.existsSync(socket)).toBe(false);
    const result = await discover();
    expect(captured.children.length, 'real packaged spawn must be captured').toBeGreaterThan(0);
    expect(captured.children[0].argv).toEqual([path.resolve('dist/host-runtime/router.js')]);
    console.info('router captured', JSON.stringify({ pid: captured.children[0].pid, argv: captured.children[0].argv, started: captured.children[0].started }));
    expect(result.status).toBe(200);
    expect(result.body).toBeTypeOf('object');
    expect(fs.lstatSync(socket).isSocket()).toBe(true);
    expect(captured.children.filter(r => !r.exited)).toHaveLength(1);
    expect(captured.children[0].pid).toBeGreaterThan(0);
  }, 90_000);

  it('concurrent discovers share one router, which a later request reuses', async () => {
    const both = await Promise.all([discover(), discover()]);
    expect(both.map(r => r.status)).toEqual([200, 200]);
    await vi.waitFor(() => expect(captured.children.filter(r => !r.exited)).toHaveLength(1));
    const running = captured.children.find(r => !r.exited)!;
    const later = await discover();
    expect(later.status).toBe(200);
    expect(captured.children.filter(r => !r.exited)).toEqual([running]);
    expect(fs.lstatSync(socket).isSocket()).toBe(true);
  }, 120_000);

  it('reports the concrete router error when startup cannot succeed', async () => {
    const blocker = path.join(home, 'not-a-directory');
    fs.writeFileSync(blocker, 'fixture');
    const blockedSocket = path.join(blocker, 'r.sock');
    attempted = true;
    const errno = await new Promise<string | undefined>(resolve => {
      const connection = net.createConnection(blockedSocket);
      connection.setTimeout(3000, () => connection.destroy(new Error('socket probe timeout')));
      connection.once('error', error => { connection.destroy(); resolve((error as NodeJS.ErrnoException).code); });
      connection.once('connect', () => { connection.destroy(); resolve('CONNECTED'); });
    });
    console.info('private socket errno', errno);
    expect(errno).toBe('ENOTDIR');
    vi.stubEnv('MEMESH_ROUTER_SOCKET', blockedSocket);
    const result = await discover();
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ success: false, errorCode: 'operation.failed', error: expect.stringContaining('router_unreachable') });
    expect(JSON.stringify(result.body)).toContain('memesh-router');
    expect(captured.children).toHaveLength(0);
    verifiedPreSpawn = true;
  }, 90_000);
});
