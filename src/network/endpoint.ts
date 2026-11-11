// Small helpers the bridge's two roles share. Only ever loaded in the child.

import type { Endpoint, IrohModule } from './iroh-types.js';
import { RELAY_OFF } from './types.js';

export function toBytes(value: string | Buffer): number[] {
  return Array.from(typeof value === 'string' ? Buffer.from(value) : value);
}

/**
 * Bound a native call. `online()` never settles while the relay is unreachable
 * and connect takes 30 s to give up, so nothing here may wait on one unguarded.
 * The losing promise keeps running; its later result is ignored, not unhandled.
 */
export function deadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/**
 * TEST HOOK, off unless MEMESH_TEST_NETWORK_BIND is set: bind to that one address
 * (`127.0.0.1:0`, `[::1]:0`) and advertise no direct addresses, so the relay is the
 * only path between two bridges on one machine. Unset changes nothing. A value of
 * any other shape is refused, never silently ignored: a test that meant to force
 * the relay must not pass over a direct path.
 */
export const TEST_BIND_VARIABLE = 'MEMESH_TEST_NETWORK_BIND';

export function testBindAddress(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  const match = /^(?:(\d{1,3}(?:\.\d{1,3}){3})|\[([0-9A-Fa-f:]+)\]):(\d{1,5})$/.exec(value);
  const octetsOk = match?.[1] === undefined || match[1].split('.').every((octet) => Number(octet) <= 255);
  if (!match || !octetsOk || Number(match[3]) > 65_535) {
    throw new Error(`${TEST_BIND_VARIABLE} must be an IP address and port such as 127.0.0.1:0, not ${JSON.stringify(value.slice(0, 80))}; the bridge did not start.`);
  }
  return value;
}

/** The direct addresses to tell others about: none while the test bind hook is on. */
export function advertisedAddresses(endpoint: Endpoint, env: NodeJS.ProcessEnv = process.env): string[] {
  return testBindAddress(env[TEST_BIND_VARIABLE]) === null ? endpoint.addr().directAddresses() : [];
}

export async function bindEndpoint(
  iroh: IrohModule, secret: Buffer, relay: string, alpns: string[], env: NodeJS.ProcessEnv = process.env,
): Promise<Endpoint> {
  const bindAddress = testBindAddress(env[TEST_BIND_VARIABLE]);
  const builder = iroh.Endpoint.builder();
  // The minimal preset: no third-party discovery. The only servers contacted are the relay named here.
  builder.applyMinimal();
  builder.secretKey(toBytes(secret));
  builder.relayMode(relay === RELAY_OFF ? iroh.RelayMode.disabled() : iroh.RelayMode.customFromUrls([relay]));
  if (alpns.length > 0) builder.alpns(alpns.map((alpn) => toBytes(alpn)));
  if (bindAddress !== null) builder.bindAddr(bindAddress);
  return builder.bind();
}
