// =============================================================================
// db-copy — a verified copy of the database, taken before MeMesh changes stored memories
// =============================================================================
//
// The same discipline as the agent-message expiry pass: copy to a temporary name,
// check the copy holds what the database held, rename it into place, keep the newest
// few. A copy that cannot be made or does not match stops the change: the caller must
// not touch the data. The copy lives in `backups/` beside the database file.
//
// Unlike that pass this one is synchronous (`VACUUM INTO`, one consistent snapshot):
// its callers are short-lived processes (the Stop hook, the CLI), where holding the
// process for the length of the copy costs nothing, and they cannot await.

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
 * `entities` before and in the copy; a copy with fewer is refused.
 */
export function copyDatabaseBefore(db: MemeshDatabase, prefix: string): DbCopyOutcome {
  const location = db.location();
  if (!location) return { kind: 'failed', reason: 'the database has no file path, so no copy can be made' };
  const directory = path.join(path.dirname(location), 'backups');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const finalPath = path.join(directory, `${prefix}-${stamp}.db`);
  const partialPath = path.join(directory, `.partial-${prefix}-${process.pid}-${randomUUID().slice(0, 8)}.db`);
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const expected = (db.prepare('SELECT COUNT(*) AS n FROM entities').get() as { n: number }).n;
    db.prepare('VACUUM INTO ?').run(partialPath);
    fs.chmodSync(partialPath, 0o600);
    db.prepare('ATTACH DATABASE ? AS db_copy_check').run(partialPath);
    let found: number;
    try {
      found = (db.prepare('SELECT COUNT(*) AS n FROM db_copy_check.entities').get() as { n: number }).n;
    } finally {
      db.exec('DETACH DATABASE db_copy_check');
    }
    if (found < expected) throw new Error(`the copy holds ${found} memories, fewer than the ${expected} the database had`);
    fs.renameSync(partialPath, finalPath);
  } catch (error) {
    try { fs.rmSync(partialPath, { force: true }); } catch { /* nothing to remove */ }
    return { kind: 'failed', reason: `the copy to ${directory} failed (${error instanceof Error ? error.message : String(error)})` };
  }
  try {
    const mine = fs.readdirSync(directory).filter((name) => name.startsWith(`${prefix}-`) && name.endsWith('.db')).sort();
    for (const name of mine.slice(0, Math.max(0, mine.length - DB_COPIES_KEPT))) {
      fs.rmSync(path.join(directory, name), { force: true });
      fs.rmSync(path.join(directory, `${name}.json`), { force: true });
    }
  } catch { /* an old copy that stays is not a failure */ }
  return { kind: 'ready', path: finalPath };
}
