import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { makeWindowsPathsPrivate, verifyWindowsPathsPrivate } from './windows-permissions.js';
export const DB_COPIES_KEPT = 3;
export function backupDirectoryFor(dbPath) {
    return path.join(path.dirname(dbPath), 'backups');
}
function requireSameEntry(file, expected) {
    const actual = fs.lstatSync(file, { bigint: true });
    const expectedType = expected.isDirectory() ? actual.isDirectory() : actual.isFile() && actual.nlink === 1n;
    if (!expectedType || actual.isSymbolicLink() || actual.ino === 0n || actual.ino !== expected.ino || actual.dev !== expected.dev)
        throw new Error('Backup path changed or is unsafe: ' + file);
}
function prepareWindowsBackupDirectory(directory) {
    const parent = path.dirname(directory);
    for (let ancestor = parent;; ancestor = path.dirname(ancestor)) {
        const entry = fs.lstatSync(ancestor);
        if (!entry.isDirectory() || entry.isSymbolicLink())
            throw new Error('Unsafe backup ancestor: ' + ancestor);
        if (path.dirname(ancestor) === ancestor)
            break;
    }
    if (path.relative(parent, fs.realpathSync(parent)) !== '')
        throw new Error('Unsafe backup parent: ' + parent);
    let created = false;
    try {
        fs.mkdirSync(directory, { mode: 0o700 });
        created = true;
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
    }
    const leaf = fs.lstatSync(directory, { bigint: true });
    if (!leaf.isDirectory() || leaf.isSymbolicLink() || leaf.ino === 0n || path.relative(directory, fs.realpathSync(directory)) !== '')
        throw new Error('Unsafe backup directory: ' + directory);
    try {
        if (created)
            makeWindowsPathsPrivate([directory]);
        else
            verifyWindowsPathsPrivate([directory]);
        requireSameEntry(directory, leaf);
    }
    catch (error) {
        if (created) {
            try {
                requireSameEntry(directory, leaf);
                fs.rmdirSync(directory);
            }
            catch { }
        }
        throw error;
    }
    return leaf;
}
export function copyDatabaseBefore(db, prefix, inCopy) {
    const location = db.location();
    if (!location)
        return { kind: 'failed', reason: 'the database has no file path, so no copy can be made' };
    const windows = process.platform === 'win32';
    const directory = windows ? path.resolve(backupDirectoryFor(location)) : backupDirectoryFor(location);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const unique = randomUUID().slice(0, 8);
    const finalPath = path.join(directory, `${prefix}-${stamp}-${unique}.db`);
    const partialPath = path.join(directory, `.partial-${prefix}-${process.pid}-${unique}.db`);
    const journalPath = `${partialPath}-journal`;
    let leaf;
    let ownedPartial;
    let mayHaveJournal = false;
    try {
        if (windows) {
            if (path.dirname(finalPath) !== directory || path.dirname(partialPath) !== directory)
                throw new Error('Backup paths must be inside the backups directory');
            leaf = prepareWindowsBackupDirectory(directory);
        }
        else {
            fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        }
        removeInterruptedCopies(directory, prefix);
        const expected = db.prepare('SELECT COUNT(*) AS n FROM entities').get().n;
        let destination = partialPath;
        if (leaf) {
            requireSameEntry(directory, leaf);
            const fd = fs.openSync(partialPath, 'wx', 0o600);
            try {
                ownedPartial = fs.fstatSync(fd, { bigint: true });
            }
            finally {
                fs.closeSync(fd);
            }
            requireSameEntry(partialPath, ownedPartial);
            makeWindowsPathsPrivate([partialPath]);
            requireSameEntry(partialPath, ownedPartial);
            if (fs.lstatSync(journalPath, { throwIfNoEntry: false }))
                throw new Error('Backup journal already exists');
            destination = `${pathToFileURL(partialPath).href}?mode=rw`;
            mayHaveJournal = true;
        }
        db.prepare('VACUUM INTO ?').run(destination);
        if (ownedPartial)
            requireSameEntry(partialPath, ownedPartial);
        else
            fs.chmodSync(partialPath, 0o600);
        db.prepare('ATTACH DATABASE ? AS db_copy_check').run(partialPath);
        let found;
        try {
            found = db.prepare('SELECT COUNT(*) AS n FROM db_copy_check.entities').get().n;
            if (found >= expected)
                inCopy?.('db_copy_check');
        }
        finally {
            db.exec('DETACH DATABASE db_copy_check');
        }
        if (found < expected)
            throw new Error(`the copy holds ${found} memories, fewer than the ${expected} the database had`);
        if (leaf && ownedPartial) {
            requireSameEntry(directory, leaf);
            requireSameEntry(partialPath, ownedPartial);
        }
        fs.renameSync(partialPath, finalPath);
    }
    catch (error) {
        try {
            if (!windows) {
                for (const name of [partialPath, journalPath])
                    fs.rmSync(name, { force: true });
            }
            else if (leaf && ownedPartial) {
                requireSameEntry(directory, leaf);
                requireSameEntry(partialPath, ownedPartial);
                fs.rmSync(partialPath, { force: true });
                const journal = mayHaveJournal ? fs.lstatSync(journalPath, { throwIfNoEntry: false }) : undefined;
                if (journal?.isFile() && !journal.isSymbolicLink() && journal.nlink === 1)
                    fs.rmSync(journalPath, { force: true });
            }
        }
        catch { }
        return { kind: 'failed', reason: `the copy to ${directory} failed (${error instanceof Error ? error.message : String(error)})` };
    }
    try {
        if (leaf)
            requireSameEntry(directory, leaf);
        const made = path.basename(finalPath);
        const older = fs.readdirSync(directory).filter((name) => name !== made && copyName(prefix).test(name)).sort();
        for (const name of older.slice(0, Math.max(0, older.length - (DB_COPIES_KEPT - 1))))
            fs.rmSync(path.join(directory, name), { force: true });
    }
    catch { }
    return { kind: 'ready', path: finalPath };
}
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const copyName = (prefix) => new RegExp(`^${escaped(prefix)}-\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z(?:-[0-9a-f]{8})?\\.db$`);
function removeInterruptedCopies(directory, prefix) {
    const partial = new RegExp(`^\\.partial-${escaped(prefix)}-(\\d+)-[0-9a-f]{8}\\.db(?:-journal)?$`);
    for (const name of fs.readdirSync(directory)) {
        const pid = Number(partial.exec(name)?.[1]);
        if (pid && !processRuns(pid))
            fs.rmSync(path.join(directory, name), { force: true });
    }
}
function processRuns(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === 'EPERM';
    }
}
//# sourceMappingURL=db-copy.js.map