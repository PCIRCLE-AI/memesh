import fs from 'fs';
import path from 'path';
import { isSqliteSelfCheckFailure, isUnsupportedNode } from '../storage/sqlite.js';
import { databaseFiles, runOrSay, shellQuote } from './file-mode.js';
export function isDamagedDatabaseError(message) {
    return /malformed|SQLITE_CORRUPT|not a database|SQLITE_NOTADB/i.test(message);
}
const MEMORY_BACKUP_PREFIXES = ['pre-update-', 'before-compression-marker-', 'kg-before-', 'knowledge-graph-before-note-trust-'];
function newestBackup(dir) {
    let newest;
    let names;
    try {
        names = fs.readdirSync(dir);
    }
    catch {
        return undefined;
    }
    for (const name of names) {
        if (!name.endsWith('.db') || !MEMORY_BACKUP_PREFIXES.some((prefix) => name.startsWith(prefix)))
            continue;
        const file = path.join(dir, name);
        try {
            const stat = fs.statSync(file);
            if (stat.isFile() && stat.size > 0 && (!newest || stat.mtimeMs > newest.mtime))
                newest = { file, mtime: stat.mtimeMs };
        }
        catch { }
    }
    return newest?.file;
}
export function damagedDatabaseSteps(databasePath) {
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
export function damagedDatabaseFix(databasePath) {
    const steps = damagedDatabaseSteps(databasePath);
    const restore = steps.restore
        ? ` To go back to the newest backup instead (this overwrites the file, which is why the copy comes first): ${steps.restore}.`
        : '';
    return `Stop every memesh process, then copy the damaged file and its journal so nothing is lost: ${steps.copy}.${restore} To salvage what is readable: ${steps.salvage}, check the result, then put it in place and rebuild the keyword index: ${steps.replace}.`;
}
export function diagnoseDatabaseFailure(err, databasePath, existsSyncImpl = fs.existsSync, statSyncImpl = fs.statSync) {
    const message = err instanceof Error ? err.message : 'unknown database error';
    let diagnosis;
    let fix;
    const ownFix = err?.fix;
    if (/database is locked|SQLITE_BUSY/i.test(message)) {
        diagnosis = `Another process has the database locked: ${message}`;
        fix = 'Wait for the other memesh process to finish, or stop it, then retry';
    }
    else if (isUnsupportedNode(err)) {
        diagnosis = message;
        fix = err.fix;
    }
    else if (isSqliteSelfCheckFailure(err)) {
        diagnosis = message;
        fix = err.advice;
    }
    else if (typeof ownFix === 'string') {
        diagnosis = message;
        fix = runOrSay(ownFix);
    }
    else if (existsSyncImpl(databasePath)) {
        try {
            const stat = statSyncImpl(databasePath);
            const canRead = !!(stat.mode & 0o400);
            const canWrite = !!(stat.mode & 0o200);
            if (!canRead || !canWrite) {
                diagnosis = `Database file exists but has insufficient permissions (${(stat.mode & 0o777).toString(8)})`;
                const files = databaseFiles(databasePath).filter((file) => existsSyncImpl(file));
                fix = `If this is your live database (not a read-only copy), restore your own access: chmod u+rw ${files.map(shellQuote).join(' ')}`;
            }
            else if (stat.size === 0) {
                diagnosis = 'Database file is empty (0 bytes) — likely corrupted';
                fix = `Delete it; the next memesh command creates a fresh database: rm ${shellQuote(databasePath)} && memesh recall`;
            }
            else if (isDamagedDatabaseError(message)) {
                diagnosis = `Database file exists (${stat.size} bytes) but cannot be opened: ${message}`;
                fix = damagedDatabaseFix(databasePath);
            }
            else {
                diagnosis = `Database file exists (${stat.size} bytes) but cannot be opened: ${message}`;
                fix = `Backup and reset: mv ${shellQuote(databasePath)} ${shellQuote(`${databasePath}.backup`)} && memesh recall`;
            }
        }
        catch {
            diagnosis = `Database file exists at ${databasePath} but stat() failed: ${message}`;
            fix = `Check file system integrity and permissions`;
        }
    }
    else {
        const dir = path.dirname(databasePath);
        if (!existsSyncImpl(dir)) {
            diagnosis = `Database directory does not exist: ${dir}`;
            fix = `Create the folder; the next memesh command creates a fresh database: mkdir -p ${shellQuote(dir)} && memesh recall`;
        }
        else {
            try {
                const dirStat = statSyncImpl(dir);
                const canWrite = !!(dirStat.mode & 0o200);
                if ((dirStat.mode & fs.constants.S_IFMT) === fs.constants.S_IFREG) {
                    diagnosis = `${dir} is a file, not a folder, so no database can be created inside it`;
                    fix = 'Point MEMESH_DB_PATH at a path inside a folder';
                }
                else if (!(dirStat.mode & 0o100)) {
                    diagnosis = `Cannot reach the database — the directory has no search (x) permission: ${dir}`;
                    fix = `Fix directory permissions: chmod u+wx ${shellQuote(dir)}`;
                }
                else if (!canWrite) {
                    diagnosis = `Cannot create database — directory is not writable: ${dir}`;
                    fix = `Fix directory permissions: chmod u+w ${shellQuote(dir)}`;
                }
                else {
                    diagnosis = `Database file missing at ${databasePath}, but directory exists and is writable`;
                    fix = `Run any memesh command (e.g., memesh recall) to create a fresh database`;
                }
            }
            catch {
                diagnosis = `Database directory exists but cannot be accessed: ${dir}`;
                fix = `Check directory permissions and ownership`;
            }
        }
    }
    return { diagnosis, fix };
}
export function databaseOpenFailureReport(err, databasePath) {
    const message = err instanceof Error ? err.message : String(err);
    const { diagnosis, fix } = diagnoseDatabaseFailure(err, databasePath);
    const diagnosisLine = diagnosis !== message ? `   Diagnosis: ${diagnosis}\n` : '';
    return `\n❌ MeMesh startup failed: database cannot be opened\n\n   Database path: ${databasePath}\n   Error: ${message}\n\n${diagnosisLine}Fix: ${fix}\n`;
}
//# sourceMappingURL=database-diagnosis.js.map