import fs from 'fs';
import path from 'path';
import { isUnsupportedNode, MIN_NODE_SERIES } from '../storage/sqlite.js';
import { databaseFiles, runOrSay, shellQuote } from './file-mode.js';

/** SQLite's words for damaged pages or a file that is not a database at all. */
export function isDamagedDatabaseError(message: string): boolean {
  return /malformed|SQLITE_CORRUPT|not a database|SQLITE_NOTADB/i.test(message);
}

/** The newest complete `.db` copy in `dir` (a `.tmp` is a backup still being written), or undefined. */
function newestBackup(dir: string): string | undefined {
  let newest: { file: string; mtime: number } | undefined;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const name of names) {
    if (!name.endsWith('.db')) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (stat.isFile() && stat.size > 0 && (!newest || stat.mtimeMs > newest.mtime)) newest = { file, mtime: stat.mtimeMs };
    } catch { /* vanished while listing */ }
  }
  return newest?.file;
}

/**
 * The shell commands of {@link damagedDatabaseFix}, each one runnable as
 * printed. SQLite keeps recent writes in `<db>-wal` until they are copied into
 * the file, so the copy takes the journal along (or the newest memories are
 * lost), and anything put back in place first removes the old `-wal`/`-shm`
 * (or SQLite replays that stale journal onto the new file and breaks it).
 * `.recover` may not bring the keyword index back intact, so the salvage ends
 * by rebuilding it.
 */
export function damagedDatabaseSteps(databasePath: string): { copy: string; restore?: string; salvage: string; replace: string } {
  const q = shellQuote;
  const db = q(databasePath);
  const damaged = `${databasePath}.damaged`;
  const recovered = q(`${databasePath}.recovered.db`);
  const dropJournal = `rm -f ${q(`${databasePath}-wal`)} ${q(`${databasePath}-shm`)}`;
  const journalCopies = ['-wal', '-shm'].map((s) => `[ ! -e ${q(databasePath + s)} ] || cp ${q(databasePath + s)} ${q(damaged + s)}`);
  const backup = newestBackup(path.join(path.dirname(databasePath), 'backups'));
  return {
    copy: [`rm -f ${q(`${damaged}-wal`)} ${q(`${damaged}-shm`)}`, `cp ${db} ${q(damaged)}`, ...journalCopies].join('; '),
    ...(backup ? { restore: `${dropJournal} && cp ${q(backup)} ${db}` } : {}),
    salvage: `rm -f ${recovered} && sqlite3 ${q(damaged)} .recover | sqlite3 ${recovered}`,
    replace: `${dropJournal} && mv ${recovered} ${db} && memesh reindex --fts`,
  };
}

/**
 * The one fix for a database file whose pages are damaged (it opens, or fails
 * to open, with "malformed"/"not a database"). Moving it aside and starting
 * fresh would throw away whatever is still readable, so the first step is to
 * copy the damaged file, and the restore choice appears only when `backups`
 * beside it holds a complete copy (plain installs have none: only the
 * maintenance commands make one).
 */
export function damagedDatabaseFix(databasePath: string): string {
  const steps = damagedDatabaseSteps(databasePath);
  const restore = steps.restore
    ? ` To go back to the newest backup instead (this overwrites the file, which is why the copy comes first): ${steps.restore}.`
    : '';
  return `Stop every memesh process, then copy the damaged file and its journal so nothing is lost: ${steps.copy}.${restore} To salvage what is readable: ${steps.salvage}, check the result, then put it in place and rebuild the keyword index: ${steps.replace}.`;
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

  // A held lock comes first: the file is fine, and any repair advice
  // (moving it aside, or salvaging it as damaged) would be wrong.
  const ownFix = (err as { fix?: unknown } | null)?.fix;
  if (/database is locked|SQLITE_BUSY/i.test(message)) {
    diagnosis = `Another process has the database locked: ${message}`;
    fix = 'Wait for the other memesh process to finish, or stop it, then retry';
  } else if (isUnsupportedNode(err)) {
    // Not a database problem: this Node lacks FTS5, and no file move fixes that.
    diagnosis = message;
    fix = `Upgrade Node to ${MIN_NODE_SERIES} or newer, then run memesh again`;
  } else if (typeof ownFix === 'string') {
    // MeMesh's own errors (#520 permissions, a failed integrity check) already
    // say what is wrong and carry the one command that fixes it; a generic
    // guess below (move the database away and start fresh) would be wrong.
    diagnosis = message;
    fix = runOrSay(ownFix);
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
      } else if (isDamagedDatabaseError(message)) {
        // Damaged pages (a truncated file, say): the same advice as a file
        // that opens but fails its integrity check, never "move it away".
        diagnosis = `Database file exists (${stat.size} bytes) but cannot be opened: ${message}`;
        fix = damagedDatabaseFix(databasePath);
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

/**
 * What a long-running entry point (`memesh serve`, the MCP server) prints with
 * `console.error` (stderr; their tests watch that channel) when its database
 * will not open: the same diagnosis and fix as `memesh doctor`'s database
 * row, so a permission problem gets its chmod and damage gets the copy-first
 * salvage, never "move it aside".
 */
export function databaseOpenFailureReport(err: unknown, databasePath: string): string {
  const message = err instanceof Error ? err.message : String(err);
  const { diagnosis, fix } = diagnoseDatabaseFailure(err, databasePath);
  const diagnosisLine = diagnosis !== message ? `   Diagnosis: ${diagnosis}\n` : '';
  return `\n❌ MeMesh startup failed: database cannot be opened\n\n   Database path: ${databasePath}\n   Error: ${message}\n\n${diagnosisLine}Fix: ${fix}\n`;
}
