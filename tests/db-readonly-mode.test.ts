/**
 * #520: opening the database tightens permissions for other users but never
 * gives the owner a right the owner took away. A database the user made
 * read-only (a snapshot, a backup) must stay read-only for every later
 * process, not only the first one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, openDatabase } from '../src/db.js';

const posix = process.platform !== 'win32';

describe('Feature: #520 a read-only database stays read-only', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-readonly-mode-'));
    dbPath = path.join(dir, 'knowledge-graph.db');
    openDatabase(dbPath);
    closeDatabase();
  });

  afterEach(() => {
    try { closeDatabase(); } catch { /* not open */ }
    try { fs.chmodSync(dbPath, 0o600); } catch { /* gone */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it.skipIf(!posix)('opening a chmod 444 database does not make it writable', () => {
    fs.chmodSync(dbPath, 0o444);
    openDatabase(dbPath);
    closeDatabase();
    const mode = fs.statSync(dbPath).mode & 0o777;
    expect(mode & 0o400).toBeGreaterThan(0); // the owner can still read it
    expect(mode & 0o200).toBe(0);            // the owner still cannot write
    expect(mode & 0o077).toBe(0);            // group and others lost their read bit
  });

  it.skipIf(!posix)('a second open of that database still cannot write to it', () => {
    fs.chmodSync(dbPath, 0o444);
    openDatabase(dbPath);
    closeDatabase();
    const db = openDatabase(dbPath);
    expect(() => db.prepare("INSERT INTO entities (name, type) VALUES ('should-not-land', 'note')").run())
      .toThrow(/readonly/i);
  });

  it.skipIf(!posix)('a world-readable writable database is still tightened to owner-only', () => {
    fs.chmodSync(dbPath, 0o644);
    openDatabase(dbPath);
    closeDatabase();
    expect(fs.statSync(dbPath).mode & 0o777).toBe(0o600);
  });
});

describe('Feature: #520 a read-only snapshot folder still opens for reading', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-readonly-dir-'));
    dbPath = path.join(dir, 'knowledge-graph.db');
    const db = openDatabase(dbPath);
    db.prepare("INSERT INTO entities (name, type) VALUES ('snapshot-row', 'note')").run();
    closeDatabase();
  });

  afterEach(() => {
    try { closeDatabase(); } catch { /* not open */ }
    try { fs.chmodSync(dir, 0o700); fs.chmodSync(dbPath, 0o600); } catch { /* gone */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it.skipIf(!posix || process.getuid?.() === 0)('a read-only database in a read-only folder is refused loudly and nothing is made writable', () => {
    // A WAL database cannot be read without creating its -shm file, and the
    // folder refuses that. Opening it used to "work" only by making the
    // folder and the file writable again — the defect itself.
    fs.chmodSync(dbPath, 0o444);
    fs.chmodSync(dir, 0o555);
    expect(() => openDatabase(dbPath)).toThrow(/readonly|read-only/i);
    expect(fs.statSync(dir).mode & 0o200).toBe(0);
    expect(fs.statSync(dbPath).mode & 0o200).toBe(0);
    expect(fs.statSync(dbPath).mode & 0o400).toBeGreaterThan(0);
  });
});
