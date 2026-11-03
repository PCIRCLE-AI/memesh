import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBridge } from '../../src/network/bridge-control.js';
import { ensureIdentity } from '../../src/network/identity.js';
import { encodeLink } from '../../src/network/invites.js';
import { explainLoadFailure } from '../../src/network/native-loader.js';
import { createNetwork, joinNetwork, runJoinChild } from '../../src/network/operations.js';
import { currentLibc, platformPackages } from '../../src/network/runtime-platform.js';
import { checkRuntime, ensureRuntime, explainInstallFailure, isPlatformSupported } from '../../src/network/runtime.js';
import { openNetworkStore, readConfig } from '../../src/network/store.js';
import { NetworkError, childEnv, runtimeDir } from '../../src/network/types.js';
import { buildTree, contextFor, makeHome, removeTree, type Tree } from './helpers.js';
import { startRegistry, type Registry } from './local-registry.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const lockText = fs.readFileSync(path.join(repoRoot, 'src/network/runtime-lock.json'), 'utf8');
const PLATFORM_SUPPORTED = isPlatformSupported(lockText, process.platform, process.arch, currentLibc());
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

describe.skipIf(process.platform === 'win32' || !PLATFORM_SUPPORTED)('child process failures reach the caller as errors', () => {
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
  const signedLink = (token: string): string => {
    const ownerHome = makeHome();
    homes.push(ownerHome);
    const owner = ensureIdentity(ownerHome);
    return encodeLink(owner, {
      v: 1, network_id: '0123456789abcdef0123456789abcdef', owner_id: owner.machineId, relay: 'https://relay.example/', token, expires_at_ms: Date.now() + 60_000,
    });
  };
  const TOKEN = Buffer.alloc(32, 9).toString('base64url');

  it('a crash in the load check is an error naming the signal', async () => {
    const ctx = { ...newContext(), bridgeEntry: crashingBridge(SEGFAULT) };
    const err = await failure(() => checkRuntime(ctx));
    expect(err.code).toBe('runtime_load_failed');
    expect(err.message).toMatch(/SIGSEGV/);
    expect(err.message).toMatch(/Single-machine MeMesh keeps working/);
  });

  it('a load check that times out says so, and does not blame the file', async () => {
    const ctx = { ...newContext(), bridgeEntry: crashingBridge('setTimeout(() => {}, 20000);') };
    const err = await failure(() => checkRuntime(ctx, 300));
    expect(err.code).toBe('runtime_load_failed');
    expect(err.message).toMatch(/did not finish/);
    expect(err.message).not.toMatch(/damaged/);
  });

  it('a crash while starting the bridge is an error naming the signal', async () => {
    const ctx = { ...newContext(), bridgeEntry: crashingBridge(SEGFAULT) };
    const err = await failure(() => startBridge(ctx));
    expect(err.code).toBe('bridge_failed');
    expect(err.message).toMatch(/SIGSEGV/);
    expect(err.message).toMatch(/up --reinstall/);
  });

  it('a crash during join is an error without the token or advice a joining machine cannot follow', async () => {
    const ctx = {
      ...newContext(),
      bridgeEntry: crashingBridge(`if (process.argv[2] === 'check') { console.log('{"ok":true}'); } else { process.stdin.resume(); process.stdin.on('end', () => process.kill(process.pid, 'SIGBUS')); setTimeout(() => {}, 5000); }`),
    };
    seedInstalled(ctx);
    const err = await failure(() => joinNetwork(ctx, { link: signedLink(TOKEN), name: 'mac', person: 'kt' }));
    expect(err.code).toBe('bridge_failed');
    expect(err.message).toMatch(/SIGBUS/);
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toMatch(/--reinstall/);
  });

  it('the token reaches the child on stdin and is in no child argv', async () => {
    const log = path.join(home, 'child-argv.json');
    const ctx = {
      ...newContext(),
      bridgeEntry: crashingBridge(`
import fs from 'node:fs';
if (process.argv[2] === 'check') { console.log('{"ok":true}'); process.exit(0); }
let input = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv, input }));
  console.log(JSON.stringify({ ok: false, code: 'owner_unreachable', detail: 'probe', relay_reached: null }));
});`),
    };
    seedInstalled(ctx);
    const err = await failure(() => joinNetwork(ctx, { link: signedLink(TOKEN), name: 'mac', person: 'kt' }));
    expect(err.code).toBe('owner_unreachable');
    const seen = JSON.parse(fs.readFileSync(log, 'utf8')) as { argv: string[]; input: string };
    expect(seen.input).toContain(TOKEN);
    expect(seen.argv.join(' ')).not.toContain(TOKEN);
  });

  it('a child that goes past the deadline is reported as a timeout, not as damage', async () => {
    const ctx = { ...newContext(), bridgeEntry: crashingBridge('process.stdin.resume(); setTimeout(() => {}, 20000);') };
    const err = await failure(() => runJoinChild(ctx, {
      request: { network_id: 'x', token: TOKEN, name: 'mac', person: 'kt' }, owner_id: 'x', owner_relay: null, owner_addrs: [], own_relay: 'off',
    }, 300));
    expect(err.code).toBe('join_timed_out');
    expect(err.message).toMatch(/did not finish/);
    expect(err.message).toMatch(/same link is safe/);
    expect(err.message).not.toMatch(/damaged|--reinstall/);
  });

  it('a bridge that exits with an error reports its status and its own last error', async () => {
    const ctx = {
      ...newContext(),
      bridgeEntry: crashingBridge(`
import fs from 'node:fs';
import path from 'node:path';
const dir = path.join(process.argv[3], 'network');
fs.writeFileSync(path.join(dir, 'bridge-status.json'), JSON.stringify({ pid: process.pid, state: 'failed', last_error: 'the actual reason' }));
process.exit(7);`),
    };
    const err = await failure(() => startBridge(ctx));
    expect(err.message).toMatch(/status 7/);
    expect(err.message).toMatch(/the actual reason/);
  });

  it('the child environment cannot point the loader elsewhere', () => {
    const env = childEnv({ ...newContext(), env: { KEEP: '1', NODE_PATH: '/x', node_path: '/y', NAPI_RS_NATIVE_LIBRARY_PATH: '/z', NAPI_RS_FORCE_WASI: '1' } });
    expect(Object.keys(env).sort()).toEqual(['KEEP', 'MEMESH_DB_PATH', 'MEMESH_DIR']);
  });

  it('a missing shipped pin is reported, and a machine with nothing keeps nothing', async () => {
    const ctx = { ...newContext(), assetsDir: path.join(home, 'nowhere') };
    const err = await failure(() => createNetwork(ctx, { name: 'mac', person: 'kt' }));
    expect(err.code).toBe('runtime_install_failed');
    expect(err.message).toMatch(/Reinstall MeMesh/);
    expect(fs.existsSync(ctx.dataDir)).toBe(false);
  });

  describe('installing, against a local registry', () => {
    let registry: Registry;
    const platformKey = (): string => platformPackages(lockText, process.platform, process.arch, currentLibc())[0];

    beforeAll(async () => { registry = await startRegistry(platformKey()); });
    afterAll(() => registry.close());

    const installContext = (lock: string, extraEnv: Record<string, string> = {}) => {
      const ctx = newContext();
      const assets = fs.mkdtempSync(path.join(home, 'assets-'));
      fs.writeFileSync(path.join(assets, 'runtime-lock.json'), lock);
      fs.copyFileSync(path.join(repoRoot, 'src/network/runtime-package.json'), path.join(assets, 'runtime-package.json'));
      return {
        ...ctx,
        assetsDir: assets,
        env: { ...ctx.env, HOME: ctx.env?.HOME as string, npm_config_registry: registry.url, npm_config_fetch_retries: '0', npm_config_cache: path.join(home, 'npm-cache'), ...extraEnv },
      };
    };
    const markerOf = (ctx: { dataDir: string }): string => path.join(runtimeDir(ctx.dataDir), '.installed-lock-sha256');

    it('a good download installs, with scripts off, even under omit=optional', async () => {
      registry.serve('good');
      const ctx = installContext(registry.lockWith({ wrapper: true, platform: true }), { npm_config_omit: 'optional' });
      ensureRuntime(ctx);
      expect(fs.existsSync(markerOf(ctx))).toBe(true);
      expect(fs.existsSync(path.join(runtimeDir(ctx.dataDir), 'node_modules', platformKey()))).toBe(true);
      expect(fs.existsSync(path.join(ctx.env.HOME as string, 'POSTINSTALL-RAN'))).toBe(false);
    }, 120_000);

    it('only the platform package corrupted: npm exits 0, and this still fails, saying why', async () => {
      registry.serve('platform-garbage');
      const ctx = installContext(registry.lockWith({ wrapper: true, platform: false }));
      const err = await failure(() => ensureRuntime(ctx));
      expect(err.code).toBe('runtime_install_failed');
      expect(err.message).toMatch(/did not match its pinned checksum/);
      expect(fs.existsSync(markerOf(ctx))).toBe(false);
    }, 120_000);

    it('a corrupted main package fails its checksum, leaves nothing, and no config', async () => {
      registry.serve('all-garbage');
      const ctx = installContext(lockText);
      const err = await failure(() => createNetwork(ctx, { name: 'mac', person: 'kt' }));
      expect(err.code).toBe('runtime_install_failed');
      expect(err.message).toMatch(/pinned checksum/);
      expect(fs.existsSync(ctx.dataDir)).toBe(false);
    }, 120_000);

    it('a failed install on a machine that has a database writes no network settings', async () => {
      registry.serve('all-garbage');
      const ctx = installContext(lockText);
      openNetworkStore(ctx.dbPath).close();
      const err = await failure(() => createNetwork(ctx, { name: 'mac', person: 'kt' }));
      expect(err.code).toBe('runtime_install_failed');
      const db = openNetworkStore(ctx.dbPath);
      try {
        expect(readConfig(db)).toBeNull();
      } finally {
        db.close();
      }
      expect(fs.existsSync(ctx.dbPath)).toBe(true);
    }, 120_000);

    it('a copy planted in a parent node_modules is not loaded, and no marker is written', async () => {
      registry.serve('platform-garbage');
      const ctx = installContext(registry.lockWith({ wrapper: true, platform: false }));
      const planted = path.join(ctx.env.HOME as string, 'node_modules', platformKey());
      fs.mkdirSync(planted, { recursive: true });
      const proof = path.join(ctx.env.HOME as string, 'PLANTED-LOADED');
      fs.writeFileSync(path.join(planted, 'package.json'), JSON.stringify({ name: platformKey(), version: '9.9.9', main: 'index.js' }));
      fs.writeFileSync(path.join(planted, 'index.js'), `require('fs').writeFileSync(${JSON.stringify(proof)}, 'x'); module.exports = { Endpoint: { builder() { return {}; } } };`);
      const err = await failure(() => ensureRuntime(ctx));
      expect(err.code).toBe('runtime_install_failed');
      expect(fs.existsSync(proof)).toBe(false);
      expect(fs.existsSync(markerOf(ctx))).toBe(false);

      // The same at load time, with the install already gone wrong on disk.
      fs.mkdirSync(path.join(runtimeDir(ctx.dataDir), 'node_modules/@number0/iroh'), { recursive: true });
      fs.writeFileSync(path.join(runtimeDir(ctx.dataDir), 'package-lock.json'), lockText);
      fs.writeFileSync(path.join(runtimeDir(ctx.dataDir), 'node_modules/@number0/iroh/index.js'), `module.exports = require(${JSON.stringify(platformKey())});`);
      const check = await failure(() => checkRuntime(ctx));
      expect(check.message).toMatch(/missing from the install/);
      expect(fs.existsSync(proof)).toBe(false);
    }, 120_000);

    it('resolution stays inside the runtime folder for the main package too', async () => {
      registry.serve('good');
      const ctx = installContext(registry.lockWith({ wrapper: true, platform: true }));
      ensureRuntime(ctx);
      fs.rmSync(path.join(runtimeDir(ctx.dataDir), 'node_modules/@number0/iroh'), { recursive: true });
      const planted = path.join(ctx.env.HOME as string, 'node_modules/@number0/iroh');
      fs.mkdirSync(planted, { recursive: true });
      const proof = path.join(ctx.env.HOME as string, 'PLANTED-MAIN-LOADED');
      fs.writeFileSync(path.join(planted, 'index.js'), `require('fs').writeFileSync(${JSON.stringify(proof)}, 'x'); module.exports = { Endpoint: { builder() { return {}; } } };`);
      const check = await failure(() => checkRuntime(ctx));
      expect(check.code).toBe('runtime_load_failed');
      expect(fs.existsSync(proof)).toBe(false);
    }, 120_000);
  });
});
