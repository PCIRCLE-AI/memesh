import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { memeshDir } from './paths.js';
import { getLastUpdateCheck } from './version-check.js';
import { claimJustUpgradedMarker, resolveUpdateNotice, shouldRefreshUpdateCache } from './update-notice.js';
export const RECENT_HOOK_NOTICE_MS = 10 * 60 * 1000;
export const CLI_NOTICE_THROTTLE_MS = 24 * 60 * 60 * 1000;
export const FRESH_CHECK_THROTTLE_MS = 5 * 60 * 1000;
export function formatUpdateNoticeLine(notice) {
    switch (notice.kind) {
        case 'UPGRADE_AVAILABLE':
            return `[memesh update] ${notice.latestVersion} is available (you are on ${notice.currentVersion}). Run \`memesh update\`, or reply “Not now” / “Never ask again” in a hooked session.`;
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
            if (value.currentVersion === currentVersion && (latestVersion === null || value.latestVersion === latestVersion))
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
function updateCheckEnabledIn(dir) {
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
    try {
        const cliPath = fileURLToPath(new URL('../transports/cli/cli.js', import.meta.url));
        if (!fs.existsSync(cliPath))
            return false;
        const tag = /^[0-9A-Za-z.+-]+$/.test(currentVersion) ? currentVersion : 'unknown';
        const marker = path.join(dir, `last-fresh-refresh.${tag}.lock`);
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
                fs.writeSync(fd, `${process.pid}-${now.getTime()}`);
            }
            finally {
                fs.closeSync(fd);
            }
        }
        catch {
            return false;
        }
        const child = spawn(process.execPath, [cliPath, 'status'], {
            detached: true, stdio: 'ignore', env: { ...process.env }, windowsHide: true,
        });
        child.unref();
        return true;
    }
    catch {
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
        if (notice.kind === 'DISABLED' || notice.kind === 'SNOOZED' || notice.kind === 'UP_TO_DATE')
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
        return formatUpdateNoticeLine(notice);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=update-entrypoint.js.map