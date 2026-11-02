import { RELAY_OFF } from './types.js';
export function toBytes(value) {
    return Array.from(typeof value === 'string' ? Buffer.from(value) : value);
}
export function deadline(promise, ms, label) {
    let timer;
    const expired = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    });
    return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}
export async function bindEndpoint(iroh, secret, relay, alpns) {
    const builder = iroh.Endpoint.builder();
    builder.applyMinimal();
    builder.secretKey(toBytes(secret));
    builder.relayMode(relay === RELAY_OFF ? iroh.RelayMode.disabled() : iroh.RelayMode.customFromUrls([relay]));
    if (alpns.length > 0)
        builder.alpns(alpns.map((alpn) => toBytes(alpn)));
    return builder.bind();
}
//# sourceMappingURL=endpoint.js.map