import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The real reinstall must never start from a test: it would run an update.
const startReinstall = vi.fn(() => ({ started: true, message: 'A verified reinstall of this version was started in the background.' }));
vi.mock('../../src/core/auto-update.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../src/core/auto-update.js')>()), startReinstall }));

// The doctor row that asks for the plugin refresh, so the route reaches the repair without inspecting this machine's real install.
vi.mock('../../src/core/doctor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/doctor.js')>();
  const report = {
    status: 'PASS_WITH_CONCERNS',
    checks: [{
      id: 'plugin', label: 'Plugin', status: 'warn', summary: 'cannot tell', fix: 'reinstall',
      fixId: 'plugin-cache-refresh', params: { host: 'Codex' },
    }],
  };
  return { ...actual, runDoctor: vi.fn(async () => report) };
});

let root: string;
let server: import('node:http').Server;
let port: number;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-doctor-plugin-cache-'));
  process.env.MEMESH_DIR = root;
  const { openDatabase } = await import('../../src/db.js');
  openDatabase(path.join(root, 'test.db'));
  const { app } = await import('../../src/transports/http/server.js');
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const { closeDatabase } = await import('../../src/db.js');
  closeDatabase();
  delete process.env.MEMESH_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('POST /v1/doctor/fix for a plugin cache', () => {
  it('starts the verified reinstall and answers at once, saying it runs in the background', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/doctor/fix`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'plugin' }),
    });
    const body = await response.json() as { success: boolean; data?: { action: { command: string; output: string }; restartRequired: boolean } };
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(startReinstall).toHaveBeenCalledTimes(1);
    expect(body.data?.action.command).toBe('memesh update --reinstall');
    expect(body.data?.action.output).toContain('verified reinstall');
  });
});
