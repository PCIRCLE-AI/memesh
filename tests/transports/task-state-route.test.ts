import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { app } from '../../src/transports/http/server.js';
import { setTaskState } from '../../src/core/task-state-store.js';
import { taskStateName } from '../../src/core/task-state.js';

let server: ReturnType<typeof app.listen>;
let base = '';
let tmpDir = '';
let previousMemeshDir: string | undefined;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-task-state-route-'));
  previousMemeshDir = process.env.MEMESH_DIR;
  process.env.MEMESH_DIR = tmpDir;
  openDatabase(path.join(tmpDir, 'test.db'));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDatabase();
  if (previousMemeshDir === undefined) delete process.env.MEMESH_DIR; else process.env.MEMESH_DIR = previousMemeshDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /v1/task-state (#237: the Project tab reads what the owner stated)', () => {
  it('returns the stated fields for a project and an empty state for one never stated', async () => {
    setTaskState({ project: 'alpha', patch: { goal: 'Ship it', blocked: 'waiting on review' } });
    const res = await fetch(`${base}/v1/task-state?project=alpha`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.project).toBe('alpha');
    expect(body.data.state).toMatchObject({ goal: 'Ship it', blocked: 'waiting on review' });
    expect(body.data.state.next).toBeUndefined();

    const none = await (await fetch(`${base}/v1/task-state?project=never-stated`)).json();
    expect(none.success).toBe(true);
    expect(none.data.state).toEqual({});
  });

  it('requires a project and names the parameter', async () => {
    const res = await fetch(`${base}/v1/task-state`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe('validation.bad-param');
    expect(body.error).toContain('project');
  });

  it('rejects an empty, blank or oversized project name with 400', async () => {
    for (const value of ['', '%20%20', 'x'.repeat(201)]) {
      const res = await fetch(`${base}/v1/task-state?project=${value}`);
      expect(res.status, `project=${value.slice(0, 12)}…`).toBe(400);
      expect((await res.json()).errorCode).toBe('validation.bad-param');
    }
    // 200 characters is the documented maximum and is accepted.
    expect((await fetch(`${base}/v1/task-state?project=${'y'.repeat(200)}`)).status).toBe(200);
  });

  it('answers 500, not an empty state, when the stored metadata is corrupted', async () => {
    setTaskState({ project: 'broken', patch: { goal: 'was fine' } });
    getDatabase().prepare('UPDATE entities SET metadata = ? WHERE name = ?').run('{oops', taskStateName('broken'));
    const res = await fetch(`${base}/v1/task-state?project=broken`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('not valid JSON');
    expect(body.error).not.toContain('task-state:');
  });

  it('the graph routes are gone with the Graph tab', async () => {
    expect((await fetch(`${base}/v1/graph`)).status).toBe(404);
    expect((await fetch(`${base}/v1/graph/evidence?node=x`)).status).toBe(404);
  });
});
