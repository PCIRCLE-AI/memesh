import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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

const MAX_ROUTER_TOKEN_FILE_BYTES = 8 * 1024;
const SECURE_LOCAL_HOST_RUNTIME_UNSUPPORTED =
  'The secure local host runtime is not supported on Windows.';

function assertSecureLocalHostRuntimeSupported(): void {
  if (process.platform === 'win32') {
    throw new Error(SECURE_LOCAL_HOST_RUNTIME_UNSUPPORTED);
  }
}

function readTokenFile(tokenFile: unknown): string {
  const file = requiredString(tokenFile, 'token_file');
  return requiredString(readOwnerPrivateFile(
    file,
    'router token file',
    MAX_ROUTER_TOKEN_FILE_BYTES,
  ).trim(), 'router token');
}

function ensureRouterTokenFile(tokenFile: string): string {
  assertSecureLocalHostRuntimeSupported();
  try {
    fs.writeFileSync(tokenFile, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return readTokenFile(tokenFile);
}

/**
 * The key that signs `memesh export` files, derived from this folder's own
 * existing owner-private secret (never exported) so the token itself is never
 * used as a signing key. Throws when the folder has no usable token, or on a
 * platform without the secure host runtime; `create` makes the token if absent.
 */
export function exportSigningKey(dataDir: string, options: { create: boolean }): Buffer {
  const tokenFile = path.join(dataDir, 'agent-router.token');
  const token = options.create ? ensureRouterTokenFile(tokenFile) : readTokenFile(tokenFile);
  return createHmac('sha256', token).update('memesh-export-signature-v1').digest();
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 4096) {
    throw new Error(`${field} must be a bounded non-empty string.`);
  }
  return value;
}

function readOwnerPrivateFile(file: string, label: string, maxBytes: number): string {
  assertSecureLocalHostRuntimeSupported();
  if (typeof fs.constants.O_NOFOLLOW !== 'number') {
    throw new Error(`This platform cannot safely reject a symlink ${label}.`);
  }

  const descriptor = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`The ${label} must be an owner-private regular file.`);
    assertOwnerPrivate(stat, label);
    if (stat.size > maxBytes) throw new Error(`The ${label} exceeds its ${maxBytes}-byte limit.`);

    const content = Buffer.allocUnsafe(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < content.length) {
      const chunkBytes = fs.readSync(
        descriptor,
        content,
        bytesRead,
        content.length - bytesRead,
        null,
      );
      if (chunkBytes === 0) break;
      bytesRead += chunkBytes;
    }
    if (bytesRead > maxBytes) throw new Error(`The ${label} exceeds its ${maxBytes}-byte limit.`);
    return content.subarray(0, bytesRead).toString('utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertOwnerPrivate(stat: fs.Stats, label: string): void {
  if ((stat.mode & 0o077) !== 0) throw new Error(`The ${label} must be owner-private.`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`The ${label} must be owned by the current user.`);
  }
}
