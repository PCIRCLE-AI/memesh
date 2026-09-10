import fs from 'fs';
import path from 'path';
import { memeshDir } from './paths.js';
import { getLastUpdateCheck } from './version-check.js';
import { claimJustUpgradedMarker, resolveUpdateNotice } from './update-notice.js';
export const RECENT_HOOK_NOTICE_MS = 10 * 60 * 1000;
export const CLI_NOTICE_THROTTLE_MS = 24 * 60 * 60 * 1000;
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
        try {
            const stat = fs.statSync(file);
            if (now.getTime() - stat.mtimeMs > RECENT_HOOK_NOTICE_MS)
                continue;
            const value = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (value.currentVersion === currentVersion && value.latestVersion === latestVersion)
                return true;
        }
        catch { }
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
    try {
        const stat = fs.statSync(marker);
        if (now.getTime() - stat.mtimeMs < CLI_NOTICE_THROTTLE_MS)
            return true;
    }
    catch { }
    try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(marker, String(now.getTime()), { mode: 0o600 });
        try {
            fs.chmodSync(marker, 0o600);
        }
        catch { }
    }
    catch { }
    return false;
}
export function updateNoticeForEntryPoint(input) {
    try {
        const dir = input.dir ?? memeshDir();
        const now = input.now ?? new Date();
        const updateCheckEnabled = input.updateCheckEnabled ?? updateCheckEnabledIn(dir);
        const tag = /^[0-9A-Za-z.+-]+$/.test(input.currentVersion) ? input.currentVersion : 'unknown';
        const cache = getLastUpdateCheck(input.currentVersion, { now, updateCheckPath: path.join(dir, `update-check.${tag}.json`) });
        const notice = resolveUpdateNotice({ dir, currentVersion: input.currentVersion, cache, now, updateCheckEnabled });
        if (notice.kind === 'DISABLED' || notice.kind === 'SNOOZED' || notice.kind === 'UP_TO_DATE')
            return null;
        if (input.entryPoint === 'mcp') {
            const key = `${input.currentVersion}`;
            if (input.processOnce?.has(key))
                return null;
            input.processOnce?.add(key);
            if (notice.kind === 'UPGRADE_AVAILABLE' && recentHookNoticeExists(dir, notice.currentVersion, notice.latestVersion, now))
                return null;
        }
        else if (cliThrottled(dir, input.currentVersion, now)) {
            return null;
        }
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