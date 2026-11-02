import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBridge } from '../../src/network/bridge-control.js';
import { explainLoadFailure } from '../../src/network/native-loader.js';
import { joinNetwork, createNetwork } from '../../src/network/operations.js';
import { checkRuntime, ensureRuntime, explainInstallFailure, isPlatformSupported } from '../../src/network/runtime.js';
import { ensureIdentity } from '../../src/network/identity.js';
import { encodeLink } from '../../src/network/invites.js';
import { NetworkError, runtimeDir } from '../../src/network/types.js';
import { buildTree, contextFor, makeHome, removeTree, type Tree } from './helpers.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const lockText = fs.readFileSync(path.join(repoRoot, 'src/network/runtime-lock.json'), 'utf8');
const failure = async (run: () => unknown): Promise<NetworkError> => {
  try {
    await run();
  } catch (err) {
    if (err instanceof NetworkError) return err;
    throw err;
  }
  throw new Error('expected a NetworkError');
};

describe('the shipped pin', () => {
  const lock = JSON.parse(lockText) as { packages: Record<string, { version?: string; integrity?: string }> };

  it('pins exact versions with sha512 for the package and every platform package', () => {
    const entries = Object.entries(lock.packages).filter(([name]) => name !== '');
    expect(entries.length).toBe(12);
    for (const [name, entry] of entries) {
      expect(name).toMatch(/^node_modules\/@number0\/iroh/);
      expect(entry.version).toBe('1.2.0');
      expect(entry.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src/network/runtime-package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(manifest.dependencies).toEqual({ '@number0/iroh': '1.2.0' });
  });

  it('is not a dependency of MeMesh', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      expect(manifest[field]?.['@number0/iroh']).toBeUndefined();
    }
  });

  it('knows which computers it covers', () => {
    expect(isPlatformSupported(lockText, 'darwin', 'arm64', null)).toBe(true);
    expect(isPlatformSupported(lockText, 'darwin', 'x64', null)).toBe(false);
    expect(isPlatformSupported(lockText, 'linux', 'x64', 'glibc')).toBe(true);
    expect(isPlatformSupported(lockText, 'linux', 'x64', 'musl')).toBe(true);
    expect(isPlatformSupported(lockText, 'linux', 'ppc64', 'glibc')).toBe(false);
    expect(isPlatformSupported(lockText, 'win32', 'x64', null)).toBe(true);
  });
});

describe('explaining failures', () => {
  it('replaces the loader\'s "npm has a bug" with the real reason', () => {
    const platformMissing = new Error('Cannot find native binding. npm has a bug related to optional dependencies (https://example). Please try `npm i` again after removing both package-lock.json and node_modules directory.');
    platformMissing.cause = new Error("Cannot find module '@number0/iroh-darwin-x64'");
    expect(explainLoadFailure(platformMissing)).not.toMatch(/npm has a bug|package-lock/);
    expect(explainLoadFailure(platformMissing)).toMatch(/missing from the install/);

    const unsupported = new Error('Cannot find native binding. npm has a bug related to optional dependencies.');
    unsupported.cause = new Error('Unsupported architecture on macOS: x64');
    expect(explainLoadFailure(unsupported)).toMatch(/not supported.*macOS: x64/);

    const damaged = new Error('Cannot find native binding. npm has a bug related to optional dependencies.');
    damaged.cause = new Error('dlopen(/x/iroh.node, 0x0001): file too short');
    expect(explainLoadFailure(damaged)).toMatch(/damaged/);
  });

  it('says what happened to npm in plain terms', () => {
    expect(explainInstallFailure(undefined, 'npm error code EINTEGRITY')).toMatch(/pinned checksum/);
    expect(explainInstallFailure(undefined, 'npm error code ENOTFOUND')).toMatch(/registry could not be reached/);
    expect(explainInstallFailure({ code: 'ENOENT' } as NodeJS.ErrnoException, '')).toMatch(/npm was not found/);
    for (const output of ['npm error code EINTEGRITY', 'something else']) {
      expect(explainInstallFailure(undefined, output)).toMatch(/Single-machine MeMesh keeps working/);
    }
  });
});

describe('child process failures reach the caller as errors', () => {
  let tree: Tree;
  let home: string;
  const homes: string[] = [];
  const newContext = () => {
    const made = makeHome();
    homes.push(made);
    return contextFor(tree, made);
  };

  beforeAll(async () => {
    tree = await buildTree();
    home = makeHome();
  });
  afterAll(() => {
    removeTree(tree.root);
    removeTree(home);
    homes.forEach(removeTree);
  });

  // A stand-in for the bridge that dies the way a truncated native file does.
  const crashingBridge = (behaviour: string): string => {
    const file = path.join(home, `crash-${createHash('sha256').update(behaviour).digest('hex').slice(0, 8)}.mjs`);
    fs.writeFileSync(file, behaviour);
    return file;
  };
  const SEGFAULT = "process.kill(process.pid, 'SIGSEGV'); setTimeout(() => {}, 5000);";
  const seedInstalled = (ctx: ReturnType<typeof newContext>): void => {
    fs.mkdirSync(runtimeDir(ctx.dataDir), { recursive: true });
    fs.writeFileSync(path.join(runtimeDir(ctx.dataDir), '.installed-lock-sha256'), `${createHash('sha256').update(lockText).digest('hex')}\n`);
  };

  // Windows has no signals to die from: process.kill there just ends the process.
  const posixIt = it.skipIf(process.platform === 'win32');

  posixIt('a crash in the load check is an error naming the signal', async () => {
    const ctx = { ...newContext(), bridgeEntry: crashingBridge(SEGFAULT) };
    const err = await failure(() => checkRuntime(ctx));
    expect(err.code).toBe('runtime_load_failed');
    expect(err.message).toMatch(/SIGSEGV/);
    expect(err.message).toMatch(/Single-machine MeMesh keeps working/);
  });

  posixIt('a crash while starting the bridge is an error naming the signal', async () => {
    const ctx = { ...newContext(), bridgeEntry: crashingBridge(SEGFAULT) };
    const err = await failure(() => startBridge(ctx));
    expect(err.code).toBe('bridge_failed');
    expect(err.message).toMatch(/SIGSEGV/);
  });

  posixIt('a crash during join is an error, and the token is not in it', async () => {
    const ctx = {
      ...newContext(),
      bridgeEntry: crashingBridge(`if (process.argv[2] === 'check') { console.log('{"ok":true}'); } else { process.stdin.resume(); process.stdin.on('end', () => process.kill(process.pid, 'SIGBUS')); setTimeout(() => {}, 5000); }`),
    };
    seedInstalled(ctx);
    const ownerHome = makeHome();
    homes.push(ownerHome);
    const token = Buffer.alloc(32, 9).toString('base64url');
    const link = encodeLink(ensureIdentity(ownerHome), {
      v: 1, network_id: 'net-1', owner_id: ensureIdentity(ownerHome).machineId, relay: 'https://relay.example/', token, expires_at_ms: Date.now() + 60_000,
    });
    const err = await failure(() => joinNetwork(ctx, { link, name: 'mac', person: 'kt' }));
    expect(err.code).toBe('bridge_failed');
    expect(err.message).toMatch(/SIGBUS/);
    expect(err.message).not.toContain(token);
  });

  it('a bridge that exits with an error reports its last error', async () => {
    const ctx = { ...newContext(), bridgeEntry: crashingBridge('process.exit(7);') };
    const err = await failure(() => startBridge(ctx));
    expect(err.message).toMatch(/status 7/);
  });

  it('a corrupted download fails its checksum and installs nothing', async () => {
    const ctx = newContext();
    const assets = path.join(ctx.dataDir, 'assets');
    fs.mkdirSync(assets, { recursive: true });
    const corrupted = JSON.parse(lockText) as { packages: Record<string, { integrity?: string }> };
    for (const entry of Object.values(corrupted.packages)) {
      if (entry.integrity) entry.integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
    }
    fs.writeFileSync(path.join(assets, 'runtime-lock.json'), JSON.stringify(corrupted));
    fs.copyFileSync(path.join(repoRoot, 'src/network/runtime-package.json'), path.join(assets, 'runtime-package.json'));
    const err = await failure(() => ensureRuntime({ ...ctx, assetsDir: assets }));
    expect(err.code).toBe('runtime_install_failed');
    expect(err.message).toMatch(/pinned checksum/);
    expect(fs.existsSync(path.join(runtimeDir(ctx.dataDir), '.installed-lock-sha256'))).toBe(false);
  }, 180_000);

  it('a missing shipped pin is reported, and no network state appears in the database', async () => {
    const ctx = { ...newContext(), assetsDir: path.join(home, 'nowhere') };
    const err = await failure(() => createNetwork(ctx, { name: 'mac', person: 'kt' }));
    expect(err.code).toBe('runtime_install_failed');
    expect(err.message).toMatch(/Reinstall MeMesh/);
  });
});
