// #523: the doctor report goes into a PUBLIC GitHub issue body, so a
// private key inside any of its strings must be gone from both routes. The
// redaction used to run over the JSON-serialised report, where a line break
// is the two characters `\r\n` or `\n\t` — shapes the key pattern did not see,
// so the key body was published whole.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Assembled at runtime so no line in the repository is a key.
const HEADER = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
const BODY1 = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7';
const BODY2 = 'VJTUt9Us8cKjMzEfYyjiWA4R4M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jkc';
const SHAPES: Record<string, string> = {
  crlf: `${HEADER}\r\n${BODY1}\r\n${BODY2}`,
  tab: `${HEADER}\n\t${BODY1}\n\t${BODY2}`,
  trailing: `${HEADER}\n${BODY1}\n${BODY2} (cut by head)`,
  // A lone END line in one summary must not turn the whole report into markers.
  loneEnd: `see the line ${['-----END', 'PRIVATE KEY-----'].join(' ')} in the file`,
};

vi.mock('../../src/core/doctor.js', () => ({
  runDoctor: async () => ({
    status: 'warn',
    checks: Object.entries(SHAPES).map(([id, summary]) => ({ id, status: 'warn', summary, fixId: 'config-retired-settings' })),
  }),
}));

vi.mock('../../src/core/doctor-fixes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/doctor-fixes.js')>();
  return { ...actual, removeRetiredConfigKeys: () => ({ removed: Object.values(SHAPES) }) };
});

let root: string;
let server: import('node:http').Server;
let port: number;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-doctor-redact-'));
  process.env.MEMESH_DIR = root;
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

function expectNoKey(text: string): void {
  expect(text).not.toContain(BODY1.slice(0, 20));
  expect(text).not.toContain(BODY2.slice(0, 20));
  expect(text).toContain('***REDACTED***');
}

describe('doctor routes redact a private key in every line-break shape (#523)', () => {
  it('GET /v1/doctor', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/doctor`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expectNoKey(text);
    for (const id of Object.keys(SHAPES)) expect(text).toContain(`"id":"${id}"`);
  });

  it('POST /v1/doctor/fix', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/doctor/fix`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'crlf' }),
    });
    expect(response.status).toBe(200);
    expectNoKey(await response.text());
  });
});
