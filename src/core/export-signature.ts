import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A `memesh export` file carries an HMAC of its own content, keyed by a secret
 * that never leaves the folder it was exported from. `memesh import` trusts the
 * file only when the signature verifies against this folder's secret: the file
 * came from here and was not changed since. A file with no signature, a wrong
 * one, or one signed elsewhere stays untrusted.
 */
export interface ExportSignature {
  alg: 'hmac-sha256';
  mac: string;
}

export type ExportSignatureStatus = 'valid' | 'invalid' | 'absent';

/** The signed text: the bundle without its `signature`, serialized once, key order kept. */
function signedText(bundle: Record<string, unknown>): string {
  const { signature: _signature, ...content } = bundle;
  return JSON.stringify(content);
}

export function signExport(bundle: Record<string, unknown>, key: Buffer): ExportSignature {
  return { alg: 'hmac-sha256', mac: createHmac('sha256', key).update(signedText(bundle)).digest('hex') };
}

export function verifyExport(data: unknown, key: Buffer): ExportSignatureStatus {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return 'absent';
  const bundle = data as Record<string, unknown>;
  if (!Object.hasOwn(bundle, 'signature')) return 'absent';
  const claimed = bundle.signature as { alg?: unknown; mac?: unknown } | null;
  if (typeof claimed !== 'object' || claimed === null || claimed.alg !== 'hmac-sha256'
    || typeof claimed.mac !== 'string' || !/^[0-9a-f]{64}$/.test(claimed.mac)) return 'invalid';
  const expected = Buffer.from(signExport(bundle, key).mac, 'hex');
  return timingSafeEqual(expected, Buffer.from(claimed.mac, 'hex')) ? 'valid' : 'invalid';
}
