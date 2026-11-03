/**
 * The published package carries an npm-shrinkwrap.json so an unattended update installs exactly the dependency versions
 * the release was tested with (scripts/shrinkwrap.mjs writes it while packing). The unit tests pin what the file may
 * contain; the last two prove the real lockfile can become one, and that packing is wired to do it.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildShrinkwrap, SHRINKWRAP_FILE } from '../scripts/shrinkwrap.mjs';
import { judgeShrinkwrap } from '../src/core/auto-update.js';

const FULL = `sha512-${'A'.repeat(86)}==`; // a whole sha512 digest in base64: 88 characters
const entry = (name: string, version = '1.0.0', extra: Record<string, unknown> = {}) => ({
  version, resolved: `https://registry.npmjs.org/${name}/-/${name.startsWith('@') ? name.split('/')[1] : name}-${version}.tgz`, integrity: FULL, ...extra,
});
const lock = (mutate?: (packages: Record<string, Record<string, unknown>>) => void) => {
  const packages: Record<string, Record<string, unknown>> = {
    '': { name: 'pkg', version: '2.0.0', dependencies: { a: '^1.0.0' }, devDependencies: { d: '^1.0.0' } },
    'node_modules/a': entry('a'),
    'node_modules/d': entry('d', '1.0.0', { dev: true }),
  };
  mutate?.(packages);
  return { name: 'pkg', version: '2.0.0', lockfileVersion: 3, requires: true, packages };
};
const pkg = { name: 'pkg', version: '2.0.0' };

describe('buildShrinkwrap', () => {
  it('keeps the whole tree, dev entries and the root\'s devDependencies included (npm ignores a file that does not match package.json)', () => {
    const built = buildShrinkwrap(lock(), pkg);
    expect(Object.keys(built.packages)).toEqual(['', 'node_modules/a', 'node_modules/d']);
    expect(built.packages[''].devDependencies).toEqual({ d: '^1.0.0' });
    expect(built.version).toBe('2.0.0');
  });

  it.each([
    ['a lockfile for another version', (p: Record<string, Record<string, unknown>>) => { p[''].version = '1.9.0'; }],
    ['an entry without a version', (p: Record<string, Record<string, unknown>>) => { delete p['node_modules/a'].version; }],
    ['an entry without a hash', (p: Record<string, Record<string, unknown>>) => { delete p['node_modules/a'].integrity; }],
    ['an entry from another host', (p: Record<string, Record<string, unknown>>) => { p['node_modules/a'].resolved = 'https://example.com/a.tgz'; }],
    ['an entry from a repository', (p: Record<string, Record<string, unknown>>) => { p['node_modules/a'].resolved = 'git+ssh://example.com/a.git#abc'; }],
    ['a link', (p: Record<string, Record<string, unknown>>) => { p['node_modules/a'] = { resolved: '../a', link: true }; }],
  ])('refuses %s, rather than writing a file that pins less than it claims', (_label, mutate) => {
    expect(() => buildShrinkwrap(lock(mutate), pkg)).toThrow();
  });

  it('refuses an old lockfile format and a lockfile with no package list', () => {
    expect(() => buildShrinkwrap({ ...lock(), lockfileVersion: 1 }, pkg)).toThrow(/lockfileVersion/);
    expect(() => buildShrinkwrap({}, pkg)).toThrow();
    expect(() => buildShrinkwrap(null, pkg)).toThrow();
  });

  it('what it builds is what the updater accepts', () => {
    expect(judgeShrinkwrap(JSON.stringify(buildShrinkwrap(lock(), pkg)), '2.0.0')).toEqual({ ok: true });
  });
});

describe('what each installed entry has to be: the writer and the updater ask the same questions', () => {
  type P = Record<string, Record<string, unknown>>;
  const cases: Array<[string, (p: P) => void, string]> = [
    ['a sha1 hash', (p) => { p['node_modules/a'].integrity = 'sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA='; }, 'a has no full sha512 integrity hash'],
    ['a sha256 hash', (p) => { p['node_modules/a'].integrity = `sha256-${'A'.repeat(43)}=`; }, 'a has no full sha512 integrity hash'],
    ['a truncated sha512 hash', (p) => { p['node_modules/a'].integrity = 'sha512-AAAA'; }, 'a has no full sha512 integrity hash'],
    ['an indirect dependency with no version', (p) => { p['node_modules/a/node_modules/x'] = { resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz', integrity: FULL }; }, 'a/node_modules/x has no pinned version'],
    ['an address that is another package\'s', (p) => { p['node_modules/a'].resolved = 'https://registry.npmjs.org/b/-/b-1.0.0.tgz'; }, 'a is not pinned to its own address'],
    ['an address that is another version\'s', (p) => { p['node_modules/a'].resolved = 'https://registry.npmjs.org/a/-/a-9.9.9.tgz'; }, 'a is not pinned to its own address'],
    ['an address on another host with the right path', (p) => { p['node_modules/a'].resolved = 'https://registry.npmjs.org.evil.test/a/-/a-1.0.0.tgz'; }, 'a is not pinned to its own address'],
    ['no address', (p) => { delete p['node_modules/a'].resolved; }, 'a is not pinned to the npm registry'],
    ['a scoped package at an unscoped address', (p) => { p['node_modules/@s/b'] = entry('@s/b'); p['node_modules/@s/b'].resolved = 'https://registry.npmjs.org/@s/b/-/@s/b-1.0.0.tgz'; }, '@s/b is not pinned to its own address'],
    ['a link', (p) => { p['node_modules/a'] = { resolved: '../a', link: true }; }, 'a has no pinned version'],
  ];
  // The updater also checks that every declared dependency is pinned, before the entries: for a link that is the line it stops at.
  const judgedAs: Record<string, string> = { 'a link': 'npm-shrinkwrap.json does not pin a' };

  it.each(cases)('refuses %s, in both places, naming the entry', (label, mutate, detail) => {
    const l = lock(mutate);
    expect(() => buildShrinkwrap(l, pkg)).toThrow(detail);
    const text = JSON.stringify({ name: l.name, version: l.version, lockfileVersion: 3, packages: l.packages });
    const judged = judgeShrinkwrap(text, '2.0.0') as { ok: boolean; detail: string };
    expect(judged.ok).toBe(false);
    // an address problem ends with the address itself; the rest of the sentence is what is compared
    expect(judged.detail.startsWith(judgedAs[label] ?? detail)).toBe(true);
  });

  it('accepts a scoped package at its own address, an alias at the address of the package it is, and a nested copy', () => {
    const l = lock((p) => {
      p['node_modules/@s/b'] = entry('@s/b', '2.1.0');
      p['node_modules/alias'] = { ...entry('real', '3.0.0'), name: 'real' };
      p['node_modules/a/node_modules/n'] = entry('n', '1.2.3');
    });
    expect(() => buildShrinkwrap(l, pkg)).not.toThrow();
    expect(judgeShrinkwrap(JSON.stringify({ name: l.name, version: l.version, lockfileVersion: 3, packages: l.packages }), '2.0.0')).toEqual({ ok: true });
  });

  it('the real lockfile passes both', () => {
    const real = JSON.parse(fs.readFileSync(path.resolve('package-lock.json'), 'utf8'));
    const realPkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
    const built = buildShrinkwrap(real, realPkg);
    expect(judgeShrinkwrap(JSON.stringify(built), realPkg.version)).toEqual({ ok: true });
  });
});

describe('the script', () => {
  const stage = (lockContents: unknown) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-sw-'));
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(path.resolve('scripts/shrinkwrap.mjs'), path.join(dir, 'scripts', 'shrinkwrap.mjs'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    if (lockContents !== undefined) fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lockContents));
    return dir;
  };
  const run = (dir: string, mode: string) => spawnSync(process.execPath, [path.join(dir, 'scripts', 'shrinkwrap.mjs'), mode], { encoding: 'utf8' });

  it('write creates the file next to package.json, and remove deletes it (and is fine when it is already gone)', () => {
    const dir = stage(lock());
    try {
      const written = run(dir, 'write');
      expect(written.status === 0, written.stderr).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(dir, SHRINKWRAP_FILE), 'utf8')).packages['node_modules/a'].version).toBe('1.0.0');
      expect(run(dir, 'remove').status === 0).toBe(true);
      expect(fs.existsSync(path.join(dir, SHRINKWRAP_FILE))).toBe(false);
      expect(run(dir, 'remove').status === 0).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('write over a leftover file from an earlier pack replaces it and says so', () => {
    const dir = stage(lock());
    try {
      fs.writeFileSync(path.join(dir, SHRINKWRAP_FILE), 'stale');
      const result = run(dir, 'write');
      expect(result.status === 0, result.stderr).toBe(true);
      expect(result.stderr).toContain('replacing a leftover');
      expect(JSON.parse(fs.readFileSync(path.join(dir, SHRINKWRAP_FILE), 'utf8')).version).toBe('2.0.0');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('write fails loudly (non-zero, says why, leaves no file) when the lockfile is missing or cannot pin', () => {
    for (const contents of [undefined, lock((p) => { delete p['node_modules/a'].integrity; })]) {
      const dir = stage(contents);
      try {
        const result = run(dir, 'write');
        expect(result.status === 0).toBe(false);
        expect(result.stderr).toContain('shrinkwrap:');
        expect(fs.existsSync(path.join(dir, SHRINKWRAP_FILE))).toBe(false);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it('an unknown mode is a usage error, not a silent success', () => {
    const dir = stage(lock());
    try { expect(run(dir, 'nonsense').status).toBe(2); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('this repository', () => {
  const read = (name: string) => JSON.parse(fs.readFileSync(name, 'utf8'));

  it('its own lockfile can become the shrinkwrap, and the updater accepts the result', () => {
    const built = buildShrinkwrap(read('package-lock.json'), read('package.json'));
    expect(Object.keys(built.packages).length).toBeGreaterThan(50);
    expect(judgeShrinkwrap(JSON.stringify(built), read('package.json').version)).toEqual({ ok: true });
  });

  it('packing writes and removes it, ships it, and git ignores it', () => {
    const manifest = read('package.json');
    expect(manifest.scripts.prepack).toBe('node scripts/shrinkwrap.mjs write');
    expect(manifest.scripts.postpack).toBe('node scripts/shrinkwrap.mjs remove');
    expect(manifest.files).toContain('npm-shrinkwrap.json'); // npm leaves it out of the tarball otherwise
    // Neither a compiled Python cache directory nor a stray .pyc of the Hermes provider is packed.
    expect(manifest.files).toContain('!extensions/hermes-memesh/**/__pycache__');
    expect(manifest.files).toContain('!extensions/hermes-memesh/**/*.pyc');
    expect(fs.readFileSync('.gitignore', 'utf8').split('\n')).toContain('/npm-shrinkwrap.json'); // at the root only: a nested file of that name is not ours to hide
    expect(manifest.scripts.preinstall ?? manifest.scripts.install ?? manifest.scripts.postinstall).toBeUndefined();
  });
});
