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
export const TEST_BIND_VARIABLE = 'MEMESH_TEST_NETWORK_BIND';
export function testBindAddress(value) {
    if (value === undefined || value === '')
        return null;
    const match = /^(?:(\d{1,3}(?:\.\d{1,3}){3})|\[([0-9A-Fa-f:]+)\]):(\d{1,5})$/.exec(value);
    const octetsOk = match?.[1] === undefined || match[1].split('.').every((octet) => Number(octet) <= 255);
    if (!match || !octetsOk || Number(match[3]) > 65_535) {
        throw new Error(`${TEST_BIND_VARIABLE} must be an IP address and port such as 127.0.0.1:0, not ${JSON.stringify(value.slice(0, 80))}; the bridge did not start.`);
    }
    return value;
}
export function advertisedAddresses(endpoint, env = process.env) {
    return testBindAddress(env[TEST_BIND_VARIABLE]) === null ? endpoint.addr().directAddresses() : [];
}
export async function bindEndpoint(iroh, secret, relay, alpns, env = process.env) {
    const bindAddress = testBindAddress(env[TEST_BIND_VARIABLE]);
    const builder = iroh.Endpoint.builder();
    builder.applyMinimal();
    builder.secretKey(toBytes(secret));
    builder.relayMode(relay === RELAY_OFF ? iroh.RelayMode.disabled() : iroh.RelayMode.customFromUrls([relay]));
    if (alpns.length > 0)
        builder.alpns(alpns.map((alpn) => toBytes(alpn)));
    if (bindAddress !== null)
        builder.bindAddr(bindAddress);
    return builder.bind();
}
//# sourceMappingURL=endpoint.js.map