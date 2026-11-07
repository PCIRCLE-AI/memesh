import fs from 'fs';
import path from 'path';
import { databaseFiles, runOrSay, shellQuote } from './file-mode.js';

/**
 * The one fix for a database file whose pages are damaged (it opens, or fails
 * to open, with "malformed"/"not a database"). Moving it aside and starting
 * fresh would throw away whatever is still readable, so the first step is to
 * copy the damaged file, and the restore choice appears only when a `backups`
 * folder exists (plain installs have none: only the maintenance commands make it).
 */
export function damagedDatabaseFix(
  databasePath: string,
  existsSyncImpl: (p: fs.PathLike) => boolean = fs.existsSync,
): string {
  const db = shellQuote(databasePath);
  const damaged = shellQuote(`${databasePath}.damaged`);
  const recovered = shellQuote(`${databasePath}.recovered.db`);
  const backups = path.join(path.dirname(databasePath), 'backups');
  const restore = existsSyncImpl(backups)
    ? ` To go back to a backup instead, restore the newest copy in ${shellQuote(backups)}: sqlite3 ${db} ".restore '<backup>'" (this overwrites the file, which is why the copy comes first).`
    : '';
  return `Stop every memesh process, then copy the damaged file so nothing is lost: cp ${db} ${damaged}.${restore} To salvage what is readable: sqlite3 ${damaged} .recover | sqlite3 ${recovered}, check the result, then move it to ${db}.`;
}

/**
 * Why a database would not open, and the one fix to print for it. `memesh
 * doctor`'s database row and `memesh serve`'s startup error both say this, so
 * the two never disagree (#520): a permission problem gets the chmod that
 * fixes it, and only a file that opens with every permission in place gets the
 * advice to move it aside and start a fresh one.
 */
export function diagnoseDatabaseFailure(
  err: unknown,
  databasePath: string,
  existsSyncImpl: (p: fs.PathLike) => boolean = fs.existsSync,
  statSyncImpl: typeof fs.statSync = fs.statSync,
): { diagnosis: string; fix: string } {
  const message = err instanceof Error ? err.message : 'unknown database error';
  let diagnosis: string;
  let fix: string;

  // MeMesh's own permission errors (#520) already say what is wrong and
  // carry the one command that fixes it; a generic guess below (move the
  // database away and start fresh) would be wrong for every one of them.
  const ownFix = (err as { fix?: unknown } | null)?.fix;
  if (typeof ownFix === 'string') {
    diagnosis = message;
    fix = runOrSay(ownFix);
  } else if (/database is locked|SQLITE_BUSY/i.test(message)) {
    // Another process holds the write lock: the file is fine, and moving it
    // aside would hide the owner's data from that process too.
    diagnosis = `Another process has the database locked: ${message}`;
    fix = 'Wait for the other memesh process to finish, or stop it, then retry';
  } else if (existsSyncImpl(databasePath)) {
    try {
      const stat = statSyncImpl(databasePath);
      const canRead = !!(stat.mode & 0o400);
      const canWrite = !!(stat.mode & 0o200);

      if (!canRead || !canWrite) {
        diagnosis = `Database file exists but has insufficient permissions (${(stat.mode & 0o777).toString(8)})`;
        // #520: MeMesh never gives the owner back a permission the owner
        // removed — a read-only snapshot must stay read-only — so --fix has
        // nothing to do here; putting it back is the owner's decision.
        // The -wal/-shm a read-only open left behind need the same bits;
        // restoring only the database would not make it writable (#520).
        const files = databaseFiles(databasePath).filter((file) => existsSyncImpl(file));
        fix = `If this is your live database (not a read-only copy), restore your own access: chmod u+rw ${files.map(shellQuote).join(' ')}`;
      } else if (stat.size === 0) {
        diagnosis = 'Database file is empty (0 bytes) — likely corrupted';
        fix = `Delete it; the next memesh command creates a fresh database: rm ${shellQuote(databasePath)} && memesh recall`;
      } else if (/malformed|SQLITE_CORRUPT|not a database|SQLITE_NOTADB/i.test(message)) {
        // Damaged pages (a truncated file, say): the same advice as a file
        // that opens but fails its integrity check, never "move it away".
        diagnosis = `Database file exists (${stat.size} bytes) but cannot be opened: ${message}`;
        fix = damagedDatabaseFix(databasePath, existsSyncImpl);
      } else {
        diagnosis = `Database file exists (${stat.size} bytes) but cannot be opened: ${message}`;
        fix = `Backup and reset: mv ${shellQuote(databasePath)} ${shellQuote(`${databasePath}.backup`)} && memesh recall`;
      }
    } catch {
      diagnosis = `Database file exists at ${databasePath} but stat() failed: ${message}`;
      fix = `Check file system integrity and permissions`;
    }
  } else {
    // Database file doesn't exist — check parent directory
    const dir = path.dirname(databasePath);
    if (!existsSyncImpl(dir)) {
      diagnosis = `Database directory does not exist: ${dir}`;
      fix = `Create the folder; the next memesh command creates a fresh database: mkdir -p ${shellQuote(dir)} && memesh recall`;
    } else {
      try {
        const dirStat = statSyncImpl(dir);
        const canWrite = !!(dirStat.mode & 0o200);
        if ((dirStat.mode & fs.constants.S_IFMT) === fs.constants.S_IFREG) {
          diagnosis = `${dir} is a file, not a folder, so no database can be created inside it`;
          fix = 'Point MEMESH_DB_PATH at a path inside a folder';
        } else if (!(dirStat.mode & 0o100)) {
          // Without search (x) permission the database inside cannot even be
          // seen, so it reads as missing; write alone would not fix that.
          diagnosis = `Cannot reach the database — the directory has no search (x) permission: ${dir}`;
          fix = `Fix directory permissions: chmod u+wx ${shellQuote(dir)}`;
        } else if (!canWrite) {
          diagnosis = `Cannot create database — directory is not writable: ${dir}`;
          fix = `Fix directory permissions: chmod u+w ${shellQuote(dir)}`;
        } else {
          diagnosis = `Database file missing at ${databasePath}, but directory exists and is writable`;
          fix = `Run any memesh command (e.g., memesh recall) to create a fresh database`;
        }
      } catch {
        diagnosis = `Database directory exists but cannot be accessed: ${dir}`;
        fix = `Check directory permissions and ownership`;
      }
    }
  }

  return { diagnosis, fix };
}
