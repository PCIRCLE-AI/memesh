import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { remember } from '../../src/core/operations.js';
import { app } from '../../src/transports/http/server.js';
import { handleTool } from '../../src/transports/mcp/handlers.js';

let tmpDir: string;
let server: ReturnType<typeof app.listen>;
let port: number;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-patterns-http-'));
  process.env.MEMESH_UPDATE_CHECK_PATH = path.join(tmpDir, 'update-check.json');
  openDatabase(path.join(tmpDir, 'test.db'));
  remember({ name: 'p1', type: 'decision', why: 'a placeholder choice; revisit if the test changes', observations: ['x'] });
  remember({ name: 'p2', type: 'commit', observations: ['fix: x'] });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  closeDatabase();
  delete process.env.MEMESH_UPDATE_CHECK_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function get(urlPath: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`);
  return { status: res.status, body: await res.json() };
}

describe('GET /v1/patterns categories', () => {
  it('returns every category with no filter', async () => {
    const res = await get('/v1/patterns');
    expect(res.status).toBe(200);
    expect(res.body.data.focusAreas.length).toBeGreaterThan(0);
    expect(res.body.data.workSchedule.hourDistribution.length).toBeGreaterThan(0);
    expect(res.body.data.workflow.totalCommits).toBe(1);
    expect(res.body.data.workflow.totalSessions).toBe(0);
    expect(res.body.data.focusAreas.map((f: { type: string }) => f.type)).toEqual(['decision']);
    expect(Array.isArray(res.body.data.strengths)).toBe(true);
    expect(Array.isArray(res.body.data.learningAreas)).toBe(true);
  });

  it('?categories=workflow fills only workflow, like the MCP tool', async () => {
    const res = await get('/v1/patterns?categories=workflow');
    expect(res.status).toBe(200);
    expect(res.body.data.workflow.totalCommits).toBe(1);
    expect(res.body.data.focusAreas).toEqual([]);
    expect(res.body.data.workSchedule.hourDistribution).toEqual([]);
  });

  it('accepts a comma-separated list and a repeated parameter', async () => {
    for (const q of ['categories=workflow,focusAreas', 'categories=workflow&categories=focusAreas']) {
      const res = await get(`/v1/patterns?${q}`);
      expect(res.status).toBe(200);
      expect(res.body.data.workflow.totalCommits).toBe(1);
      expect(res.body.data.focusAreas.length).toBeGreaterThan(0);
      expect(res.body.data.workSchedule.hourDistribution).toEqual([]);
    }
  });

  it('trims spaces around listed names, and leaves workflow empty when it was not asked for', async () => {
    const spaced = await get('/v1/patterns?categories=workflow,%20focusAreas');
    expect(spaced.status).toBe(200);
    expect(spaced.body.data.workflow.totalCommits).toBe(1);
    const focusOnly = await get('/v1/patterns?categories=focusAreas');
    expect(focusOnly.status).toBe(200);
    expect(focusOnly.body.data.workflow.totalCommits).toBe(0);
  });

  it('refuses an unknown category with 400 validation.bad-param', async () => {
    const res = await get('/v1/patterns?categories=bogus');
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('validation.bad-param');
    expect(res.body.error).toMatch(/categories/);
    expect(res.body.error).toMatch(/workSchedule/);
  });

  it('treats an empty ?categories= as no filter, as the docs say', async () => {
    const res = await get('/v1/patterns?categories=');
    expect(res.status).toBe(200);
    expect(res.body.data.workflow.totalCommits).toBe(1);
    expect(res.body.data.focusAreas.length).toBeGreaterThan(0);
    expect(res.body.data.workSchedule.hourDistribution.length).toBeGreaterThan(0);
  });

  it('refuses the bracket spellings instead of silently returning every category', async () => {
    for (const q of ['categories[]=workflow', 'categories[a]=workflow']) {
      const res = await get(`/v1/patterns?${q}`);
      expect(res.status, q).toBe(400);
      expect(res.body.errorCode, q).toBe('validation.bad-param');
      expect(res.body.error, q).toMatch(/categories=a,b/);
    }
  });
});

describe('user_patterns MCP text', () => {
  it('labels the strengths number as an average confidence, not a count', async () => {
    remember({ name: 'd1', type: 'lesson_learned', observations: ['a'] });
    remember({ name: 'd2', type: 'lesson_learned', observations: ['b'] });
    const result = await handleTool('user_patterns', { categories: ['strengths'] });
    const text = result.content.map((c) => c.text).join('\n');
    expect(text).toMatch(/lesson_learned \(avg confidence [0-9.]+\)/);
    // The heading says what the list is: no confidence threshold, just 2+ memories ranked by average.
    expect(text).toContain('### Strengths (types with 2+ memories, by average confidence)');
    expect(text).not.toContain('high confidence');
  });
});
