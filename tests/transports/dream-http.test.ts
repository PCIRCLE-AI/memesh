import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { app } from '../../src/transports/http/server.js';

// Removed generation route and retained human-review failure contract.

let tmpDir: string;
let server: ReturnType<typeof app.listen>;
let port: number;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-dream-http-'));
  // Isolate update-check + config files so this suite cannot collide
  // with `tests/transports/http.test.ts` running in the same fork.
  process.env.MEMESH_UPDATE_CHECK_PATH = path.join(tmpDir, 'update-check.json');
  openDatabase(path.join(tmpDir, 'test.db'));

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  closeDatabase();
  delete process.env.MEMESH_UPDATE_CHECK_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function req(method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: any }> {
  const url = `http://127.0.0.1:${port}${urlPath}`;
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return { status: res.status, body: await res.json() };
}

describe('HTTP Transport: removed dream generation', () => {
  it('returns route.not-found instead of staging a built-in generation', async () => {
    const res = await req('POST', '/v1/dream/run', { windowDays: 14, maxLlmCalls: 1 });
    expect(res.status).toBe(404);
    expect(res.body.errorCode).toBe('route.not-found');
  });
});

describe('HTTP Transport: POST /v1/dream/proposals/:id/accept', () => {
  it('answers an empty-claim proposal with 400 operation.failed, not 500', async () => {
    // NothingToClaimError is the server resolving the proposal, not the server
    // breaking. As a 500 `server.internal` a dashboard's generic retry logic
    // retried it, and the retry — the proposal now being rejected — got a 404:
    // two contradictory errors for one click. The contract is one answer that
    // names the outcome.
    const { getDatabase } = await import('../../src/db.js');
    const db = getDatabase();
    db.prepare(`
      INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, prompt_version)
      VALUES ('memesh', '2026-W19', ?, ?, 'v1')
    `).run(
      JSON.stringify([999901, 999902]), // no such entities — the digest can claim nothing
      JSON.stringify({ name: 'http-empty-digest', type: 'digest', observations: ['s'], tags: ['digest'] })
    );
    const id = (db.prepare("SELECT id FROM dream_proposals WHERE status='pending' ORDER BY id DESC").get() as { id: number }).id;

    const res = await req('POST', `/v1/dream/proposals/${id}/accept`);
    expect(res.status, 'an empty-claim proposal surfaced as a server failure').toBe(400);
    expect(res.body.errorCode).toBe('operation.failed');
    expect(res.body.error).toMatch(/claimed nothing/);

    // And the server really did resolve it: rejected, not still pending.
    const row = db.prepare('SELECT status FROM dream_proposals WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('rejected');
  });
});
