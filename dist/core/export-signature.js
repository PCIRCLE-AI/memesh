import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
function signedText(bundle) {
    const { signature: _signature, ...content } = bundle;
    return JSON.stringify(content);
}
export function signExport(bundle, key) {
    return { alg: 'hmac-sha256', mac: createHmac('sha256', key).update(signedText(bundle)).digest('hex') };
}
export function verifyExport(data, key) {
    if (typeof data !== 'object' || data === null || Array.isArray(data))
        return 'absent';
    const bundle = data;
    if (!Object.hasOwn(bundle, 'signature'))
        return 'absent';
    const claimed = bundle.signature;
    if (typeof claimed !== 'object' || claimed === null || claimed.alg !== 'hmac-sha256'
        || typeof claimed.mac !== 'string' || !/^[0-9a-f]{64}$/.test(claimed.mac))
        return 'invalid';
    const expected = Buffer.from(signExport(bundle, key).mac, 'hex');
    return timingSafeEqual(expected, Buffer.from(claimed.mac, 'hex')) ? 'valid' : 'invalid';
}
const MAX_ROUTER_TOKEN_FILE_BYTES = 8 * 1024;
const SECURE_LOCAL_HOST_RUNTIME_UNSUPPORTED = 'The secure local host runtime is not supported on Windows.';
function assertSecureLocalHostRuntimeSupported() {
    if (process.platform === 'win32') {
        throw new Error(SECURE_LOCAL_HOST_RUNTIME_UNSUPPORTED);
    }
}
function readTokenFile(tokenFile) {
    const file = requiredString(tokenFile, 'token_file');
    return requiredString(readOwnerPrivateFile(file, 'router token file', MAX_ROUTER_TOKEN_FILE_BYTES).trim(), 'router token');
}
function ensureRouterTokenFile(tokenFile) {
    assertSecureLocalHostRuntimeSupported();
    try {
        fs.writeFileSync(tokenFile, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
    }
    return readTokenFile(tokenFile);
}
export function exportSigningKey(dataDir, options) {
    const tokenFile = path.join(dataDir, 'agent-router.token');
    const token = options.create ? ensureRouterTokenFile(tokenFile) : readTokenFile(tokenFile);
    return createHmac('sha256', token).update('memesh-export-signature-v1').digest();
}
function requiredString(value, field) {
    if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 4096) {
        throw new Error(`${field} must be a bounded non-empty string.`);
    }
    return value;
}
function readOwnerPrivateFile(file, label, maxBytes) {
    assertSecureLocalHostRuntimeSupported();
    if (typeof fs.constants.O_NOFOLLOW !== 'number') {
        throw new Error(`This platform cannot safely reject a symlink ${label}.`);
    }
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile())
            throw new Error(`The ${label} must be an owner-private regular file.`);
        assertOwnerPrivate(stat, label);
        if (stat.size > maxBytes)
            throw new Error(`The ${label} exceeds its ${maxBytes}-byte limit.`);
        const content = Buffer.allocUnsafe(maxBytes + 1);
        let bytesRead = 0;
        while (bytesRead < content.length) {
            const chunkBytes = fs.readSync(descriptor, content, bytesRead, content.length - bytesRead, null);
            if (chunkBytes === 0)
                break;
            bytesRead += chunkBytes;
        }
        if (bytesRead > maxBytes)
            throw new Error(`The ${label} exceeds its ${maxBytes}-byte limit.`);
        return content.subarray(0, bytesRead).toString('utf8');
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function assertOwnerPrivate(stat, label) {
    if ((stat.mode & 0o077) !== 0)
        throw new Error(`The ${label} must be owner-private.`);
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new Error(`The ${label} must be owned by the current user.`);
    }
}
//# sourceMappingURL=export-signature.js.map