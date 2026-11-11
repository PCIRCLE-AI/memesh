import { createHmac, timingSafeEqual } from 'node:crypto';
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
//# sourceMappingURL=export-signature.js.map