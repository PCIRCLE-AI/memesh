/**
 * #522: a small database last opened by an older build holds keyword-index
 * rows split the old way (whole runs of CJK / Thai text). Opening it must
 * rebuild that index before any step removes rows from it one by one with
 * today's splitting, or the removal fails and every open reports
 * "database disk image is malformed" for a database that is not corrupt.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, getDatabase, openDatabase, reindexFts } from '../src/db.js';
import { KnowledgeGraph } from '../src/knowledge-graph.js';
import { MemeshDatabase } from '../src/storage/sqlite.js';
import { FTS_SQL, SCHEMA_SQL, ftsIndexIsCurrent, migrateEntitiesSchema } from '../src/storage/schema.js';

function writeLegacyDatabase(dbPath: string, name: string, observation: string, segmentationVersion?: string): void {
  const db = new MemeshDatabase(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  db.exec(FTS_SQL);
  migrateEntitiesSchema(db);
  db.prepare("INSERT INTO entities (name, type) VALUES (?, 'decision')").run(name);
  db.prepare('INSERT INTO observations (entity_id, content) VALUES (1, ?)').run(observation);
  // Indexed the way an older build did: the whole unspaced run as one token.
  db.prepare('INSERT INTO entities_fts (rowid, name, observations) VALUES (1, ?, ?)').run(name, observation);
  if (segmentationVersion) {
    db.prepare("INSERT INTO memesh_metadata (key, value) VALUES ('fts_segmentation_version', ?)").run(segmentationVersion);
  }
  db.close();
}

describe('Feature: #522 an old small database opens after upgrading', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-old-index-'));
    dbPath = path.join(dir, 'knowledge-graph.db');
  });

  afterEach(() => {
    try { closeDatabase(); } catch { /* not open */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('a pre-segmentation database with Chinese text opens and finds it', () => {
    writeLegacyDatabase(dbPath, '資料庫遷移', '資料庫遷移前一定要先備份');
    const db = openDatabase(dbPath);
    expect(new KnowledgeGraph(db).search('資料庫').map((e) => e.name)).toContain('資料庫遷移');
  });

  it('a database indexed before Thai was segmented opens and finds it', () => {
    writeLegacyDatabase(dbPath, 'ฐานข้อมูล', 'สำรองข้อมูลก่อนย้ายฐานข้อมูลเสมอ', '2');
    const db = openDatabase(dbPath);
    expect(new KnowledgeGraph(db).search('ฐานข้อมูล').map((e) => e.name)).toContain('ฐานข้อมูล');
  });
});

// #568: a rebuild that failed (a full disk, say) records its attempt and waits
// 24 hours before retrying. The upgrade steps that rewrite keyword-index rows
// tokenise with today's rules, which the old index cannot take: they failed
// with "database disk image is malformed" and every open failed with them,
// so even `memesh reindex --fts` could not run. They now wait for the rebuild.
describe('Feature: #568 a database whose index rebuild is waiting to retry still opens', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-failed-rebuild-'));
    dbPath = path.join(dir, 'knowledge-graph.db');
    writeLegacyDatabase(dbPath, '資料庫遷移', '資料庫遷移前一定要先備份');
    const db = new MemeshDatabase(dbPath);
    db.prepare("INSERT INTO memesh_metadata (key, value) VALUES ('fts_segmentation_version_last_attempt', ?)").run(String(Date.now()));
    // Work for the passes that rewrite index rows: a duplicate observation
    // (dedupe) and an archived memory still in the old index (archived-row drop).
    db.prepare('INSERT INTO observations (entity_id, content) VALUES (1, ?)').run('資料庫遷移前一定要先備份');
    db.prepare("INSERT INTO entities (id, name, type, status) VALUES (2, '舊的資料庫決定', 'decision', 'archived')").run();
    db.prepare('INSERT INTO observations (entity_id, content) VALUES (2, ?)').run('舊的資料庫決定已經不用了');
    db.prepare('INSERT INTO entities_fts (rowid, name, observations) VALUES (2, ?, ?)').run('舊的資料庫決定', '舊的資料庫決定已經不用了');
    db.close();
  });

  afterEach(() => {
    try { closeDatabase(); } catch { /* not open */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('opens, finds the memory through the stored-text scan, and lets reindex run', () => {
    openDatabase(dbPath);
    expect(ftsIndexIsCurrent(getDatabase())).toBe(false);
    expect(new KnowledgeGraph(getDatabase()).searchWithFacts('資料庫').entities.map((e) => e.name)).toContain('資料庫遷移');
    reindexFts();
    expect(ftsIndexIsCurrent(getDatabase())).toBe(true);
    expect(new KnowledgeGraph(getDatabase()).search('資料庫').map((e) => e.name)).toContain('資料庫遷移');
  });

  it('runs the deferred upgrade steps on the next open after the rebuild', () => {
    openDatabase(dbPath);
    const titleBefore = (getDatabase().prepare("SELECT title FROM entities WHERE name = '資料庫遷移'").get() as { title: string | null }).title;
    expect(titleBefore).toBeNull();
    reindexFts();
    closeDatabase();
    openDatabase(dbPath);
    const titleAfter = (getDatabase().prepare("SELECT title FROM entities WHERE name = '資料庫遷移'").get() as { title: string | null }).title;
    expect(titleAfter).not.toBeNull();
  });
});
