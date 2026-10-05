import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: vi.fn(),
}));

// The doctor row that asks for the Codex plugin refresh, so the route reaches
// refreshPluginCache without inspecting this machine's real install.
vi.mock('../../src/core/doctor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/doctor.js')>();
  const report = {
    status: 'PASS_WITH_CONCERNS',
    checks: [{
      id: 'plugin', label: 'Plugin', status: 'warn', summary: 'stale', fix: 'refresh',
      fixId: 'plugin-cache-refresh', params: { host: 'Codex' },
    }],
  };
  return { ...actual, runDoctor: vi.fn(async () => report) };
});

let root: string;
let server: import('node:http').Server;
let port: number;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-doctor-incomplete-'));
  process.env.MEMESH_DIR = root;
  const { openDatabase } = await import('../../src/db.js');
  openDatabase(path.join(root, 'test.db'));
  const { app } = await import('../../src/transports/http/server.js');
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as { port: number }).port;
});

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(execFileSync).mockReset();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const { closeDatabase } = await import('../../src/db.js');
  closeDatabase();
  delete process.env.MEMESH_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('POST /v1/doctor/fix when the Codex plugin refresh runs out of budget', () => {
  it('answers doctor.repair-incomplete with the step left to run, not server.internal', async () => {
    // The marketplace upgrade takes 119 s of the 120 s budget; only the Date
    // clock is faked, so the HTTP round trip below runs on real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.mocked(execFileSync).mockImplementation((() => {
      vi.advanceTimersByTime(119_000);
      return 'ok';
    }) as unknown as typeof execFileSync);

    const response = await fetch(`http://127.0.0.1:${port}/v1/doctor/fix`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'plugin' }),
    });
    const body = await response.json() as { success: boolean; errorCode: string; error: string };

    expect(response.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('doctor.repair-incomplete');
    expect(body.error).toContain('marketplace upgrade ran');
    expect(body.error).toContain('codex plugin add memesh@pcircle-memesh');
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(1); // `plugin add` never spawned
  });
});
