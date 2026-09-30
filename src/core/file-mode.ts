import fs from 'fs';

/** Targets already warned about in this process: say it once, not per open. */
const warned = new Set<string>();

/**
 * Take read/write/execute away from group and others, and leave the owner's
 * bits exactly as they are. Setting a fixed 0600/0700 used to ADD the owner's
 * write bit to a database or folder the user had made read-only (a snapshot,
 * a backup), so every process after the first wrote into it (#520).
 */
export function removeGroupAndOtherAccess(target: string): void {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(target);
    const mode = stat.mode & 0o7777;
    if ((mode & 0o077) !== 0) fs.chmodSync(target, mode & ~0o077);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return; // a sidecar that does not exist (yet)
    if (warned.has(target)) return; // said once in this process already
    warned.add(target);
    // A folder such as /tmp (or a file in it) belongs to someone else: chmod
    // on it is not the owner's to run, and the way out is a database of their
    // own in a folder of their own.
    const notYours = stat !== undefined && belongsToAnotherUser(stat);
    try {
      process.stderr.write(
        notYours
          ? `MeMesh: ${target} belongs to another user, so MeMesh cannot remove other users' access to it (${code}). ` +
              'Point MEMESH_DB_PATH at a database you own, in a folder you own.\n'
          : `MeMesh: could not remove other users' access to ${target} (${code ?? String(err)}); ` +
              `they may be able to read your memories. Fix it with: chmod go-rwx "${target}"\n`,
      );
    } catch { /* stderr gone */ }
  }
}

/** A chmod on it is not this user's to run. */
export function belongsToAnotherUser(stat: fs.Stats): boolean {
  // Root can change any file, so nothing is out of its reach.
  return typeof process.getuid === 'function' && process.getuid() !== 0 && stat.uid !== process.getuid();
}

/**
 * The database file and its -wal/-shm as SQLite names them: beside the REAL
 * file when the database path is itself a symlink (#546's class). A symlink
 * higher up the path names the same files either way, so the path is kept
 * as the owner wrote it.
 */
export function databaseFiles(dbPath: string): [string, string, string] {
  let real = dbPath;
  try {
    if (fs.lstatSync(dbPath).isSymbolicLink()) real = fs.realpathSync(dbPath);
  } catch { /* not created yet */ }
  return [real, `${real}-wal`, `${real}-shm`];
}

/**
 * Everything MeMesh does to the database's files before SQLite opens them,
 * for every opener (core, hooks, read-only or not): other users lose access,
 * the owner's bits stay, and a -wal/-shm SQLite would change is refused.
 */
export function guardDatabaseFiles(dbPath: string): void {
  for (const target of databaseFiles(dbPath)) removeGroupAndOtherAccess(target);
  refuseMismatchedSidecars(dbPath);
}

/**
 * For a folder a runtime process must write into and keep private (sockets,
 * tokens, lifecycle state): remove group/other access, then stop with the
 * reason when the folder is still open to others or the owner cannot write
 * to it. The owner's write bit is never added (#520).
 */
export function requirePrivateWritableDirectory(dir: string, purpose: string): void {
  removeGroupAndOtherAccess(dir);
  const mode = fs.statSync(dir).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`${dir} is still open to other users (${mode.toString(8)}), and ${purpose}. Run: chmod go-rwx "${dir}"`);
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    throw new Error(`${dir} is read-only, and ${purpose}. MeMesh does not make it writable; if you want it to run, run: chmod u+w "${dir}"`);
  }
}

/** Error code of a refused open, so a hook's outcome record names the cause. */
export const SIDECAR_PERMISSIONS_CODE = 'MEMESH_SIDECAR_PERMISSIONS';

const OWNER_LETTERS: Array<[number, string]> = [[0o400, 'r'], [0o200, 'w'], [0o100, 'x']];
const quoted = (files: string[]) => files.map((f) => `"${f}"`).join(' ');

const letters = (bits: number) => OWNER_LETTERS.filter(([bit]) => bits & bit).map(([, letter]) => letter).join('');

/**
 * Refuse, before SQLite opens anything, a -wal or -shm whose owner
 * permissions opening would change or silently depend on (#520). MeMesh never
 * changes an owner bit, and the owner decides with the printed commands:
 * - one with FEWER owner permissions than the database: SQLite would give an
 *   empty one the database's mode (adding the bit the owner removed) or open
 *   a non-empty one read-only and leave the database silently read-only;
 * - an EMPTY one with MORE owner permissions than the database: SQLite would
 *   reset it to the database's mode (robust_open in os_unix.c).
 * A non-empty sidecar with more permissions is left alone by SQLite, so a
 * read-only database next to it still opens for reads.
 */
export function refuseMismatchedSidecars(dbPath: string): void {
  if (process.platform === 'win32') return; // no owner/group/other bits there
  const [real, wal, shm] = databaseFiles(dbPath);
  const database = fs.statSync(real, { throwIfNoEntry: false });
  if (!database) return;
  const fewer: string[] = [];
  const extra: string[] = [];
  const notYours: string[] = [];
  let fewerBits = 0;
  let extraBits = 0;
  for (const sidecar of [wal, shm]) {
    const stat = fs.statSync(sidecar, { throwIfNoEntry: false });
    if (!stat) continue;
    // SQLite copies the whole owner triplet (x included) onto an EMPTY
    // sidecar; a non-empty one only needs read and write.
    const missing = database.mode & ~stat.mode & (stat.size === 0 ? 0o700 : 0o600);
    const added = stat.mode & ~database.mode & 0o700;
    if (missing !== 0) { fewer.push(sidecar); fewerBits |= missing; }
    else if (added !== 0 && stat.size === 0) { extra.push(sidecar); extraBits |= added; }
    else continue;
    if (belongsToAnotherUser(stat)) notYours.push(sidecar);
  }
  // A chmod on another user's file is not this user's to run: the way out is
  // a database of their own.
  if (notYours.length === 0 && fewer.length + extra.length > 0 && belongsToAnotherUser(database)) notYours.push(real);
  if (notYours.length > 0) {
    const fix = 'Point MEMESH_DB_PATH at a database you own, in a folder you own.';
    throw Object.assign(
      new Error(
        `MeMesh: the owner permissions of ${real} and its ${[...fewer, ...extra].join(' and ')} do not match, and ` +
          `${notYours.join(' and ')} ${notYours.length > 1 ? 'belong' : 'belongs'} to another user, so you cannot change them. ${fix}`,
      ),
      { fix, code: SIDECAR_PERMISSIONS_CODE },
    );
  }
  if (fewer.length > 0) {
    const fix = `chmod u+${letters(fewerBits)} ${quoted(fewer)}`;
    const keepReadOnly = fewerBits === 0o200 ? ` To keep the database read-only instead, run: chmod u-w "${real}"` : '';
    throw Object.assign(
      new Error(
        `MeMesh: ${fewer.join(' and ')} ${fewer.length > 1 ? 'have' : 'has'} fewer owner permissions than ` +
          `${real}, so opening it would either widen them or leave the database silently read-only. ` +
          `To use the database normally, run: ${fix}.${keepReadOnly}`,
      ),
      // The code is what a hook's outcome record keeps (hookErrorReason).
      { fix, code: SIDECAR_PERMISSIONS_CODE },
    );
  }
  if (extra.length > 0) {
    const fix = `chmod u-${letters(extraBits)} ${quoted(extra)}`;
    throw Object.assign(
      new Error(
        `MeMesh: ${extra.join(' and ')} ${extra.length > 1 ? 'are' : 'is'} empty and ${extra.length > 1 ? 'have' : 'has'} ` +
          `more owner permissions than ${real}, which SQLite would reset while opening. ` +
          `To read the database as it is, run: ${fix}. To use it normally, run: chmod u+${letters(extraBits)} "${real}"`,
      ),
      // The code is what a hook's outcome record keeps (hookErrorReason).
      { fix, code: SIDECAR_PERMISSIONS_CODE },
    );
  }
}

/**
 * What gives write access back to a database that opened read-only because
 * the owner removed it: `run: chmod u+w` on the database and its -wal/-shm
 * that exist without an owner write bit, or, when one of them belongs to
 * another user (whose chmod this user cannot run), a database of their own.
 * Undefined when none lacks the bit (the cause is then something else, such
 * as a read-only mount).
 */
export function ownerWriteCommand(dbPath: string): string | undefined {
  if (process.platform === 'win32') return undefined;
  const readOnly: string[] = [];
  for (const file of databaseFiles(dbPath)) {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (stat === undefined || (stat.mode & 0o200) !== 0) continue;
    if (belongsToAnotherUser(stat)) {
      return `point MEMESH_DB_PATH at a database you own, in a folder you own; ${file} belongs to another user.`;
    }
    readOnly.push(file);
  }
  return readOnly.length > 0 ? `run: chmod u+w ${quoted(readOnly)}` : undefined;
}
