// ============================================================================
// AUTO-GENERATED from src/core/public-network-context.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { MemeshDatabase } from './sqlite.js';
import { hasPagesWaiting, immutableAddress, refuseMismatchedSidecars } from './file-mode.js';
import { verifyRoster } from './network-roster.js';
function stat(file) {
    try {
        return fs.lstatSync(file);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
export function openPublicNetworkDatabase(file, consistentSnapshot = false) {
    const parent = stat(path.dirname(file));
    if (!parent)
        return undefined;
    let expectedParent = path.resolve(path.dirname(file));
    if (process.platform === 'darwin') {
        for (const alias of ['/var', '/tmp']) {
            if ((expectedParent === alias || expectedParent.startsWith(`${alias}/`)) && fs.realpathSync(alias) === `/private${alias}`) {
                expectedParent = `/private${expectedParent}`;
            }
        }
    }
    if (!parent.isDirectory() || parent.isSymbolicLink() || fs.realpathSync(path.dirname(file)) !== expectedParent
        || (process.platform !== 'win32' && (parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0)))
        throw new Error('Unsafe network metadata directory');
    const main = stat(file);
    if (!main)
        return undefined;
    for (const target of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
        const value = stat(target);
        if (value && (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1
            || (process.platform !== 'win32' && (value.uid !== process.getuid?.() || (value.mode & 0o077) !== 0))))
            throw new Error('Unsafe network metadata file');
    }
    const pending = hasPagesWaiting(file);
    if (pending) {
        if (!stat(`${file}-shm`))
            throw new Error('Network metadata WAL requires existing SHM for readonly access');
    }
    if (pending || consistentSnapshot) {
        refuseMismatchedSidecars(file, { readOnly: true });
    }
    const db = new MemeshDatabase(pending || consistentSnapshot ? file : immutableAddress(file), { readOnly: true });
    db.pragma('busy_timeout = 100');
    return db;
}
export function readPublicNetworkContext(dataDir) {
    const db = openPublicNetworkDatabase(path.join(dataDir, 'network', 'metadata.db'));
    if (!db)
        return undefined;
    try {
        const row = db.prepare('SELECT network_id,owner_id,machine_id,roster_json,roster_signature FROM agent_network_config WHERE id=1').get();
        if (!row)
            return undefined;
        const roster = verifyRoster({ roster_json: row.roster_json, signature: row.roster_signature }, row.owner_id, row.network_id);
        const self = roster.members.find(member => member.machine_id === row.machine_id);
        if (!self)
            throw new Error('This machine is no longer a network member');
        return { network_id: row.network_id, self: { id: self.machine_id, name: self.name },
            members: roster.members.map(member => ({ id: member.machine_id, name: member.name })) };
    }
    finally {
        db.close();
    }
}
