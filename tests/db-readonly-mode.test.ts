/**
 * #520: opening the database tightens permissions for other users but never
 * gives the owner a right the owner took away. A database the user made
 * read-only (a snapshot, a backup) must stay read-only for every later
 * process, not only the first one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { closeDatabase, openDatabase } from '../src/db.js';
import { MemeshDatabase } from '../src/storage/sqlite.js';
import { belongsToAnotherUser, ownerWriteCommand, SIDECAR_PERMISSIONS_CODE } from '../src/core/file-mode.js';

const posix = process.platform !== 'win32';

/** A root-owned file without the owner write bit, if this system has one. */
const rootOwnedReadOnly = ['/etc/sudoers', '/usr/share/firmlinks'].find((file) => {
  try {
    const stat = fs.statSync(file);
    return stat.uid === 0 && (stat.mode & 0o200) === 0;
  } catch { return false; }
});

/**
 * Read the modes of `targets` after every SQLite call the open makes, so a
 * permission SQLite adds and something later takes back is still caught: the
 * end state alone cannot show a window in which another writer got in.
 */
function sampleModesDuringOpen(targets: string[]): number[][] {
  const samples: number[][] = [];
  for (const method of ['pragma', 'exec', 'prepare'] as const) {
    const original = MemeshDatabase.prototype[method] as (...args: unknown[]) => unknown;
    vi.spyOn(MemeshDatabase.prototype, method).mockImplementation(function (this: MemeshDatabase, ...args: unknown[]) {
      const result = original.apply(this, args);
      samples.push(targets.map((t) => (fs.existsSync(t) ? fs.statSync(t).mode & 0o777 : -1)));
      return result;
    } as never);
  }
  return samples;
}

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

describe('Feature: #520 a read-only snapshot folder is read, never made writable', () => {
  let live: string;
  let dir: string;
  let dbPath: string;
  const files = () => ['', '-wal', '-shm'].map((suffix) => `${dbPath}${suffix}`);
  const sha = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

  beforeEach(() => {
    // The snapshot is a copy of a database IN USE: one row checkpointed into
    // the main file, one that lives only in its -wal, with -wal and -shm
    // copied alongside it.
    live = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-live-'));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-readonly-dir-'));
    dbPath = path.join(dir, 'knowledge-graph.db');
    const livePath = path.join(live, 'knowledge-graph.db');
    openDatabase(livePath).prepare("INSERT INTO entities (name, type) VALUES ('snapshot-row', 'note')").run();
    closeDatabase();
    const peer = new MemeshDatabase(livePath);
    try {
      peer.prepare("INSERT INTO entities (name, type) VALUES ('wal-only-row', 'note')").run();
      for (const suffix of ['', '-wal', '-shm']) fs.copyFileSync(`${livePath}${suffix}`, `${dbPath}${suffix}`);
    } finally {
      peer.close();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { closeDatabase(); } catch { /* not open */ }
    try { fs.chmodSync(dir, 0o700); } catch { /* gone */ }
    for (const file of files()) {
      try { fs.chmodSync(file, 0o600); } catch { /* absent */ }
    }
    for (const folder of [dir, live]) {
      fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  /** Owner read-only on every file, folder read-only too: a real snapshot. */
  function makeReadOnly(): void {
    for (const file of files()) if (fs.existsSync(file)) fs.chmodSync(file, 0o444);
    fs.chmodSync(dir, 0o555);
  }

  function expectNoOwnerWrite(): void {
    for (const target of [dir, ...files()]) {
      if (fs.existsSync(target)) expect(fs.statSync(target).mode & 0o200, target).toBe(0);
    }
  }

  it.skipIf(!posix || process.getuid?.() === 0)('with its -wal and -shm files present it opens for reading; a write is refused and changes nothing', () => {
    makeReadOnly();
    const before = files().map(sha);

    const during = sampleModesDuringOpen(files());
    const db = openDatabase(dbPath);
    vi.restoreAllMocks();
    expect(during.length).toBeGreaterThan(0);
    for (const sample of during) for (const m of sample) expect(m & 0o200).toBe(0);
    const names = db.prepare('SELECT name FROM entities ORDER BY name').all() as Array<{ name: string }>;
    expect(names.map((r) => r.name)).toEqual(['snapshot-row', 'wal-only-row']);
    expect(() => db.prepare("INSERT INTO entities (name, type) VALUES ('should-not-land', 'note')").run())
      .toThrow(/readonly/i);
    closeDatabase();

    expect(files().map(sha)).toEqual(before);
    expect(openDatabase(dbPath).prepare("SELECT count(*) AS n FROM entities WHERE name = 'should-not-land'").get())
      .toEqual({ n: 0 });
    expectNoOwnerWrite();
  });

  for (const missing of ['-shm', '-wal']) {
    it.skipIf(!posix || process.getuid?.() === 0)(`without its ${missing} file, which the folder cannot create, it fails loudly and nothing is made writable`, () => {
      fs.rmSync(`${dbPath}${missing}`);
      makeReadOnly();
      // Names the folder and a way out, not SQLite's bare "unable to open".
      let message = '';
      try { openDatabase(dbPath); } catch (err) { message = String(err); }
      expect(message).toContain(dir);
      expect(message).toMatch(/read-only/);
      expect(message).toContain('MEMESH_DB_PATH');
      expect(fs.existsSync(`${dbPath}${missing}`)).toBe(false);
      expectNoOwnerWrite();
    });
  }

  it.skipIf(!posix || process.getuid?.() === 0)('with neither -wal nor -shm it fails loudly and nothing is made writable', () => {
    // A WAL database cannot be read without creating its -shm file, and the
    // folder refuses that. Opening it used to "work" only by making the
    // folder and the file writable again — the defect itself.
    fs.rmSync(`${dbPath}-wal`);
    fs.rmSync(`${dbPath}-shm`);
    makeReadOnly();
    expect(() => openDatabase(dbPath)).toThrow(/readonly|read-only/i);
    expectNoOwnerWrite();
    expect(fs.statSync(dbPath).mode & 0o400).toBeGreaterThan(0);
  });
});

describe('Feature: #520 permission hardening covers every file, every outcome', () => {
  let dir: string;
  let dbPath: string;
  let peer: MemeshDatabase | undefined;
  const mode = (p: string) => fs.statSync(p).mode & 0o777;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-hardening-'));
    dbPath = path.join(dir, 'knowledge-graph.db');
    openDatabase(dbPath);
    closeDatabase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Writable again BEFORE the connections close, so the last one can
    // checkpoint and remove its WAL.
    try { fs.chmodSync(dir, 0o700); } catch { /* gone */ }
    for (const s of ['', '-wal', '-shm']) {
      try { fs.chmodSync(`${dbPath}${s}`, 0o600); } catch { /* absent */ }
    }
    try { closeDatabase(); } catch { /* not open */ }
    try { peer?.close(); } catch { /* already closed */ }
    peer = undefined;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** A second reader keeps the -wal and -shm files on disk between opens. */
  function keepSidecars(): void {
    peer = new MemeshDatabase(dbPath);
    peer.prepare('SELECT count(*) FROM entities').get();
  }

  it.skipIf(!posix)('a permission change that cannot be applied is reported on stderr, never skipped silently', () => {
    fs.chmodSync(dbPath, 0o644);
    fs.chmodSync(dir, 0o755);
    const realChmod = fs.chmodSync;
    vi.spyOn(fs, 'chmodSync').mockImplementation((target, m) => {
      if (String(target) === dbPath || String(target) === dir) {
        throw Object.assign(new Error('read-only file system'), { code: 'EROFS' });
      }
      realChmod(target, m);
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    openDatabase(dbPath);
    const written = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain(dbPath);
    expect(written).toContain(dir);
    expect(written).toContain('EROFS');
  });

  it.skipIf(!posix)('an open that succeeds removes group/other access from the folder, the database, -wal and -shm', () => {
    keepSidecars();
    for (const s of ['', '-wal', '-shm']) fs.chmodSync(`${dbPath}${s}`, 0o664);
    fs.chmodSync(dir, 0o775);
    openDatabase(dbPath);
    expect(mode(dir)).toBe(0o700);
    for (const s of ['', '-wal', '-shm']) expect(mode(`${dbPath}${s}`), s || 'database').toBe(0o600);
  });

  // SQLite gives an EMPTY -wal the database file's mode when it opens it. The
  // tests below need that empty -wal, or they would pass vacuously.
  it.skipIf(!posix)('an empty read-only -wal next to a writable database is refused before SQLite opens anything', () => {
    keepSidecars();
    const wal = `${dbPath}-wal`;
    expect(fs.statSync(wal).size).toBe(0);
    fs.chmodSync(wal, 0o444);
    const during = sampleModesDuringOpen([wal]);
    let error: (Error & { fix?: string }) | undefined;
    try { openDatabase(dbPath); } catch (err) { error = err as Error & { fix?: string }; }
    expect(error?.message).toContain(wal);
    expect(error?.fix).toBe(`chmod u+w "${wal}"`);
    expect(error?.message).toContain(`chmod u-w "${dbPath}"`); // the read-only way out too
    expect(during).toEqual([]); // SQLite never ran, so it never widened the -wal
    expect(mode(wal)).toBe(0o400); // group/other gone, owner bits as the owner set them
  });

  it.skipIf(!posix)('a non-empty read-only -wal next to a writable database is refused and never written', () => {
    keepSidecars();
    peer!.prepare("INSERT INTO entities (name, type) VALUES ('only-in-the-wal', 'note')").run();
    const wal = `${dbPath}-wal`;
    const before = fs.readFileSync(wal);
    expect(before.length).toBeGreaterThan(0);
    fs.chmodSync(wal, 0o444);
    expect(() => openDatabase(dbPath)).toThrow(`chmod u+w "${wal}"`);
    expect(fs.readFileSync(wal).equals(before)).toBe(true);
    expect(mode(wal)).toBe(0o400);
    expect(peer!.prepare("SELECT count(*) AS n FROM entities WHERE name = 'only-in-the-wal'").get()).toEqual({ n: 1 });
  });

  it.skipIf(!posix)('a read-only database opens for reads next to non-empty writable sidecars, changes none of them, and says how to write again', () => {
    keepSidecars();
    peer!.prepare("INSERT INTO entities (name, type) VALUES ('only-in-the-wal', 'note')").run();
    expect(fs.statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
    fs.chmodSync(dbPath, 0o444);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const during = sampleModesDuringOpen([`${dbPath}-wal`, `${dbPath}-shm`]);
    const db = openDatabase(dbPath);
    expect(db.prepare("SELECT count(*) AS n FROM entities WHERE name = 'only-in-the-wal'").get()).toEqual({ n: 1 });
    expect(() => db.prepare("INSERT INTO entities (name, type) VALUES ('refused', 'note')").run()).toThrow(/readonly/i);
    const written = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain(`To write to it again, run: chmod u+w "${dbPath}"`);
    expect(during.length).toBeGreaterThan(0);
    for (const sample of during) expect(sample).toEqual([0o600, 0o600]); // not even for a moment
    expect(mode(dbPath)).toBe(0o400);
    for (const s of ['-wal', '-shm']) expect(mode(`${dbPath}${s}`), s).toBe(0o600);
  });

  it.skipIf(!posix)('an empty writable -wal next to a read-only database is refused, since SQLite would reset it', () => {
    keepSidecars();
    const wal = `${dbPath}-wal`;
    expect(fs.statSync(wal).size).toBe(0);
    fs.chmodSync(dbPath, 0o444);
    const during = sampleModesDuringOpen([wal]);
    let error: (Error & { fix?: string }) | undefined;
    try { openDatabase(dbPath); } catch (err) { error = err as Error & { fix?: string }; }
    expect(error?.fix).toBe(`chmod u-w "${wal}"`);
    expect(error?.message).toContain(`chmod u+w "${dbPath}"`);
    expect(during).toEqual([]);
    expect(mode(wal)).toBe(0o600);
  });

  it.skipIf(!posix)('a read-only database with an empty read-only -wal opens, and no write bit appears at any point of the open', () => {
    keepSidecars();
    const wal = `${dbPath}-wal`;
    expect(fs.statSync(wal).size).toBe(0);
    fs.chmodSync(dbPath, 0o444);
    fs.chmodSync(wal, 0o444);
    const during = sampleModesDuringOpen([dbPath, wal]);
    const db = openDatabase(dbPath);
    expect(db.prepare('SELECT count(*) AS n FROM entities').get()).toEqual({ n: 0 });
    expect(during.length).toBeGreaterThan(0);
    for (const sample of during) for (const m of sample) expect(m & 0o200).toBe(0);
    expect(mode(dbPath)).toBe(0o400);
    expect(mode(wal)).toBe(0o400);
  });

  it.skipIf(!posix)('a world-readable database never lends group/other access to its empty -wal, not even during the open', () => {
    keepSidecars();
    const wal = `${dbPath}-wal`;
    expect(fs.statSync(wal).size).toBe(0);
    fs.chmodSync(dbPath, 0o644);
    fs.chmodSync(wal, 0o600);
    const during = sampleModesDuringOpen([wal]);
    openDatabase(dbPath);
    expect(during.length).toBeGreaterThan(0);
    for (const [m] of during) expect(m & 0o077).toBe(0);
    expect(mode(wal)).toBe(0o600);
  });

  it.skipIf(!posix)('the owner x bit is not asked of a non-empty -wal/-shm (a database unpacked 0700 opens)', () => {
    keepSidecars();
    peer!.prepare("INSERT INTO entities (name, type) VALUES ('in-the-wal', 'note')").run();
    expect(fs.statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
    fs.chmodSync(dbPath, 0o700);
    const db = openDatabase(dbPath);
    expect(db.prepare("SELECT count(*) AS n FROM entities WHERE name = 'in-the-wal'").get()).toEqual({ n: 1 });
    for (const s of ['-wal', '-shm']) expect(mode(`${dbPath}${s}`), s).toBe(0o600);
  });

  it.skipIf(!posix)('a symlinked database path is checked where SQLite keeps its -wal/-shm: beside the real file', () => {
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-db-link-'));
    const link = path.join(linkDir, 'link.db');
    fs.symlinkSync(dbPath, link);
    try {
      fs.chmodSync(dbPath, 0o444);
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      openDatabase(dbPath).prepare('SELECT count(*) FROM entities').get();
      closeDatabase();
      expect(fs.statSync(`${dbPath}-wal`).size).toBe(0);
      fs.chmodSync(dbPath, 0o600);
      let error: (Error & { fix?: string }) | undefined;
      try { openDatabase(link); } catch (err) { error = err as Error & { fix?: string }; }
      const real = fs.realpathSync(dbPath); // SQLite's own name for the file
      expect(error?.fix).toBe(`chmod u+w "${real}-wal" "${real}-shm"`);
      expect(mode(`${dbPath}-wal`) & 0o200).toBe(0);
      expect(fs.existsSync(`${link}-wal`)).toBe(false);
    } finally {
      fs.rmSync(linkDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!posix)('a mismatched -wal/-shm that belongs to another user gets a way out, not a chmod the owner cannot run', () => {
    fs.chmodSync(dbPath, 0o444);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    openDatabase(dbPath).prepare('SELECT count(*) FROM entities').get();
    closeDatabase();
    fs.chmodSync(dbPath, 0o600);
    // A stubbed uid, never a real other user: the sidecars now look like
    // someone else's.
    vi.spyOn(process, 'getuid').mockReturnValue(fs.statSync(`${dbPath}-wal`).uid + 1);
    let error: (Error & { fix?: string; code?: string }) | undefined;
    try { openDatabase(dbPath); } catch (err) { error = err as Error & { fix?: string; code?: string }; }
    expect(error?.message).toMatch(/belongs? to another user/);
    expect(error?.fix).toBe('Point MEMESH_DB_PATH at a database you own, in a folder you own.');
    expect(error?.message).not.toContain('chmod');
    expect(error?.code).toBe(SIDECAR_PERMISSIONS_CODE);
    for (const s of ['-wal', '-shm']) expect(mode(`${dbPath}${s}`), s).toBe(0o400);
    expect(mode(dbPath)).toBe(0o600);
  });

  it.skipIf(!posix)('an empty -wal with more owner permissions that belongs to another user gets the same way out', () => {
    closeDatabase();
    for (const s of ['-wal', '-shm']) fs.rmSync(`${dbPath}${s}`, { force: true });
    fs.writeFileSync(`${dbPath}-wal`, '');
    fs.chmodSync(`${dbPath}-wal`, 0o700);
    vi.spyOn(process, 'getuid').mockReturnValue(fs.statSync(`${dbPath}-wal`).uid + 1);
    let error: (Error & { fix?: string }) | undefined;
    try { openDatabase(dbPath); } catch (err) { error = err as Error & { fix?: string }; }
    expect(error?.fix).toBe('Point MEMESH_DB_PATH at a database you own, in a folder you own.');
    expect(error?.message).not.toContain('chmod');
    expect(mode(`${dbPath}-wal`)).toBe(0o700);
  });

  // Root can chmod any file, so it is never told a file is someone else's.
  it.skipIf(!posix || process.getuid?.() === 0)('a mismatched -wal next to a database that belongs to another user gets the same way out', () => {
    fs.chmodSync(dbPath, 0o444);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    openDatabase(dbPath).prepare('SELECT count(*) FROM entities').get();
    closeDatabase();
    fs.chmodSync(dbPath, 0o600);
    // Only the database looks like someone else's; the -wal/-shm stay yours.
    const statSync = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) => {
      const stat = statSync(p, o as never);
      return stat && String(p) === dbPath ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: stat.uid + 1 }) : stat;
    }) as typeof fs.statSync);
    let error: (Error & { fix?: string }) | undefined;
    try { openDatabase(dbPath); } catch (err) { error = err as Error & { fix?: string }; }
    expect(error?.message).toContain(`${dbPath} belongs to another user`);
    expect(error?.fix).toBe('Point MEMESH_DB_PATH at a database you own, in a folder you own.');
  });

  it.skipIf(!posix || process.getuid?.() === 0)('a symlinked database opens when only the link\'s folder is read-only: the real file\'s folder holds the -wal/-shm', () => {
    keepSidecars(); // the -wal/-shm a killed writer leaves beside the real file
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-db-link-ro-'));
    const link = path.join(linkDir, 'kg.db');
    fs.symlinkSync(dbPath, link);
    fs.chmodSync(linkDir, 0o500);
    try {
      const db = openDatabase(link);
      expect(db.prepare('SELECT count(*) AS n FROM entities').get()).toEqual({ n: 0 });
      closeDatabase();
      expect(mode(linkDir)).toBe(0o500);
    } finally {
      fs.chmodSync(linkDir, 0o700);
      fs.rmSync(linkDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!posix || process.getuid?.() === 0)('a symlinked database whose REAL folder is read-only and holds no -wal/-shm is refused, naming the real folder', () => {
    for (const s of ['-wal', '-shm']) fs.rmSync(`${dbPath}${s}`, { force: true });
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-db-link-rw-'));
    const link = path.join(linkDir, 'kg.db');
    fs.symlinkSync(dbPath, link);
    const realDir = path.dirname(fs.realpathSync(dbPath));
    fs.chmodSync(dir, 0o500);
    try {
      let error: (Error & { fix?: string }) | undefined;
      try { openDatabase(link); } catch (err) { error = err as Error & { fix?: string }; }
      expect(error?.message).toContain(`MeMesh: ${realDir} is read-only`);
      expect(error?.fix).toBe(`chmod u+w "${realDir}"`);
      expect(mode(dir)).toBe(0o500);
    } finally {
      fs.chmodSync(dir, 0o700);
      fs.rmSync(linkDir, { recursive: true, force: true });
    }
  });


  it.skipIf(!posix)('a symlinked database\'s real folder is left as it is; only the link\'s folder is tightened', () => {
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-db-link-open-'));
    const link = path.join(linkDir, 'kg.db');
    fs.symlinkSync(dbPath, link);
    fs.chmodSync(dir, 0o755);
    fs.chmodSync(linkDir, 0o755);
    try {
      openDatabase(link);
      closeDatabase();
      expect(mode(dir)).toBe(0o755);
      expect(mode(linkDir)).toBe(0o700);
    } finally {
      fs.chmodSync(dir, 0o700);
      fs.rmSync(linkDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!posix || process.getuid?.() === 0)('a symlinked database\'s read-only real folder is never given an owner bit', () => {
    keepSidecars(); // so the read-only folder can still be read
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-db-link-ro-real-'));
    const link = path.join(linkDir, 'kg.db');
    fs.symlinkSync(dbPath, link);
    fs.chmodSync(dir, 0o500);
    try {
      openDatabase(link).prepare('SELECT count(*) FROM entities').get();
      closeDatabase();
      expect(mode(dir)).toBe(0o500);
    } finally {
      fs.chmodSync(dir, 0o700);
      fs.rmSync(linkDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!posix || process.getuid?.() === 0)('a database in a folder that belongs to another user is refused with a way out, not a chmod the owner cannot run', () => {
    // /etc/hosts: an existing file in a root-owned folder this user cannot
    // write to, and with no -wal/-shm beside it. Never run as root: the guard
    // would then really change /etc.
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-db-link-other-'));
    const link = path.join(linkDir, 'kg.db');
    fs.symlinkSync('/etc/hosts', link);
    const realDir = path.dirname(fs.realpathSync(link));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      let error: (Error & { fix?: string }) | undefined;
      try { openDatabase(link); } catch (err) { error = err as Error & { fix?: string }; }
      expect(error?.message).toContain(`${realDir} belongs to another user`);
      expect(error?.message).toContain('Point MEMESH_DB_PATH at a database you own, in a folder you own.');
      expect(error?.message).not.toContain('chmod u+w');
      expect(error?.fix).not.toContain('chmod');
    } finally {
      fs.rmSync(linkDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!posix || process.getuid?.() === 0 || !rootOwnedReadOnly)('a read-only database that belongs to another user gets a way out, not a chmod the owner cannot run', () => {
    const advice = ownerWriteCommand(rootOwnedReadOnly!);
    expect(advice).toContain(`${rootOwnedReadOnly} belongs to another user`);
    expect(advice).toContain('point MEMESH_DB_PATH at a database you own, in a folder you own');
    expect(advice).not.toContain('chmod');
  });

  it.skipIf(!posix)('root is never told a file belongs to another user: it gets the chmod, which root can run', () => {
    // A stubbed uid, never a real root run: one read-only file of this
    // user's, seen first by another user and then by root.
    const readOnly = path.join(dir, 'seen-by-root.db');
    fs.writeFileSync(readOnly, '');
    fs.chmodSync(readOnly, 0o444);
    const getuid = vi.spyOn(process, 'getuid');
    getuid.mockReturnValue(fs.statSync(readOnly).uid + 1);
    expect(ownerWriteCommand(readOnly)).toContain(`${readOnly} belongs to another user`);
    getuid.mockReturnValue(0);
    expect(ownerWriteCommand(readOnly)).toBe(`run: chmod u+w "${readOnly}"`);
    // An owner other than root, even when the suite itself runs as root.
    expect(belongsToAnotherUser({ uid: 12345 } as fs.Stats)).toBe(false);
  });

  it.skipIf(!posix)('a folder that belongs to someone else is named once, with a way out, not a chmod the owner cannot run', () => {
    fs.chmodSync(dir, 0o755);
    const realChmod = fs.chmodSync;
    vi.spyOn(fs, 'chmodSync').mockImplementation((target, m) => {
      if (String(target) === dir) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      realChmod(target, m);
    });
    const someoneElse = fs.statSync(dir).uid + 1;
    vi.spyOn(process, 'getuid').mockReturnValue(someoneElse);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    openDatabase(dbPath);
    closeDatabase();
    openDatabase(dbPath);
    const written = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(written.split('belongs to another user').length - 1).toBe(1);
    expect(written).toContain('Point MEMESH_DB_PATH at a database you own, in a folder you own.');
    expect(written).not.toContain(`chmod go-rwx "${dir}"`);
  });

  it.skipIf(!posix)('a read-only database that fails to open still loses group/other access', () => {
    const legacy = path.join(dir, 'legacy.db');
    const old = new MemeshDatabase(legacy);
    old.exec('CREATE TABLE placeholder (x)');
    old.close();
    fs.chmodSync(legacy, 0o444);
    try { openDatabase(legacy); } catch { /* an old read-only schema cannot be migrated */ }
    expect(mode(legacy) & 0o077).toBe(0);
    expect(mode(legacy) & 0o200).toBe(0);
  });
});

describe('Feature: #520 a database made read-only and then restored', () => {
  let dir: string;
  let dbPath: string;
  const mode = (p: string) => fs.statSync(p).mode & 0o777;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-roundtrip-'));
    dbPath = path.join(dir, 'knowledge-graph.db');
    openDatabase(dbPath);
    closeDatabase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { closeDatabase(); } catch { /* not open */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it.skipIf(!posix)('chmod 444, open, chmod u+rw on the database only: refused with the command for the -wal/-shm; after it, the write lands', () => {
    const wal = `${dbPath}-wal`;
    const shm = `${dbPath}-shm`;
    fs.chmodSync(dbPath, 0o444);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    openDatabase(dbPath).prepare('SELECT count(*) FROM entities').get();
    closeDatabase();
    // The read-only open named every file that needs write access back.
    const written = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain(`To write to it again, run: chmod u+w "${dbPath}" "${wal}" "${shm}"`);
    vi.restoreAllMocks();
    // What the rest rests on: a read-only open leaves SQLite's own -wal and
    // -shm behind at the database's 0400, and a non-empty -shm.
    expect(mode(wal)).toBe(0o400);
    expect(mode(shm)).toBe(0o400);
    expect(fs.statSync(shm).size).toBeGreaterThan(0);

    fs.chmodSync(dbPath, 0o600); // the owner restores the database only
    let error: (Error & { fix?: string }) | undefined;
    try { openDatabase(dbPath); } catch (err) { error = err as Error & { fix?: string }; }
    expect(error?.fix).toBe(`chmod u+w "${wal}" "${shm}"`);
    expect(mode(wal)).toBe(0o400); // MeMesh added nothing
    expect(mode(shm)).toBe(0o400);

    fs.chmodSync(wal, 0o600); // what the printed command does
    fs.chmodSync(shm, 0o600);
    const db = openDatabase(dbPath);
    db.prepare("INSERT INTO entities (name, type) VALUES ('after-restore', 'note')").run();
    expect(db.prepare("SELECT count(*) AS n FROM entities WHERE name = 'after-restore'").get()).toEqual({ n: 1 });
  });
});
