#!/usr/bin/env node
// Writes (prepack) and removes (postpack) the `npm-shrinkwrap.json` that ships inside the published package.
//
// Why: an unattended update installs the package on the owner's machine, and npm resolves the package's dependencies
// at that moment from whatever the registry answers that day. A published npm-shrinkwrap.json makes the release itself
// decide every version, with a hash for each. The file is package-lock.json (the same tree the tests ran against), kept
// whole: npm checks it against package.json, dev dependencies included, and ignores one that does not match. It exists
// only while the package is being packed and is never committed, because npm would then prefer it over
// package-lock.json for every checkout.
//
//   node scripts/shrinkwrap.mjs write    (npm "prepack")
//   node scripts/shrinkwrap.mjs remove   (npm "postpack")
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHRINKWRAP_FILE = 'npm-shrinkwrap.json';

/** A full sha512 digest in base64 (64 bytes = 88 characters ending in ==). sha1 and the shorter hashes are not accepted. */
export const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;

/** The registry address npm gives a package version: the name, then `-/<last part of the name>-<version>.tgz`. */
export function registryTarballUrl(name, version) {
  const last = name.startsWith('@') ? name.split('/')[1] : name;
  return `https://registry.npmjs.org/${name}/-/${last}-${version}.tgz`;
}

/** The package an entry of the lockfile is: its own `name` when it is an alias, else the part of the key after the last node_modules/. */
export function entryName(key, entry) {
  return typeof entry.name === 'string' ? entry.name : key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

/** What is wrong with one installed entry, or null. The same questions are asked by the updater (judgeShrinkwrap). */
export function entryProblem(key, entry) {
  const where = key.replace(/^node_modules\//, '');
  if (entry === null || typeof entry !== 'object' || typeof entry.version !== 'string') return `${where} has no pinned version`;
  if (typeof entry.resolved !== 'string') return `${where} is not pinned to the npm registry`;
  if (entry.resolved !== registryTarballUrl(entryName(key, entry), entry.version)) return `${where} is not pinned to its own address on the npm registry (${entry.resolved})`;
  if (typeof entry.integrity !== 'string' || !SHA512_INTEGRITY.test(entry.integrity)) return `${where} has no full sha512 integrity hash`;
  return null;
}

/**
 * The shrinkwrap for `pkg` from its lockfile. Throws (never returns a partial file) when the lockfile cannot pin the
 * tree: wrong version, a hash that is not a full sha512, an address that is not the package's own on the npm registry, or a link.
 */
export function buildShrinkwrap(lock, pkg) {
  if (!lock || typeof lock !== 'object' || !lock.packages || typeof lock.packages !== 'object') throw new Error('package-lock.json has no package list');
  if (!(lock.lockfileVersion >= 2)) throw new Error(`package-lock.json is lockfileVersion ${lock.lockfileVersion}; 2 or newer is needed`);
  const root = lock.packages[''];
  if (!root || root.version !== pkg.version) throw new Error(`package-lock.json is for version ${root?.version}, package.json says ${pkg.version}: run npm install`);
  const packages = {};
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '') { packages[''] = entry; continue; }
    // A link has no version, so it is refused here with the rest.
    const problem = entryProblem(key, entry);
    if (problem) throw new Error(problem);
    packages[key] = entry;
  }
  return { name: lock.name, version: lock.version, lockfileVersion: lock.lockfileVersion, requires: lock.requires, packages };
}

function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const target = path.join(root, SHRINKWRAP_FILE);
  const mode = argv[2];
  if (mode === 'remove') { fs.rmSync(target, { force: true }); return 0; }
  if (mode !== 'write') { console.error('usage: shrinkwrap.mjs write|remove'); return 2; }
  const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  try {
    // A file here before this run is what an earlier pack left (it died before postpack): it is replaced, and said.
    if (fs.existsSync(target)) console.error(`shrinkwrap: replacing a leftover ${SHRINKWRAP_FILE} from an earlier pack`);
    fs.writeFileSync(target, `${JSON.stringify(buildShrinkwrap(read('package-lock.json'), read('package.json')), null, 2)}\n`);
    return 0;
  } catch (err) {
    console.error(`shrinkwrap: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// realpath on both sides: a temp directory reached through a symlink (macOS /var → /private/var) must still count as this file.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv);
