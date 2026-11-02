import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { removeGroupAndOtherAccess } from '../core/file-mode.js';
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
export function ensureNetworkDir(dataDir) {
    const dir = networkDir(dataDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    removeGroupAndOtherAccess(dir);
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
export function loadIdentity(dataDir) {
    const file = identityPath(dataDir);
    let secret;
    try {
        secret = fs.readFileSync(file);
    }
    catch (err) {
        const code = err.code;
        throw new NetworkError(code === 'ENOENT' ? 'not_joined' : 'identity_invalid', code === 'ENOENT' ? 'This machine has not joined a network.' : `Cannot read ${file} (${code}).`);
    }
    if (secret.length !== SEED_BYTES) {
        throw new NetworkError('identity_invalid', `${file} is not a valid machine key (${secret.length} bytes, expected ${SEED_BYTES}).`);
    }
    removeGroupAndOtherAccess(file);
    return identityFromSeed(secret);
}
export function ensureIdentity(dataDir) {
    ensureNetworkDir(dataDir);
    const file = identityPath(dataDir);
    if (!fs.existsSync(file)) {
        const temporary = `${file}.tmp-${process.pid}`;
        fs.writeFileSync(temporary, randomBytes(SEED_BYTES), { mode: 0o600, flag: 'wx' });
        try {
            fs.chmodSync(temporary, 0o600);
            fs.linkSync(temporary, file);
        }
        catch (err) {
            if (err.code !== 'EEXIST')
                throw err;
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