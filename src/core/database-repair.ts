import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { MemeshDatabase } from '../storage/sqlite.js';
import { FTS_SQL } from '../storage/schema.js';
import { reindexFts } from '../db.js';
import { salvageWithNode } from './node-salvage.js';
import { repairCommand } from './database-diagnosis.js';
import { backupDirectoryFor } from './db-copy.js';
import { liveHostPids, updateControlDir } from './auto-update.js';
import { hasPagesWaiting, immutableAddress, requirePrivateWritableDirectory, refuseMismatchedSidecars, SIDECAR_PERMISSIONS_CODE } from './file-mode.js';
import { acquireWindowsRepairGuard, WindowsReplacementUncertainError } from './windows-repair-guard.js';

const SUFFIXES = ['', '-wal', '-shm'] as const;
type Family = Record<(typeof SUFFIXES)[number], string | null>;
export interface RepairTable { name: string; copied: number; complete: boolean }
export interface RepairBackup { file: string; at: string; memories: number }
export interface RepairResult {
  status: 'healthy' | 'repaired';
  method?: 'sqlite3' | 'built-in' | 'backup';
  reason?: string;
  damagedCopy?: string;
  tables?: RepairTable[];
  backup?: RepairBackup;
}

function hash(file: string, keepOpen?: number[]): string | null {
  let fd: number;
  try { fd = fs.openSync(file, 'r'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Repair requires regular files');
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let size: number;
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, size));
    return digest.digest('hex');
  } finally { if (keepOpen) keepOpen.push(fd); else fs.closeSync(fd); }
}
const family = (file: string, keepOpen?: number[]): Family => Object.fromEntries(SUFFIXES.map(suffix => [suffix, hash(file + suffix, keepOpen)])) as Family;
const same = (a: Family, b: Family): boolean => SUFFIXES.every(suffix => a[suffix] === b[suffix]);

/** New owner-private file, with no transient copy of the source's broader mode. */
function copyPrivate(source: string, target: string): void {
  const input = fs.openSync(source, 'r');
  let output: number | undefined;
  try {
    output = fs.openSync(target, 'wx', 0o600);
    const buffer = Buffer.alloc(1024 * 1024);
    let size: number;
    while ((size = fs.readSync(input, buffer, 0, buffer.length, null)) > 0) {
      let written = 0;
      while (written < size) written += fs.writeSync(output, buffer, written, size - written);
    }
    fs.fsyncSync(output);
  } finally { fs.closeSync(input); if (output !== undefined) fs.closeSync(output); }
}

function memoryCount(db: MemeshDatabase): number {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='entities'").get()) throw new Error('No memory table');
  return (db.prepare('SELECT COUNT(*) AS n FROM entities NOT INDEXED').get() as { n: number }).n;
}
const openReadOnly = (file: string): MemeshDatabase => {
  const pending = hasPagesWaiting(file);
  if (pending) refuseMismatchedSidecars(file, { readOnly: true });
  return new MemeshDatabase(pending ? file : immutableAddress(file), { readOnly: true });
};
function inspect(file: string): { memories: number } {
  const db = openReadOnly(file);
  try {
    db.exec('PRAGMA busy_timeout=0');
    const checks = db.prepare('PRAGMA quick_check').all();
    if (checks.length !== 1 || Object.values(checks[0])[0] !== 'ok') throw new Error('quick_check failed');
    return { memories: memoryCount(db) };
  } finally { db.close(); }
}

/** Repair chooses by readable contents, never a message-archive filename. */
export function usableMemoryBackups(database: string): RepairBackup[] {
  const directory = backupDirectoryFor(database);
  let names: string[];
  try { names = fs.readdirSync(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const found: RepairBackup[] = [];
  for (const name of names) {
    const file = path.join(directory, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size === 0 || hasPagesWaiting(file)) continue;
      const { memories } = inspect(file);
      found.push({ file, at: stat.mtime.toISOString(), memories });
    } catch { /* Not a complete, readable memory backup. */ }
  }
  return found.sort((a, b) => b.at.localeCompare(a.at) || a.file.localeCompare(b.file));
}

function snapshot(source: string, expected: Family): string {
  const directory = path.dirname(source);
  const prefix = `${path.basename(source)}.damaged-`;
  for (const name of fs.readdirSync(directory)) {
    if (!name.startsWith(prefix) || name.endsWith('-wal') || name.endsWith('-shm')) continue;
    const candidate = path.join(directory, name);
    try { if (same(family(candidate), expected)) return candidate; } catch { /* not a matching copy */ }
  }
  const target = `${source}.damaged-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  for (const suffix of SUFFIXES) if (expected[suffix] !== null) copyPrivate(source + suffix, target + suffix);
  if (!same(family(source), expected) || !same(family(target), expected)) throw new Error(`Database changed while copying; keep the copy at ${target} and stop other writers`);
  return target;
}

function rebuildAndValidate(file: string, allowEmpty: boolean): RepairTable[] {
  const db = new MemeshDatabase(file);
  try {
    const memories = memoryCount(db);
    if (!memories && !allowEmpty) throw new Error('The memory table could not be recovered');
    db.exec('DROP TABLE IF EXISTS fts_vocab; DROP TABLE IF EXISTS entities_fts;');
    db.exec(FTS_SQL);
    reindexFts(db);
    const checks = db.prepare('PRAGMA quick_check').all();
    if (checks.length !== 1 || Object.values(checks[0])[0] !== 'ok') throw new Error('Recovered database failed quick_check');
    return ['entities', 'observations', 'relations', 'tags'].map(name => ({ name,
      copied: (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n, complete: true }));
  } finally { db.close(); }
}

function removeNewFamily(file: string): void {
  for (const suffix of [...SUFFIXES, '-journal']) fs.rmSync(file + suffix, { force: true });
}

function systemSalvage(source: string, output: string, executable: string): string | undefined {
  const sql = `${output}.sql`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(sql, 'wx', 0o600);
    const address = hasPagesWaiting(source) ? source : immutableAddress(source);
    const recovered = spawnSync(executable, ['-readonly', address, '.recover --ignore-freelist'], {
      stdio: ['ignore', fd, 'pipe'], encoding: 'utf8', timeout: 120_000,
    });
    fs.closeSync(fd); fd = undefined;
    if (recovered.error || recovered.status !== 0) return recovered.error?.message ?? String(recovered.stderr).trim().split('\n')[0] ?? 'sqlite3 .recover failed';
    // Two checked child processes, no shell pipeline and no whole dump in Node's heap.
    fs.closeSync(fs.openSync(output, 'wx', 0o600));
    fd = fs.openSync(sql, 'r');
    const imported = spawnSync(executable, ['-bail', output], {
      stdio: [fd, 'ignore', 'pipe'], encoding: 'utf8', timeout: 120_000,
    });
    fs.closeSync(fd); fd = undefined;
    if (imported.error || imported.status !== 0) return imported.error?.message ?? String(imported.stderr).trim().split('\n')[0] ?? 'sqlite3 import failed';
    const db = openReadOnly(output);
    try { memoryCount(db); } finally { db.close(); }
    return undefined;
  } catch (error) { return error instanceof Error ? error.message : String(error); }
  finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(sql, { force: true }); }
}

type Replacement = (from: string, to: string, commit: () => void | Promise<void>) => void | Promise<void>;
interface InstallOutcome { rename?: 'committed' | 'uncertain' }
export class DatabaseReplacementOutcomeError extends Error {}

function requireNoRegisteredHosts(cause: unknown): void {
  const alive = liveHostPids(updateControlDir());
  if (alive === null || alive.length) throw new Error('Close every AI tool and memesh serve before restoring this damaged header', { cause });
}

const isNotDatabase = (error: unknown) =>
  /not a database|SQLITE_NOTADB/i.test(error instanceof Error ? error.message : String(error));

function hasFileIdentity(file: string, original: fs.BigIntStats): boolean {
  try {
    const current = fs.statSync(file, { bigint: true });
    return current.ino !== 0n && current.ino === original.ino && current.dev === original.dev;
  } catch { return false; }
}

async function installWindows(source: string, recovered: string, rollback: string, expected: Family, outcome: InstallOutcome,
  replace?: Replacement): Promise<void> {
  const probes: string[] = [];
  const createProbe = (suffix: string, contents: string): string => {
    const file = recovered + suffix;
    fs.writeFileSync(file, contents, { flag: 'wx', mode: 0o600 });
    probes.push(file);
    return file;
  };
  try {
    const from = createProbe('.guard-from', '1');
    const to = createProbe('.guard-to', '0');
    const unlink = createProbe('.guard-unlink', '');
    const sidecars = (['-wal', '-shm'] as const).filter(suffix => expected[suffix] !== null);
    const guard = await acquireWindowsRepairGuard([source, ...sidecars.map(suffix => source + suffix), unlink], { from, to });
    try {
      if (fs.readFileSync(to, 'utf8') !== '1' || fs.existsSync(from)) throw new Error('Guarded Windows replacement preflight failed');
      try {
        fs.unlinkSync(unlink);
        fs.closeSync(fs.openSync(unlink, 'wx', 0o600));
        fs.unlinkSync(unlink);
      } catch (cause) {
        throw new Error('This volume does not release guarded Windows journal paths on unlink', { cause });
      }
      if (!same(family(source), expected)) throw new Error('Database changed before the repair lock; stop other writers and retry');

      // Opening the salvage copy can rebuild an empty SHM. Stage rollback from
      // the verified original sidecars while the Windows guard holds them.
      for (const suffix of sidecars) copyPrivate(source + suffix, rollback + suffix);
      const removed: typeof sidecars = [];
      const staged = fs.statSync(recovered, { bigint: true });
      let installation: Promise<void> | undefined;
      const commit = () => installation ??= guard.replace(recovered, source).then(
        () => { outcome.rename = 'committed'; },
        error => {
          if (error instanceof WindowsReplacementUncertainError) outcome.rename = 'uncertain';
          throw error;
        },
      );
      try {
        for (const suffix of sidecars) {
          fs.unlinkSync(source + suffix);
          removed.push(suffix);
        }
        if (replace) await replace(recovered, source, commit);
        else await commit();
        if (installation) await installation;
        else if (hasFileIdentity(source, staged)) outcome.rename = 'committed';
        else throw new Error('Replacement did not run');
      } catch (error) {
        // A callback can throw after dispatching or completing the rename.
        // An unconfirmed reply cannot authorize rollback over a new writer.
        if (installation) await installation.catch(() => {});
        if (!outcome.rename) {
          if (hasFileIdentity(source, staged)) outcome.rename = 'committed';
          else if (!hasFileIdentity(recovered, staged)) outcome.rename = 'uncertain';
          else for (const suffix of removed) await guard.replace(rollback + suffix, source + suffix);
        }
        throw error;
      }
    } finally { await guard.release(); }
  } finally {
    for (const probe of probes) fs.rmSync(probe, { force: true });
  }
}

/** Keep the original guarded until replacement or restoration is finished. */
async function installRecovered(source: string, recovered: string, copy: string, expected: Family, outcome: InstallOutcome,
  replace?: Replacement, brokenHeader?: unknown): Promise<void> {
  const rollback = `${recovered}.rollback`;
  if (process.platform !== 'win32') {
    for (const suffix of SUFFIXES) if (expected[suffix] !== null) copyPrivate(copy + suffix, rollback + suffix);
  }
  let opened = false;
  let staged: fs.BigIntStats | undefined;
  let lock: MemeshDatabase | undefined;
  const hashHandles: number[] = [];
  try {
    if (!same(family(source), expected)) throw new Error('Database changed during salvage; stop other writers and retry');
    if (process.platform === 'win32') {
      if (brokenHeader) requireNoRegisteredHosts(brokenHeader);
      await installWindows(source, recovered, rollback, expected, outcome, replace);
      return;
    }
    try {
      refuseMismatchedSidecars(source);
      lock = new MemeshDatabase(source);
      lock.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;');
      // The lock must cover the final byte check AND replacement. SQLite's
      // EXCLUSIVE locking mode retains it after ROLLBACK until this handle closes.
      // POSIX record locks are process-wide: closing ANY descriptor for this
      // inode would release SQLite's lock. Keep hash descriptors through close.
      const locked = family(source, hashHandles);
      const empty = createHash('sha256').digest('hex');
      const wal = (value: string | null) => value === empty ? null : value;
      if (locked[''] !== expected[''] || wal(locked['-wal']) !== wal(expected['-wal']))
        throw new Error('Database changed before the repair lock; stop other writers and retry');
      opened = true;
      lock.exec('ROLLBACK');
    } catch (error) {
      // A destroyed header cannot take a SQLite lock. Never guess while a host is registered.
      if (!isNotDatabase(error)) throw error;
      requireNoRegisteredHosts(error);
      opened = true;
    }
    for (const suffix of ['-wal', '-shm']) fs.rmSync(source + suffix, { force: true });
    if (replace) {
      staged = fs.statSync(recovered, { bigint: true });
      const pending = replace(recovered, source, () => {
        fs.renameSync(recovered, source);
        outcome.rename = 'committed';
      });
      if (pending) await pending;
      if (!outcome.rename && !hasFileIdentity(source, staged)) throw new Error('Replacement did not run');
    } else fs.renameSync(recovered, source);
    outcome.rename = 'committed';
  } catch (error) {
    if (staged && !outcome.rename) {
      if (hasFileIdentity(source, staged)) outcome.rename = 'committed';
      else if (!hasFileIdentity(recovered, staged)) outcome.rename = 'uncertain';
    }
    if (opened && !outcome.rename) {
      // Opening/closing SQLite can checkpoint WAL. Restore the exact pre-open bytes on failure.
      for (const suffix of SUFFIXES) {
        if (expected[suffix] === null) fs.rmSync(source + suffix, { force: true });
        else fs.renameSync(rollback + suffix, source + suffix);
      }
    }
    throw error;
  } finally {
    // Never release the original inode's lock before replacement/restoration.
    // SQLite detects the moved database on close; it must not remove a new
    // database's WAL at the same pathname (covered by a real writer regression).
    try { lock?.close(); } finally {
      for (const fd of hashHandles) fs.closeSync(fd);
      removeNewFamily(rollback);
    }
  }
}

export async function repairDatabase(database: string, options: {
  fromBackup?: string | true;
  sqliteExecutable?: string;
  replaceFile?: Replacement;
} = {}): Promise<RepairResult> {
  const source = fs.realpathSync(database);
  let before: Family | undefined;
  let copy: string | undefined;
  let recovered: string | undefined;
  const outcome: InstallOutcome = {};
  try {
    if (!options.fromBackup) {
      try { inspect(source); return { status: 'healthy' }; } catch (error) {
        if ((error as NodeJS.ErrnoException).code === SIDECAR_PERMISSIONS_CODE) throw error;
        if (/database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(error instanceof Error ? error.message : String(error))) throw error;
        // Corruption can prevent both the integrity check and the table read.
      }
    }
    const mode = fs.statSync(source).mode;
    if (!(mode & 0o400) || !(mode & 0o200)) throw new Error('The database is read-only or unreadable; repair will not add owner permissions');
    requirePrivateWritableDirectory(path.dirname(source), 'repair needs a private writable directory');
    before = family(source);
    copy = snapshot(source, before);
    recovered = `${source}.recovered-${randomUUID()}.db`;
    let method: RepairResult['method'];
    let reason: string | undefined;
    let tables: RepairTable[];
    let brokenHeader: unknown;
    if (options.fromBackup) {
      let allowEmpty = false;
      try { allowEmpty = inspect(copy).memories === 0; } catch (error) {
        if (isNotDatabase(error)) brokenHeader = error;
      }
      const backup = typeof options.fromBackup === 'string' ? { file: options.fromBackup, ...inspect(options.fromBackup) } : usableMemoryBackups(source).find(item => item.memories > 0 || allowEmpty);
      if (!backup) throw new Error('No usable memory backup is available');
      // A valid backup is a standalone file; its source is never moved or modified.
      if (hasPagesWaiting(backup.file)) throw new Error('Backup still has pending journal pages; use a complete standalone backup');
      copyPrivate(backup.file, recovered);
      tables = rebuildAndValidate(recovered, allowEmpty);
      method = 'backup';
    } else {
      let allowEmpty = false;
      try {
        const db = openReadOnly(copy);
        try { allowEmpty = memoryCount(db) === 0; } finally { db.close(); }
      } catch (error) {
        if (isNotDatabase(error)) brokenHeader = error;
      }
      reason = systemSalvage(copy, recovered, options.sqliteExecutable ?? 'sqlite3');
      try {
        if (reason) throw new Error(reason);
        tables = rebuildAndValidate(recovered, allowEmpty);
        method = 'sqlite3';
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
        removeNewFamily(recovered);
        const result = salvageWithNode(copy, recovered);
        tables = result.tables;
        rebuildAndValidate(recovered, allowEmpty && result.tables.some(table => table.name === 'entities' && table.complete));
        method = 'built-in';
      }
    }
    // Optional advice must not turn a completed replacement into an error afterwards.
    let backup: RepairBackup | undefined;
    try { backup = usableMemoryBackups(source)[0]; } catch { /* unavailable advice does not block salvage */ }
    await installRecovered(source, recovered, copy, before, outcome, options.replaceFile, brokenHeader);
    recovered = undefined;
    return { status: 'repaired', method, reason: method === 'built-in' ? reason : undefined,
      damagedCopy: copy, tables, backup };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (outcome.rename) {
      const status = outcome.rename === 'committed'
        ? 'Database replacement completed before this error.'
        : 'Could not confirm whether the database replacement completed.';
      throw new DatabaseReplacementOutcomeError(`${status} ${message} Check the database before retrying.${copy ? ` Damaged copy: ${copy}.` : ''}`, { cause: error });
    }
    let unchanged = false;
    try { const after = family(source); unchanged = before === undefined || (after[''] === before[''] && after['-wal'] === before['-wal']); } catch { /* report without making a preservation claim */ }
    let advice: string;
    try {
      const backup = usableMemoryBackups(source).find(item => item.memories > 0);
      if (backup) advice = ` Verified backup: ${backup.file} (${backup.at}, ${backup.memories} memories). Restore with: ${repairCommand(source, backup.file)}`;
      else advice = ' No usable memory backup is available.';
    } catch { advice = ' Could not inspect memory backups.'; }
    throw new Error(`${message}. ${unchanged ? 'The original database and WAL have not been changed.' : 'Repair stopped; inspect the preserved damaged copy before retrying.'}${copy ? ` Damaged copy: ${copy}.` : ''}${advice}`, { cause: error });
  } finally { if (recovered && !outcome.rename) removeNewFamily(recovered); }
}
