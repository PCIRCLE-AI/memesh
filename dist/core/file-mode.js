import fs from 'fs';
const warned = new Set();
export function removeGroupAndOtherAccess(target) {
    let stat;
    try {
        stat = fs.statSync(target);
        const mode = stat.mode & 0o7777;
        if ((mode & 0o077) !== 0)
            fs.chmodSync(target, mode & ~0o077);
    }
    catch (err) {
        const code = err.code;
        if (code === 'ENOENT')
            return;
        if (warned.has(target))
            return;
        warned.add(target);
        const notYours = stat !== undefined && typeof process.getuid === 'function' && stat.uid !== process.getuid();
        try {
            process.stderr.write(notYours
                ? `MeMesh: ${target} belongs to another user, so MeMesh cannot remove other users' access to it (${code}). ` +
                    'Keep the database in a folder of your own (MEMESH_DB_PATH).\n'
                : `MeMesh: could not remove other users' access to ${target} (${code ?? String(err)}); ` +
                    `they may be able to read your memories. Fix it with: chmod go-rwx "${target}"\n`);
        }
        catch { }
    }
}
export function databaseFiles(dbPath) {
    let real = dbPath;
    try {
        if (fs.lstatSync(dbPath).isSymbolicLink())
            real = fs.realpathSync(dbPath);
    }
    catch { }
    return [real, `${real}-wal`, `${real}-shm`];
}
export function guardDatabaseFiles(dbPath) {
    for (const target of databaseFiles(dbPath))
        removeGroupAndOtherAccess(target);
    refuseMismatchedSidecars(dbPath);
}
export function requirePrivateWritableDirectory(dir, purpose) {
    removeGroupAndOtherAccess(dir);
    const mode = fs.statSync(dir).mode & 0o777;
    if ((mode & 0o077) !== 0) {
        throw new Error(`${dir} is still open to other users (${mode.toString(8)}), and ${purpose}. Run: chmod go-rwx "${dir}"`);
    }
    try {
        fs.accessSync(dir, fs.constants.W_OK);
    }
    catch {
        throw new Error(`${dir} is read-only, and ${purpose}. MeMesh does not make it writable; if you want it to run, run: chmod u+w "${dir}"`);
    }
}
export const SIDECAR_PERMISSIONS_CODE = 'MEMESH_SIDECAR_PERMISSIONS';
const OWNER_LETTERS = [[0o400, 'r'], [0o200, 'w'], [0o100, 'x']];
const quoted = (files) => files.map((f) => `"${f}"`).join(' ');
const letters = (bits) => OWNER_LETTERS.filter(([bit]) => bits & bit).map(([, letter]) => letter).join('');
export function refuseMismatchedSidecars(dbPath) {
    if (process.platform === 'win32')
        return;
    const [real, wal, shm] = databaseFiles(dbPath);
    const database = fs.statSync(real, { throwIfNoEntry: false });
    if (!database)
        return;
    const fewer = [];
    const extra = [];
    let fewerBits = 0;
    let extraBits = 0;
    for (const sidecar of [wal, shm]) {
        const stat = fs.statSync(sidecar, { throwIfNoEntry: false });
        if (!stat)
            continue;
        const missing = database.mode & ~stat.mode & (stat.size === 0 ? 0o700 : 0o600);
        const added = stat.mode & ~database.mode & 0o700;
        if (missing !== 0) {
            fewer.push(sidecar);
            fewerBits |= missing;
        }
        else if (added !== 0 && stat.size === 0) {
            extra.push(sidecar);
            extraBits |= added;
        }
    }
    if (fewer.length > 0) {
        const fix = `chmod u+${letters(fewerBits)} ${quoted(fewer)}`;
        const keepReadOnly = fewerBits === 0o200 ? ` To keep the database read-only instead, run: chmod u-w "${real}"` : '';
        throw Object.assign(new Error(`MeMesh: ${fewer.join(' and ')} ${fewer.length > 1 ? 'have' : 'has'} fewer owner permissions than ` +
            `${real}, so opening it would either widen them or leave the database silently read-only. ` +
            `To use the database normally, run: ${fix}.${keepReadOnly}`), { fix, code: SIDECAR_PERMISSIONS_CODE });
    }
    if (extra.length > 0) {
        const fix = `chmod u-${letters(extraBits)} ${quoted(extra)}`;
        throw Object.assign(new Error(`MeMesh: ${extra.join(' and ')} ${extra.length > 1 ? 'are' : 'is'} empty and ${extra.length > 1 ? 'have' : 'has'} ` +
            `more owner permissions than ${real}, which SQLite would reset while opening. ` +
            `To read the database as it is, run: ${fix}. To use it normally, run: chmod u+${letters(extraBits)} "${real}"`), { fix, code: SIDECAR_PERMISSIONS_CODE });
    }
}
export function ownerWriteCommand(dbPath) {
    if (process.platform === 'win32')
        return undefined;
    const readOnly = databaseFiles(dbPath)
        .filter((file) => {
        const stat = fs.statSync(file, { throwIfNoEntry: false });
        return stat !== undefined && (stat.mode & 0o200) === 0;
    });
    return readOnly.length > 0 ? `chmod u+w ${quoted(readOnly)}` : undefined;
}
//# sourceMappingURL=file-mode.js.map