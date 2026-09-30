// ============================================================================
// AUTO-GENERATED from src/core/file-mode.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
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
        const notYours = stat !== undefined && belongsToAnotherUser(stat);
        try {
            process.stderr.write(notYours
                ? `MeMesh: ${target} belongs to another user, so MeMesh cannot remove other users' access to it (${code}). ` +
                    'Point MEMESH_DB_PATH at a database you own, in a folder you own.\n'
                : `MeMesh: could not remove other users' access to ${target} (${code ?? String(err)}); ` +
                    `they may be able to read your memories. Fix it with: chmod go-rwx "${target}"\n`);
        }
        catch { }
    }
}
export function belongsToAnotherUser(stat) {
    return typeof process.getuid === 'function' && process.getuid() !== 0 && stat.uid !== process.getuid();
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
    const notYours = [];
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
        else
            continue;
        if (belongsToAnotherUser(stat))
            notYours.push(sidecar);
    }
    if (notYours.length === 0 && fewer.length + extra.length > 0 && belongsToAnotherUser(database))
        notYours.push(real);
    if (notYours.length > 0) {
        const fix = 'Point MEMESH_DB_PATH at a database you own, in a folder you own.';
        throw Object.assign(new Error(`MeMesh: the owner permissions of ${real} and its ${[...fewer, ...extra].join(' and ')} do not match, and ` +
            `${notYours.join(' and ')} ${notYours.length > 1 ? 'belong' : 'belongs'} to another user, so you cannot change them. ${fix}`), { fix, code: SIDECAR_PERMISSIONS_CODE });
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
    const readOnly = [];
    for (const file of databaseFiles(dbPath)) {
        const stat = fs.statSync(file, { throwIfNoEntry: false });
        if (stat === undefined || (stat.mode & 0o200) !== 0)
            continue;
        if (belongsToAnotherUser(stat)) {
            return `point MEMESH_DB_PATH at a database you own, in a folder you own; ${file} belongs to another user.`;
        }
        readOnly.push(file);
    }
    return readOnly.length > 0 ? `run: chmod u+w ${quoted(readOnly)}` : undefined;
}
