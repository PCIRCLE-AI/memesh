// Shared by tests/network: a throwaway build of the bridge and CLI from the
// current source (so a stale dist/ cannot fake a pass, and a mutation is seen
// without a rebuild), throwaway HOMEs, and one real install of the runtime.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { ensureRuntime } from '../../src/network/runtime.js';
import { ensureNetworkDir } from '../../src/network/identity.js';
import type { IrohModule } from '../../src/network/iroh-types.js';
import { logPath, readStatus } from '../../src/network/bridge-state.js';
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

// Short: a socket path has a byte limit, and macOS's temp folder is already long.
export function makeHome(prefix = 'mn-'): string {
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
  const seed = contextFor(tree, makeHome('mn-seed-'));
  ensureRuntime(seed);
  return runtimeDir(seed.dataDir);
}

/** Give a home the installed runtime without another download. */
export function linkRuntime(ctx: NetworkContext, runtime: string): void {
  ensureNetworkDir(ctx.dataDir);
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

/** Read only the case's own directories; print stage names and allowlisted error codes. */
export function reportBridgeFailure(dataDirs: readonly string[]): void {
  const events = new Set([
    'running', 'stopped', 'exit_already_running', 'exit_holder_unresponsive', 'exit_database',
    'exit_not_joined', 'exit_identity', 'exit_native', 'exit_bind', 'control_problem',
    'control_socket_unreadable', 'control_socket_lost', 'status_write_failed', 'close_failed',
    'presence_unreachable', 'courier_failed', 'connection_failed', 'frame_received', 'frame_sent',
  ]);
  for (const [index, dataDir] of dataDirs.entries()) {
    const status = readStatus(dataDir);
    const logTail: string[] = [];
    try {
      const fd = fs.openSync(logPath(dataDir), 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const buffer = Buffer.alloc(Math.min(size, 4096));
        const bytes = fs.readSync(fd, buffer, 0, buffer.length, size - buffer.length);
        for (const line of buffer.toString('utf8', 0, bytes).split('\n').slice(-13)) {
          if (line.startsWith('The network bridge failed before it could start:')) {
            logTail.push('failed_before_start');
          } else {
            try {
              const entry = JSON.parse(line);
              const event = entry?.event;
              if (events.has(event)) {
                if (event === 'control_problem') {
                  const code = typeof entry.error === 'string'
                    ? /^Control (?:connection|socket) failed: (?:(?:read|write|connect|listen|accept|shutdown) )?(EPIPE|ECONNRESET|EACCES|EPERM|ENOENT|EINVAL|ECONNREFUSED|ETIMEDOUT|ENOTCONN|EADDRINUSE|ERR_STREAM_DESTROYED|ERR_STREAM_WRITE_AFTER_END|ERR_SOCKET_CLOSED)(?=$|[ :])/.exec(entry.error)?.[1]
                    : undefined;
                  logTail.push(`control_problem:${code ?? 'unknown'}`);
                } else logTail.push(event);
              }
            } catch { /* the tail can start or end in the middle of a line */ }
          }
        }
      } finally { fs.closeSync(fd); }
    } catch { /* diagnostic I/O must not replace the test failure */ }
    console.error('Bridge failure evidence:', JSON.stringify({
      context: index + 1,
      status: status ? {
        state: ['starting', 'running', 'stopped', 'failed'].find(state => state === status.state),
        reportedPid: Number.isSafeInteger(status.pid) ? status.pid : null,
        directAddressCount: Array.isArray(status.direct_addresses) ? status.direct_addresses.length : null,
        framesReceived: Number.isSafeInteger(status.frames_received) ? status.frames_received : null,
        hasLastError: Boolean(status.last_error),
      } : null,
      logTail,
    }));
  }
}
