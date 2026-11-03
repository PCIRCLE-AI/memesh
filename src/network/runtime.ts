// Installs the native transport on demand into <data dir>/network/runtime, from
// the lockfile this build shipped. It is not a dependency of MeMesh: a plugin cache
// has no node_modules, and someone who never joins a team never downloads it.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describeChildDeath } from './bridge-control.js';
import { ensureNetworkDir } from './identity.js';
import { currentLibc, platformPackages } from './runtime-platform.js';
import { NetworkError, SINGLE_MACHINE_NOTE, childEnv, runtimeDir, type NetworkContext } from './types.js';

const INSTALL_TIMEOUT_MS = 5 * 60_000;
const CHECK_TIMEOUT_MS = 30_000;
const MARKER = '.installed-lock-sha256';

function assetText(ctx: NetworkContext, name: string): string {
  try {
    return fs.readFileSync(path.join(ctx.assetsDir, name), 'utf8');
  } catch {
    throw new NetworkError('runtime_install_failed', `This MeMesh install is missing ${name}. Reinstall MeMesh. ${SINGLE_MACHINE_NOTE}`);
  }
}

/** Does the lock pin a native package for this computer? */
export function isPlatformSupported(lockText: string, platform: string, arch: string, libc: string | null): boolean {
  return platformPackages(lockText, platform, arch, libc).length > 0;
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

/**
 * Load the native file in a child. A truncated file can end a process with a
 * signal; here that is a failed result, not a crashed CLI.
 */
export function checkRuntime(ctx: NetworkContext, timeoutMs: number = CHECK_TIMEOUT_MS): void {
  const result = spawnSync(process.execPath, [ctx.bridgeEntry, 'check'], {
    env: childEnv(ctx), encoding: 'utf8', timeout: timeoutMs,
  });
  if (result.status === 0) return;
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
    throw new NetworkError('runtime_check_timeout', `The check of the networking component did not finish within ${timeoutMs / 1000} s, so nothing is known about its files and they were left alone. Try again when this computer is less busy. ${SINGLE_MACHINE_NOTE}`);
  }
  let reason: string;
  try {
    reason = (JSON.parse(result.stdout) as { reason: string }).reason;
  } catch {
    reason = `the networking component could not start: ${describeChildDeath(result.status, result.signal)}`;
  }
  throw new NetworkError('runtime_load_failed', `The networking component did not load: ${reason}. ${SINGLE_MACHINE_NOTE}`);
}

function runNpmCi(ctx: NetworkContext, directory: string): void {
  // --include=optional: the native files are optional packages, and a user's
  // `omit=optional` npm setting would otherwise install none of them and exit 0.
  const args = ['ci', '--ignore-scripts', '--include=optional', '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=error'];
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

/**
 * npm treats the native packages as optional: one that fails its checksum or its
 * download is dropped and npm still exits 0. So success has to be checked here.
 */
function assertPlatformPackageInstalled(lockText: string, directory: string): void {
  const packages = platformPackages(lockText, process.platform, process.arch, currentLibc());
  if (packages.some((name) => fs.existsSync(path.join(directory, 'node_modules', name, 'package.json')))) return;
  throw new NetworkError(
    'runtime_install_failed',
    `Could not install the networking component: the native file for this computer failed to download or did not match its pinned checksum, so it was refused. Try again; if it repeats, your network or npm registry is changing the files. ${SINGLE_MACHINE_NOTE}`,
  );
}

/**
 * Undo what a failed install created, so a failed `create` leaves no trace on a
 * machine that had none. Best effort: the caller is about to report why the install
 * failed, and a problem here must not replace that.
 */
function removeFailedInstall(dataDir: string, directory: string, created: { network: boolean; data: boolean }): void {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
    if (created.network) fs.rmdirSync(path.dirname(directory));
    if (created.data) fs.rmdirSync(dataDir);
  } catch (err) {
    process.stderr.write(`MeMesh could not clean up after the failed install: ${(err as Error).message}\n`);
  }
}

export interface InstallOptions {
  /** Reinstall even when the installed files pass the load check. */
  force?: boolean;
  /** How long the load check may take. */
  checkTimeoutMs?: number;
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

  const directory = runtimeDir(ctx.dataDir);
  const created = { network: !fs.existsSync(path.dirname(directory)), data: !fs.existsSync(ctx.dataDir) };
  ensureNetworkDir(ctx.dataDir);
  const wanted = createHash('sha256').update(lockText).digest('hex');
  const marker = path.join(directory, MARKER);
  if (!options.force && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === wanted) {
    try {
      checkRuntime(ctx, options.checkTimeoutMs);
      return;
    } catch (err) {
      // A check that ran out of time says nothing about the files: no reinstall.
      if ((err as NetworkError).code === 'runtime_check_timeout') throw err;
      options.onProgress?.(`The installed networking component is not usable (${(err as Error).message}) Reinstalling.`);
    }
  }

  options.onProgress?.('Installing the networking component (once per machine, verified against pinned checksums)...');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.rmSync(marker, { force: true });
  fs.writeFileSync(path.join(directory, 'package.json'), packageText);
  fs.writeFileSync(path.join(directory, 'package-lock.json'), lockText);
  try {
    runNpmCi(ctx, directory);
    assertPlatformPackageInstalled(lockText, directory);
    checkRuntime(ctx, options.checkTimeoutMs);
  } catch (err) {
    // A freshly installed runtime whose check ran out of time is not a failed install.
    if ((err as NetworkError).code !== 'runtime_check_timeout') removeFailedInstall(ctx.dataDir, directory, created);
    throw err;
  }
  fs.writeFileSync(marker, `${wanted}\n`);
}
