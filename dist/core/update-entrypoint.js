import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { memeshDir } from './paths.js';
import { bumpKind, currentPolicy, policyPermits } from './auto-update.js';
import { findPackageRoot } from './package-root.js';
import { getCurrentInstallChannel, getInstallChannelSupport } from './install-channel.js';
import { getLastUpdateCheck } from './version-check.js';
import { claimJustUpgradedMarker, resolveUpdateNotice, shouldRefreshUpdateCache } from './update-notice.js';
export const RECENT_HOOK_NOTICE_MS = 10 * 60 * 1000;
export const CLI_NOTICE_THROTTLE_MS = 24 * 60 * 60 * 1000;
export const FRESH_CHECK_THROTTLE_MS = 5 * 60 * 1000;
export function formatUpdateNoticeLine(notice, mode = { updates: 'on', door: 'cli' }) {
    switch (notice.kind) {
        case 'UPGRADE_AVAILABLE': {
            const head = `[memesh update] ${notice.latestVersion} is available (you are on ${notice.currentVersion}).`;
            if (mode.updates === 'off') {
                if (mode.door === 'mcp')
                    return `${head} Automatic updates are off, so it is not being installed. Do not update on your own.`;
                if (mode.unsupported)
                    return `${head} Automatic updates are off, and MeMesh cannot install it for this install method: ${mode.unsupported}`;
                return `${head} Automatic updates are off, so it is not being installed; \`memesh update\` installs it when you choose to.`;
            }
            if (mode.updates === 'held') {
                if (mode.door === 'mcp')
                    return `${head} The setting autoUpdate: ${mode.setting} does not install this release by itself, so it is not being installed. Do not update on your own.`;
                return `${head} The setting autoUpdate: ${mode.setting} does not install this release by itself; \`memesh update\` installs it when you choose to.`;
            }
            if (mode.updates === 'unsupported') {
                if (mode.door === 'mcp')
                    return `${head} MeMesh cannot install it for this install method. Do not update on your own; tell the person.`;
                return `${head} MeMesh cannot install it for this install method: ${mode.guidance}`;
            }
            if (mode.door === 'mcp')
                return `${head} Automatic updates are on: it is installed by itself after the running sessions end. No action is needed.`;
            return `${head} Run \`memesh update\` to install it now.`;
        }
        case 'JUST_UPGRADED':
            return `[memesh update] Upgraded ${notice.from} → ${notice.to}. Processes started before the upgrade keep running ${notice.from} until they restart.`;
        case 'CHECK_FAILED':
            return `[memesh update] Could not confirm whether an update exists (${notice.reason}). Status is unknown, not current — \`memesh status\` retries.`;
        default:
            return null;
    }
}
export function recentHookNoticeExists(dir, currentVersion, latestVersion, now = new Date()) {
    const claims = path.join(dir, 'update-prompt-claims');
    let names;
    try {
        names = fs.readdirSync(claims);
    }
    catch {
        return false;
    }
    for (const name of names) {
        if (!name.endsWith('.json'))
            continue;
        const file = path.join(claims, name);
        let fd = null;
        try {
            fd = fs.openSync(file, 'r');
            const stat = fs.fstatSync(fd);
            if (now.getTime() - stat.mtimeMs > RECENT_HOOK_NOTICE_MS)
                continue;
            const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
            if (value.decision === 'emitted' && value.currentVersion === currentVersion && (latestVersion === null || value.latestVersion === latestVersion))
                return true;
        }
        catch {
        }
        finally {
            if (fd !== null)
                try {
                    fs.closeSync(fd);
                }
                catch { }
        }
    }
    return false;
}
export function updateCheckEnabledIn(dir) {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
        return raw.updateCheck !== false;
    }
    catch {
        return true;
    }
}
function cliThrottled(dir, currentVersion, now) {
    const tag = /^[0-9A-Za-z.+-]+$/.test(currentVersion) ? currentVersion : 'unknown';
    const marker = path.join(dir, `last-cli-update-notice.${tag}.lock`);
    let fd = null;
    try {
        try {
            fd = fs.openSync(marker, 'r+');
        }
        catch (err) {
            const code = err.code;
            if (code !== 'ENOENT') {
                return true;
            }
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            try {
                fd = fs.openSync(marker, 'wx', 0o600);
            }
            catch (raceErr) {
                if (raceErr.code === 'EEXIST')
                    return true;
                throw raceErr;
            }
            fs.writeSync(fd, String(now.getTime()));
            return false;
        }
        const stat = fs.fstatSync(fd);
        if (now.getTime() - stat.mtimeMs < CLI_NOTICE_THROTTLE_MS)
            return true;
        fs.ftruncateSync(fd, 0);
        fs.writeSync(fd, String(now.getTime()), 0);
        try {
            fs.fchmodSync(fd, 0o600);
        }
        catch { }
        return false;
    }
    catch {
        return true;
    }
    finally {
        if (fd !== null)
            try {
                fs.closeSync(fd);
            }
            catch { }
    }
}
function spawnCacheRefresh(dir, currentVersion, now) {
    let marker;
    const claim = `${process.pid}-${now.getTime()}`;
    const failed = (error) => {
        try {
            if (marker && fs.readFileSync(marker, 'utf8') === claim)
                fs.unlinkSync(marker);
        }
        catch { }
        const code = error?.code;
        const reason = typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'UNKNOWN';
        console.error(`[memesh update] Could not start update cache refresh (${reason}). Status remains unknown; a later call can retry.`);
    };
    try {
        const modulePath = fileURLToPath(import.meta.url);
        const bundledCli = path.basename(modulePath) === 'cli.js'
            && path.basename(path.dirname(modulePath)) === 'cli'
            && path.basename(path.dirname(path.dirname(modulePath))) === 'transports';
        const helperUrl = new URL(bundledCli ? '../../core/version-check.js' : '../core/version-check.js', import.meta.url);
        if (!fs.existsSync(fileURLToPath(helperUrl)))
            return false;
        const tag = /^[0-9A-Za-z.+-]+$/.test(currentVersion) ? currentVersion : 'unknown';
        marker = path.join(dir, `last-fresh-refresh.${tag}.lock`);
        try {
            if (now.getTime() - fs.statSync(marker).mtimeMs < FRESH_CHECK_THROTTLE_MS)
                return false;
            fs.unlinkSync(marker);
        }
        catch { }
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        try {
            const fd = fs.openSync(marker, 'wx', 0o600);
            try {
                fs.writeSync(fd, claim);
            }
            finally {
                fs.closeSync(fd);
            }
        }
        catch {
            return false;
        }
        const refresh = 'const { getUpdateCheck } = await import(process.argv[1]); await getUpdateCheck(process.argv[2], { preferFresh: true });';
        const child = spawn(process.execPath, ['--input-type=module', '--eval', refresh, helperUrl.href, currentVersion], {
            detached: true, stdio: 'ignore', env: { ...process.env }, windowsHide: true,
        });
        child.once('error', failed);
        child.unref();
        return true;
    }
    catch (error) {
        failed(error);
        return false;
    }
}
export const MCP_PENDING_RETRY_MS = 60 * 1000;
class ProcessMemo {
    set;
    key;
    now;
    retryPrefix;
    constructor(set, key, now) {
        this.set = set;
        this.key = key;
        this.now = now;
        this.retryPrefix = `${key}#retry:`;
    }
    decided() {
        if (!this.set)
            return false;
        if (this.set.has(this.key))
            return true;
        for (const entry of this.set) {
            if (entry.startsWith(this.retryPrefix) && this.now.getTime() < Number(entry.slice(this.retryPrefix.length)))
                return true;
        }
        return false;
    }
    decide() { this.clearRetry(); this.set?.add(this.key); }
    retryLater() { this.clearRetry(); this.set?.add(`${this.retryPrefix}${this.now.getTime() + MCP_PENDING_RETRY_MS}`); }
    clearRetry() {
        if (!this.set)
            return;
        for (const entry of [...this.set])
            if (entry.startsWith(this.retryPrefix))
                this.set.delete(entry);
    }
}
function upgradeNoticeMode(input, latestVersion) {
    let policy;
    try {
        policy = currentPolicy().policy;
    }
    catch {
        policy = 'off';
    }
    let support = input.installSupport;
    if (support === undefined) {
        try {
            const packageRoot = findPackageRoot(import.meta.url);
            support = getInstallChannelSupport(getCurrentInstallChannel({ packageRoot }), packageRoot);
        }
        catch {
            support = null;
        }
    }
    const cannot = support && !support.canSelfUpdate ? support.guidance : undefined;
    if (policy === 'off')
        return { updates: 'off', door: input.entryPoint, ...(cannot ? { unsupported: cannot } : {}) };
    if (cannot)
        return { updates: 'unsupported', guidance: cannot, door: input.entryPoint };
    if (latestVersion && !policyPermits(policy, bumpKind(input.currentVersion, latestVersion)))
        return { updates: 'held', door: input.entryPoint, setting: policy };
    return { updates: 'on', door: input.entryPoint };
}
export function updateNoticeForEntryPoint(input) {
    try {
        const now = input.now ?? new Date();
        const memo = input.entryPoint === 'mcp' ? new ProcessMemo(input.processOnce, input.currentVersion, now) : null;
        if (memo?.decided())
            return null;
        const dir = input.dir ?? memeshDir();
        const updateCheckEnabled = input.updateCheckEnabled ?? updateCheckEnabledIn(dir);
        const tag = /^[0-9A-Za-z.+-]+$/.test(input.currentVersion) ? input.currentVersion : 'unknown';
        const cache = getLastUpdateCheck(input.currentVersion, { now, updateCheckPath: path.join(dir, `update-check.${tag}.json`) });
        if (updateCheckEnabled && shouldRefreshUpdateCache(input.currentVersion, cache, now)) {
            (input.refresh ?? spawnCacheRefresh)(dir, input.currentVersion, now);
        }
        const notice = resolveUpdateNotice({ dir, currentVersion: input.currentVersion, cache, now, updateCheckEnabled });
        if (notice.kind === 'CHECK_FAILED' && !notice.attempted) {
            memo?.retryLater();
            return null;
        }
        memo?.decide();
        if (notice.kind === 'DISABLED' || notice.kind === 'UP_TO_DATE')
            return null;
        if (input.entryPoint === 'mcp'
            && recentHookNoticeExists(dir, notice.currentVersion, notice.kind === 'UPGRADE_AVAILABLE' ? notice.latestVersion : null, now)) {
            return null;
        }
        if (input.entryPoint === 'cli' && cliThrottled(dir, input.currentVersion, now))
            return null;
        if (notice.kind === 'JUST_UPGRADED') {
            const claimed = claimJustUpgradedMarker(dir);
            if (!claimed)
                return null;
            return formatUpdateNoticeLine({ ...notice, from: claimed.from, to: claimed.to });
        }
        return formatUpdateNoticeLine(notice, upgradeNoticeMode(input, notice.kind === 'UPGRADE_AVAILABLE' ? notice.latestVersion : null));
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=update-entrypoint.js.map