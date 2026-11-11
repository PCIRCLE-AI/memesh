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
import type { MemeshDatabase } from '../storage/sqlite.js';

/** Copies kept per kind of change; older ones are removed. */
export const DB_COPIES_KEPT = 3;

export type DbCopyOutcome =
  | { kind: 'ready'; path: string }
  | { kind: 'failed'; reason: string };

/**
 * Copy the database to `backups/<prefix>-<time>.db` beside it. Counts the rows of
 * `entities` before and in the copy; a copy with fewer is refused. `inCopy` writes
 * to the copy (attached as `schema`) before it is put in place: what it writes is in
 * the copy whenever the copy exists.
 */
export function copyDatabaseBefore(db: MemeshDatabase, prefix: string, inCopy?: (schema: string) => void): DbCopyOutcome {
  const location = db.location();
  if (!location) return { kind: 'failed', reason: 'the database has no file path, so no copy can be made' };
  const directory = path.join(path.dirname(location), 'backups');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const unique = randomUUID().slice(0, 8);
  // The stamp first, so names sort by time; the suffix keeps two copies of one millisecond apart.
  const finalPath = path.join(directory, `${prefix}-${stamp}-${unique}.db`);
  const partialPath = path.join(directory, `.partial-${prefix}-${process.pid}-${unique}.db`);
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    removeInterruptedCopies(directory, prefix);
    const expected = (db.prepare('SELECT COUNT(*) AS n FROM entities').get() as { n: number }).n;
    db.prepare('VACUUM INTO ?').run(partialPath);
    fs.chmodSync(partialPath, 0o600);
    db.prepare('ATTACH DATABASE ? AS db_copy_check').run(partialPath);
    let found: number;
    try {
      found = (db.prepare('SELECT COUNT(*) AS n FROM db_copy_check.entities').get() as { n: number }).n;
      if (found >= expected) inCopy?.('db_copy_check');
    } finally {
      db.exec('DETACH DATABASE db_copy_check');
    }
    if (found < expected) throw new Error(`the copy holds ${found} memories, fewer than the ${expected} the database had`);
    fs.renameSync(partialPath, finalPath);
  } catch (error) {
    try {
      for (const name of [partialPath, `${partialPath}-journal`]) fs.rmSync(name, { force: true });
    } catch { /* nothing to remove */ }
    return { kind: 'failed', reason: `the copy to ${directory} failed (${error instanceof Error ? error.message : String(error)})` };
  }
  try {
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
