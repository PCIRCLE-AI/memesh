import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('creates the key file with mode 0600 before anything could read it', () => {
    const writes = vi.spyOn(fs, 'writeFileSync');
    const modes = vi.spyOn(fs, 'chmodSync');
    try {
      ensureIdentity(dataDir);
      const temporaryWrite = writes.mock.calls.find(([file]) => String(file).includes('identity.key.tmp-'));
      expect(temporaryWrite?.[2]).toMatchObject({ mode: 0o600, flag: 'wx' });
      expect(modes.mock.calls.some(([file, mode]) => String(file).includes('identity.key.tmp-') && mode === 0o600)).toBe(true);
    } finally {
      writes.mockRestore();
      modes.mockRestore();
    }
  });

  it('makes the network folder private even under an open umask', () => {
    if (process.platform === 'win32') return;
    const previous = process.umask(0);
    try {
      ensureIdentity(dataDir);
    } finally {
      process.umask(previous);
    }
    expect(fs.statSync(path.join(dataDir, 'network')).mode & 0o777).toBe(0o700);
  });

  it('refuses a key that is too long as well as too short', () => {
    ensureIdentity(dataDir);
    fs.writeFileSync(identityPath(dataDir), Buffer.alloc(33));
    expect(() => loadIdentity(dataDir)).toThrowError(expect.objectContaining({ code: 'identity_invalid' }));
  });

  it('says a machine with no key has not joined', () => {
    expect(() => loadIdentity(dataDir)).toThrowError(expect.objectContaining({ code: 'not_joined' }));
  });

  it('never replaces a damaged key: that would silently change the machine\'s identity', () => {
    ensureIdentity(dataDir);
    const damaged = Buffer.alloc(31, 5);
    fs.writeFileSync(identityPath(dataDir), damaged);
    expect(() => ensureIdentity(dataDir)).toThrowError(expect.objectContaining({ code: 'identity_invalid' }));
    expect(fs.readFileSync(identityPath(dataDir)).equals(damaged)).toBe(true);
  });

  it('a signature that does not check out under a well-formed id is a false', () => {
    const identity = ensureIdentity(dataDir);
    const message = Buffer.from('m');
    expect(verifySignature('f'.repeat(64), message, identity.sign(message))).toBe(false);
    expect(verifySignature('e'.repeat(64), message, 'A'.repeat(86))).toBe(false);
  });

  it('concurrent creators all end up with one key', async () => {
    const bundle = path.join(dataDir, 'creator.mjs');
    await build({
      entryPoints: [path.resolve(import.meta.dirname, 'fixtures/create-identity.ts')],
      outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    });
    for (let round = 0; round < 5; round++) {
      const target = path.join(dataDir, `round-${round}`);
      const ids = await Promise.all(Array.from({ length: 8 }, () => new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, [bundle, target], { stdio: ['ignore', 'pipe', 'inherit'] });
        let output = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
        child.on('close', (code) => (code === 0 ? resolve(output.trim()) : reject(new Error(`creator exited ${code}`))));
      })));
      expect(new Set(ids).size).toBe(1);
    }
  }, 60_000);

  it('signs what only its own id verifies', () => {
    const identity = ensureIdentity(dataDir);
    const otherHome = makeHome();
    const other = ensureIdentity(otherHome);
    removeTree(otherHome);
    const message = Buffer.from('hello');
    const signature = identity.sign(message);
    expect(verifySignature(identity.machineId, message, signature)).toBe(true);
    expect(verifySignature(identity.machineId, Buffer.from('hellO'), signature)).toBe(false);
    expect(verifySignature(other.machineId, message, signature)).toBe(false);
    expect(verifySignature('not-an-id', message, signature)).toBe(false);
    expect(verifySignature(identity.machineId, message, 'garbage')).toBe(false);
  });
});
