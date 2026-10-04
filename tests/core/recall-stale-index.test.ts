/**
 * #571: a database whose keyword index was written by an older build (whole
 * unspaced runs as one token) and that cannot be rebuilt — here because the
 * file is read-only — must still answer a recall for the memories in scope,
 * and say that it fell back from the index instead of reporting an empty,
 * complete answer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, openDatabase } from '../../src/db.js';
import { recallForAgent } from '../../src/core/operations.js';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { FTS_SQL, SCHEMA_SQL, migrateEntitiesSchema } from '../../src/storage/schema.js';

type Row = { name: string; observations: string[]; project: string | null; metadata?: string };
const ROWS: Row[] = [
  { name: '資料庫遷移-a', observations: ['資料庫遷移前一定要先備份（A）'], project: 'A' },
  { name: '資料庫遷移-b', observations: ['資料庫遷移前一定要先備份（B）'], project: 'B' },
  { name: '資料庫遷移-loose', observations: ['資料庫遷移前一定要先備份（無專案）'], project: null },
];

/** Same shape as tests/db-old-index-opens.test.ts: indexed the way an older build did. */
function writeLegacyDatabase(dbPath: string, rows: Row[] = ROWS, marker?: string): void {
  const db = new MemeshDatabase(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  db.exec(FTS_SQL);
  migrateEntitiesSchema(db);
  rows.forEach((row, i) => {
    const id = i + 1;
    db.prepare("INSERT INTO entities (id, name, type, metadata) VALUES (?, ?, 'decision', ?)").run(id, row.name, row.metadata ?? null);
    for (const observation of row.observations) {
      db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(id, observation);
    }
    if (row.project) db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(id, `project:${row.project}`);
    db.prepare('INSERT INTO entities_fts (rowid, name, observations) VALUES (?, ?, ?)').run(id, row.name, row.observations.join(' '));
  });
  if (marker !== undefined) {
    db.prepare("INSERT INTO memesh_metadata (key, value) VALUES ('fts_segmentation_version', ?)").run(marker);
  }
  db.close();
}

// Same loader as tests/cli/recall-size-caps.test.ts: runs src/transports/cli/cli.ts without a build.
const cliLoader = `
  import { createServer } from 'vite';
  const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  try {
    const { runCli } = await server.ssrLoadModule('/src/transports/cli/cli.ts');
    await runCli([process.argv[0], 'memesh', ...process.argv.slice(1)]);
  } finally {
    await server.close();
  }
`;
function runCli(home: string, ...args: string[]) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', cliLoader, ...args], {
    encoding: 'utf8',
    input: '{}',
    env: { ...process.env, HOME: home, USERPROFILE: home, MEMESH_AUTO_CAPTURE: 'false' },
    timeout: 120_000,
  });
}

const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('#571 recall on a read-only database with an out-of-date keyword index', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-stale-index-'));
    dbPath = path.join(dir, 'knowledge-graph.db');
  });
  const staleReadOnly = (rows: Row[] = ROWS) => {
    writeLegacyDatabase(dbPath, rows);
    fs.chmodSync(dbPath, 0o444);
    openDatabase(dbPath);
  };

  afterEach(() => {
    try { closeDatabase(); } catch { /* not open */ }
    if (fs.existsSync(dbPath)) fs.chmodSync(dbPath, 0o644);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('returns the memories in scope, never another project\'s, says it fell back, and writes nothing', async () => {
    writeLegacyDatabase(dbPath);
    fs.chmodSync(dbPath, 0o444);
    const before = sha(dbPath);
    openDatabase(dbPath);
    const result = await recallForAgent(
      { query: '資料庫', projectScope: 'project:B' },
      { project: 'B', searched: 'project B, memories with no project, and global memories' },
    );
    expect(result.entities).toHaveLength(2);
    const names = result.entities.map((e) => e.name).sort();
    expect(names).toEqual(['資料庫遷移-b', '資料庫遷移-loose']);
    expect(names).not.toContain('資料庫遷移-a');
    expect(result.retrieval).toMatchObject({ degraded: true, reason: 'index_out_of_date' });
    closeDatabase();
    expect(sha(dbPath)).toBe(before);
  });

  it('a marker that is not a plain number does not vouch for the index', async () => {
    writeLegacyDatabase(dbPath, ROWS, '1e9');
    fs.chmodSync(dbPath, 0o444);
    openDatabase(dbPath);
    const result = await recallForAgent({ query: '資料庫', projectScope: 'project:B' });
    expect(result.entities.map((e) => e.name).sort()).toEqual(['資料庫遷移-b', '資料庫遷移-loose']);
    expect(result.retrieval).toMatchObject({ mode: 'scan', degraded: true, reason: 'index_out_of_date' });
  });

  it('the plain CLI says a stored-text scan answered, with results and without', () => {
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
    const homeDb = path.join(home, '.memesh', 'knowledge-graph.db');
    writeLegacyDatabase(homeDb);
    fs.chmodSync(homeDb, 0o444);
    try {
      const found = runCli(home, 'recall', '資料庫');
      expect(found.status, found.stderr).toBe(0);
      expect(found.stdout).toContain('3 result(s)');
      expect(found.stdout).toContain('The search index is out of date; these results come from a scan of the stored text.');
      const none = runCli(home, 'recall', 'zebra');
      expect(none.status, none.stderr).toBe(0);
      expect(none.stdout).toContain('No results found by a scan of the stored text (the search index is out of date).');
      expect(none.stdout).not.toContain('keyword index');
    } finally {
      fs.chmodSync(homeDb, 0o644);
    }
  });

  it('the plain CLI still says a scan answered when every match is too large to show', () => {
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
    const homeDb = path.join(home, '.memesh', 'knowledge-graph.db');
    // Same mechanism as tests/cli/recall-size-caps.test.ts: a metadata blob over the response budget.
    writeLegacyDatabase(homeDb, [
      { name: '資料庫遷移-huge', observations: ['資料庫遷移前一定要先備份'], project: null, metadata: JSON.stringify({ blob: 'm'.repeat(40_000) }) },
    ]);
    fs.chmodSync(homeDb, 0o444);
    try {
      const r = runCli(home, 'recall', '資料庫');
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('1 result(s) found, all omitted to keep the response under size');
      expect(r.stdout).toContain('The search index is out of date; these results come from a scan of the stored text.');
    } finally {
      fs.chmodSync(homeDb, 0o644);
    }
  });

  it('a current index answers as before: same memories, mode fts, not degraded', async () => {
    writeLegacyDatabase(dbPath);
    openDatabase(dbPath); // writable: the open rebuilds the index and moves the marker
    const result = await recallForAgent(
      { query: '資料庫', projectScope: 'project:B' },
      { project: 'B', searched: 'project B, memories with no project, and global memories' },
    );
    expect(result.entities.map((e) => e.name).sort()).toEqual(['資料庫遷移-b', '資料庫遷移-loose']);
    expect(result.retrieval).toEqual({ mode: 'fts', degraded: false, truncated: false });
  });

  it('listing recent memories with no query reads the tables and is not marked degraded', async () => {
    staleReadOnly();
    const result = await recallForAgent({ projectScope: 'project:B' });
    expect(result.entities.map((e) => e.name).sort()).toEqual(['資料庫遷移-b', '資料庫遷移-loose']);
    expect(result.retrieval).toEqual({ mode: 'fts', degraded: false, truncated: false });
  });

  it('three or more terms need all of them first, each may sit in a different observation; only then any term', async () => {
    staleReadOnly([
      { name: 'split-across', observations: ['walrus and narwhal', 'pelican notes'], project: null },
      { name: 'walrus-only', observations: ['walrus facts'], project: null },
    ]);
    const all = await recallForAgent({ query: 'walrus narwhal pelican' });
    expect(all.entities.map((e) => e.name)).toEqual(['split-across']);
    expect(all.retrieval).toMatchObject({ mode: 'scan', degraded: true, reason: 'index_out_of_date' });

    const any = await recallForAgent({ query: 'walrus dolphin octopus' });
    expect(any.entities.map((e) => e.name).sort()).toEqual(['split-across', 'walrus-only']);
    expect(any.retrieval).toMatchObject({ mode: 'scan', degraded: true });
  });
});
