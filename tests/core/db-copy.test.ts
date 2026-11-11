/**
 * The copy taken before MeMesh changes stored memories: what it keeps, what it removes,
 * and that a failed or interrupted copy leaves nothing behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { copyDatabaseBefore, DB_COPIES_KEPT } from '../../src/core/db-copy.js';

const PREFIX = 'knowledge-graph-before-note-trust';
let root: string;
let backups: string;
let previousDir: string | undefined;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-db-copy-')));
  backups = path.join(root, 'backups');
  previousDir = process.env.MEMESH_DIR;
  process.env.MEMESH_DIR = root;
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ updateCheck: false }));
  openDatabase(path.join(root, 'kg.db'));
});
afterEach(() => {
  closeDatabase();
  if (previousDir === undefined) delete process.env.MEMESH_DIR;
  else process.env.MEMESH_DIR = previousDir;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A pid that is certainly not running: a child that has already exited. */
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid!;

describe('copyDatabaseBefore', () => {
  it('keeps the newest copies and every record of what was changed', () => {
    for (let i = 0; i < DB_COPIES_KEPT + 2; i++) {
      const copy = copyDatabaseBefore(getDatabase(), PREFIX);
      expect(copy.kind).toBe('ready');
      if (copy.kind === 'ready') fs.writeFileSync(`${copy.path}.json`, '{}');
    }
    const left = fs.readdirSync(backups);
    expect(left.filter(n => n.endsWith('.db'))).toHaveLength(DB_COPIES_KEPT);
    // A record is a few hundred bytes and is the only list of which ids changed: never removed.
    expect(left.filter(n => n.endsWith('.db.json'))).toHaveLength(DB_COPIES_KEPT + 2);
  });

  it('two copies in the same millisecond are two files', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-11T00:00:00.000Z') });
    try {
      const a = copyDatabaseBefore(getDatabase(), PREFIX);
      const b = copyDatabaseBefore(getDatabase(), PREFIX);
      expect(a.kind === 'ready' && b.kind === 'ready' && a.path !== b.path).toBe(true);
      expect(fs.readdirSync(backups).filter(n => n.endsWith('.db'))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes only its own kind: a longer prefix that starts the same is not its copy', () => {
    for (let i = 0; i < DB_COPIES_KEPT + 1; i++) expect(copyDatabaseBefore(getDatabase(), `${PREFIX}-other`).kind).toBe('ready');
    const mine = copyDatabaseBefore(getDatabase(), PREFIX);
    expect(mine.kind).toBe('ready');
    expect(mine.kind === 'ready' && fs.existsSync(mine.path)).toBe(true);
  });

  it('a copy with fewer memories than the database is refused, and leaves no partial file or journal', () => {
    getDatabase().prepare("INSERT INTO entities (name, type) VALUES ('one', 'note')").run();
    const db = getDatabase();
    const real = db.prepare.bind(db);
    (db as unknown as { prepare: (s: string) => unknown }).prepare = (s: string) =>
      real(s.includes('db_copy_check.entities') ? 'SELECT 0 AS n' : s);
    try {
      const copy = copyDatabaseBefore(db, PREFIX);
      expect(copy.kind).toBe('failed');
    } finally {
      (db as unknown as { prepare: unknown }).prepare = real;
    }
    expect(fs.readdirSync(backups).filter(n => n.startsWith('.partial'))).toEqual([]);
  });

  it('removes what an interrupted copy left behind, and leaves a running copy alone', () => {
    fs.mkdirSync(backups, { recursive: true });
    const stale = `.partial-${PREFIX}-${deadPid()}-0000aaaa.db`;
    const running = `.partial-${PREFIX}-${process.ppid}-0000bbbb.db`;
    for (const name of [stale, `${stale}-journal`, running]) fs.writeFileSync(path.join(backups, name), 'x');
    expect(copyDatabaseBefore(getDatabase(), PREFIX).kind).toBe('ready');
    const left = fs.readdirSync(backups).filter(n => n.startsWith('.partial'));
    expect(left).toEqual([running]);
  });

  it('a database with no file path gets no copy, and the reason says so', () => {
    const mem = new MemeshDatabase(':memory:');
    try {
      const copy = copyDatabaseBefore(mem, PREFIX);
      expect(copy.kind).toBe('failed');
      expect(copy.kind === 'failed' && copy.reason).toMatch(/no file path/);
    } finally { mem.close(); }
  });
});
