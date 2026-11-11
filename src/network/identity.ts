// This machine's key: 32 random bytes that are at once the transport secret key
// and the ed25519 seed used for roster and link signatures. The transport's
// endpoint id is the hex of the public key, so a machine id is verifiable with
// node:crypto alone and the native package is never needed to check a signature.

import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { removeGroupAndOtherAccess } from '../core/file-mode.js';
import { NetworkError, networkDir } from './types.js';

const SEED_BYTES = 32;
// DER prefixes wrapping a raw ed25519 seed (PKCS#8) and public key (SPKI).
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MACHINE_ID = /^[0-9a-f]{64}$/;

export interface Identity {
  secret: Buffer;
  machineId: string;
  /** Base64url ed25519 signature over `message`. */
  sign(message: Buffer): string;
}

export function isMachineId(value: unknown): value is string {
  return typeof value === 'string' && MACHINE_ID.test(value);
}

export function identityPath(dataDir: string): string {
  return path.join(networkDir(dataDir), 'identity.key');
}

/** Make `<data dir>/network` private. Creating it is what marks this data dir as opted in. */
export function ensureNetworkDir(dataDir: string): string {
  const dir = networkDir(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  removeGroupAndOtherAccess(dir);
  return dir;
}

function identityFromSeed(secret: Buffer): Identity {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, secret]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return {
    secret,
    machineId: spki.subarray(-SEED_BYTES).toString('hex'),
    sign: (message) => sign(null, message, privateKey).toString('base64url'),
  };
}

export function loadIdentity(dataDir: string): Identity {
  const file = identityPath(dataDir);
  let secret: Buffer;
  try {
    secret = fs.readFileSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new NetworkError(
      code === 'ENOENT' ? 'not_joined' : 'identity_invalid',
      code === 'ENOENT' ? 'This machine has not joined a network.' : `Cannot read ${file} (${code}).`,
    );
  }
  if (secret.length !== SEED_BYTES) {
    throw new NetworkError('identity_invalid', `${file} is not a valid machine key (${secret.length} bytes, expected ${SEED_BYTES}).`);
  }
  removeGroupAndOtherAccess(file);
  return identityFromSeed(secret);
}

/**
 * Load the key, or create it. Written beside its final name and linked into
 * place, so a concurrent reader never sees a partial key and two concurrent
 * creators agree on one.
 */
export function ensureIdentity(dataDir: string): Identity {
  ensureNetworkDir(dataDir);
  const file = identityPath(dataDir);
  if (!fs.existsSync(file)) {
    const temporary = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, randomBytes(SEED_BYTES), { mode: 0o600, flag: 'wx' });
    try {
      fs.chmodSync(temporary, 0o600);
      fs.linkSync(temporary, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  return loadIdentity(dataDir);
}

/** True only for a valid signature by `machineId`. Bad input is a false, never a throw. */
export function verifySignature(machineId: string, message: Buffer, signature: string): boolean {
  if (!isMachineId(machineId) || typeof signature !== 'string') return false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(machineId, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, message, publicKey, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}
