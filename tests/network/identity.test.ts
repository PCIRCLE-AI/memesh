import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureIdentity, identityPath, isMachineId, loadIdentity, verifySignature } from '../../src/network/identity.js';
import { NetworkError } from '../../src/network/types.js';
import { makeHome, removeTree } from './helpers.js';

describe('machine identity', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = makeHome(); });
  afterEach(() => removeTree(dataDir));

  it('creates 32 random bytes with mode 0600 and keeps them', () => {
    const first = ensureIdentity(dataDir);
    const stat = fs.statSync(identityPath(dataDir));
    expect(stat.size).toBe(32);
    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600);
    expect(isMachineId(first.machineId)).toBe(true);
    expect(ensureIdentity(dataDir).machineId).toBe(first.machineId);
    expect(loadIdentity(dataDir).secret.equals(first.secret)).toBe(true);
  });

  it('tightens a key file another user could read', () => {
    ensureIdentity(dataDir);
    if (process.platform === 'win32') return;
    fs.chmodSync(identityPath(dataDir), 0o644);
    loadIdentity(dataDir);
    expect(fs.statSync(identityPath(dataDir)).mode & 0o777).toBe(0o600);
  });

  it('refuses a key of the wrong size instead of using it', () => {
    ensureIdentity(dataDir);
    fs.writeFileSync(identityPath(dataDir), Buffer.alloc(31));
    expect(() => loadIdentity(dataDir)).toThrowError(NetworkError);
    expect(() => loadIdentity(dataDir)).toThrowError(/not a valid machine key/);
  });

  it('signs what only its own id verifies', () => {
    const identity = ensureIdentity(dataDir);
    const other = ensureIdentity(makeHome());
    const message = Buffer.from('hello');
    const signature = identity.sign(message);
    expect(verifySignature(identity.machineId, message, signature)).toBe(true);
    expect(verifySignature(identity.machineId, Buffer.from('hellO'), signature)).toBe(false);
    expect(verifySignature(other.machineId, message, signature)).toBe(false);
    expect(verifySignature('not-an-id', message, signature)).toBe(false);
    expect(verifySignature(identity.machineId, message, 'garbage')).toBe(false);
  });
});
