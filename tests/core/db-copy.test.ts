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

  it('the copy just made is never the one removed, even when the clock went back and older copies have later names', () => {
    fs.mkdirSync(backups, { recursive: true });
    const later = ['2099-01-01T00-00-00-001Z', '2099-01-01T00-00-00-002Z', '2099-01-01T00-00-00-003Z']
      .map((stamp) => `${PREFIX}-${stamp}-0000aaaa.db`);
    for (const name of later) fs.writeFileSync(path.join(backups, name), 'x');
    const copy = copyDatabaseBefore(getDatabase(), PREFIX);
    expect(copy.kind).toBe('ready');
    expect(copy.kind === 'ready' && fs.existsSync(copy.path)).toBe(true);
    const left = fs.readdirSync(backups).filter(n => n.endsWith('.db')).sort();
    expect(left).toHaveLength(DB_COPIES_KEPT);
    expect(left).toEqual([...later.slice(-(DB_COPIES_KEPT - 1)), path.basename(copy.kind === 'ready' ? copy.path : '')].sort());
  });

  it('the copies kept are the newest ones', () => {
    const made: string[] = [];
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-11T00:00:00.000Z') });
    try {
      for (let i = 0; i < DB_COPIES_KEPT + 2; i++) {
        vi.setSystemTime(new Date(Date.UTC(2026, 10, 11, 0, 0, i)));
        const copy = copyDatabaseBefore(getDatabase(), PREFIX);
        if (copy.kind === 'ready') made.push(path.basename(copy.path));
      }
    } finally {
      vi.useRealTimers();
    }
    expect(made).toHaveLength(DB_COPIES_KEPT + 2);
    expect(fs.readdirSync(backups).filter(n => n.endsWith('.db')).sort()).toEqual(made.slice(-DB_COPIES_KEPT));
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

  it('the copy holds the whole graph, so only its owner can read it', () => {
    const previousMask = process.umask(0o022);
    try {
      const copy = copyDatabaseBefore(getDatabase(), PREFIX);
      expect(copy.kind).toBe('ready');
      if (copy.kind === 'ready') expect(fs.statSync(copy.path).mode & 0o777).toBe(0o600);
      expect(fs.statSync(backups).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(previousMask);
    }
  });

  it('a copy that fails before it is put in place leaves neither its partial file nor its journal', () => {
    let partial = '';
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike) => {
      partial = String(from);
      // What a copy stopped while it wrote to itself leaves beside it.
      fs.writeFileSync(`${partial}-journal`, 'x');
      throw new Error('rename refused');
    }) as typeof fs.renameSync);
    try {
      expect(copyDatabaseBefore(getDatabase(), PREFIX).kind).toBe('failed');
    } finally {
      vi.restoreAllMocks();
    }
    expect(partial).toMatch(/\.partial-/);
    expect(fs.readdirSync(backups).filter(n => n.startsWith('.partial'))).toEqual([]);
  });

  it('a partial copy of a process it may not signal (another user\'s, EPERM) is running, and is left alone', () => {
    fs.mkdirSync(backups, { recursive: true });
    const theirs = `.partial-${PREFIX}-424242-0000cccc.db`;
    fs.writeFileSync(path.join(backups, theirs), 'x');
    const realKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid === 424242) throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
      return realKill(pid, signal);
    }) as typeof process.kill);
    try {
      expect(copyDatabaseBefore(getDatabase(), PREFIX).kind).toBe('ready');
    } finally {
      vi.restoreAllMocks();
    }
    expect(fs.readdirSync(backups)).toContain(theirs);
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
