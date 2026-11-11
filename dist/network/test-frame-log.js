import fs from 'node:fs';
import path from 'node:path';
export function appendTestFrameLog(file, bytes) {
    const folder = path.dirname(path.resolve(file));
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