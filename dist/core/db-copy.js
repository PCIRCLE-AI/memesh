import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export const DB_COPIES_KEPT = 3;
export function copyDatabaseBefore(db, prefix) {
    const location = db.location();
    if (!location)
        return { kind: 'failed', reason: 'the database has no file path, so no copy can be made' };
    const directory = path.join(path.dirname(location), 'backups');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const unique = randomUUID().slice(0, 8);
    const finalPath = path.join(directory, `${prefix}-${stamp}-${unique}.db`);
    const partialPath = path.join(directory, `.partial-${prefix}-${process.pid}-${unique}.db`);
    try {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        removeInterruptedCopies(directory, prefix);
        const expected = db.prepare('SELECT COUNT(*) AS n FROM entities').get().n;
        db.prepare('VACUUM INTO ?').run(partialPath);
        fs.chmodSync(partialPath, 0o600);
        db.prepare('ATTACH DATABASE ? AS db_copy_check').run(partialPath);
        let found;
        try {
            found = db.prepare('SELECT COUNT(*) AS n FROM db_copy_check.entities').get().n;
        }
        finally {
            db.exec('DETACH DATABASE db_copy_check');
        }
        if (found < expected)
            throw new Error(`the copy holds ${found} memories, fewer than the ${expected} the database had`);
        fs.renameSync(partialPath, finalPath);
    }
    catch (error) {
        try {
            for (const name of [partialPath, `${partialPath}-journal`])
                fs.rmSync(name, { force: true });
        }
        catch { }
        return { kind: 'failed', reason: `the copy to ${directory} failed (${error instanceof Error ? error.message : String(error)})` };
    }
    try {
        const mine = fs.readdirSync(directory).filter((name) => copyName(prefix).test(name)).sort();
        for (const name of mine.slice(0, Math.max(0, mine.length - DB_COPIES_KEPT)))
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