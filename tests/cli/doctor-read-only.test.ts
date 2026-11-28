/**
 * `memesh doctor` asks whether an install is healthy. It must not change what it is asking about:
 *  - on a machine where MeMesh has never stored anything it says there is no database yet, and creates none (and
 *    runs no schema or migration);
 *  - on an existing database it writes no data: the file stays byte for byte as it was, even when the schema is
 *    older than this version, which it reports instead of migrating. (Like any open, it takes group/other access
 *    off the files, and a read of a WAL database may leave the -wal/-shm beside it: those are not data.)
 *
 * Runs the built CLI against a throwaway HOME.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { cliEnv, runCli } from '../helpers/built-cli.js';
import { removeTempDir } from '../helpers/temp-dir.js';

describe('memesh doctor does not create or change the database', () => {
  let home: string;
  let dir: string;
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-doctor-ro-')));
    dir = path.join(home, '.memesh');
  });
  afterEach(() => { removeTempDir(home); });

  const cli = (args: string[]) => runCli(args, { cwd: home, env: cliEnv(home), timeout: 60_000 });
  const row = (stdout: string, id: string) => (JSON.parse(stdout) as { checks: Array<{ id: string; status: string; summary: string; fix?: string; informational?: boolean }> }).checks.find((c) => c.id === id);
  /** Every database-shaped file under HOME. */
  function databaseFiles(): string[] {
    const found: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(db|sqlite)(-wal|-shm)?$/.test(e.name)) found.push(path.relative(home, full));
      }
    };
    walk(home);
    return found.sort();
  }
  /** The database files themselves, not the -wal/-shm a reading connection leaves beside a WAL database. */
  const mainFiles = () => databaseFiles().filter((f) => !/-(wal|shm)$/.test(f));
  /** Everything under HOME, folders included. */
  function everything(): string[] {
    const found: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        found.push(`${path.relative(home, full)}${e.isDirectory() ? '/' : ''}`);
        if (e.isDirectory()) walk(full);
      }
    };
    walk(home);
    // npm's own log folder is npm's, not MeMesh's: the doctor asks npm where global packages live.
    return found.filter((entry) => !entry.startsWith('.npm')).sort();
  }
  const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

  it('on a fresh HOME it reports "no database yet" and leaves no database file behind', () => {
    expect(databaseFiles()).toEqual([]);
    const r = cli(['doctor', '--json']);
    expect(r.stdout.length, `doctor printed nothing: ${r.stderr}`).toBeGreaterThan(0);
    const database = row(r.stdout, 'database');
    expect(database?.summary).toContain('No database yet');
    expect(database?.status).not.toBe('fail');
    expect(database?.informational).toBe(true);
    expect(row(r.stdout, 'install_id')?.summary).toContain('No install ID yet');
    for (const id of ['hook-activity', 'capture-liveness']) {
      expect(row(r.stdout, id)?.summary, `${id} did not say why it was not checked`).toContain('No database yet');
      expect(row(r.stdout, id)?.status).not.toBe('fail');
    }
    expect(databaseFiles(), 'doctor created a database').toEqual([]);
    // Not a database, not an install ID, not even the folder: asking whether MeMesh is healthy left nothing behind.
    expect(everything(), 'doctor left files or folders in a HOME nobody has used').toEqual([]);
  });

  it('on an existing database it changes nothing: the file is byte-for-byte the same afterwards', () => {
    const stored = cli(['remember', '--name', 'doctor-readonly-memory', '--type', 'note', '--obs', 'keep me as I am', '--tags', 'project:doctor-readonly']);
    expect(stored.status, stored.stderr).toBe(0);
    const db = path.join(dir, 'knowledge-graph.db');
    expect(fs.existsSync(db)).toBe(true);
    // A WAL database is already in its final shape, so a read-write open would change nothing in the file and this
    // test could not tell the two apart. In rollback mode a read-write open rewrites the header (it switches the
    // database to WAL): that is the change this test watches for.
    const convert = new DatabaseSync(db);
    convert.exec('PRAGMA journal_mode = DELETE');
    convert.close();
    const before = { sha: sha(db), files: mainFiles() };
    expect(before.files.length, 'no database files to compare').toBeGreaterThan(0);
    const r = cli(['doctor', '--json']);
    expect(r.stdout.length, r.stderr).toBeGreaterThan(0);
    expect(row(r.stdout, 'database')?.summary).toContain('Database opened successfully');
    expect(sha(db), 'doctor rewrote the database file').toBe(before.sha);
    expect(mainFiles(), 'doctor added or removed a database').toEqual(before.files);
    const after = new DatabaseSync(db, { readOnly: true });
    try {
      expect((after.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('delete');
    } finally { after.close(); }
  });

  it('a database written by an older version is reported as behind, not migrated', () => {
    fs.mkdirSync(dir, { recursive: true });
    const db = path.join(dir, 'knowledge-graph.db');
    const old = new DatabaseSync(db);
    old.exec('CREATE TABLE entities (id INTEGER PRIMARY KEY, name TEXT, type TEXT, created_at TEXT)');
    old.exec("INSERT INTO entities (name, type, created_at) VALUES ('old-row', 'note', '2026-01-01')");
    old.close();
    const before = sha(db);
    const r = cli(['doctor', '--json']);
    expect(r.stdout.length, r.stderr).toBeGreaterThan(0);
    const database = row(r.stdout, 'database');
    expect(database?.status).toBe('warn');
    expect(database?.summary).toMatch(/older than this version/);
    expect(sha(db), 'doctor migrated the database').toBe(before);
    expect(r.stderr, 'doctor tried a migration and reported its failure').not.toMatch(/migration was skipped|read-only/);
    for (const id of ['hook-activity', 'capture-liveness']) {
      expect(row(r.stdout, id)?.status, `${id} failed on a layout that is only behind`).not.toBe('fail');
      expect(row(r.stdout, id)?.summary, `${id} did not say why it was not checked`).toMatch(/^Not checked: .*older version/);
    }
    const check = new DatabaseSync(db, { readOnly: true });
    try {
      const tables = (check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
      expect(tables).toEqual(['entities']);
    } finally { check.close(); }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an older-layout database in a folder that cannot be written is told how to make it writable, not to run a command that would fail', () => {
    fs.mkdirSync(dir, { recursive: true });
    const db = path.join(dir, 'knowledge-graph.db');
    const old = new DatabaseSync(db);
    old.exec('CREATE TABLE entities (id INTEGER PRIMARY KEY, name TEXT, type TEXT, created_at TEXT)');
    old.close();
    fs.chmodSync(dir, 0o555);
    try {
      const r = cli(['doctor', '--json']);
      expect(r.stdout.length, r.stderr).toBeGreaterThan(0);
      const database = row(r.stdout, 'database');
      expect(database?.status).toBe('warn');
      expect(database?.fix, 'the fix does not make the folder writable').toContain(`chmod u+w '${dir}'`);
      expect(database?.fix, 'the chmod must come before the command it makes possible').toMatch(/First run: chmod u\+w '.*'; then run any memesh command/);
      expect(row(r.stdout, 'hook-activity')?.summary).toContain(`chmod u+w '${dir}'`);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('no database yet, in a folder that cannot be written: the row says MeMesh cannot create one, with the fix', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o555);
    try {
      const r = cli(['doctor', '--json']);
      expect(r.stdout.length, r.stderr).toBeGreaterThan(0);
      const database = row(r.stdout, 'database');
      expect(database?.status).toBe('warn');
      expect(database?.summary).toContain('cannot create one');
      expect(database?.fix).toBe(`chmod u+w '${dir}'`);
      expect(databaseFiles()).toEqual([]);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });
});
