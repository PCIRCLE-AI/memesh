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
    const finalPath = path.join(directory, `${prefix}-${stamp}.db`);
    const partialPath = path.join(directory, `.partial-${prefix}-${process.pid}-${randomUUID().slice(0, 8)}.db`);
    try {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
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
            fs.rmSync(partialPath, { force: true });
        }
        catch { }
        return { kind: 'failed', reason: `the copy to ${directory} failed (${error instanceof Error ? error.message : String(error)})` };
    }
    try {
        const mine = fs.readdirSync(directory).filter((name) => name.startsWith(`${prefix}-`) && name.endsWith('.db')).sort();
        for (const name of mine.slice(0, Math.max(0, mine.length - DB_COPIES_KEPT))) {
            fs.rmSync(path.join(directory, name), { force: true });
            fs.rmSync(path.join(directory, `${name}.json`), { force: true });
        }
    }
    catch { }
    return { kind: 'ready', path: finalPath };
}
//# sourceMappingURL=db-copy.js.map