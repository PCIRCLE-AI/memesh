/**
 * The schema is created in one transaction: another process opening the same
 * file never sees `entities` without `tags` (the half-built state behind
 * "memories not loaded this session (no such table: tags)").
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { createSchema, hasTables, MEMORY_READ_TABLES } from '../../src/storage/schema.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const tmp = () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-schema-atomic-')));
  dirs.push(d);
  return d;
};
const tableNames = (db: MemeshDatabase) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);

describe('createSchema', () => {
  it('a failure part-way leaves no tables behind, not the first few', () => {
    const db = new MemeshDatabase(path.join(tmp(), 'half.db'));
    // The last statement of the schema indexes a column this table lacks: it fails after every memory table was created.
    db.exec('CREATE TABLE agent_network_outbox (id INTEGER)');
    expect(() => createSchema(db)).toThrow(/next_attempt_at_ms|no such column/);
    expect(tableNames(db)).toEqual(['agent_network_outbox']);
    expect(tableNames(db)).toHaveLength(1);
    db.close();
  });

  it('creates every memory table, and is safe to run again', () => {
    const db = new MemeshDatabase(path.join(tmp(), 'whole.db'));
    createSchema(db);
    expect(hasTables(db, MEMORY_READ_TABLES)).toBe(true);
    createSchema(db);
    expect(hasTables(db, MEMORY_READ_TABLES)).toBe(true);
    db.close();
  });

  it('a database left half-built by an older version is completed', () => {
    const db = new MemeshDatabase(path.join(tmp(), 'old.db'));
    db.exec('CREATE TABLE entities (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, type TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, metadata JSON)');
    expect(hasTables(db, MEMORY_READ_TABLES)).toBe(false);
    createSchema(db);
    expect(hasTables(db, MEMORY_READ_TABLES)).toBe(true);
    db.close();
  });

  it('two processes opening a file that does not exist: a reader polling the file never sees some memory tables but not all', async () => {
    const dir = tmp();
    const dbPath = path.join(dir, 'race.db');
    const opener = `
      import { openHookDb } from ${JSON.stringify(path.resolve('scripts/hooks/_shared.js'))};
      const { db } = openHookDb({ ...process.env, MEMESH_DB_PATH: ${JSON.stringify(dbPath)} }, { fts: true });
      db.close();
    `;
    const run = () => new Promise<number | null>((resolve) => {
      const child = spawn('node', ['--input-type=module', '-e', opener], { env: { ...process.env, HOME: dir }, stdio: 'ignore' });
      child.on('close', resolve);
    });
    const seen = new Set<number>();
    let done = false;
    const poll = (async () => {
      while (!done) {
        if (fs.existsSync(dbPath)) {
          let reader: MemeshDatabase | null = null;
          try {
            reader = new MemeshDatabase(dbPath, { readOnly: true });
            const row = reader.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (${MEMORY_READ_TABLES.map(() => '?').join(',')})`).get(...MEMORY_READ_TABLES) as { n: number };
            seen.add(row.n);
          } catch { /* the file is being created: try again */ } finally { try { reader?.close(); } catch { /* closed */ } }
        }
        await new Promise((r) => setTimeout(r, 1));
      }
    })();
    const codes = await Promise.all([run(), run()]);
    done = true;
    await poll;
    expect(codes).toEqual([0, 0]);
    expect(codes).toHaveLength(2);
    expect([...seen].filter((n) => n !== 0 && n !== MEMORY_READ_TABLES.length), 'a reader saw a half-built schema').toEqual([]);
  }, 60_000);
});
