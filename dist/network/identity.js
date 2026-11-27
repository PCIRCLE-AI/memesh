import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { removeGroupAndOtherAccess } from '../core/file-mode.js';
import { makeWindowsPathsPrivate, verifyWindowsPathsPrivate } from '../core/windows-permissions.js';
import { NetworkError, networkDir } from './types.js';
const SEED_BYTES = 32;
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MACHINE_ID = /^[0-9a-f]{64}$/;
export function isMachineId(value) {
    return typeof value === 'string' && MACHINE_ID.test(value);
}
export function identityPath(dataDir) {
    return path.join(networkDir(dataDir), 'identity.key');
}
function windowsEntry(file, directory) {
    const entry = fs.lstatSync(file, { bigint: true });
    if (entry.isSymbolicLink() || entry.ino === 0n || !(directory ? entry.isDirectory() : entry.isFile())
        || path.relative(file, fs.realpathSync(file)) !== '') {
        throw new NetworkError('identity_invalid', `Unsafe network path: ${file}.`);
    }
    return entry;
}
function requireSameIdentity(file, expected, actual) {
    if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
        throw new NetworkError('identity_invalid', `Network path changed: ${file}.`);
    }
}
function removeWindowsStage(file, owned) {
    try {
        requireSameIdentity(file, owned, windowsEntry(file, owned.isDirectory()));
        if (owned.isDirectory())
            fs.rmdirSync(file);
        else
            fs.unlinkSync(file);
    }
    catch { }
}
function verifyExistingWindowsNetworkDir(directory) {
    if (!fs.lstatSync(directory, { throwIfNoEntry: false }))
        return false;
    const leaf = windowsEntry(directory, true);
    verifyWindowsPathsPrivate([directory]);
    requireSameIdentity(directory, leaf, windowsEntry(directory, true));
    return true;
}
function ensureWindowsNetworkDir(dir) {
    const directory = path.resolve(dir);
    if (verifyExistingWindowsNetworkDir(directory))
        return;
    const parent = path.dirname(directory);
    for (let ancestor = parent;; ancestor = path.dirname(ancestor)) {
        const entry = fs.lstatSync(ancestor, { throwIfNoEntry: false });
        if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
            throw new NetworkError('identity_invalid', `Unsafe network parent: ${ancestor}.`);
        }
        if (path.dirname(ancestor) === ancestor)
            break;
    }
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    windowsEntry(parent, true);
    const temporary = fs.mkdtempSync(path.join(parent, '.network-'));
    const owned = windowsEntry(temporary, true);
    try {
        makeWindowsPathsPrivate([temporary]);
        requireSameIdentity(temporary, owned, windowsEntry(temporary, true));
        if (verifyExistingWindowsNetworkDir(directory))
            return;
        try {
            fs.renameSync(temporary, directory);
        }
        catch (error) {
            if (!verifyExistingWindowsNetworkDir(directory))
                throw error;
            return;
        }
        requireSameIdentity(directory, owned, windowsEntry(directory, true));
    }
    finally {
        removeWindowsStage(temporary, owned);
    }
}
export function ensureNetworkDir(dataDir) {
    const dir = networkDir(dataDir);
    if (process.platform === 'win32') {
        ensureWindowsNetworkDir(dir);
    }
    else {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        removeGroupAndOtherAccess(dir);
    }
    return dir;
}
function identityFromSeed(secret) {
    const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, secret]), format: 'der', type: 'pkcs8' });
    const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    return {
        secret,
        machineId: spki.subarray(-SEED_BYTES).toString('hex'),
        sign: (message) => sign(null, message, privateKey).toString('base64url'),
    };
}
function readWindowsIdentity(file) {
    const directory = path.dirname(file);
    const leaf = windowsEntry(directory, true);
    const key = windowsEntry(file, false);
    const fd = fs.openSync(file, 'r');
    try {
        requireSameIdentity(file, key, fs.fstatSync(fd, { bigint: true }));
        verifyWindowsPathsPrivate([directory, file]);
        requireSameIdentity(directory, leaf, windowsEntry(directory, true));
        requireSameIdentity(file, key, windowsEntry(file, false));
        return fs.readFileSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
}
export function loadIdentity(dataDir) {
    const file = identityPath(dataDir);
    let secret;
    try {
        secret = process.platform === 'win32' ? readWindowsIdentity(file) : fs.readFileSync(file);
    }
    catch (err) {
        if (err instanceof NetworkError)
            throw err;
        const code = err.code;
        throw new NetworkError(code === 'ENOENT' ? 'not_joined' : 'identity_invalid', code === 'ENOENT' ? 'This machine has not joined a network.'
            : code === 'MEMESH_PRIVATE_PATH' && err instanceof Error ? err.message : `Cannot read ${file} (${code}).`);
    }
    if (secret.length !== SEED_BYTES) {
        throw new NetworkError('identity_invalid', `${file} is not a valid machine key (${secret.length} bytes, expected ${SEED_BYTES}).`);
    }
    if (process.platform !== 'win32')
        removeGroupAndOtherAccess(file);
    return identityFromSeed(secret);
}
function linkIdentity(temporary, file) {
    try {
        fs.linkSync(temporary, file);
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
    }
}
function createWindowsIdentity(temporary, file) {
    const directory = path.dirname(file);
    const leaf = windowsEntry(directory, true);
    const fd = fs.openSync(temporary, 'wx', 0o600);
    let owned;
    try {
        try {
            const stage = windowsEntry(temporary, false);
            requireSameIdentity(temporary, stage, fs.fstatSync(fd, { bigint: true }));
            if (stage.nlink !== 1n)
                throw new NetworkError('identity_invalid', `Unsafe network key stage: ${temporary}.`);
            owned = stage;
            makeWindowsPathsPrivate([temporary]);
            requireSameIdentity(directory, leaf, windowsEntry(directory, true));
            const verified = windowsEntry(temporary, false);
            requireSameIdentity(temporary, owned, verified);
            if (verified.nlink !== 1n)
                throw new NetworkError('identity_invalid', `Unsafe network key stage: ${temporary}.`);
            fs.writeFileSync(fd, randomBytes(SEED_BYTES));
        }
        finally {
            fs.closeSync(fd);
        }
        requireSameIdentity(temporary, owned, windowsEntry(temporary, false));
        linkIdentity(temporary, file);
    }
    finally {
        if (owned)
            removeWindowsStage(temporary, owned);
    }
}
export function ensureIdentity(dataDir) {
    ensureNetworkDir(dataDir);
    const file = identityPath(dataDir);
    if (process.platform === 'win32') {
        if (!fs.lstatSync(file, { throwIfNoEntry: false })) {
            createWindowsIdentity(`${file}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`, file);
        }
        return loadIdentity(dataDir);
    }
    if (!fs.existsSync(file)) {
        const temporary = `${file}.tmp-${process.pid}`;
        fs.writeFileSync(temporary, randomBytes(SEED_BYTES), { mode: 0o600, flag: 'wx' });
        try {
            fs.chmodSync(temporary, 0o600);
            linkIdentity(temporary, file);
        }
        finally {
            fs.rmSync(temporary, { force: true });
        }
    }
    return loadIdentity(dataDir);
}
export function verifySignature(machineId, message, signature) {
    if (!isMachineId(machineId) || typeof signature !== 'string')
        return false;
    try {
        const publicKey = createPublicKey({
            key: Buffer.concat([SPKI_PREFIX, Buffer.from(machineId, 'hex')]),
            format: 'der',
            type: 'spki',
        });
        return verify(null, message, publicKey, Buffer.from(signature, 'base64url'));
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=identity.js.map