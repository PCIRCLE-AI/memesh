// =============================================================================
// db-copy — a verified copy of the database, taken before MeMesh changes stored memories
// =============================================================================
//
// Copy to a temporary name, check the copy holds what the database held, rename it
// into place, keep the newest few. A copy that cannot be made or does not match stops
// the change: the caller must not touch the data. The copy lives in `backups/` beside
// the database file; the `.json` record a caller writes beside a copy (which ids it
// changed, and how to undo it) is never removed.
//
// Synchronous (`VACUUM INTO`, one consistent snapshot): its callers are short-lived
// processes (the Stop hook, the CLI), where holding the process for the length of the
// copy costs nothing, and they cannot await.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { MemeshDatabase } from '../storage/sqlite.js';
import { makeWindowsPathsPrivate, verifyWindowsPathsPrivate } from './windows-permissions.js';

/** Copies kept per kind of change; older ones are removed. */
export const DB_COPIES_KEPT = 3;

/** Backups follow the database, independently of the account control directory. */
export function backupDirectoryFor(dbPath: string): string {
  return path.join(path.dirname(dbPath), 'backups');
}

export type DbCopyOutcome =
  | { kind: 'ready'; path: string }
  | { kind: 'failed'; reason: string };

function requireSameEntry(file: string, expected: fs.BigIntStats): void {
  const actual = fs.lstatSync(file, { bigint: true });
  const expectedType = expected.isDirectory() ? actual.isDirectory() : actual.isFile() && actual.nlink === 1n;
  if (!expectedType || actual.isSymbolicLink() || actual.ino === 0n || actual.ino !== expected.ino || actual.dev !== expected.dev)
    throw new Error('Backup path changed or is unsafe: ' + file);
}

function prepareWindowsBackupDirectory(directory: string): fs.BigIntStats {
  // The database parent already exists. Check it and its ancestors without
  // changing ACLs outside the product-owned backups leaf.
  const parent = path.dirname(directory);
  for (let ancestor = parent; ; ancestor = path.dirname(ancestor)) {
    const entry = fs.lstatSync(ancestor);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Unsafe backup ancestor: ' + ancestor);
    if (path.dirname(ancestor) === ancestor) break;
  }
  if (path.relative(parent, fs.realpathSync(parent)) !== '') throw new Error('Unsafe backup parent: ' + parent);
  let created = false;
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const leaf = fs.lstatSync(directory, { bigint: true });
  if (!leaf.isDirectory() || leaf.isSymbolicLink() || leaf.ino === 0n || path.relative(directory, fs.realpathSync(directory)) !== '')
    throw new Error('Unsafe backup directory: ' + directory);
  try {
    if (created) makeWindowsPathsPrivate([directory]);
    else verifyWindowsPathsPrivate([directory]);
    requireSameEntry(directory, leaf);
  } catch (error) {
    if (created) {
      // Leave a failed first attempt retryable without removing someone else's directory.
      try {
        requireSameEntry(directory, leaf);
        fs.rmdirSync(directory);
      } catch { /* best effort, only the same empty directory */ }
    }
    throw error;
  }
  return leaf;
}

/**
 * Copy the database to `backups/<prefix>-<time>.db` beside it. Counts the rows of
 * `entities` before and in the copy; a copy with fewer is refused. `inCopy` writes
 * to the copy (attached as `schema`) before it is put in place: what it writes is in
 * the copy whenever the copy exists.
 */
export function copyDatabaseBefore(db: MemeshDatabase, prefix: string, inCopy?: (schema: string) => void): DbCopyOutcome {
  const location = db.location();
  if (!location) return { kind: 'failed', reason: 'the database has no file path, so no copy can be made' };
  const windows = process.platform === 'win32';
  const directory = windows ? path.resolve(backupDirectoryFor(location)) : backupDirectoryFor(location);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const unique = randomUUID().slice(0, 8);
  // The stamp first, so names sort by time; the suffix keeps two copies of one millisecond apart.
  const finalPath = path.join(directory, `${prefix}-${stamp}-${unique}.db`);
  const partialPath = path.join(directory, `.partial-${prefix}-${process.pid}-${unique}.db`);
  const journalPath = `${partialPath}-journal`;
  let leaf: fs.BigIntStats | undefined;
  let ownedPartial: fs.BigIntStats | undefined;
  let mayHaveJournal = false;
  try {
    if (windows) {
      if (path.dirname(finalPath) !== directory || path.dirname(partialPath) !== directory)
        throw new Error('Backup paths must be inside the backups directory');
      leaf = prepareWindowsBackupDirectory(directory);
    } else {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    removeInterruptedCopies(directory, prefix);
    const expected = (db.prepare('SELECT COUNT(*) AS n FROM entities').get() as { n: number }).n;
    let destination = partialPath;
    if (leaf) {
      requireSameEntry(directory, leaf);
      const fd = fs.openSync(partialPath, 'wx', 0o600);
      try { ownedPartial = fs.fstatSync(fd, { bigint: true }); } finally { fs.closeSync(fd); }
      requireSameEntry(partialPath, ownedPartial);
      makeWindowsPathsPrivate([partialPath]);
      requireSameEntry(partialPath, ownedPartial);
      if (fs.lstatSync(journalPath, { throwIfNoEntry: false })) throw new Error('Backup journal already exists');
      destination = `${pathToFileURL(partialPath).href}?mode=rw`;
      mayHaveJournal = true;
    }
    db.prepare('VACUUM INTO ?').run(destination);
    if (ownedPartial) requireSameEntry(partialPath, ownedPartial);
    else fs.chmodSync(partialPath, 0o600);
    // ATTACH inherits the source's access mode, including read-only updates.
    db.prepare('ATTACH DATABASE ? AS db_copy_check').run(partialPath);
    let found: number;
    try {
      found = (db.prepare('SELECT COUNT(*) AS n FROM db_copy_check.entities').get() as { n: number }).n;
      if (found >= expected) inCopy?.('db_copy_check');
    } finally {
      db.exec('DETACH DATABASE db_copy_check');
    }
    if (found < expected) throw new Error(`the copy holds ${found} memories, fewer than the ${expected} the database had`);
    if (leaf && ownedPartial) {
      requireSameEntry(directory, leaf);
      requireSameEntry(partialPath, ownedPartial);
    }
    fs.renameSync(partialPath, finalPath);
  } catch (error) {
    try {
      if (!windows) {
        for (const name of [partialPath, journalPath]) fs.rmSync(name, { force: true });
      } else if (leaf && ownedPartial) {
        requireSameEntry(directory, leaf);
        requireSameEntry(partialPath, ownedPartial);
        fs.rmSync(partialPath, { force: true });
        const journal = mayHaveJournal ? fs.lstatSync(journalPath, { throwIfNoEntry: false }) : undefined;
        if (journal?.isFile() && !journal.isSymbolicLink() && journal.nlink === 1) fs.rmSync(journalPath, { force: true });
      }
    } catch { /* nothing to remove */ }
    return { kind: 'failed', reason: `the copy to ${directory} failed (${error instanceof Error ? error.message : String(error)})` };
  }
  try {
    if (leaf) requireSameEntry(directory, leaf);
    // The copy just made is kept whatever its name sorts as: a clock set back gives it an older name.
    const made = path.basename(finalPath);
    const older = fs.readdirSync(directory).filter((name) => name !== made && copyName(prefix).test(name)).sort();
    for (const name of older.slice(0, Math.max(0, older.length - (DB_COPIES_KEPT - 1)))) fs.rmSync(path.join(directory, name), { force: true });
  } catch { /* an old copy that stays is not a failure */ }
  return { kind: 'ready', path: finalPath };
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A finished copy of this prefix, `<prefix>-<ISO stamp>[-<suffix>].db`: never a longer prefix's. */
const copyName = (prefix: string) => new RegExp(`^${escaped(prefix)}-\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z(?:-[0-9a-f]{8})?\\.db$`);

/** The partial file and journal a copy of this prefix left when its process was killed. A running copy's are left alone. */
function removeInterruptedCopies(directory: string, prefix: string): void {
  const partial = new RegExp(`^\\.partial-${escaped(prefix)}-(\\d+)-[0-9a-f]{8}\\.db(?:-journal)?$`);
  for (const name of fs.readdirSync(directory)) {
    const pid = Number(partial.exec(name)?.[1]);
    if (pid && !processRuns(pid)) fs.rmSync(path.join(directory, name), { force: true });
  }
}

function processRuns(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
