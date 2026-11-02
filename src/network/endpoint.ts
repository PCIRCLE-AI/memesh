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

export async function bindEndpoint(iroh: IrohModule, secret: Buffer, relay: string, alpns: string[]): Promise<Endpoint> {
  const builder = iroh.Endpoint.builder();
  // The minimal preset: no third-party discovery. The only servers contacted are the relay named here.
  builder.applyMinimal();
  builder.secretKey(toBytes(secret));
  builder.relayMode(relay === RELAY_OFF ? iroh.RelayMode.disabled() : iroh.RelayMode.customFromUrls([relay]));
  if (alpns.length > 0) builder.alpns(alpns.map((alpn) => toBytes(alpn)));
  return builder.bind();
}
