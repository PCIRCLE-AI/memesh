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
import { closeDatabase, openDatabase } from '../src/db.js';
import { KnowledgeGraph } from '../src/knowledge-graph.js';
import { MemeshDatabase } from '../src/storage/sqlite.js';
import { FTS_SQL, SCHEMA_SQL, migrateEntitiesSchema } from '../src/storage/schema.js';

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
