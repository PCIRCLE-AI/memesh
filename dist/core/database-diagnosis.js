import fs from 'fs';
import path from 'path';
import { databaseFiles, runOrSay, shellQuote } from './file-mode.js';
export function diagnoseDatabaseFailure(err, databasePath, existsSyncImpl = fs.existsSync, statSyncImpl = fs.statSync) {
    const message = err instanceof Error ? err.message : 'unknown database error';
    let diagnosis;
    let fix;
    const ownFix = err?.fix;
    if (typeof ownFix === 'string') {
        diagnosis = message;
        fix = runOrSay(ownFix);
    }
    else if (/database is locked|SQLITE_BUSY/i.test(message)) {
        diagnosis = `Another process has the database locked: ${message}`;
        fix = 'Wait for the other memesh process to finish, or stop it, then retry';
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
                fix = `Delete and recreate: rm ${shellQuote(databasePath)} && memesh recall (will create fresh DB)`;
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
            fix = `Create directory: mkdir -p ${shellQuote(dir)} && memesh recall (will create fresh DB)`;
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
//# sourceMappingURL=database-diagnosis.js.map