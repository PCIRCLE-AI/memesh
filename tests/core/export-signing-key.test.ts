import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportSigningKey, signExport, verifyExport } from '../../src/core/export-signature.js';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(content = 'synthetic-export-compat\n') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-export-key-'));
  directories.push(dir);
  const file = path.join(dir, 'agent-router.token');
  fs.writeFileSync(file, content, { mode: 0o600 });
  return { dir, file };
}

describe.skipIf(process.platform === 'win32')('owner-private export signing key', () => {
  it('keeps the existing filename, derivation and secret unchanged', () => {
    const { dir, file } = fixture();
    const before = fs.readFileSync(file);
    const key = exportSigningKey(dir, { create: false });
    expect(key.toString('hex')).toBe('a781fdca65e2e432892abc9b6515d8e4fe7c2f67d0deebdd65063c2b321e3c82');
    expect(exportSigningKey(dir, { create: true })).toEqual(key);
    expect(fs.readFileSync(file)).toEqual(before);
    const bundle = { entities: [{ name: 'compatibility fixture' }] };
    expect(verifyExport({ ...bundle, signature: signExport(bundle, key) }, key)).toBe('valid');
  });

  it('creates one private secret only when requested and reuses it', () => {
    const { dir, file } = fixture();
    fs.unlinkSync(file);
    expect(() => exportSigningKey(dir, { create: false })).toThrow();
    expect(fs.existsSync(file)).toBe(false);
    const key = exportSigningKey(dir, { create: true });
    expect(fs.readFileSync(file, 'utf8')).toMatch(/^[0-9a-f]{64}\n$/);
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect(exportSigningKey(dir, { create: true })).toEqual(key);
  });

  it('rejects a symlink without changing its target', () => {
    const { dir, file } = fixture();
    const target = path.join(dir, 'synthetic-target');
    fs.renameSync(file, target);
    fs.symlinkSync(target, file);
    expect(() => exportSigningKey(dir, { create: false })).toThrow();
    expect(() => exportSigningKey(dir, { create: true })).toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('synthetic-export-compat\n');
  });

  it.each([0o640, 0o604])('rejects group/other-readable secrets (%s)', mode => {
    const { dir, file } = fixture();
    fs.chmodSync(file, mode);
    expect(() => exportSigningKey(dir, { create: false })).toThrow(/owner-private/);
  });

  it('rejects a directory at the secret path', () => {
    const { dir, file } = fixture();
    fs.unlinkSync(file);
    fs.mkdirSync(file, { mode: 0o700 });
    expect(() => exportSigningKey(dir, { create: false })).toThrow(/regular file/);
  });

  it('rejects a secret owned by another uid', () => {
    const { dir } = fixture();
    const uid = process.getuid!();
    vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    expect(() => exportSigningKey(dir, { create: false })).toThrow(/owned by the current user/);
  });

  it('bounds reads and rejects an empty secret', () => {
    const { dir, file } = fixture('x'.repeat(8 * 1024 + 1));
    expect(() => exportSigningKey(dir, { create: false })).toThrow(/byte limit/);
    fs.writeFileSync(file, '\n');
    expect(() => exportSigningKey(dir, { create: false })).toThrow(/non-empty/);
  });
});

it.runIf(process.platform === 'win32')('refuses unsupported signing before creating the secret', () => {
  const { dir, file } = fixture();
  fs.unlinkSync(file);
  expect(() => exportSigningKey(dir, { create: true })).toThrow(/not supported on Windows/);
  expect(fs.existsSync(file)).toBe(false);
});
