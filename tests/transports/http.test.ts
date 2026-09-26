import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';

// Import the Express app (not startServer, which opens its own DB and binds a port).
// We open our own isolated DB and start the app on a random port.
import { app, startServer, __setRemoteTokenForTest, isLoopbackRequest } from '../../src/transports/http/server.js';
import { readConfig } from '../../src/core/config.js';

let tmpDir: string;
let server: ReturnType<typeof app.listen>;
let port: number;
let updateCheckPath: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-http-'));
  updateCheckPath = path.join(tmpDir, 'update-check.json');
  process.env.MEMESH_UPDATE_CHECK_PATH = updateCheckPath;
  // Point EVERY config read/write at the tmp dir. The DB was always
  // isolated (explicit path below), but the /v1/config POST tests write
  // through updateConfig(), which resolves ~/.memesh when MEMESH_DIR is
  // unset — so running this file with vitest directly (outside
  // run-tests-isolated's throwaway HOME) mutated the DEVELOPER'S REAL
  // config: sessionLimit overwritten, llm/llmFallbacks wiped by the
  // reset-to-Core-Mode test. That is exactly the class of accident
  // CLAUDE.md's "uses YOUR ~/.memesh" warning describes; isolate here so
  // the warning stops depending on which runner invoked the file.
  process.env.MEMESH_DIR = tmpDir;
  openDatabase(path.join(tmpDir, 'test.db'));

  // Bind on port 0 → OS assigns a free port
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as any).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  closeDatabase();
  delete process.env.MEMESH_UPDATE_CHECK_PATH;
  delete process.env.MEMESH_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── Helper ───────────────────────────────────────────────────────────────────

async function req(method: string, urlPath: string, body?: unknown) {
  const url = `http://127.0.0.1:${port}${urlPath}`;
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return { status: res.status, body: await res.json() };
}

// ── Body-parsing failures answer JSON, never Express's HTML error page ──────

describe('HTTP Transport: body-parsing failures', () => {
  it('malformed JSON answers 400 JSON, not an HTML stack trace', async () => {
    // The P7 audit sent `{not json` and got Express's default error page:
    // HTML, a full stack trace, and this machine's absolute paths — served
    // to remote callers under --allow-remote. Every /v1 error is JSON.
    const res = await fetch(`http://127.0.0.1:${port}/v1/remember`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{definitely not json',
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text, 'the body must be JSON, not an HTML error page').not.toContain('<');
    expect(text).not.toContain('at ');
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('not valid JSON');
    // Stable code alongside (never replacing) the prose — the dashboard
    // translates codes, scripts branch on them. English sentences are
    // not a machine contract.
    expect(parsed.errorCode).toBe('validation.bad-body');
  });

  it('a non-JSON Content-Type names the header on the hand-rolled routes too', async () => {
    // The review of the first fix found the guard only inside handlePost,
    // while /v1/recall (the single most-used endpoint), /v1/config and
    // /v1/config/test hand-roll their parsing and still emitted Zod's
    // "expected object, received undefined". One owner now; this pins the
    // busiest of the three.
    const res = await fetch(`http://127.0.0.1:${port}/v1/recall`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ query: 'anything' }),
    });
    expect(res.status).toBe(400);
    const parsed = await res.json();
    expect(String(parsed.hint ?? parsed.error)).toContain('Content-Type');
  });

  it('a non-JSON Content-Type names the header as the problem', async () => {
    // express.json() skips other content types, req.body stays undefined,
    // and the old Zod message ("expected object, received undefined") sent
    // users off to fix their body when the problem was the header.
    const res = await fetch(`http://127.0.0.1:${port}/v1/remember`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ name: 'x', type: 'test' }),
    });
    expect(res.status).toBe(400);
    const parsed = await res.json();
    expect(parsed.success).toBe(false);
    expect(String(parsed.hint ?? parsed.error), 'the message must point at Content-Type').toContain('Content-Type');
  });
});

describe('HTTP Transport: Dashboard doctor repairs', () => {
  it('applies retired-config cleanup only after explicit POST and returns a fresh readback', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      llm: { apiKey: 'fixture-secret' },
      autoUpdate: 'patch',
      futureSetting: { keep: true },
    }));

    const before = await req('GET', '/v1/doctor');
    const config = before.body.data.checks.find((check: any) => check.id === 'config');
    expect(config.fixId).toBe('config-retired-settings');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).llm).toBeDefined();

    const fixed = await req('POST', '/v1/doctor/fix', { id: 'config' });
    expect(fixed.status).toBe(200);
    expect(fixed.body.data.after.checks.find((check: any) => check.id === 'config')?.status).toBe('pass');
    expect(JSON.stringify(fixed.body)).not.toContain('fixture-secret');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({ autoUpdate: 'patch', futureSetting: { keep: true } });
    const backups = fs.readdirSync(tmpDir).filter((name) => name.startsWith('config.json.bak-'));
    expect(backups).toHaveLength(1);
  });
});

// ── Health ───────────────────────────────────────────────────────────────────

describe('HTTP Transport: GET /v1/health', () => {
  it('returns 200 with status ok', async () => {
    const res = await req('GET', '/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
  });

  it('includes version, entity_count, and demo_entity_count', async () => {
    const res = await req('GET', '/v1/health');
    expect(typeof res.body.data.version).toBe('string');
    expect(typeof res.body.data.entity_count).toBe('number');
    expect(typeof res.body.data.demo_entity_count).toBe('number');
  });

  it('tracks demo-tagged entities across seed and reset without removing real entities', async () => {
    await req('POST', '/v1/remember', { name: 'health-real-memory', type: 'note' });
    const before = await req('GET', '/v1/health');
    expect(before.body.data.demo_entity_count).toBe(0);

    const seeded = await req('POST', '/v1/demo/seed');
    expect(seeded.status).toBe(200);
    const afterSeed = await req('GET', '/v1/health');
    expect(afterSeed.body.data.demo_entity_count).toBe(30);
    expect(afterSeed.body.data.entity_count).toBe(before.body.data.entity_count + 30);

    const reset = await req('POST', '/v1/demo/reset');
    expect(reset.status).toBe(200);
    const afterReset = await req('GET', '/v1/health');
    expect(afterReset.body.data.demo_entity_count).toBe(0);
    expect(afterReset.body.data.entity_count).toBe(before.body.data.entity_count);
  });
});

// ── Remember ─────────────────────────────────────────────────────────────────

describe('HTTP Transport: POST /v1/remember', () => {
  it('stores entity and returns stored=true', async () => {
    const res = await req('POST', '/v1/remember', { name: 'http-alpha', type: 'note' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.stored).toBe(true);
    expect(res.body.data.name).toBe('http-alpha');
  });

  it('stores entity with observations', async () => {
    const res = await req('POST', '/v1/remember', {
      name: 'http-beta',
      type: 'decision',
      observations: ['Use TLS everywhere'],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.observations).toBe(1);
  });

  it('stores entity with tags', async () => {
    const res = await req('POST', '/v1/remember', {
      name: 'http-gamma',
      type: 'pattern',
      tags: ['env:prod'],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.tags).toBe(1);
  });

  it('stamps source_host=http on the stored entity', async () => {
    // The route wrapper injects sourceHost: 'http' — deleting that injection
    // used to leave the whole suite green. Read the stamp back out.
    await req('POST', '/v1/remember', {
      name: 'http-prov',
      type: 'note',
      observations: ['http-prov-unique-obs'],
    });
    const res = await req('POST', '/v1/recall', { query: 'http-prov-unique-obs' });
    const found = res.body.data.entities.find((e: any) => e.name === 'http-prov');
    expect(found.metadata.provenance.source_host).toBe('http');
  });
});

// ── Recall ────────────────────────────────────────────────────────────────────

describe('HTTP Transport: POST /v1/recall', () => {
  beforeAll(async () => {
    await req('POST', '/v1/remember', {
      name: 'recall-target',
      type: 'note',
      observations: ['unique-recall-obs-abc'],
    });
  });

  it('returns matching entities by query', async () => {
    const res = await req('POST', '/v1/recall', { query: 'unique-recall-obs-abc' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.entities).toBeDefined();
    expect(res.body.data.entities.length).toBeGreaterThanOrEqual(1);
    const found = res.body.data.entities.find((e: any) => e.name === 'recall-target');
    expect(found).toBeDefined();
    // R2: every recall envelope reports how it was answered.
    expect(res.body.data.retrieval.mode).toBe('fts');
    expect(res.body.data.retrieval.degraded).toBe(false);
    expect(typeof res.body.data.retrieval.truncated).toBe('boolean');
  });

  it('returns an empty array for a no-match query', async () => {
    const res = await req('POST', '/v1/recall', { query: 'no-match-xyz-999' });
    expect(res.status).toBe(200);
    expect(res.body.data.entities).toBeDefined();
    expect(Array.isArray(res.body.data.entities)).toBe(true);
    expect(res.body.data.entities).toEqual([]);
    for (const e of res.body.data.entities) {
      expect(typeof e.name).toBe('string');
      expect(typeof e.type).toBe('string');
    }
  });

  it('lists entities when no query provided', async () => {
    const res = await req('POST', '/v1/recall', {});
    expect(res.status).toBe(200);
    expect(res.body.data.entities).toBeDefined();
    expect(Array.isArray(res.body.data.entities)).toBe(true);
    expect(res.body.data.entities.length).toBeGreaterThan(0);
  });
});

// ── Get single entity ────────────────────────────────────────────────────────

describe('HTTP Transport: GET /v1/entities/:name', () => {
  beforeAll(async () => {
    await req('POST', '/v1/remember', { name: 'entity-lookup', type: 'test' });
  });

  it('returns entity by name', async () => {
    const res = await req('GET', '/v1/entities/entity-lookup');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.name).toBe('entity-lookup');
  });

  it('returns 404 for missing entity', async () => {
    const res = await req('GET', '/v1/entities/no-such-entity-xyz');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

// ── List entities ─────────────────────────────────────────────────────────────

describe('HTTP Transport: GET /v1/entities', () => {
  it('returns list of entities', async () => {
    const res = await req('GET', '/v1/entities');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('respects limit query param', async () => {
    const res = await req('GET', '/v1/entities?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(1);
  });
});

// ── Forget ────────────────────────────────────────────────────────────────────

describe('HTTP Transport: POST /v1/forget', () => {
  beforeAll(async () => {
    await req('POST', '/v1/remember', { name: 'http-forget-me', type: 'note' });
  });

  it('archives entity and returns archived=true', async () => {
    const res = await req('POST', '/v1/forget', { name: 'http-forget-me' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.archived).toBe(true);
  });

  it('returns archived=false for non-existent entity', async () => {
    const res = await req('POST', '/v1/forget', { name: 'ghost-entity-xyz' });
    expect(res.status).toBe(200);
    expect(res.body.data.archived).toBe(false);
  });
});

describe('HTTP Transport: POST /v1/import and archived memories (#363)', () => {
  const statusOf = (name: string) =>
    (getDatabase().prepare('SELECT status FROM entities WHERE name = ?').get(name) as { status: string }).status;
  const observationsOf = (name: string) =>
    (getDatabase()
      .prepare('SELECT o.content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = ? ORDER BY o.id')
      .all(name) as Array<{ content: string }>).map((r) => r.content);
  const bundleFor = (name: string) => ({
    version: '3.1.0', exported_at: '2026-09-20T00:00:00.000Z', entity_count: 1,
    entities: [{ name, type: 'note', namespace: 'personal', observations: ['bundle text'], tags: [], relations: [] }],
  });
  const seedArchived = async (name: string) => {
    await req('POST', '/v1/remember', { name, type: 'note', observations: ['original text'] });
    expect((await req('POST', '/v1/forget', { name })).body.data.archived).toBe(true);
    expect(statusOf(name), 'fixture: entity must start archived').toBe('archived');
  };

  it('leaves an archived entity archived and reports kept_archived', async () => {
    await seedArchived('http-import-kept');
    const res = await req('POST', '/v1/import', { data: bundleFor('http-import-kept'), merge_strategy: 'append' });
    expect(res.status).toBe(200);
    expect(res.body.data.kept_archived).toBe(1);
    expect(res.body.data.appended).toBe(0);
    expect(statusOf('http-import-kept')).toBe('archived');
    expect(observationsOf('http-import-kept')).toEqual(['original text']);
  });

  it('restore_archived: true brings it back', async () => {
    await seedArchived('http-import-restored');
    const res = await req('POST', '/v1/import', {
      data: bundleFor('http-import-restored'), merge_strategy: 'append', restore_archived: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.kept_archived).toBe(0);
    expect(res.body.data.appended).toBe(1);
    expect(statusOf('http-import-restored')).toBe('active');
    expect(observationsOf('http-import-restored')).toContain('bundle text');
  });

  it('refuses restore_archived with `skip`, as it does an unknown strategy: 400 with the core message', async () => {
    await seedArchived('http-import-skip-restore');
    const res = await req('POST', '/v1/import', {
      data: bundleFor('http-import-skip-restore'), merge_strategy: 'skip', restore_archived: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.errorCode).toBe('operation.failed');
    expect(res.body.error).toContain('restore_archived (--restore-archived) only applies with merge strategy "append" or "overwrite"');
    expect(statusOf('http-import-skip-restore')).toBe('archived');
    expect(observationsOf('http-import-skip-restore')).toEqual(['original text']);
  });

  it('refuses a restore_archived that is not a boolean, and changes nothing', async () => {
    await seedArchived('http-import-not-boolean');
    const res = await req('POST', '/v1/import', {
      data: bundleFor('http-import-not-boolean'), merge_strategy: 'append', restore_archived: 'yes',
    });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(statusOf('http-import-not-boolean')).toBe('archived');
  });
});

describe('HTTP Transport: GET /v1/update-status', () => {
  it('returns cached update metadata when requested', async () => {
    const now = Date.now();
    const lastSuccessfulCheckAt = new Date(now - 60 * 60 * 1000).toISOString();
    const lastAttemptAt = new Date(now - 45 * 60 * 1000).toISOString();

    // Use the running package's installed version so version-scoped
    // fields (lastError, deprecation) are returned unchanged. With a
    // mismatched currentVersion in the cache, the round-10 fix
    // correctly clears those fields as belonging to a prior install.
    const installedVersion = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).version;

    fs.writeFileSync(updateCheckPath, JSON.stringify({
      currentVersion: installedVersion,
      latestVersion: '9.9.9',
      lastAttemptAt,
      lastSuccessfulCheckAt,
      lastError: 'npm unavailable',
      checkSucceeded: false,
    }));

    const res = await req('GET', '/v1/update-status?cached=1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.currentVersion).toBeDefined();
    expect(res.body.data.latestVersion).toBe('9.9.9');
    expect(res.body.data.updateAvailable).toBe(true);
    expect(res.body.data.checkSucceeded).toBe(false);
    expect(res.body.data.source).toBe('cache');
    expect(res.body.data.checkedAt).toBe(lastAttemptAt);
    expect(res.body.data.lastAttemptAt).toBe(lastAttemptAt);
    expect(res.body.data.lastSuccessfulCheckAt).toBe(lastSuccessfulCheckAt);
    expect(res.body.data.lastError).toBe('npm unavailable');
    expect(res.body.data.freshness).toBe('cached');
    expect(res.body.data.installChannel).toBe('source-checkout');
    expect(res.body.data.canSelfUpdate).toBe(false);
    expect(res.body.data.recommendedCommand).toBeNull();
  });

  it('returns an unavailable state when no successful check has been recorded', async () => {
    const installedVersion = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).version;
    fs.writeFileSync(updateCheckPath, JSON.stringify({
      currentVersion: installedVersion,
      latestVersion: null,
      lastAttemptAt: '2026-04-24T11:00:00.000Z',
      lastSuccessfulCheckAt: null,
      lastError: 'registry offline',
      checkSucceeded: false,
    }));

    const res = await req('GET', '/v1/update-status?cached=1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.currentVersion).toBeDefined();
    expect(res.body.data.latestVersion).toBeNull();
    expect(res.body.data.updateAvailable).toBe(false);
    expect(res.body.data.checkSucceeded).toBe(false);
    expect(res.body.data.source).toBe('cache');
    expect(res.body.data.checkedAt).toBe('2026-04-24T11:00:00.000Z');
    expect(res.body.data.lastAttemptAt).toBe('2026-04-24T11:00:00.000Z');
    expect(res.body.data.lastSuccessfulCheckAt).toBeNull();
    expect(res.body.data.lastError).toBe('registry offline');
    expect(res.body.data.freshness).toBe('unavailable');
    expect(res.body.data.installChannel).toBe('source-checkout');
    expect(res.body.data.canSelfUpdate).toBe(false);
    expect(res.body.data.recommendedCommand).toBeNull();
  });
});

// ── Stats ─────────────────────────────────────────────────────────────────────

describe('HTTP Transport: GET /v1/stats', () => {
  beforeAll(async () => {
    await req('POST', '/v1/remember', { name: 'stats-test', type: 'note', observations: ['data'] });
  });

  it('returns aggregate counts', async () => {
    const res = await req('GET', '/v1/stats');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.totalEntities).toBeGreaterThanOrEqual(1);
    expect(res.body.data.typeDistribution).toBeDefined();
  });
});

// ── Body limit ────────────────────────────────────────────────────────────────

describe('HTTP Transport: 1MB request body limit', () => {
  it('rejects oversized JSON with a structured 413 (not an HTML error page)', async () => {
    // Build a JSON body > 1MB. The simplest path: a string field whose
    // value is 1.5 MB of repeated characters. JSON.stringify wraps with
    // quotes + the field name; the resulting body comfortably exceeds the cap.
    const filler = 'x'.repeat(1.5 * 1024 * 1024);
    const url = `http://127.0.0.1:${port}/v1/remember`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'oversize', type: 'note', observations: [filler] }),
    });
    expect(res.status).toBe(413);
    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).toMatch(/application\/json/);
    const body = await res.json() as { success: boolean; code?: string; limit?: string; errorCode?: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('PAYLOAD_TOO_LARGE');
    // `code` predates the errorCode contract and is kept for back-compat;
    // `errorCode` is the field consistent across every error class.
    expect(body.errorCode).toBe('payload.too-large');
    expect(body.limit).toBe('1mb');
  });

  it('accepts a small JSON payload (control — confirms 1MB cap is not too aggressive)', async () => {
    const res = await req('POST', '/v1/remember', {
      name: 'tiny',
      type: 'note',
      observations: ['short observation'],
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ── Stable errorCode contract ─────────────────────────────────────────────────
//
// Every `success: false` envelope carries a machine `errorCode` ALONGSIDE the
// human `error` string. The prose is English and free to be reworded; the
// code is what the dashboard translates into the user's locale and what
// scripts branch on. These tests pin one representative per error class that
// the auth tests above don't already cover (401s and 413 are pinned in their
// own sections).

describe('HTTP Transport: stable errorCode on error envelopes', () => {
  it('a Zod validation failure carries validation.bad-body', async () => {
    // Empty object — RememberSchema requires name/type at minimum.
    const res = await req('POST', '/v1/remember', {});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error, 'the human message must survive next to the code').toBeTruthy();
    expect(res.body.errorCode).toBe('validation.bad-body');
  });

  it('the retired /v1/consolidate route carries route.retired on its 410', async () => {
    const res = await req('POST', '/v1/consolidate', {});
    expect(res.status).toBe(410);
    expect(res.body.success).toBe(false);
    // The prose names the replacement; the code is what a client switches on.
    expect(res.body.error).toContain('work_package');
    expect(res.body.errorCode).toBe('route.retired');
  });

  it('the retired /v1/verify route carries route.retired on its 410', async () => {
    const res = await req('POST', '/v1/verify', {});
    expect(res.status).toBe(410);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('/v1/remember');
    expect(res.body.errorCode).toBe('route.retired');
  });

  it('an unknown route carries route.not-found (legacy `code` field preserved)', async () => {
    const res = await req('GET', '/v1/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.body.errorCode).toBe('route.not-found');
    expect(res.body.code, 'pre-existing code field must not be dropped').toBe('NOT_FOUND');
  });
});

// ── Graph ─────────────────────────────────────────────────────────────────────

// ── Learn ─────────────────────────────────────────────────────────────────────

describe('HTTP Transport: POST /v1/learn', () => {
  it('creates a lesson_learned entity and returns learned=true', async () => {
    const res = await req('POST', '/v1/learn', { error: 'NullPointerException', fix: 'Added null guard' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.learned).toBe(true);
    expect(res.body.data.type).toBe('lesson_learned');
    expect(res.body.data.name).toContain('lesson-');
  });

  it('stamps source_host=http on the lesson entity', async () => {
    // Same guard as the remember route: the wrapper injection is the only
    // thing carrying provenance here, so its absence must turn a test red.
    await req('POST', '/v1/learn', { error: 'http-learn-prov-unique boom', fix: 'reseat the cable' });
    const res = await req('POST', '/v1/recall', { query: 'http-learn-prov-unique' });
    const found = res.body.data.entities.find((e: any) => e.name.startsWith('lesson-'));
    expect(found.metadata.provenance.source_host).toBe('http');
  });

  it('accepts optional fields', async () => {
    const res = await req('POST', '/v1/learn', {
      error: 'DB timeout on write',
      fix: 'Increased write timeout',
      root_cause: 'Default timeout too low',
      prevention: 'Always configure timeouts explicitly',
      severity: 'major',
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns 400 when error field is missing', async () => {
    const res = await req('POST', '/v1/learn', { fix: 'Some fix' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 when fix field is missing', async () => {
    const res = await req('POST', '/v1/learn', { error: 'Some error' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe('HTTP Transport: POST /v1/message', () => {
  it('wakes one waiting recipient and keeps the notification payload-free', async () => {
    const project = 'http-message-live';
    const waiting = req('POST', '/v1/message', {
      action: 'poll', project, recipient: 'receiver-http', wait_ms: 500, limit: 20,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    const sent = await req('POST', '/v1/message', {
      action: 'send',
      project,
      sender: 'sender-http',
      recipient: 'receiver-http',
      idempotency_key: 'http-send-1',
      payload: { text: 'wake up', payload_only: 'not-in-header' },
      content_type: 'application/json',
      privacy: 'private',
    });
    expect(sent.status).toBe(200);

    const delivered = await waiting;
    expect(delivered.status).toBe(200);
    expect(delivered.body.data.events).toHaveLength(1);
    expect(delivered.body.data.events[0].message_id).toBe(sent.body.data.message_id);
    expect(JSON.stringify(delivered.body.data.events[0])).not.toContain('not-in-header');

    const control = await req('POST', '/v1/message', {
      action: 'poll', project, recipient: 'control-http', wait_ms: 0,
    });
    expect(control.body.data.events).toEqual([]);
  });

  it('fetch does not imply ACK and foreign recipients get no payload', async () => {
    const project = 'http-message-fetch';
    const sent = await req('POST', '/v1/message', {
      action: 'send',
      project,
      sender: 'sender-http',
      recipient: 'receiver-http',
      idempotency_key: 'http-send-1',
      payload: 'private body',
    });
    const messageId = sent.body.data.message_id;

    const fetched = await req('POST', '/v1/message', {
      action: 'fetch', project, recipient: 'receiver-http', message_id: messageId,
    });
    expect(fetched.body.data.payload).toBe('private body');

    const receipts = await req('POST', '/v1/message', {
      action: 'receipts', project, recipient: 'receiver-http', message_id: messageId,
    });
    expect(receipts.body.data).toEqual([]);

    const foreign = await req('POST', '/v1/message', {
      action: 'fetch', project, recipient: 'control-http', message_id: messageId,
    });
    expect(foreign.status).toBe(400);
    expect(foreign.body.success).toBe(false);
    expect(JSON.stringify(foreign.body)).not.toContain('private body');
  });
});

describe('HTTP Transport: POST /v1/why', () => {
  it('joins caller-resolved hashes to commit entities and reports typed abstentions', async () => {
    // The route runs NO git — hashes come from the caller (WhySchema's
    // documented contract). Seed an abbrev-named commit entity the way
    // post-commit does, then query with the full sha.
    const fullSha = 'abcdef0123456789abcdef0123456789abcdef01';
    await req('POST', '/v1/remember', {
      name: `commit-${fullSha.slice(0, 7)}`,
      type: 'commit',
      observations: ['feat: why over http'],
    });
    const res = await req('POST', '/v1/why', { file: 'src/auth.ts', commits: [fullSha, 'f'.repeat(40)] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.basename).toBe('auth.ts');
    expect(res.body.data.commits).toHaveLength(2);
    expect(res.body.data.commits[0].entity.name).toBe(`commit-${fullSha.slice(0, 7)}`);
    expect(res.body.data.commits[1].entity).toBeNull();
    expect(res.body.data.commits[1].abstentions).toEqual(['no_commit_entity']);
    expect(res.body.data.file_memories.basis).toBe('file-tag');
  });

  it('rejects a non-hex hash and an unknown key (strict schema)', async () => {
    const bad = await req('POST', '/v1/why', { file: 'a.ts', commits: ['not-a-sha'] });
    expect(bad.status).toBe(400);
    expect(bad.body.success).toBe(false);

    // No repo-path key exists on purpose — the server must never be handed
    // a directory to run git in. Strictness is what keeps that true.
    const sneaky = await req('POST', '/v1/why', { file: 'a.ts', cwd: '/tmp/somewhere' });
    expect(sneaky.status).toBe(400);
    expect(sneaky.body.success).toBe(false);
  });
});

describe('HTTP Transport: startServer host guard', () => {
  it('rejects non-loopback binds without explicit opt-in', () => {
    expect(() => startServer('0.0.0.0', 0)).toThrow(/Refusing to bind MeMesh HTTP server/);
  });

  // 使用者原話：「還沒查過更新」這件事，伺服器自己就能默默做掉（它本來
  // 就在線上），根本不需要叫使用者打指令。A serving process fills the
  // npm update cache itself; the old flow told the user to run
  // `memesh status` for it — the definition of 脫褲子放屁.
  it('fills the update cache in the background when none exists', async () => {
    let refreshed = 0;
    const server = startServer('127.0.0.1', 0, {
      lastUpdateCheckImpl: (() => null) as never,
      updateCheckImpl: (async () => { refreshed++; return {} as never; }) as never,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(refreshed, 'no cache -> the server must populate it itself').toBe(1);
    } finally {
      server.close();
    }
  });

  it('does not hit the registry when the cache is already fresh', async () => {
    let refreshed = 0;
    const server = startServer('127.0.0.1', 0, {
      lastUpdateCheckImpl: (() => ({ freshness: 'cached' })) as never,
      updateCheckImpl: (async () => { refreshed++; return {} as never; }) as never,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(refreshed, 'fresh cache -> no network call').toBe(0);
    } finally {
      server.close();
    }
  });

  it('allows non-loopback binds when explicit opt-in is provided, and demands a bearer token (F3)', async () => {
    const remoteTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-http-remote-'));
    const previousDbPath = process.env.MEMESH_DB_PATH;
    const previousToken = process.env.MEMESH_REMOTE_TOKEN;
    process.env.MEMESH_DB_PATH = path.join(remoteTmpDir, 'test.db');
    // Inject a known token so the test doesn't need to read the
    // generated file under the temp dir.
    process.env.MEMESH_REMOTE_TOKEN = 'test-token-deadbeefcafef00d';

    let remoteServer: ReturnType<typeof app.listen> | undefined;
    try {
      remoteServer = startServer('0.0.0.0', 0, { allowRemote: true });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(remoteServer.listening).toBe(true);

      const remotePort = (remoteServer.address() as any).port;

      // F3: without bearer token → 401 even on /v1/health.
      const noAuth = await fetch(`http://127.0.0.1:${remotePort}/v1/health`);
      expect(noAuth.status).toBe(401);
      // Stable code so the dashboard can translate "you need a token"
      // instead of regex-matching the English sentence.
      const noAuthBody = await noAuth.json() as { errorCode?: string };
      expect(noAuthBody.errorCode).toBe('auth.missing-bearer');

      // F3: with the right bearer token → 200.
      const withAuth = await fetch(`http://127.0.0.1:${remotePort}/v1/health`, {
        headers: { Authorization: 'Bearer test-token-deadbeefcafef00d' },
      });
      expect(withAuth.status).toBe(200);

      // F3: with a wrong token → 401, and timing-safe compare doesn't
      // leak length (we don't assert timing here, just that it rejects).
      const wrongAuth = await fetch(`http://127.0.0.1:${remotePort}/v1/health`, {
        headers: { Authorization: 'Bearer wrong-token' },
      });
      expect(wrongAuth.status).toBe(401);
      // Distinct code from the missing-header case — "typo in the token"
      // and "no token at all" need different UI guidance.
      const wrongAuthBody = await wrongAuth.clone().json() as { errorCode?: string };
      expect(wrongAuthBody.errorCode).toBe('auth.invalid-token');

      // F3 ordering regression: auth must run BEFORE the rate limiter.
      // If a 401 also returned RateLimit-* headers, the limiter is
      // counting unauthed traffic against legitimate clients sharing
      // an IP — a trivial DoS. After the fix the 401 response must
      // NOT include RateLimit-Limit / RateLimit-Remaining headers
      // (rate limiter never ran).
      expect(wrongAuth.headers.get('ratelimit-limit')).toBeNull();
      expect(wrongAuth.headers.get('ratelimit-remaining')).toBeNull();
      expect(wrongAuth.headers.get('x-ratelimit-limit')).toBeNull();

      // Codex challenge regression: auth must also run BEFORE the JSON
      // body parser. If express.json() runs first, an unauthenticated
      // attacker can force up to 1 MB of JSON parsing per request before
      // getting a 401 — pre-auth CPU/memory DoS primitive. Proof:
      // sending a malformed JSON body without auth must return 401
      // (auth rejection), not 400 (body parse error). If the parser
      // ran first it would emit a 400 "invalid JSON" before auth ever
      // saw the request.
      const malformedNoAuth = await fetch(`http://127.0.0.1:${remotePort}/v1/remember`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{this is not valid json',
      });
      expect(malformedNoAuth.status).toBe(401);

      // And a valid (but unauthorized) JSON body still gets 401 —
      // proving the JSON parser is gated, not just the schema validator.
      const validJsonNoAuth = await fetch(`http://127.0.0.1:${remotePort}/v1/remember`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'unauthed', type: 'note' }),
      });
      expect(validJsonNoAuth.status).toBe(401);

      // CodeQL js/polynomial-redos regression: the previous header
      // parser used a regex where both quantifiers could match
      // whitespace, so an attacker-controlled header that is all
      // whitespace forced the regex engine to enumerate every split
      // between the two quantifiers (quadratic in input length). The
      // replacement single-pass parser must answer in bounded time
      // even for a 10k-char whitespace header. We measure the latency
      // for that pathological case and assert it returns 401 quickly
      // — no exponential hang.
      const pathological = 'Bearer ' + ' '.repeat(10_000);
      const t0 = Date.now();
      const redosProbe = await fetch(`http://127.0.0.1:${remotePort}/v1/health`, {
        headers: { Authorization: pathological },
      });
      const elapsed = Date.now() - t0;
      expect(redosProbe.status).toBe(401);
      // Generous bound — actual cost is microseconds; anything over
      // 500ms would indicate the old quadratic pattern is back.
      expect(elapsed).toBeLessThan(500);
    } finally {
      if (remoteServer) {
        await new Promise<void>((resolve, reject) => {
          remoteServer!.close((err) => (err ? reject(err) : resolve()));
        });
      }
      closeDatabase();
      // Reset module-level remoteToken so subsequent loopback-only
      // tests in the same suite are not auth-gated.
      __setRemoteTokenForTest(null);
      if (previousDbPath === undefined) delete process.env.MEMESH_DB_PATH;
      else process.env.MEMESH_DB_PATH = previousDbPath;
      if (previousToken === undefined) delete process.env.MEMESH_REMOTE_TOKEN;
      else process.env.MEMESH_REMOTE_TOKEN = previousToken;
      fs.rmSync(remoteTmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  // Codex challenge regression: previously a second startServer() call
  // bound to loopback would clobber the module-global `remoteToken` to
  // null, silently de-authenticating any already-running remote
  // listener attached to the same app. Auth is now gated per-request
  // by the connection's local address, so a loopback listener cannot
  // break a peer remote listener.
  it('dual-listener safety: loopback start does not de-auth a running remote listener', async () => {
    const remoteTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-http-dual-'));
    const previousDbPath = process.env.MEMESH_DB_PATH;
    const previousToken = process.env.MEMESH_REMOTE_TOKEN;
    process.env.MEMESH_DB_PATH = path.join(remoteTmpDir, 'test.db');
    process.env.MEMESH_REMOTE_TOKEN = 'test-token-dual-0123456789abcdef';

    let remoteServer: ReturnType<typeof app.listen> | undefined;
    let loopbackServer: ReturnType<typeof app.listen> | undefined;
    try {
      remoteServer = startServer('0.0.0.0', 0, { allowRemote: true });
      await new Promise((resolve) => setTimeout(resolve, 25));
      const remotePort = (remoteServer.address() as any).port;

      // Now start a loopback listener on the SAME app — pre-fix this
      // would set remoteToken = null and break the remote listener.
      loopbackServer = startServer('127.0.0.1', 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const loopbackPort = (loopbackServer.address() as any).port;

      // Remote still requires the token (loopback start did not break it).
      const remoteNoAuth = await fetch(`http://127.0.0.1:${remotePort}/v1/health`);
      // 127.0.0.1 connecting to a 0.0.0.0-bound socket has the local
      // address of the bound socket; per-request loopback detection
      // sees this as remote-bound and demands auth.
      expect(remoteNoAuth.status).toBe(401);

      const remoteWithAuth = await fetch(`http://127.0.0.1:${remotePort}/v1/health`, {
        headers: { Authorization: 'Bearer test-token-dual-0123456789abcdef' },
      });
      expect(remoteWithAuth.status).toBe(200);

      // And the loopback listener is still no-auth (process-owner trust).
      const loopback = await fetch(`http://127.0.0.1:${loopbackPort}/v1/health`);
      expect(loopback.status).toBe(200);
    } finally {
      const closes: Promise<void>[] = [];
      if (remoteServer) closes.push(new Promise<void>((res, rej) => remoteServer!.close((err) => err ? rej(err) : res())));
      if (loopbackServer) closes.push(new Promise<void>((res, rej) => loopbackServer!.close((err) => err ? rej(err) : res())));
      await Promise.all(closes);
      closeDatabase();
      __setRemoteTokenForTest(null);
      if (previousDbPath === undefined) delete process.env.MEMESH_DB_PATH;
      else process.env.MEMESH_DB_PATH = previousDbPath;
      if (previousToken === undefined) delete process.env.MEMESH_REMOTE_TOKEN;
      else process.env.MEMESH_REMOTE_TOKEN = previousToken;
      fs.rmSync(remoteTmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

// ── Dashboard ─────────────────────────────────────────────────────────────────

describe('HTTP Transport: GET /dashboard', () => {
  it('returns HTML with dashboard content', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/dashboard`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('html');
    const html = await res.text();
    expect(html).toContain('MeMesh');
  });

  it('returns no content for browser favicon probes', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
    expect(res.status).toBe(204);
  });
});

// ── Startup Validation (F15) ──────────────────────────────────────────────────

describe('HTTP Transport: Startup validation', () => {
  it('throws with actionable error if database cannot be opened', () => {
    // Create a path that fails on both POSIX and Windows: take a regular
    // file, then ask SQLite to open a "child" of that file. Files can't
    // have children, so mkdir-recursive (which db.ts calls) will fail
    // with EEXIST/ENOTDIR. /dev/null worked on POSIX but Windows has no
    // /dev/null analogue, so we make our own.
    const badTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-http-bad-'));
    const blockingFile = path.join(badTmpDir, 'iamafile.txt');
    fs.writeFileSync(blockingFile, 'I am a regular file, not a directory.');
    const badDbPath = path.join(blockingFile, 'cannot-write-here.db');
    const previousDbPath = process.env.MEMESH_DB_PATH;
    process.env.MEMESH_DB_PATH = badDbPath;

    // The beforeAll opened a db at tmpDir/test.db. Close it so startServer's
    // openDatabase() actually tries to open badDbPath instead of returning
    // the cached connection (openDatabase is idempotent: returns existing).
    closeDatabase();

    try {
      expect(() => startServer('127.0.0.1', 0)).toThrow(/Database initialization failed/);
    } finally {
      if (previousDbPath === undefined) delete process.env.MEMESH_DB_PATH;
      else process.env.MEMESH_DB_PATH = previousDbPath;
      fs.rmSync(badTmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      // Reopen the original db so subsequent tests in afterAll can closeDatabase
      // and so other concurrent tests are not affected.
      openDatabase(path.join(tmpDir, 'test.db'));
    }
  });

  it('shows actual bound port instead of input port (F15 port display fix)', async () => {
    const portTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-http-port-'));
    const previousDbPath = process.env.MEMESH_DB_PATH;
    process.env.MEMESH_DB_PATH = path.join(portTmpDir, 'test.db');

    let testServer: ReturnType<typeof app.listen> | undefined;
    try {
      // Start with port=0 (random port)
      testServer = startServer('127.0.0.1', 0);
      await new Promise((resolve) => setTimeout(resolve, 25));

      const actualPort = (testServer.address() as any).port;
      expect(actualPort).toBeGreaterThan(0);
      expect(actualPort).not.toBe(0); // Should not show ":0" in logs

      // Verify server is actually listening on the reported port
      const res = await fetch(`http://127.0.0.1:${actualPort}/v1/health`);
      expect(res.status).toBe(200);
    } finally {
      if (testServer) await new Promise<void>((res, rej) => testServer!.close((err) => err ? rej(err) : res()));
      closeDatabase();
      if (previousDbPath === undefined) delete process.env.MEMESH_DB_PATH;
      else process.env.MEMESH_DB_PATH = previousDbPath;
      fs.rmSync(portTmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe('isLoopbackRequest (rate-limit skip boundary)', () => {
  // This predicate decides whether the rate limiter is SKIPPED, so it is the
  // security boundary: a public IP must never be treated as loopback, or an
  // exposed (--allow-remote) instance loses its abuse control. `trust proxy`
  // is left at Express's default (false), so `req.ip` is the raw socket address
  // and cannot be forged via X-Forwarded-For — these cases lock that in.
  it('returns true for every loopback form the stack can produce', () => {
    expect(isLoopbackRequest({ ip: '127.0.0.1' })).toBe(true);
    expect(isLoopbackRequest({ ip: '::1' })).toBe(true);
    expect(isLoopbackRequest({ ip: '::ffff:127.0.0.1' })).toBe(true);
  });

  it('returns false for public and private-but-remote addresses', () => {
    // Break-test: widen the predicate to `true` and each of these goes red.
    expect(isLoopbackRequest({ ip: '203.0.113.5' })).toBe(false); // public
    expect(isLoopbackRequest({ ip: '10.0.0.7' })).toBe(false); // LAN, still remote
    expect(isLoopbackRequest({ ip: '::ffff:203.0.113.5' })).toBe(false); // mapped public
    expect(isLoopbackRequest({ ip: '127.0.0.1:54321' })).toBe(false); // ip never carries a port
    expect(isLoopbackRequest({})).toBe(false); // missing ip is not loopback
    expect(isLoopbackRequest({ ip: '' })).toBe(false);
  });
});

describe('HTTP Transport: agent-only workflows', () => {
  it.each([
    ['GET', '/v1/reindex'], ['POST', '/v1/reindex'],
    ['POST', '/v1/config/test'], ['GET', '/v1/telemetry'], ['POST', '/v1/dream/run'],
  ])('rejects removed %s %s without provider requests', async (method, route) => {
    const nativeFetch = globalThis.fetch;
    const calls = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      expect(String(input).startsWith(`http://127.0.0.1:${port}/`)).toBe(true);
      return nativeFetch(input, init);
    });
    try {
      const res = await req(method, route, method === 'POST' ? {} : undefined);
      expect(res.status).toBe(404);
      expect(res.body.errorCode).toBe('route.not-found');
      expect(calls).toHaveBeenCalledTimes(1);
    } finally { calls.mockRestore(); }
  });

  it('round-trips ordinary config and rejects every removed provider field without writes', async () => {
    const saved = await req('POST', '/v1/config', { autoCapture: false, sessionLimit: 8 });
    expect(saved.status).toBe(200);
    expect((await req('GET', '/v1/config')).body.data).toMatchObject({ config: { autoCapture: false, sessionLimit: 8 } });
    const before = readConfig();
    for (const field of ['llm', 'llmFallbacks', 'embedder', 'language', 'transcriptMining']) {
      const res = await req('POST', '/v1/config', { [field]: null });
      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe('validation.bad-body');
      expect(readConfig()).toEqual(before);
    }
    expect((await req('GET', '/v1/config')).body.data).not.toHaveProperty('capabilities');
  });

  // Codex review round 1, item 2: GET /v1/config used to re-validate the
  // read through the same strict `z.enum` POST validates against, so a
  // stored value outside the known levels (hand-edited config.json, or an
  // older/newer memesh version's value) made the read itself throw and
  // answer 500 — a user with a bad value on disk could not even see it to
  // fix it. `briefing` is validated on WRITE only; GET returns it as-is.
  it('#360: GET /v1/config survives an invalid stored briefing level (200, raw value) — POST still rejects it (400)', async () => {
    // Simulate a value already on disk that predates (or postdates) this
    // version's known levels — written directly, bypassing POST validation,
    // the same way an older memesh or a hand edit would leave it.
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ briefing: 'banana' }));

    const got = await req('GET', '/v1/config');
    expect(got.status).toBe(200);
    expect(got.body.data.config.briefing).toBe('banana');

    const posted = await req('POST', '/v1/config', { briefing: 'banana' });
    expect(posted.status).toBe(400);
    expect(posted.body.errorCode).toBe('validation.bad-body');
    // The invalid POST must not have overwritten the stored value with
    // something else, and GET must still answer 200 afterward.
    expect((await req('GET', '/v1/config')).body.data.config.briefing).toBe('banana');

    // A valid POST still works and GET reflects it — the write path is not
    // broken, only the read path's over-validation was.
    const fixed = await req('POST', '/v1/config', { briefing: 'minimal' });
    expect(fixed.status).toBe(200);
    expect((await req('GET', '/v1/config')).body.data.config.briefing).toBe('minimal');
  });

  // #360 round 4 (Codex round 3 re-review, item 2): the case above only
  // covers a string that is not a known level. `readConfig()`'s old
  // `typeof === 'string'` gate discarded every OTHER JSON type before
  // `ConfigReadBody` ever saw it, so this exact 500-avoidance fix was never
  // exercised for a number, boolean, null, array or object — the real shape
  // a hand-edited config.json or an older/newer memesh can leave behind.
  // GET must answer 200 with the raw value for every one of them; POST must
  // still reject every one with 400 (the enum belongs on write only).
  it.each([42, true, [], { nested: 'object' }])(
    '#360: GET /v1/config survives a non-string stored briefing (%j) — POST still rejects it (400)',
    async (value) => {
      fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ briefing: value }));

      const got = await req('GET', '/v1/config');
      expect(got.status).toBe(200);
      expect(got.body.data.config.briefing).toEqual(value);

      const posted = await req('POST', '/v1/config', { briefing: value });
      expect(posted.status).toBe(400);
      expect(posted.body.errorCode).toBe('validation.bad-body');
      expect((await req('GET', '/v1/config')).body.data.config.briefing).toEqual(value);
    },
  );

  // `null` is its own case: round 5 (Codex round 4 re-review, item 2) made
  // `resolveBriefingLevel` classify an explicit stored `null` as an INVALID
  // value (default level + a recorded reason on hook/CLI/MCP) — the SAME
  // treatment as `42` or `"banana"`, not "not set" (only the key being
  // genuinely absent means that). GET surviving it without a 500 is a
  // DIFFERENT, narrower thing — all THIS schema is responsible for is not
  // re-validating the raw stored value on read. POST still rejects `null`
  // (the write-side enum has no null member).
  it('#360: GET /v1/config survives an explicit null stored briefing — POST still rejects it (400)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ briefing: null }));

    const got = await req('GET', '/v1/config');
    expect(got.status).toBe(200);
    expect(got.body.data.config.briefing).toBeNull();

    const posted = await req('POST', '/v1/config', { briefing: null });
    expect(posted.status).toBe(400);
    expect(posted.body.errorCode).toBe('validation.bad-body');
  });

  // `updateConfig()` writes the file first, and its result used to be
  // re-parsed with the WRITE-side strict level enum. So changing an unrelated
  // setting while an unrecognised `briefing` was stored saved the change to
  // disk and then answered 400: the client showed a failure for a write that
  // had happened. The response is a read of what is stored; it must survive
  // the same values GET survives, and must leave the stored value alone.
  it.each(['banana', 'Standard', 42, null])(
    '#360: POST of another setting succeeds when the stored briefing is %j, and leaves that value alone',
    async (value) => {
      fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ briefing: value }));

      const posted = await req('POST', '/v1/config', { autoUpdate: 'patch' });
      expect(posted.status).toBe(200);
      expect(posted.body.data.autoUpdate).toBe('patch');
      expect(posted.body.data.briefing).toEqual(value);

      const got = await req('GET', '/v1/config');
      expect(got.body.data.config.autoUpdate).toBe('patch');
      expect(got.body.data.config.briefing).toEqual(value);
    },
  );

  // #431 — `sessionLimit` gets the same read-side treatment as `briefing`
  // above: GET answers 200 with the raw stored value, unfiltered — the
  // effective value and why live in `config list`/`get` (CLI) and the
  // SessionStart hook's own record, not in this response. POST still
  // rejects a new out-of-range value and never touches the value already
  // stored.
  it('#431: GET /v1/config survives a stored sessionLimit above 100 (200, raw value) — POST still rejects 101 (400), accepts 100', async () => {
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ sessionLimit: 500 }));

    const got = await req('GET', '/v1/config');
    expect(got.status).toBe(200);
    expect(got.body.data.config.sessionLimit).toBe(500);
    expect(got.body.data.config).not.toHaveProperty('sessionLimitOutOfRange');

    const posted = await req('POST', '/v1/config', { sessionLimit: 101 });
    expect(posted.status).toBe(400);
    expect(posted.body.errorCode).toBe('validation.bad-body');
    // The rejected write must not have touched the value already stored.
    const stillStored = await req('GET', '/v1/config');
    expect(stillStored.body.data.config.sessionLimit).toBe(500);

    // The documented upper bound is still accepted.
    const fixed = await req('POST', '/v1/config', { sessionLimit: 100 });
    expect(fixed.status).toBe(200);
    expect(fixed.body.data.sessionLimit).toBe(100);
    const after = await req('GET', '/v1/config');
    expect(after.body.data.config.sessionLimit).toBe(100);
  });

  // The issue's second symptom: a stored out-of-range value used to make
  // ANY write to config.json 500 on its readback, so changing an unrelated
  // field (autoUpdate) looked like it failed even though the write itself
  // succeeded. POST of another field must still succeed and leave the
  // out-of-range sessionLimit exactly as it was.
  it('#431: POST of an unrelated field succeeds when a stored sessionLimit is out of range, and leaves it alone', async () => {
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ sessionLimit: 500 }));

    const posted = await req('POST', '/v1/config', { autoUpdate: 'patch' });
    expect(posted.status).toBe(200);
    expect(posted.body.data.autoUpdate).toBe('patch');
    expect(posted.body.data.sessionLimit).toBe(500);

    const got = await req('GET', '/v1/config');
    expect(got.status).toBe(200);
    expect(got.body.data.config.autoUpdate).toBe('patch');
    expect(got.body.data.config.sessionLimit).toBe(500);
  });

  it('#431: an in-range sessionLimit round-trips unchanged', async () => {
    const saved = await req('POST', '/v1/config', { sessionLimit: 50 });
    expect(saved.status).toBe(200);
    const got = await req('GET', '/v1/config');
    expect(got.body.data.config.sessionLimit).toBe(50);
  });
});
