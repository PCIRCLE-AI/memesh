/**
 * Several MCP servers (one per Claude Code / Codex session) start in the same
 * second on a data folder that does not exist yet. Before the fix about one in
 * ten died with "database is locked" inside `PRAGMA journal_mode = WAL`,
 * although `busy_timeout` was already 30 s: SQLite does not always call the
 * busy handler for that step. A server that dies at start leaves its session
 * without memory tools.
 *
 * The openers here are real child processes (SQLite's file locks are per
 * process, so threads or promises in one process cannot collide), released
 * together by spinning until one shared instant. They run the built
 * `dist/db.js`, like every other test that spawns a process.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MemeshDatabase } from '../src/storage/sqlite.js';
import { runChild } from './helpers/run-child.js';

const DIST_DB = path.resolve('dist/db.js');
const OPENERS = 6;
const ROUNDS = 12;

const CHILD = `
const { openDatabase } = await import(${JSON.stringify(pathToFileURL(DIST_DB).href)});
const start = Number(process.argv[1]);
while (Date.now() < start) { /* spin: every opener leaves the gate together */ }
try { openDatabase(); process.exit(0); }
catch (err) { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); }
`;

function runOpener(dbPath: string, start: number): Promise<{ code: number | null; stderr: string }> {
  return runChild(['--input-type=module', '-e', CHILD, String(start)], { ...process.env, MEMESH_DB_PATH: dbPath });
}

describe('concurrent first open of one data folder', () => {
  it(`${OPENERS} processes opening a fresh database together all succeed, ${ROUNDS} rounds in a row`, async () => {
    expect(fs.existsSync(DIST_DB), 'dist/db.js missing - run npm run build').toBe(true);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-concurrent-open-'));
    const failures: string[] = [];
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const dbPath = path.join(root, `round-${round}`, 'knowledge-graph.db');
        const start = Date.now() + 600;
        const results = await Promise.all(Array.from({ length: OPENERS }, () => runOpener(dbPath, start)));
        for (const r of results) if (r.code !== 0) failures.push(`round ${round}: exit ${r.code}: ${r.stderr.trim()}`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    expect(failures).toEqual([]);
  }, 180_000);
});

describe('the connection waits for a held lock from its first statement', () => {
  it('sets busy_timeout before running anything else', () => {
    // `new MemeshDatabase()` must configure the wait itself: every later
    // statement, including the WAL switch, runs under it.
    const seen: string[] = [];
    const original = MemeshDatabase.prototype.exec;
    MemeshDatabase.prototype.exec = function (this: MemeshDatabase, sql: string) {
      seen.push(sql);
      return original.call(this, sql);
    };
    try {
      const db = new MemeshDatabase(':memory:');
      const row = db.prepare('PRAGMA busy_timeout').get() as Record<string, number>;
      expect(Object.values(row)[0]).toBeGreaterThanOrEqual(30_000);
      db.close();
    } finally {
      MemeshDatabase.prototype.exec = original;
    }
    expect(seen[0]).toMatch(/^PRAGMA busy_timeout = \d+$/);
  });
});
