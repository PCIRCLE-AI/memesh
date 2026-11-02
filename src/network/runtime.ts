// Installs the native transport on demand into <data dir>/network/runtime, from
// the lockfile this build shipped. It is not a dependency of MeMesh: a plugin cache
// has no node_modules, and someone who never joins a team never downloads it.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureNetworkDir } from './identity.js';
import { NetworkError, SINGLE_MACHINE_NOTE, childEnv, runtimeDir, type NetworkContext } from './types.js';

const INSTALL_TIMEOUT_MS = 5 * 60_000;
const CHECK_TIMEOUT_MS = 30_000;
const MARKER = '.installed-lock-sha256';

interface LockEntry {
  os?: string[];
  cpu?: string[];
  libc?: string[];
}

function assetText(ctx: NetworkContext, name: string): string {
  try {
    return fs.readFileSync(path.join(ctx.assetsDir, name), 'utf8');
  } catch {
    throw new NetworkError('runtime_install_failed', `This MeMesh install is missing ${name}. Reinstall MeMesh. ${SINGLE_MACHINE_NOTE}`);
  }
}

function currentLibc(): string | null {
  if (process.platform !== 'linux') return null;
  // Without this the report does a reverse DNS lookup of every open socket.
  (process.report as { excludeNetwork?: boolean }).excludeNetwork = true;
  const header = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
  return header.header?.glibcVersionRuntime ? 'glibc' : 'musl';
}

/** Does the lock pin a native package for this computer? */
export function isPlatformSupported(lockText: string, platform: string, arch: string, libc: string | null): boolean {
  const { packages } = JSON.parse(lockText) as { packages: Record<string, LockEntry> };
  return Object.values(packages).some((entry) =>
    entry.os?.includes(platform)
    && entry.cpu?.includes(arch)
    && (entry.libc === undefined || libc === null || entry.libc.includes(libc)));
}

function unsupportedMessage(platform: string, arch: string): string {
  const what = platform === 'darwin' && arch === 'x64'
    ? 'This Intel Mac is not supported; cross-machine messaging on a Mac needs Apple Silicon'
    : `This computer (${platform}, ${arch}) is not supported by cross-machine messaging`;
  return `${what}. ${SINGLE_MACHINE_NOTE}`;
}

/** Explain npm's failure in terms of what a person can do about it. */
export function explainInstallFailure(spawnError: NodeJS.ErrnoException | undefined, output: string): string {
  let reason: string;
  if (spawnError?.code === 'ENOENT') {
    reason = 'npm was not found, and it is needed once to install the networking component. Install Node.js with npm';
  } else if (spawnError?.code === 'ETIMEDOUT') {
    reason = 'the download took too long. Check your connection and try again';
  } else if (/EINTEGRITY|integrity checksum failed/i.test(output)) {
    reason = 'the download did not match the pinned checksum, so it was refused and nothing was loaded. Try again; if it repeats, your network or npm registry is changing the files';
  } else if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|network request/i.test(output)) {
    reason = 'the npm registry could not be reached. Check your connection and try again';
  } else if (/ENOSPC/i.test(output)) {
    reason = 'the disk is full';
  } else if (/EACCES|EPERM/i.test(output)) {
    reason = 'npm was refused permission to write its files';
  } else {
    const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
    reason = `npm said: ${(lines[0] ?? 'nothing').slice(0, 300)}`;
  }
  return `Could not install the networking component: ${reason}. ${SINGLE_MACHINE_NOTE}`;
}

function describeChildDeath(status: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `it crashed with signal ${signal}`;
  return `it exited with status ${status}`;
}

/**
 * Load the native file in a child. A truncated file can end a process with a
 * signal; here that is a failed result, not a crashed CLI.
 */
export function checkRuntime(ctx: NetworkContext): void {
  const result = spawnSync(process.execPath, [ctx.bridgeEntry, 'check'], {
    env: childEnv(ctx), encoding: 'utf8', timeout: CHECK_TIMEOUT_MS,
  });
  let reason: string;
  if (result.status === 0) return;
  try {
    reason = (JSON.parse(result.stdout) as { reason: string }).reason;
  } catch {
    reason = `the networking component could not start: ${describeChildDeath(result.status, result.signal)}, which usually means its native file is damaged`;
  }
  throw new NetworkError('runtime_load_failed', `The networking component did not load: ${reason}. ${SINGLE_MACHINE_NOTE}`);
}

function runNpmCi(ctx: NetworkContext, directory: string): void {
  const args = ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=error'];
  const options = { cwd: directory, env: childEnv(ctx), encoding: 'utf8', timeout: INSTALL_TIMEOUT_MS } as const;
  // Windows cannot run npm.cmd without a shell. Every word here is a literal from this file.
  const result = process.platform === 'win32'
    ? spawnSync(['npm.cmd', ...args].join(' '), { ...options, shell: true })
    : spawnSync('npm', args, options);
  if (result.status === 0 && !result.error) return;
  throw new NetworkError('runtime_install_failed', explainInstallFailure(
    result.error as NodeJS.ErrnoException | undefined,
    `${result.stderr ?? ''}\n${result.stdout ?? ''}`,
  ));
}

export interface InstallOptions {
  /** Reinstall even when the installed files pass the load check. */
  force?: boolean;
  onProgress?: (message: string) => void;
}

/**
 * Make the runtime usable: keep a working install of this exact lock, otherwise
 * `npm ci --ignore-scripts` against the shipped lock (a corrupted download fails
 * its checksum), then load it once in a child.
 */
export function ensureRuntime(ctx: NetworkContext, options: InstallOptions = {}): void {
  const lockText = assetText(ctx, 'runtime-lock.json');
  const packageText = assetText(ctx, 'runtime-package.json');
  if (!isPlatformSupported(lockText, process.platform, process.arch, currentLibc())) {
    throw new NetworkError('runtime_unsupported', unsupportedMessage(process.platform, process.arch));
  }

  ensureNetworkDir(ctx.dataDir);
  const directory = runtimeDir(ctx.dataDir);
  const wanted = createHash('sha256').update(lockText).digest('hex');
  const marker = path.join(directory, MARKER);
  if (!options.force && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === wanted) {
    try {
      checkRuntime(ctx);
      return;
    } catch (err) {
      options.onProgress?.(`The installed networking component is not usable (${(err as Error).message}) Reinstalling.`);
    }
  }

  options.onProgress?.('Installing the networking component (once per machine, verified against pinned checksums)...');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.rmSync(marker, { force: true });
  fs.writeFileSync(path.join(directory, 'package.json'), packageText);
  fs.writeFileSync(path.join(directory, 'package-lock.json'), lockText);
  runNpmCi(ctx, directory);
  checkRuntime(ctx);
  fs.writeFileSync(marker, `${wanted}\n`);
}
