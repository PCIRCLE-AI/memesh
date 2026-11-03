import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describeChildDeath } from './bridge-control.js';
import { ensureNetworkDir } from './identity.js';
import { currentLibc, platformPackages } from './runtime-platform.js';
import { NetworkError, SINGLE_MACHINE_NOTE, childEnv, runtimeDir } from './types.js';
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const CHECK_TIMEOUT_MS = 30_000;
const MARKER = '.installed-lock-sha256';
function assetText(ctx, name) {
    try {
        return fs.readFileSync(path.join(ctx.assetsDir, name), 'utf8');
    }
    catch {
        throw new NetworkError('runtime_install_failed', `This MeMesh install is missing ${name}. Reinstall MeMesh. ${SINGLE_MACHINE_NOTE}`);
    }
}
export function isPlatformSupported(lockText, platform, arch, libc) {
    return platformPackages(lockText, platform, arch, libc).length > 0;
}
function unsupportedMessage(platform, arch) {
    const what = platform === 'darwin' && arch === 'x64'
        ? 'This Intel Mac is not supported; cross-machine messaging on a Mac needs Apple Silicon'
        : `This computer (${platform}, ${arch}) is not supported by cross-machine messaging`;
    return `${what}. ${SINGLE_MACHINE_NOTE}`;
}
export function explainInstallFailure(spawnError, output) {
    let reason;
    if (spawnError?.code === 'ENOENT') {
        reason = 'npm was not found, and it is needed once to install the networking component. Install Node.js with npm';
    }
    else if (spawnError?.code === 'ETIMEDOUT') {
        reason = 'the download took too long. Check your connection and try again';
    }
    else if (/EINTEGRITY|integrity checksum failed/i.test(output)) {
        reason = 'the download did not match the pinned checksum, so it was refused and nothing was loaded. Try again; if it repeats, your network or npm registry is changing the files';
    }
    else if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|network request/i.test(output)) {
        reason = 'the npm registry could not be reached. Check your connection and try again';
    }
    else if (/ENOSPC/i.test(output)) {
        reason = 'the disk is full';
    }
    else if (/EACCES|EPERM/i.test(output)) {
        reason = 'npm was refused permission to write its files';
    }
    else {
        const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
        reason = `npm said: ${(lines[0] ?? 'nothing').slice(0, 300)}`;
    }
    return `Could not install the networking component: ${reason}. ${SINGLE_MACHINE_NOTE}`;
}
export function checkRuntime(ctx, timeoutMs = CHECK_TIMEOUT_MS) {
    const result = spawnSync(process.execPath, [ctx.bridgeEntry, 'check'], {
        env: childEnv(ctx), encoding: 'utf8', timeout: timeoutMs,
    });
    if (result.status === 0)
        return;
    let reason;
    if (result.error?.code === 'ETIMEDOUT') {
        reason = `the check did not finish within ${timeoutMs / 1000} s, so nothing is known about the files; try again when this computer is less busy`;
    }
    else {
        try {
            reason = JSON.parse(result.stdout).reason;
        }
        catch {
            reason = `the networking component could not start: ${describeChildDeath(result.status, result.signal)}`;
        }
    }
    throw new NetworkError('runtime_load_failed', `The networking component did not load: ${reason}. ${SINGLE_MACHINE_NOTE}`);
}
function runNpmCi(ctx, directory) {
    const args = ['ci', '--ignore-scripts', '--include=optional', '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=error'];
    const options = { cwd: directory, env: childEnv(ctx), encoding: 'utf8', timeout: INSTALL_TIMEOUT_MS };
    const result = process.platform === 'win32'
        ? spawnSync(['npm.cmd', ...args].join(' '), { ...options, shell: true })
        : spawnSync('npm', args, options);
    if (result.status === 0 && !result.error)
        return;
    throw new NetworkError('runtime_install_failed', explainInstallFailure(result.error, `${result.stderr ?? ''}\n${result.stdout ?? ''}`));
}
function assertPlatformPackageInstalled(lockText, directory) {
    const packages = platformPackages(lockText, process.platform, process.arch, currentLibc());
    if (packages.some((name) => fs.existsSync(path.join(directory, 'node_modules', name, 'package.json'))))
        return;
    throw new NetworkError('runtime_install_failed', `Could not install the networking component: the native file for this computer failed to download or did not match its pinned checksum, so it was refused. Try again; if it repeats, your network or npm registry is changing the files. ${SINGLE_MACHINE_NOTE}`);
}
function removeFailedInstall(dataDir, directory, created) {
    fs.rmSync(directory, { recursive: true, force: true });
    try {
        if (created.network)
            fs.rmdirSync(path.dirname(directory));
        if (created.data)
            fs.rmdirSync(dataDir);
    }
    catch (err) {
        if (err.code !== 'ENOTEMPTY')
            throw err;
    }
}
export function ensureRuntime(ctx, options = {}) {
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
            checkRuntime(ctx);
            return;
        }
        catch (err) {
            options.onProgress?.(`The installed networking component is not usable (${err.message}) Reinstalling.`);
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
        checkRuntime(ctx);
    }
    catch (err) {
        removeFailedInstall(ctx.dataDir, directory, created);
        throw err;
    }
    fs.writeFileSync(marker, `${wanted}\n`);
}
//# sourceMappingURL=runtime.js.map