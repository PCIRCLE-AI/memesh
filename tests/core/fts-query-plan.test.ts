/**
 * The keyword index must be read first. Joined the other way round, SQLite walks every active
 * memory and runs the full-text match once per memory: measured on 10,000 memories that all
 * match, 907 ms against 9 ms for recall and 255 ms against 4 ms for the pre-edit lookup, and
 * 75 s for one recall on 100,000 (the pre-edit hook was killed at its timeout). The plan is
 * what is checked, not a time: it does not depend on the machine.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { recall } from '../../src/core/operations.js';

let root: string;
let previousDir: string | undefined;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-fts-plan-')));
  previousDir = process.env.MEMESH_DIR;
  process.env.MEMESH_DIR = root;
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ updateCheck: false }));
  openDatabase(path.join(root, 'kg.db'));
  const kg = new KnowledgeGraph(getDatabase());
  for (let i = 0; i < 5; i++) kg.createEntity(`m-${i}`, 'decision', { observations: [`module ${i} and auth.ts`], tags: ['project:p1'] });
});
afterEach(() => {
  closeDatabase();
  if (previousDir === undefined) delete process.env.MEMESH_DIR;
  else process.env.MEMESH_DIR = previousDir;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const firstStep = (sql: string, params: unknown[]) =>
  (getDatabase().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{ detail: string }>)[0].detail;

describe('a keyword search reads the index first', () => {
  it('a project-scoped recall', () => {
    const db = getDatabase();
    const real = db.prepare.bind(db);
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      const statement = real(sql);
      if (!sql.includes('entities_fts MATCH')) return statement;
      return { all: (...params: unknown[]) => { seen.push({ sql, params }); return statement.all(...(params as never[])); } };
    };
    try {
      recall({ query: 'module', projectScope: ['project:p1', 'project:p2'] });
    } finally {
      (db as unknown as { prepare: unknown }).prepare = real;
    }
    expect(seen.length, 'the recall ran no keyword search').toBeGreaterThan(0);
    for (const { sql, params } of seen) expect(firstStep(sql, params)).toMatch(/^SCAN f VIRTUAL TABLE/);
  });

  it('the pre-edit hook\'s lookup', () => {
    const source = fs.readFileSync(path.resolve('scripts/hooks/pre-edit-recall.js'), 'utf8');
    const start = source.indexOf('ftsResults = matchExpr === null ? [] : db.prepare(`');
    expect(start, 'the pre-edit keyword query moved; update this test').toBeGreaterThan(0);
    const template = source.slice(source.indexOf('`', start) + 1, source.indexOf('`)', start));
    const sql = template
      .replace('${projectTagMarks}', '?')
      .replace('${SESSION_SNAPSHOT_EXCLUSION_SQL}', '')
      .replace('${statusFilter}', "AND e.status = 'active'");
    expect(sql).not.toContain('${');
    expect(firstStep(sql, ['"auth" "ts"', 'project:p1', 50])).toMatch(/^SCAN fts VIRTUAL TABLE/);
  });
});
