import fs from 'node:fs';
import path from 'node:path';
import { makeWindowsPathsPrivate, verifyWindowsPathsPrivate } from '../core/windows-permissions.js';
function windowsLogEntry(file, directory, expected) {
    const entry = fs.lstatSync(file, { bigint: true });
    if (entry.isSymbolicLink() || entry.ino === 0n || !(directory ? entry.isDirectory() : entry.isFile() && entry.nlink === 1n)
        || path.relative(file, fs.realpathSync(file)) !== ''
        || (expected && (entry.dev !== expected.dev || entry.ino !== expected.ino))) {
        throw new Error(`unsafe or changed frame log path: ${file}`);
    }
    return entry;
}
function appendWindowsFrameLog(file, folder, bytes) {
    try {
        const directory = windowsLogEntry(folder, true);
        verifyWindowsPathsPrivate([folder]);
        windowsLogEntry(folder, true, directory);
        const existing = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
        if (existing)
            windowsLogEntry(file, false, existing);
        const create = existing ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL;
        windowsLogEntry(folder, true, directory);
        const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | create, 0o600);
        try {
            const opened = fs.fstatSync(fd, { bigint: true });
            windowsLogEntry(folder, true, directory);
            windowsLogEntry(file, false, opened);
            if (existing && (opened.dev !== existing.dev || opened.ino !== existing.ino)) {
                throw new Error(`frame log path changed while opening: ${file}`);
            }
            makeWindowsPathsPrivate([file]);
            windowsLogEntry(folder, true, directory);
            windowsLogEntry(file, false, opened);
            fs.writeSync(fd, `${bytes.toString('utf8')}\n`);
            return null;
        }
        finally {
            fs.closeSync(fd);
        }
    }
    catch (error) {
        return `the frame log ${file} could not be opened safely (${error instanceof Error ? error.message : String(error)})`;
    }
}
export function appendTestFrameLog(file, bytes) {
    const absolute = path.resolve(file);
    const folder = path.dirname(absolute);
    if (process.platform === 'win32')
        return appendWindowsFrameLog(absolute, folder, bytes);
    let folderStat;
    try {
        folderStat = fs.lstatSync(folder);
    }
    catch {
        return `the frame log folder ${folder} does not exist`;
    }
    if (folderStat.isSymbolicLink() || !folderStat.isDirectory())
        return `the frame log folder ${folder} is not a plain folder`;
    if ((folderStat.mode & 0o077) !== 0)
        return `the frame log folder ${folder} is readable by others`;
    if (typeof process.getuid === 'function' && folderStat.uid !== process.getuid())
        return `the frame log folder ${folder} belongs to another user`;
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    }
    catch (err) {
        return `the frame log ${file} could not be opened safely (${err.code ?? 'error'})`;
    }
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile())
            return `the frame log ${file} is not a regular file`;
        fs.fchmodSync(fd, 0o600);
        fs.writeSync(fd, `${bytes.toString('utf8')}\n`);
        return null;
    }
    finally {
        fs.closeSync(fd);
    }
}
//# sourceMappingURL=test-frame-log.js.map