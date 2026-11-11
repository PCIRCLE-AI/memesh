import fs from 'fs';
import path from 'path';
export function refuse(label, target, what, ending = 'nothing was changed') {
    return new Error(`${label} at ${target}${what}; ${ending}`);
}
export function whyFailed(err) {
    const code = err?.code;
    switch (code) {
        case 'EACCES':
        case 'EPERM': return 'permission denied';
        case 'EISDIR': return 'it is a folder';
        case 'ENOTDIR': return 'a folder on its path is a file';
        case 'ENOENT': return 'it does not exist';
        case 'EROFS': return 'the disk is read-only';
        default: return code ?? (err instanceof Error ? err.message : String(err));
    }
}
function lstatOrNull(p) {
    try {
        return fs.lstatSync(p);
    }
    catch (err) {
        const code = err.code;
        if (code === 'ENOENT' || code === 'ENOTDIR')
            return null;
        throw refuse('file', p, ` cannot be examined (${whyFailed(err)})`);
    }
}
export function assertFolderWritable(dir) {
    let probe = dir;
    while (lstatOrNull(probe) === null) {
        const parent = path.dirname(probe);
        if (parent === probe)
            return;
        probe = parent;
    }
    let target;
    try {
        target = fs.statSync(probe);
    }
    catch {
        throw refuse('link', probe, ' points to a place that does not exist');
    }
    if (!target.isDirectory())
        throw refuse('folder', probe, ' is not a folder');
    try {
        fs.accessSync(probe, fs.constants.W_OK | fs.constants.X_OK);
    }
    catch {
        throw refuse('folder', probe, ' cannot be written to (permission denied)');
    }
}
export function assertCanWrite(file, label) {
    const entry = lstatOrNull(file);
    if (entry === null)
        return assertFolderWritable(path.dirname(file));
    let target;
    try {
        target = fs.statSync(file);
    }
    catch {
        throw refuse(label, file, ' is a link to a file that does not exist');
    }
    if (target.isDirectory())
        throw refuse(label, file, ' is a folder, not a file');
    try {
        fs.accessSync(file, fs.constants.W_OK);
    }
    catch {
        throw refuse(label, file, ' cannot be written (permission denied)');
    }
}
export function assertCanDelete(file, label) {
    const entry = lstatOrNull(file);
    if (entry === null)
        return;
    if (entry.isDirectory())
        throw refuse(label, file, ' is a folder, not a file');
    const dir = path.dirname(file);
    try {
        fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
    }
    catch {
        throw refuse('folder', dir, ' cannot be written to (permission denied)');
    }
}
export function readBytesOrNull(file) {
    try {
        return fs.readFileSync(file);
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return null;
        throw err;
    }
}
export class Changes {
    undo = [];
    mkdir(dir) {
        const first = fs.mkdirSync(dir, { recursive: true });
        if (first === undefined)
            return;
        this.undo.push(() => {
            for (let d = dir;; d = path.dirname(d)) {
                fs.rmdirSync(d);
                if (d === first)
                    return;
            }
        });
    }
    write(file, data) {
        const before = readBytesOrNull(file);
        fs.writeFileSync(file, data, 'utf8');
        this.undo.push(() => (before === null ? fs.rmSync(file, { force: true }) : fs.writeFileSync(file, before)));
    }
    remove(file) {
        const before = readBytesOrNull(file);
        fs.rmSync(file);
        if (before !== null)
            this.undo.push(() => fs.writeFileSync(file, before));
    }
    copyNew(source, suffix) {
        for (let n = 0;; n++) {
            const copy = `${source}${suffix}${n === 0 ? '' : `-${n}`}`;
            try {
                fs.copyFileSync(source, copy, fs.constants.COPYFILE_EXCL);
            }
            catch (err) {
                if (err.code === 'EEXIST')
                    continue;
                throw err;
            }
            this.undo.push(() => fs.rmSync(copy, { force: true }));
            return copy;
        }
    }
    rollBack() {
        for (const step of this.undo.splice(0).reverse()) {
            try {
                step();
            }
            catch { }
        }
    }
}
//# sourceMappingURL=safe-write.js.map