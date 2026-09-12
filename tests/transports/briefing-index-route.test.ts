import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { app } from '../../src/transports/http/server.js';
import { remember } from '../../src/core/operations.js';

let server: ReturnType<typeof app.listen>;
let base = '';
let tmpDir = '';
let previousMemeshDir: string | undefined;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-briefing-index-route-'));
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

describe('GET /v1/briefing-index (#323: the Project tab shows what an agent is given)', () => {
  it('returns the rendered index and its counts for one project', async () => {
    remember({
      name: 'route-decision', type: 'decision', title: 'Keep the index capped',
      observations: ['Forty lines, three kilobytes.'], tags: ['project:alpha'],
    });
    remember({
      name: 'route-commit', type: 'commit', title: 'chore: bump',
      observations: ['chore: bump'], tags: ['project:alpha'],
    });
    const res = await fetch(`${base}/v1/briefing-index?project=alpha`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ project: 'alpha', shown: 1, more: 0, older: 0 });
    // The staleness window travels with the data — the dashboard renders
    // this number into its "no change in {days} days" copy, so dropping the
    // field leaves that sentence with a hole. The literal is deliberate:
    // comparing the response against INDEX_STALE_DAYS would compare the
    // constant with itself and pass with the field missing on both sides.
    expect(body.data.staleDays, 'staleDays left the payload').toBe(180);
    expect(body.data.ids).toHaveLength(1);
    expect(body.data.lines.join('\n')).toContain('Keep the index capped');
    expect(body.data.lines.join('\n')).not.toContain('chore: bump');

    const none = await (await fetch(`${base}/v1/briefing-index?project=never-used`)).json();
    expect(none.data.shown).toBe(0);
    expect(none.data.lines.join('\n')).toContain('No durable memories');
  });

  it('requires a project and names the parameter', async () => {
    const res = await fetch(`${base}/v1/briefing-index`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe('validation.bad-param');
    expect(body.error).toContain('project');
  });
});
