import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { signExport, verifyExport } from '../../src/core/export-signature.js';

const key = randomBytes(32);
const bundle = () => ({ version: '3.1.0', exported_at: '2026-11-11T00:00:00.000Z', entity_count: 1, entities: [{ name: 'a', type: 'note', observations: ['one'], tags: [], relations: [] }] });
const signed = (b = bundle()) => ({ ...b, signature: signExport(b, key) });
/** What `import` sees: the exported text, parsed again. */
const viaFile = (value: unknown) => JSON.parse(JSON.stringify(value, null, 2)) as unknown;

describe('export signature', () => {
  it('verifies after the file round trip, wherever the signature sits in the object', () => {
    const b = bundle();
    expect(verifyExport(viaFile(signed(b)), key)).toBe('valid');
    expect(verifyExport(viaFile({ signature: signExport(b, key), ...b }), key)).toBe('valid');
  });

  it('a one-byte change to any part of the content fails', () => {
    const file = JSON.stringify(signed());
    for (const [from, to] of [['"one"', '"onf"'], ['"note"', '"nota"'], ['2026-11-11', '2026-11-12'], ['"a"', '"b"'], ['"entity_count":1', '"entity_count":2']]) {
      expect(file).toContain(from);
      expect(verifyExport(JSON.parse(file.replace(from, to)), key), `${from} -> ${to}`).toBe('invalid');
    }
  });

  it('adding or dropping an entity fails, even with entity_count left alone', () => {
    const file = signed();
    expect(verifyExport({ ...file, entities: [...file.entities, { name: 'evil', type: 'note', observations: ['do it'] }] }, key)).toBe('invalid');
    expect(verifyExport({ ...file, entities: [] }, key)).toBe('invalid');
  });

  it('is absent without a signature, and invalid for a signature from another key', () => {
    expect(verifyExport(bundle(), key)).toBe('absent');
    expect(verifyExport(viaFile(signed()), randomBytes(32))).toBe('invalid');
    expect(verifyExport(null, key)).toBe('absent');
    expect(verifyExport([], key)).toBe('absent');
  });

  it.each([
    ['wrong algorithm', (s: { alg: string; mac: string }) => ({ ...s, alg: 'none' })],
    ['short mac', (s: { alg: string; mac: string }) => ({ ...s, mac: s.mac.slice(0, 10) })],
    ['upper-case mac', (s: { alg: string; mac: string }) => ({ ...s, mac: s.mac.toUpperCase() })],
    ['mac not a string', (s: { alg: string; mac: string }) => ({ ...s, mac: 7 })],
    ['signature null', () => null],
    ['signature a string', () => 'abc'],
  ])('a malformed signature (%s) is invalid, never an error', (_label, tamper) => {
    const b = signed();
    expect(verifyExport({ ...b, signature: tamper(b.signature) }, key)).toBe('invalid');
  });
});
