// Shared by tests/network: a throwaway build of the bridge and CLI from the
// current source (so a stale dist/ cannot fake a pass, and a mutation is seen
// without a rebuild), throwaway HOMEs, and one real install of the runtime.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { ensureRuntime } from '../../src/network/runtime.js';
import type { IrohModule } from '../../src/network/iroh-types.js';
import { runtimeDir, type NetworkContext } from '../../src/network/types.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

export interface Tree { root: string; bridgeEntry: string; assetsDir: string; cli: string }

/** Laid out like dist/, so the CLI's relative path to the bridge resolves the same way. */
export async function buildTree(options: { cli?: boolean } = {}): Promise<Tree> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-network-tree-'));
  // The CLI reads its version from ../../../package.json, and that file also makes the .js files ESM.
  fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(root, 'package.json'));
  const assetsDir = path.join(root, 'dist/network');
  fs.mkdirSync(assetsDir, { recursive: true });
  for (const asset of ['runtime-lock.json', 'runtime-package.json']) {
    fs.copyFileSync(path.join(repoRoot, 'src/network', asset), path.join(assetsDir, asset));
  }
  const bridgeEntry = path.join(assetsDir, 'bridge.js');
  const common = { bundle: true, platform: 'node', format: 'esm', target: 'node22.13', absWorkingDir: repoRoot, logLevel: 'silent' } as const;
  await build({ ...common, entryPoints: ['src/network/bridge.ts'], outfile: bridgeEntry });
  const cli = path.join(root, 'dist/transports/cli/cli.js');
  if (options.cli) {
    await build({
      ...common,
      entryPoints: ['src/transports/cli/cli.ts'],
      outfile: cli,
      define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"' },
      banner: { js: "import { createRequire as __memeshCreateRequire } from 'node:module'; const require = __memeshCreateRequire(import.meta.url);" },
    });
  }
  return { root, bridgeEntry, assetsDir, cli };
}

export function makeHome(prefix = 'memesh-network-home-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function contextFor(tree: Tree, home: string): NetworkContext {
  const dataDir = path.join(home, '.memesh');
  return {
    dataDir,
    dbPath: path.join(dataDir, 'knowledge-graph.db'),
    bridgeEntry: tree.bridgeEntry,
    assetsDir: tree.assetsDir,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  };
}

/** The real install path, once per test file: `npm ci` from the shipped lock. Needs the npm registry. */
export function installRuntimeOnce(tree: Tree): string {
  const seed = contextFor(tree, makeHome('memesh-network-seed-'));
  ensureRuntime(seed);
  return runtimeDir(seed.dataDir);
}

/** Give a home the installed runtime without another download. */
export function linkRuntime(ctx: NetworkContext, runtime: string): void {
  fs.mkdirSync(path.dirname(runtimeDir(ctx.dataDir)), { recursive: true, mode: 0o700 });
  fs.symlinkSync(runtime, runtimeDir(ctx.dataDir), 'junction');
}

export function loadIrohForTest(runtime: string): IrohModule {
  return createRequire(path.join(runtime, 'package.json'))('@number0/iroh') as IrohModule;
}

/** Starts node with stdin and stdout claiming to be a terminal, as the real CLI path needs. */
export function writeTtyPreload(directory: string): string {
  const preload = path.join(directory, 'tty-preload.mjs');
  fs.writeFileSync(preload, `
import fs from 'node:fs';
process.stdin.isTTY = true;
process.stdout.isTTY = true;
process.stdin.setRawMode = (on) => { process.stderr.write('RAW:' + on + '\\n'); return process.stdin; };
if (process.env.ARGV_LOG) fs.appendFileSync(process.env.ARGV_LOG, JSON.stringify(process.argv) + '\\n');
`);
  return preload;
}

export function removeTree(target: string): void {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
