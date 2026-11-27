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
const SUFFIXES = ['', '-wal', '-shm'];
function hash(file, keepOpen) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
    try {
        if (!fs.fstatSync(fd).isFile())
            throw new Error('Repair requires regular files');
        const digest = createHash('sha256');
        const buffer = Buffer.alloc(1024 * 1024);
        let size;
        while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0)
            digest.update(buffer.subarray(0, size));
        return digest.digest('hex');
    }
    finally {
        if (keepOpen)
            keepOpen.push(fd);
        else
            fs.closeSync(fd);
    }
}
const family = (file, keepOpen) => Object.fromEntries(SUFFIXES.map(suffix => [suffix, hash(file + suffix, keepOpen)]));
const same = (a, b) => SUFFIXES.every(suffix => a[suffix] === b[suffix]);
function copyPrivate(source, target) {
    const input = fs.openSync(source, 'r');
    let output;
    try {
        output = fs.openSync(target, 'wx', 0o600);
        const buffer = Buffer.alloc(1024 * 1024);
        let size;
        while ((size = fs.readSync(input, buffer, 0, buffer.length, null)) > 0) {
            let written = 0;
            while (written < size)
                written += fs.writeSync(output, buffer, written, size - written);
        }
        fs.fsyncSync(output);
    }
    finally {
        fs.closeSync(input);
        if (output !== undefined)
            fs.closeSync(output);
    }
}
function memoryCount(db) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='entities'").get())
        throw new Error('No memory table');
    return db.prepare('SELECT COUNT(*) AS n FROM entities NOT INDEXED').get().n;
}
const openReadOnly = (file) => {
    const pending = hasPagesWaiting(file);
    if (pending)
        refuseMismatchedSidecars(file, { readOnly: true });
    return new MemeshDatabase(pending ? file : immutableAddress(file), { readOnly: true });
};
function inspect(file) {
    const db = openReadOnly(file);
    try {
        db.exec('PRAGMA busy_timeout=0');
        const checks = db.prepare('PRAGMA quick_check').all();
        if (checks.length !== 1 || Object.values(checks[0])[0] !== 'ok')
            throw new Error('quick_check failed');
        return { memories: memoryCount(db) };
    }
    finally {
        db.close();
    }
}
export function usableMemoryBackups(database) {
    const directory = backupDirectoryFor(database);
    let names;
    try {
        names = fs.readdirSync(directory);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
    const found = [];
    for (const name of names) {
        const file = path.join(directory, name);
        try {
            const stat = fs.statSync(file);
            if (!stat.isFile() || stat.size === 0 || hasPagesWaiting(file))
                continue;
            const { memories } = inspect(file);
            found.push({ file, at: stat.mtime.toISOString(), memories });
        }
        catch { }
    }
    return found.sort((a, b) => b.at.localeCompare(a.at) || a.file.localeCompare(b.file));
}
function snapshot(source, expected) {
    const directory = path.dirname(source);
    const prefix = `${path.basename(source)}.damaged-`;
    for (const name of fs.readdirSync(directory)) {
        if (!name.startsWith(prefix) || name.endsWith('-wal') || name.endsWith('-shm'))
            continue;
        const candidate = path.join(directory, name);
        try {
            if (same(family(candidate), expected))
                return candidate;
        }
        catch { }
    }
    const target = `${source}.damaged-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    for (const suffix of SUFFIXES)
        if (expected[suffix] !== null)
            copyPrivate(source + suffix, target + suffix);
    if (!same(family(source), expected) || !same(family(target), expected))
        throw new Error(`Database changed while copying; keep the copy at ${target} and stop other writers`);
    return target;
}
function rebuildAndValidate(file, allowEmpty) {
    const db = new MemeshDatabase(file);
    try {
        const memories = memoryCount(db);
        if (!memories && !allowEmpty)
            throw new Error('The memory table could not be recovered');
        db.exec('DROP TABLE IF EXISTS fts_vocab; DROP TABLE IF EXISTS entities_fts;');
        db.exec(FTS_SQL);
        reindexFts(db);
        const checks = db.prepare('PRAGMA quick_check').all();
        if (checks.length !== 1 || Object.values(checks[0])[0] !== 'ok')
            throw new Error('Recovered database failed quick_check');
        return ['entities', 'observations', 'relations', 'tags'].map(name => ({ name,
            copied: db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n, complete: true }));
    }
    finally {
        db.close();
    }
}
function removeNewFamily(file) {
    for (const suffix of [...SUFFIXES, '-journal'])
        fs.rmSync(file + suffix, { force: true });
}
function systemSalvage(source, output, executable) {
    const sql = `${output}.sql`;
    let fd;
    try {
        fd = fs.openSync(sql, 'wx', 0o600);
        const address = hasPagesWaiting(source) ? source : immutableAddress(source);
        const recovered = spawnSync(executable, ['-readonly', address, '.recover --ignore-freelist'], {
            stdio: ['ignore', fd, 'pipe'], encoding: 'utf8', timeout: 120_000,
        });
        fs.closeSync(fd);
        fd = undefined;
        if (recovered.error || recovered.status !== 0)
            return recovered.error?.message ?? String(recovered.stderr).trim().split('\n')[0] ?? 'sqlite3 .recover failed';
        fs.closeSync(fs.openSync(output, 'wx', 0o600));
        fd = fs.openSync(sql, 'r');
        const imported = spawnSync(executable, ['-bail', output], {
            stdio: [fd, 'ignore', 'pipe'], encoding: 'utf8', timeout: 120_000,
        });
        fs.closeSync(fd);
        fd = undefined;
        if (imported.error || imported.status !== 0)
            return imported.error?.message ?? String(imported.stderr).trim().split('\n')[0] ?? 'sqlite3 import failed';
        const db = openReadOnly(output);
        try {
            memoryCount(db);
        }
        finally {
            db.close();
        }
        return undefined;
    }
    catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    finally {
        if (fd !== undefined)
            fs.closeSync(fd);
        fs.rmSync(sql, { force: true });
    }
}
export class DatabaseReplacementOutcomeError extends Error {
}
function requireNoRegisteredHosts(cause) {
    const alive = liveHostPids(updateControlDir());
    if (alive === null || alive.length)
        throw new Error('Close every AI tool and memesh serve before restoring this damaged header', { cause });
}
const isNotDatabase = (error) => /not a database|SQLITE_NOTADB/i.test(error instanceof Error ? error.message : String(error));
function hasFileIdentity(file, original) {
    try {
        const current = fs.statSync(file, { bigint: true });
        return current.ino !== 0n && current.ino === original.ino && current.dev === original.dev;
    }
    catch {
        return false;
    }
}
async function installWindows(source, recovered, rollback, expected, outcome, replace) {
    const probes = [];
    const createProbe = (suffix, contents) => {
        const file = recovered + suffix;
        fs.writeFileSync(file, contents, { flag: 'wx', mode: 0o600 });
        probes.push(file);
        return file;
    };
    try {
        const from = createProbe('.guard-from', '1');
        const to = createProbe('.guard-to', '0');
        const unlink = createProbe('.guard-unlink', '');
        const sidecars = ['-wal', '-shm'].filter(suffix => expected[suffix] !== null);
        const guard = await acquireWindowsRepairGuard([source, ...sidecars.map(suffix => source + suffix), unlink], { from, to });
        try {
            if (fs.readFileSync(to, 'utf8') !== '1' || fs.existsSync(from))
                throw new Error('Guarded Windows replacement preflight failed');
            try {
                fs.unlinkSync(unlink);
                fs.closeSync(fs.openSync(unlink, 'wx', 0o600));
                fs.unlinkSync(unlink);
            }
            catch (cause) {
                throw new Error('This volume does not release guarded Windows journal paths on unlink', { cause });
            }
            if (!same(family(source), expected))
                throw new Error('Database changed before the repair lock; stop other writers and retry');
            for (const suffix of sidecars)
                copyPrivate(source + suffix, rollback + suffix);
            const removed = [];
            const staged = fs.statSync(recovered, { bigint: true });
            let installation;
            const commit = () => installation ??= guard.replace(recovered, source).then(() => { outcome.rename = 'committed'; }, error => {
                if (error instanceof WindowsReplacementUncertainError)
                    outcome.rename = 'uncertain';
                throw error;
            });
            try {
                for (const suffix of sidecars) {
                    fs.unlinkSync(source + suffix);
                    removed.push(suffix);
                }
                if (replace)
                    await replace(recovered, source, commit);
                else
                    await commit();
                if (installation)
                    await installation;
                else if (hasFileIdentity(source, staged))
                    outcome.rename = 'committed';
                else
                    throw new Error('Replacement did not run');
            }
            catch (error) {
                if (installation)
                    await installation.catch(() => { });
                if (!outcome.rename) {
                    if (hasFileIdentity(source, staged))
                        outcome.rename = 'committed';
                    else if (!hasFileIdentity(recovered, staged))
                        outcome.rename = 'uncertain';
                    else
                        for (const suffix of removed)
                            await guard.replace(rollback + suffix, source + suffix);
                }
                throw error;
            }
        }
        finally {
            await guard.release();
        }
    }
    finally {
        for (const probe of probes)
            fs.rmSync(probe, { force: true });
    }
}
async function installRecovered(source, recovered, copy, expected, outcome, replace, brokenHeader) {
    const rollback = `${recovered}.rollback`;
    if (process.platform !== 'win32') {
        for (const suffix of SUFFIXES)
            if (expected[suffix] !== null)
                copyPrivate(copy + suffix, rollback + suffix);
    }
    let opened = false;
    let staged;
    let lock;
    const hashHandles = [];
    try {
        if (!same(family(source), expected))
            throw new Error('Database changed during salvage; stop other writers and retry');
        if (process.platform === 'win32') {
            if (brokenHeader)
                requireNoRegisteredHosts(brokenHeader);
            await installWindows(source, recovered, rollback, expected, outcome, replace);
            return;
        }
        try {
            refuseMismatchedSidecars(source);
            lock = new MemeshDatabase(source);
            lock.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;');
            const locked = family(source, hashHandles);
            const empty = createHash('sha256').digest('hex');
            const wal = (value) => value === empty ? null : value;
            if (locked[''] !== expected[''] || wal(locked['-wal']) !== wal(expected['-wal']))
                throw new Error('Database changed before the repair lock; stop other writers and retry');
            opened = true;
            lock.exec('ROLLBACK');
        }
        catch (error) {
            if (!isNotDatabase(error))
                throw error;
            requireNoRegisteredHosts(error);
            opened = true;
        }
        for (const suffix of ['-wal', '-shm'])
            fs.rmSync(source + suffix, { force: true });
        if (replace) {
            staged = fs.statSync(recovered, { bigint: true });
            const pending = replace(recovered, source, () => {
                fs.renameSync(recovered, source);
                outcome.rename = 'committed';
            });
            if (pending)
                await pending;
            if (!outcome.rename && !hasFileIdentity(source, staged))
                throw new Error('Replacement did not run');
        }
        else
            fs.renameSync(recovered, source);
        outcome.rename = 'committed';
    }
    catch (error) {
        if (staged && !outcome.rename) {
            if (hasFileIdentity(source, staged))
                outcome.rename = 'committed';
            else if (!hasFileIdentity(recovered, staged))
                outcome.rename = 'uncertain';
        }
        if (opened && !outcome.rename) {
            for (const suffix of SUFFIXES) {
                if (expected[suffix] === null)
                    fs.rmSync(source + suffix, { force: true });
                else
                    fs.renameSync(rollback + suffix, source + suffix);
            }
        }
        throw error;
    }
    finally {
        try {
            lock?.close();
        }
        finally {
            for (const fd of hashHandles)
                fs.closeSync(fd);
            removeNewFamily(rollback);
        }
    }
}
export async function repairDatabase(database, options = {}) {
    const source = fs.realpathSync(database);
    let before;
    let copy;
    let recovered;
    const outcome = {};
    try {
        if (!options.fromBackup) {
            try {
                inspect(source);
                return { status: 'healthy' };
            }
            catch (error) {
                if (error.code === SIDECAR_PERMISSIONS_CODE)
                    throw error;
                if (/database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(error instanceof Error ? error.message : String(error)))
                    throw error;
            }
        }
        const mode = fs.statSync(source).mode;
        if (!(mode & 0o400) || !(mode & 0o200))
            throw new Error('The database is read-only or unreadable; repair will not add owner permissions');
        requirePrivateWritableDirectory(path.dirname(source), 'repair needs a private writable directory');
        before = family(source);
        copy = snapshot(source, before);
        recovered = `${source}.recovered-${randomUUID()}.db`;
        let method;
        let reason;
        let tables;
        let brokenHeader;
        if (options.fromBackup) {
            let allowEmpty = false;
            try {
                allowEmpty = inspect(copy).memories === 0;
            }
            catch (error) {
                if (isNotDatabase(error))
                    brokenHeader = error;
            }
            const backup = typeof options.fromBackup === 'string' ? { file: options.fromBackup, ...inspect(options.fromBackup) } : usableMemoryBackups(source).find(item => item.memories > 0 || allowEmpty);
            if (!backup)
                throw new Error('No usable memory backup is available');
            if (hasPagesWaiting(backup.file))
                throw new Error('Backup still has pending journal pages; use a complete standalone backup');
            copyPrivate(backup.file, recovered);
            tables = rebuildAndValidate(recovered, allowEmpty);
            method = 'backup';
        }
        else {
            let allowEmpty = false;
            try {
                const db = openReadOnly(copy);
                try {
                    allowEmpty = memoryCount(db) === 0;
                }
                finally {
                    db.close();
                }
            }
            catch (error) {
                if (isNotDatabase(error))
                    brokenHeader = error;
            }
            reason = systemSalvage(copy, recovered, options.sqliteExecutable ?? 'sqlite3');
            try {
                if (reason)
                    throw new Error(reason);
                tables = rebuildAndValidate(recovered, allowEmpty);
                method = 'sqlite3';
            }
            catch (error) {
                reason = error instanceof Error ? error.message : String(error);
                removeNewFamily(recovered);
                const result = salvageWithNode(copy, recovered);
                tables = result.tables;
                rebuildAndValidate(recovered, allowEmpty && result.tables.some(table => table.name === 'entities' && table.complete));
                method = 'built-in';
            }
        }
        let backup;
        try {
            backup = usableMemoryBackups(source)[0];
        }
        catch { }
        await installRecovered(source, recovered, copy, before, outcome, options.replaceFile, brokenHeader);
        recovered = undefined;
        return { status: 'repaired', method, reason: method === 'built-in' ? reason : undefined,
            damagedCopy: copy, tables, backup };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (outcome.rename) {
            const status = outcome.rename === 'committed'
                ? 'Database replacement completed before this error.'
                : 'Could not confirm whether the database replacement completed.';
            throw new DatabaseReplacementOutcomeError(`${status} ${message} Check the database before retrying.${copy ? ` Damaged copy: ${copy}.` : ''}`, { cause: error });
        }
        let unchanged = false;
        try {
            const after = family(source);
            unchanged = before === undefined || (after[''] === before[''] && after['-wal'] === before['-wal']);
        }
        catch { }
        let advice;
        try {
            const backup = usableMemoryBackups(source).find(item => item.memories > 0);
            if (backup)
                advice = ` Verified backup: ${backup.file} (${backup.at}, ${backup.memories} memories). Restore with: ${repairCommand(source, backup.file)}`;
            else
                advice = ' No usable memory backup is available.';
        }
        catch {
            advice = ' Could not inspect memory backups.';
        }
        throw new Error(`${message}. ${unchanged ? 'The original database and WAL have not been changed.' : 'Repair stopped; inspect the preserved damaged copy before retrying.'}${copy ? ` Damaged copy: ${copy}.` : ''}${advice}`, { cause: error });
    }
    finally {
        if (recovered && !outcome.rename)
            removeNewFamily(recovered);
    }
}
//# sourceMappingURL=database-repair.js.map