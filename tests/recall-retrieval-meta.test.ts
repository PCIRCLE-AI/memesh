/**
 * R2 — honest retrieval metadata.
 *
 * MeMesh has one retrieval path: FTS5. Metadata must report that exact fact,
 * while `truncated` distinguishes a full window from a complete result set.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let dir: string;
let closeDatabase: typeof import('../src/db.js').closeDatabase;
let recallEnhanced: typeof import('../src/core/operations.js').recallEnhanced;
let remember: typeof import('../src/core/operations.js').remember;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-retrieval-meta-'));
  const db = await import('../src/db.js');
  closeDatabase = db.closeDatabase;
  db.openDatabase(path.join(dir, 'test.db'));
  ({ recallEnhanced, remember } = await import('../src/core/operations.js'));
  remember({ name: 'auth-decision', type: 'decision', observations: ['Use OAuth PKCE for the auth flow'] });
  remember({ name: 'auth-lesson', type: 'lesson_learned', observations: ['Validate the OAuth state parameter'] });
  remember({ name: 'db-note', type: 'note', observations: ['SQLite WAL mode for concurrent auth reads'] });
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('FTS recall must not make a provider or network request');
  }));
});

afterEach(() => {
  closeDatabase();
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('Feature: recall reports how it was answered', () => {
  it('reports exact FTS provenance and never degrades into a hidden second path', async () => {
    const { entities, retrieval } = await recallEnhanced({ query: 'auth' });
    expect(entities.length).toBeGreaterThan(0);
    expect(entities.every((entity) => entity.match?.source === 'keyword')).toBe(true);
    expect(retrieval).toEqual({ mode: 'fts', degraded: false, truncated: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a limit-full window says truncated; a roomy window does not', async () => {
    const tight = await recallEnhanced({ query: 'auth', limit: 2 });
    expect(tight.entities).toHaveLength(2);
    expect(tight.retrieval.truncated).toBe(true);

    const roomy = await recallEnhanced({ query: 'auth', limit: 10 });
    expect(roomy.entities.length).toBeLessThan(10);
    expect(roomy.retrieval.truncated).toBe(false);
  });

  it('the empty-query listing reports honestly too: fts mode, truncation still meaningful', async () => {
    const listed = await recallEnhanced({ limit: 2 });
    expect(listed.retrieval.mode).toBe('fts');
    expect(listed.retrieval.degraded).toBe(false);
    expect(listed.retrieval.truncated).toBe(true); // 3 entities, window of 2
    expect(fetch).not.toHaveBeenCalled();
  });
});
