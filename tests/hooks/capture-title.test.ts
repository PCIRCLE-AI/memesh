import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const shared = require('../../scripts/hooks/_shared.js');

// Every auto-captured memory is born with a title, whoever wrote it and
// whether or not the writer remembered to pass one.
describe('Feature: auto-capture always supplies a title', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-capture-title-'));
    dbPath = path.join(tmpDir, 'test.db');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const withDb = <T,>(fn: (db: any) => T): T => {
    const { db } = shared.openHookDb({ ...process.env, MEMESH_DB_PATH: dbPath }, { fts: true });
    try { return fn(db); } finally { db.close(); }
  };
  const row = (db: any, name: string) => db.prepare('SELECT title, metadata FROM entities WHERE name = ?').get(name) as { title: string | null; metadata: string };

  it('derives one from the first observation that says something, and marks it as machine-made', () => {
    withDb((db) => {
      shared.captureEntity(db, {
        name: 'pre-compact-abc', type: 'session-summary', tags: ['project:t'],
        observations: ['Tool calls: 47', 'Compaction reason: auto', 'Refactored the storage layer\nsecond line'],
      });
      const stored = row(db, 'pre-compact-abc');
      expect(stored.title).toBe('Refactored the storage layer');
      expect(JSON.parse(stored.metadata).title_source).toBe('heuristic');
    });
  });

  it('falls back to the name when there is no observation to read, and for a blank title', () => {
    withDb((db) => {
      shared.captureEntity(db, { name: 'commit-0000000', type: 'commit', observations: [], tags: [] });
      expect(row(db, 'commit-0000000').title).toBe('commit-0000000');
      shared.captureEntity(db, { name: 'commit-1111111', type: 'commit', title: '   ', observations: ['fix: parser'], tags: [] });
      expect(row(db, 'commit-1111111').title).toBe('fix: parser');
    });
  });

  it('never replaces a title the caller gave, and gives an existing memory without a title one', () => {
    withDb((db) => {
      shared.captureEntity(db, { name: 'given', type: 'commit', title: 'The title I chose', observations: ['something else entirely'], tags: [] });
      shared.captureEntity(db, { name: 'given', type: 'commit', observations: ['and more detail'], tags: [] });
      expect(row(db, 'given').title).toBe('The title I chose');

      db.prepare("INSERT INTO entities (name, type) VALUES ('legacy', 'commit')").run();
      shared.captureEntity(db, { name: 'legacy', type: 'commit', observations: ['fix: legacy parser'], tags: [] });
      expect(row(db, 'legacy').title).toBe('fix: legacy parser');
    });
  });

  it('indexes the derived title, so the memory is found by it', () => {
    withDb((db) => {
      const { id } = shared.captureEntity(db, { name: 'findable', type: 'commit', observations: ['Tool calls: 3', 'migrated zebrafish tables'], tags: [] });
      const hits = (db.prepare("SELECT rowid FROM entities_fts WHERE entities_fts MATCH 'zebrafish'").all() as Array<{ rowid: number }>).map((r) => r.rowid);
      expect(hits).toEqual([id]);
    });
  });
});
