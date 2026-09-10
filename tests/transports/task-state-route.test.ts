import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { app } from '../../src/transports/http/server.js';
import { setTaskState } from '../../src/core/task-state-store.js';

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

  it('the graph routes are gone with the Graph tab', async () => {
    expect((await fetch(`${base}/v1/graph`)).status).toBe(404);
    expect((await fetch(`${base}/v1/graph/evidence?node=x`)).status).toBe(404);
  });
});
