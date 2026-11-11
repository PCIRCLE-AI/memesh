// Installs the native transport on demand into <data dir>/network/runtime, from
// the lockfile this build shipped. It is not a dependency of MeMesh: a plugin cache
// has no node_modules, and someone who never joins a team never downloads it.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describeChildDeath } from './bridge-control.js';
import { identityOf, takeOverStaleLock } from './control-socket.js';
import { ensureNetworkDir } from './identity.js';
import { currentLibc, platformPackages } from './runtime-platform.js';
import { NetworkError, SINGLE_MACHINE_NOTE, childEnv, runtimeDir, type NetworkContext } from './types.js';

const INSTALL_TIMEOUT_MS = 5 * 60_000;
/** Longer than any install and its load check: a lock this old belongs to nobody. */
const INSTALL_LOCK_STALE_MS = INSTALL_TIMEOUT_MS + 2 * 60_000;
/** A holder writes its pid right after creating the lock; one still empty after this never will. */
const INSTALL_LOCK_EMPTY_STALE_MS = 1_500;
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

/**
 * How to run npm. On Windows npm is npm.cmd, which Node runs only through cmd.exe;
 * a timeout then kills cmd.exe and leaves npm writing into the runtime folder. So
 * Windows runs npm's own script with this Node, no shell in between: a timeout
 * kills npm itself. Node's Windows installs keep it beside node.exe. If it is not
 * there, npm counts as not found rather than falling back to a shell.
 */
export function npmInvocation(
  args: string[],
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
  exists: (file: string) => boolean = fs.existsSync,
): { command: string; args: string[] } | null {
  if (platform !== 'win32') return { command: 'npm', args };
  const cli = path.win32.join(path.win32.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return exists(cli) ? { command: execPath, args: [cli, ...args] } : null;
}

function runNpmCi(ctx: NetworkContext, directory: string): void {
  // --include=optional: the native files are optional packages, and a user's
  // `omit=optional` npm setting would otherwise install none of them and exit 0.
  const args = ['ci', '--ignore-scripts', '--include=optional', '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=error'];
  const options = { cwd: directory, env: childEnv(ctx), encoding: 'utf8', timeout: INSTALL_TIMEOUT_MS } as const;
  const npm = npmInvocation(args);
  if (npm === null) {
    throw new NetworkError('runtime_install_failed', explainInstallFailure(Object.assign(new Error('npm not found'), { code: 'ENOENT' }), ''));
  }
  const result = spawnSync(npm.command, npm.args, options);
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
  } catch (err) {
    process.stderr.write(`MeMesh could not clean up after the failed install: ${(err as Error).message}\n`);
  }
  removeCreatedFolders(dataDir, directory, created);
}

function removeCreatedFolders(dataDir: string, directory: string, created: { network: boolean; data: boolean }): void {
  try {
    if (created.network) fs.rmdirSync(path.dirname(directory));
    if (created.data) fs.rmdirSync(dataDir);
  } catch (err) {
    process.stderr.write(`MeMesh could not clean up after the failed install: ${(err as Error).message}\n`);
  }
}

const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

function installLockIsStale(lock: string): boolean {
  try {
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (age >= INSTALL_LOCK_STALE_MS) return true;
    const raw = fs.readFileSync(lock, 'utf8').trim();
    if (!/^[1-9][0-9]*$/.test(raw)) return age >= INSTALL_LOCK_EMPTY_STALE_MS;
    process.kill(Number(raw), 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * One install at a time per data dir: two `create`/`join` runs would otherwise run
 * npm into the same folder. The lock sits beside the runtime folder, since a failed
 * install removes that folder. A second installer waits, and is told it waited, so
 * it can use the first one's result. A stale lock is cleared the same safe way as
 * the bridge's: moved aside and checked, so a fresh one is never deleted.
 */
function withInstallLock<T>(dataDir: string, use: (waited: boolean) => T): T {
  const lock = path.join(path.dirname(runtimeDir(dataDir)), 'runtime.install.lock');
  const giveUpAt = Date.now() + INSTALL_LOCK_STALE_MS;
  let waited = false;
  let mine: { dev: number; ino: number };
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      const { dev, ino } = fs.fstatSync(fd);
      mine = { dev, ino };
      fs.writeSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const judged = identityOf(lock);
      if (judged !== null && installLockIsStale(lock)) {
        takeOverStaleLock(lock, judged);
        continue;
      }
      if (Date.now() >= giveUpAt) {
        throw new NetworkError('runtime_install_failed', `Another MeMesh install of the networking component is still running and did not finish. Try again when it has. ${SINGLE_MACHINE_NOTE}`);
      }
      waited = true;
      sleepSync(200);
    }
  }
  try {
    return use(waited);
  } finally {
    const current = identityOf(lock);
    if (current && current.dev === mine.dev && current.ino === mine.ino) fs.rmSync(lock, { force: true });
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
  let failed: unknown = null;
  withInstallLock(ctx.dataDir, (waited) => {
    try {
      // Someone else just installed: use what they made instead of forcing a second install.
      installOrReuse(ctx, lockText, packageText, directory, waited ? { ...options, force: false } : options);
    } catch (err) {
      failed = err;
      if ((err as NetworkError).code !== 'runtime_check_timeout' && (err as { installed?: boolean }).installed === false) {
        removeFailedInstall(ctx.dataDir, directory, { network: false, data: false });
      }
    }
  });
  if (failed === null) return;
  // Folders this run created go only once the lock is gone, or the lock file would keep them.
  if ((failed as NetworkError).code !== 'runtime_check_timeout' && (failed as { installed?: boolean }).installed === false) {
    removeCreatedFolders(ctx.dataDir, directory, created);
  }
  throw failed;
}

function installOrReuse(ctx: NetworkContext, lockText: string, packageText: string, directory: string, options: InstallOptions): void {
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
    throw Object.assign(err as object, { installed: false });
  }
  fs.writeFileSync(marker, `${wanted}\n`);
}
