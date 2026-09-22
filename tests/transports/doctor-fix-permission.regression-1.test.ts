import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../src/core/doctor-fixes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/doctor-fixes.js')>();
  return {
    ...actual,
    removeRetiredConfigKeys: () => {
      throw Object.assign(new Error('EACCES: /Users/fixture/private/config.json'), { code: 'EACCES' });
    },
  };
});

let root: string;
let server: import('node:http').Server;
let port: number;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-doctor-permission-'));
  process.env.MEMESH_DIR = root;
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    llm: { provider: 'retired-fixture' },
    autoCapture: false,
  }));

  const { openDatabase } = await import('../../src/db.js');
  openDatabase(path.join(root, 'test.db'));
  const { app } = await import('../../src/transports/http/server.js');
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const { closeDatabase } = await import('../../src/db.js');
  closeDatabase();
  delete process.env.MEMESH_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('POST /v1/doctor/fix permission failure', () => {
  it('returns a stable path-free recovery envelope', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/doctor/fix`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'config' }),
    });
    const body = await response.json() as { success: boolean; errorCode: string; error: string };

    expect(response.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('operation.permission-denied');
    expect(body.error).toContain('`memesh serve`');
    expect(JSON.stringify(body)).not.toContain('/Users/fixture');
    expect(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).llm).toBeDefined();
  });
});
