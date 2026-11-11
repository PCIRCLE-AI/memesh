import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startBridge } from '../../src/network/bridge-control.js';
import { ensureIdentity } from '../../src/network/identity.js';
import { encodeLink } from '../../src/network/invites.js';
import { explainLoadFailure } from '../../src/network/native-loader.js';
import { createNetwork, joinNetwork, runJoinChild } from '../../src/network/operations.js';
import { currentLibc, nativeFileName, platformPackage } from '../../src/network/runtime-platform.js';
import { checkRuntime, ensureRuntime, explainInstallFailure, isPlatformSupported, npmInvocation } from '../../src/network/runtime.js';
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

describe('which native file is this computer\'s', () => {
  it('picks the package, including the two 32-bit ARM ones the lock does not separate by libc', () => {
    const cases: Array<[string, string, string | null, string | null]> = [
      ['linux', 'arm', 'glibc', 'iroh-linux-arm-gnueabihf'],
      ['linux', 'arm', 'musl', 'iroh-linux-arm-musleabihf'],
      ['linux', 'x64', 'glibc', 'iroh-linux-x64-gnu'],
      ['linux', 'x64', 'musl', 'iroh-linux-x64-musl'],
      ['linux', 'arm64', 'glibc', 'iroh-linux-arm64-gnu'],
      ['linux', 'arm64', 'musl', 'iroh-linux-arm64-musl'],
      ['darwin', 'arm64', null, 'iroh-darwin-arm64'],
      ['win32', 'x64', null, 'iroh-win32-x64-msvc'],
      ['win32', 'arm64', null, 'iroh-win32-arm64-msvc'],
      ['darwin', 'x64', null, null],
      ['linux', 'ppc64', 'glibc', null],
    ];
    for (const [platform, arch, libc, expected] of cases) {
      const name = platformPackage(lockText, platform, arch, libc);
      expect({ platform, arch, libc, name: name?.split('/').pop() ?? null }).toEqual({ platform, arch, libc, name: expected });
    }
  });

  it('names the file every pinned tarball really holds', () => {
    // Read from each tarball with `npm pack` + `tar tzf` for 1.2.0.
    const measured = [
      'android-arm-eabi', 'android-arm64', 'darwin-arm64', 'linux-arm-gnueabihf', 'linux-arm-musleabihf',
      'linux-arm64-gnu', 'linux-arm64-musl', 'linux-x64-gnu', 'linux-x64-musl', 'win32-arm64-msvc', 'win32-x64-msvc',
    ];
    const lock = JSON.parse(lockText) as { packages: Record<string, { os?: string[] }> };
    const pinned = Object.entries(lock.packages).filter(([, entry]) => entry.os).map(([key]) => key.replace('node_modules/', ''));
    expect(pinned.length).toBe(measured.length);
    for (const name of pinned) {
      const suffix = (name.split('/').pop() as string).replace(/^iroh-/, '');
      expect(measured).toContain(suffix);
      expect(nativeFileName(name)).toBe(`iroh.${suffix}.node`);
    }
  });
});

describe('running npm', () => {
  const args = ['ci', '--ignore-scripts'];
  it('runs npm directly where it is a real program', () => {
    expect(npmInvocation(args, 'darwin', '/usr/local/bin/node', () => false)).toEqual({ command: 'npm', args });
    expect(npmInvocation(args, 'linux', '/usr/bin/node', () => false)).toEqual({ command: 'npm', args });
  });

  it('on Windows runs npm\'s own script with this Node, with no shell to outlive a timeout', () => {
    const node = 'C:\\Program Files\\nodejs\\node.exe';
    const cli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
    expect(npmInvocation(args, 'win32', node, (file) => file === cli)).toEqual({ command: node, args: [cli, ...args] });
  });

  it('on Windows without npm beside Node it reports npm missing instead of using a shell', () => {
    expect(npmInvocation(args, 'win32', 'C:\\tools\\node.exe', () => false)).toBeNull();
  });
});

describe('explaining failures', () => {
  it('says what a load failure means', () => {
    expect(explainLoadFailure(new Error('the native networking file for darwin-x64 is missing from the install'))).toMatch(/missing from the install/);
    expect(explainLoadFailure(Object.assign(new Error('no such file'), { code: 'ENOENT' }))).toMatch(/not installed/);
    expect(explainLoadFailure(new Error('dlopen(/x/iroh.node, 0x0001): file too short'))).toMatch(/damaged/);
  });

  it.each([
    '\\\\?\\C:\\Users\\a\\.memesh\\network\\runtime\\node_modules\\x\\iroh.win32-x64-msvc.node is not a valid Win32 application.',
    'A dynamic link library (DLL) initialization routine failed.\r\n\\\\?\\C:\\x\\iroh.win32-x64-msvc.node',
  ])('a damaged native file on Windows is "damaged", whatever code it carries: %s', (message) => {
    for (const code of [undefined, 'ERR_DLOPEN_FAILED', 'ENOENT']) {
      expect(explainLoadFailure(Object.assign(new Error(message), code ? { code } : {}))).toMatch(/damaged or cannot run here/);
    }
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

  const HANG = 'setTimeout(() => {}, 20000);';

  it('a load check that times out says so, and does not blame the file', async () => {
    const ctx = { ...newContext(), bridgeEntry: crashingBridge(HANG) };
    const err = await failure(() => checkRuntime(ctx, 300));
    expect(err.code).toBe('runtime_check_timeout');
    expect(err.message).toMatch(/did not finish/);
    expect(err.message).not.toMatch(/damaged/);
  });

  it('a load check that times out on a good install neither reinstalls nor deletes it', async () => {
    const ctx = { ...newContext(), bridgeEntry: crashingBridge(HANG) };
    seedInstalled(ctx);
    const keep = path.join(runtimeDir(ctx.dataDir), 'KEEP');
    fs.writeFileSync(keep, 'x');
    const progress: string[] = [];
    const err = await failure(() => ensureRuntime(ctx, { checkTimeoutMs: 300, onProgress: (message) => progress.push(message) }));
    expect(err.code).toBe('runtime_check_timeout');
    expect(progress).toEqual([]);
    expect(fs.existsSync(keep)).toBe(true);
  });

  it('own relay not reached and direct failed too: says so, not "run up on the other machine"', async () => {
    const answer = (relayReached: boolean) => crashingBridge(`
if (process.argv[2] === 'check') { console.log('{"ok":true}'); process.exit(0); }
process.stdin.resume();
process.stdin.on('end', () => console.log(JSON.stringify({ ok: false, code: 'owner_unreachable', detail: 'timed out', relay_reached: ${relayReached} })));`);
    const down = { ...newContext(), bridgeEntry: answer(false) };
    seedInstalled(down);
    const err = await failure(() => joinNetwork(down, { link: signedLink(TOKEN), name: 'mac', person: 'kt' }));
    expect(err.message).toMatch(/could not reach its relay either/);
    expect(err.message).not.toMatch(/network up/);
    const up = { ...newContext(), bridgeEntry: answer(true) };
    seedInstalled(up);
    expect((await failure(() => joinNetwork(up, { link: signedLink(TOKEN), name: 'mac', person: 'kt' }))).message).toMatch(/network up/);
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
const dir = path.join(process.env.MEMESH_DIR, 'network');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'bridge-status.json'), JSON.stringify({ pid: process.pid, state: 'failed', last_error: 'the actual reason' }));
process.exit(7);`),
    };
    const err = await failure(() => startBridge(ctx));
    expect(err.message).toMatch(/status 7/);
    expect(err.message).toMatch(/the actual reason/);
  });

  it('the child environment has no NODE_PATH', () => {
    const env = childEnv({ ...newContext(), env: { KEEP: '1', NODE_PATH: '/x', node_path: '/y' } });
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
    const platformKey = (): string => platformPackage(lockText, process.platform, process.arch, currentLibc()) as string;

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

    const OK_CHECK = "console.log('{\"ok\":true}');";

    it('a good download installs, with scripts off, even under omit=optional', async () => {
      registry.serve('good');
      const ctx = { ...installContext(registry.lockWith({ wrapper: true, platform: true }), { npm_config_omit: 'optional' }), bridgeEntry: crashingBridge(OK_CHECK) };
      ensureRuntime(ctx);
      expect(fs.existsSync(markerOf(ctx))).toBe(true);
      expect(fs.existsSync(path.join(runtimeDir(ctx.dataDir), 'node_modules', platformKey()))).toBe(true);
      expect(fs.existsSync(path.join(ctx.env.HOME as string, 'POSTINSTALL-RAN'))).toBe(false);
    }, 120_000);

    it('two installs at once: the second waits for the first and uses its result', async () => {
      registry.serve('good');
      const ctx = { ...installContext(registry.lockWith({ wrapper: true, platform: true })), bridgeEntry: crashingBridge(OK_CHECK) };
      const runner = path.join(home, 'install-runner.mjs');
      await build({
        stdin: {
          contents: `import { ensureRuntime } from ${JSON.stringify(path.join(repoRoot, 'src/network/runtime.ts'))};
            const ctx = JSON.parse(process.argv[2]);
            try { ensureRuntime(ctx, { onProgress: (m) => console.log('progress ' + m) }); console.log('done'); }
            catch (err) { console.log('failed ' + err.message); process.exitCode = 1; }`,
          resolveDir: repoRoot, loader: 'ts',
        },
        outfile: runner, bundle: true, platform: 'node', format: 'esm', target: 'node22.13', logLevel: 'silent', packages: 'external',
      });
      const run = () => new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(process.execPath, [runner, JSON.stringify(ctx)], { env: ctx.env });
        let out = '';
        child.stdout.on('data', (chunk) => { out += chunk; });
        child.stderr.on('data', (chunk) => { out += chunk; });
        child.on('exit', (code) => resolve({ code, out }));
      });
      const results = await Promise.all([run(), run()]);
      expect(results.map((result) => result.code)).toEqual([0, 0]);
      // Exactly one of them ran npm; the other found the finished install.
      expect(results.filter((result) => result.out.includes('Installing the networking component'))).toHaveLength(1);
      expect(fs.existsSync(markerOf(ctx))).toBe(true);
      expect(fs.readdirSync(path.dirname(runtimeDir(ctx.dataDir))).filter((name) => name.includes('install.lock'))).toEqual([]);
    }, 180_000);

    it('an install lock left by a process that is gone does not block the next install', async () => {
      registry.serve('good');
      const ctx = { ...installContext(registry.lockWith({ wrapper: true, platform: true })), bridgeEntry: crashingBridge(OK_CHECK) };
      const lock = path.join(path.dirname(runtimeDir(ctx.dataDir)), 'runtime.install.lock');
      fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
      fs.writeFileSync(lock, '2147483647\n', { mode: 0o600 });
      ensureRuntime(ctx);
      expect(fs.existsSync(markerOf(ctx))).toBe(true);
      expect(fs.existsSync(lock)).toBe(false);
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
      expect(err.message).toMatch(/the download did not match the pinned checksum/);
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

    it('pinned package missing, a planted copy in a parent node_modules: not loaded, no marker', async () => {
      registry.serve('platform-garbage');
      const ctx = installContext(registry.lockWith({ wrapper: true, platform: false }));
      const home = ctx.env.HOME;
      const planted = path.join(home, 'node_modules', platformKey());
      const proof = path.join(home, 'PLANTED-LOADED');
      fs.mkdirSync(planted, { recursive: true });
      const body = `require('fs').writeFileSync(${JSON.stringify(proof)}, 'x'); module.exports = { Endpoint: { builder() { return {}; } } };`;
      fs.writeFileSync(path.join(planted, 'package.json'), JSON.stringify({ name: platformKey(), version: '9.9.9', main: 'index.js' }));
      fs.writeFileSync(path.join(planted, 'index.js'), body);
      fs.writeFileSync(path.join(planted, nativeFileName(platformKey())), body);
      const err = await failure(() => ensureRuntime(ctx));
      expect(err.code).toBe('runtime_install_failed');
      expect(fs.existsSync(proof)).toBe(false);
      expect(fs.existsSync(markerOf(ctx))).toBe(false);

      // And at load time, with the install already gone wrong on disk.
      fs.mkdirSync(runtimeDir(ctx.dataDir), { recursive: true });
      fs.writeFileSync(path.join(runtimeDir(ctx.dataDir), 'package-lock.json'), lockText);
      const check = await failure(() => checkRuntime(ctx));
      expect(check.message).toMatch(/missing from the install/);
      expect(fs.existsSync(proof)).toBe(false);
    }, 120_000);

    it('a symlink out of the runtime folder is refused, for the package or the file', async () => {
      const ctx = newContext();
      const runtime = runtimeDir(ctx.dataDir);
      fs.mkdirSync(path.join(runtime, 'node_modules', path.dirname(platformKey())), { recursive: true });
      fs.writeFileSync(path.join(runtime, 'package-lock.json'), lockText);
      const outside = path.join(ctx.env?.HOME as string, 'outside');
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, nativeFileName(platformKey())), 'not native');
      const inside = path.join(runtime, 'node_modules', platformKey());
      fs.symlinkSync(outside, inside);
      expect((await failure(() => checkRuntime(ctx))).message).toMatch(/points outside the install/);

      fs.rmSync(inside);
      fs.mkdirSync(inside);
      fs.symlinkSync(path.join(outside, nativeFileName(platformKey())), path.join(inside, nativeFileName(platformKey())));
      expect((await failure(() => checkRuntime(ctx))).message).toMatch(/points outside the install/);
    });

    it('a cleanup that fails does not replace the install\'s real error', async () => {
      registry.serve('all-garbage');
      const ctx = installContext(lockText);
      const realRm = fs.rmSync;
      const removal = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
        if (String(target) === runtimeDir(ctx.dataDir) && options?.recursive) throw Object.assign(new Error('EACCES: no'), { code: 'EACCES' });
        realRm(target, options);
      });
      try {
        const err = await failure(() => ensureRuntime(ctx));
        expect(err.code).toBe('runtime_install_failed');
        expect(err.message).toMatch(/the download did not match the pinned checksum/);
      } finally {
        removal.mockRestore();
      }
    }, 120_000);

    it('a check that times out right after installing leaves the install in place', async () => {
      registry.serve('good');
      const ctx = { ...installContext(registry.lockWith({ wrapper: true, platform: true })), bridgeEntry: crashingBridge(HANG) };
      const err = await failure(() => ensureRuntime(ctx, { checkTimeoutMs: 300 }));
      expect(err.code).toBe('runtime_check_timeout');
      expect(fs.existsSync(path.join(runtimeDir(ctx.dataDir), 'node_modules', platformKey()))).toBe(true);
    }, 120_000);
  });
});
