import fs from 'fs';
import path from 'path';
import { redactUserPaths } from './paths.js';
export const UP_TO_DATE_REFRESH_MS = 60 * 60 * 1000;
export const UPGRADE_AVAILABLE_REFRESH_MS = 12 * 60 * 60 * 1000;
export const ANSWER_VALID_MS = 24 * 60 * 60 * 1000;
export const SNOOZE_LEVEL_MS = [24 * 60 * 60 * 1000, 48 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000];
const SNOOZE_FILE = 'update-snooze.json';
const JUST_UPGRADED_FILE = 'just-upgraded.json';
export function isStrictlyOlder(a, b) {
    const parse = (v) => {
        const [main, ...rest] = String(v).split(/[-+]/);
        const nums = main.split('.').map((s) => Number.parseInt(s, 10));
        return { nums, tail: rest.join('-') };
    };
    const pa = parse(a);
    const pb = parse(b);
    const len = Math.max(pa.nums.length, pb.nums.length);
    for (let i = 0; i < len; i++) {
        const ai = Number.isFinite(pa.nums[i]) ? pa.nums[i] : 0;
        const bi = Number.isFinite(pb.nums[i]) ? pb.nums[i] : 0;
        if (ai !== bi)
            return ai < bi;
    }
    if (pa.tail && !pb.tail)
        return true;
    if (!pa.tail && pb.tail)
        return false;
    return pa.tail < pb.tail;
}
function parseIso(value) {
    if (typeof value !== 'string')
        return null;
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
}
function readJson(file) {
    try {
        if (!fs.existsSync(file))
            return null;
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
function writePrivateJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
    try {
        fs.chmodSync(file, 0o600);
    }
    catch { }
}
export function readSnooze(dir) {
    const raw = readJson(path.join(dir, SNOOZE_FILE));
    if (!raw)
        return null;
    const { target, level, since } = raw;
    if (typeof target !== 'string' || !target)
        return null;
    if (typeof level !== 'number' || !Number.isInteger(level) || level < 1)
        return null;
    if (parseIso(since) === null)
        return null;
    return { target, level, since: since };
}
export function writeSnooze(dir, target, now = new Date()) {
    const previous = readSnooze(dir);
    const level = previous && previous.target === target
        ? Math.min(previous.level + 1, SNOOZE_LEVEL_MS.length)
        : 1;
    const state = { target, level, since: now.toISOString() };
    writePrivateJson(path.join(dir, SNOOZE_FILE), state);
    return state;
}
export function clearSnooze(dir) {
    try {
        fs.unlinkSync(path.join(dir, SNOOZE_FILE));
    }
    catch { }
}
export function snoozeExpiresAt(state) {
    const since = parseIso(state.since) ?? 0;
    const duration = SNOOZE_LEVEL_MS[Math.min(state.level, SNOOZE_LEVEL_MS.length) - 1];
    return since + duration;
}
export function readJustUpgradedMarker(dir) {
    const raw = readJson(path.join(dir, JUST_UPGRADED_FILE));
    if (!raw)
        return null;
    const { from, to, at } = raw;
    if (typeof from !== 'string' || !from || typeof to !== 'string' || !to)
        return null;
    return { from, to, at: typeof at === 'string' ? at : '' };
}
export function writeJustUpgradedMarker(dir, from, to, now = new Date()) {
    writePrivateJson(path.join(dir, JUST_UPGRADED_FILE), { from, to, at: now.toISOString() });
}
export function clearJustUpgradedMarker(dir) {
    try {
        fs.unlinkSync(path.join(dir, JUST_UPGRADED_FILE));
    }
    catch { }
}
export function claimJustUpgradedMarker(dir) {
    const file = path.join(dir, JUST_UPGRADED_FILE);
    const taken = `${file}.claimed-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    try {
        fs.renameSync(file, taken);
    }
    catch {
        return null;
    }
    const raw = readJson(taken);
    try {
        fs.unlinkSync(taken);
    }
    catch { }
    if (!raw)
        return null;
    const { from, to, at } = raw;
    if (typeof from !== 'string' || !from || typeof to !== 'string' || !to)
        return null;
    return { from, to, at: typeof at === 'string' ? at : '' };
}
function boundedReason(raw) {
    const oneLine = redactUserPaths(raw).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return oneLine.length > 160 ? `${oneLine.slice(0, 157)}...` : oneLine;
}
function answerIsCurrent(currentVersion, cache, now) {
    if (!cache || cache.currentVersion !== currentVersion)
        return false;
    if (typeof cache.latestVersion !== 'string' || !cache.latestVersion)
        return false;
    const successAt = parseIso(cache.lastSuccessfulCheckAt);
    if (successAt === null)
        return false;
    return now.getTime() - successAt <= ANSWER_VALID_MS;
}
export function shouldRefreshUpdateCache(currentVersion, cache, now = new Date()) {
    if (!answerIsCurrent(currentVersion, cache, now))
        return true;
    const successAt = parseIso(cache.lastSuccessfulCheckAt);
    const age = now.getTime() - successAt;
    const upgrade = isStrictlyOlder(currentVersion, cache.latestVersion);
    return age > (upgrade ? UPGRADE_AVAILABLE_REFRESH_MS : UP_TO_DATE_REFRESH_MS);
}
export function resolveUpdateNotice(input) {
    const { dir, currentVersion, cache } = input;
    const now = input.now ?? new Date();
    if (input.updateCheckEnabled === false)
        return { kind: 'DISABLED', currentVersion };
    const marker = readJustUpgradedMarker(dir);
    if (marker) {
        if (marker.to === currentVersion) {
            return { kind: 'JUST_UPGRADED', currentVersion, from: marker.from, to: marker.to };
        }
        clearJustUpgradedMarker(dir);
    }
    if (!answerIsCurrent(currentVersion, cache, now)) {
        let reason = 'no update check has completed yet';
        let attempted = false;
        if (cache && cache.currentVersion === currentVersion) {
            attempted = parseIso(cache.lastSuccessfulCheckAt) !== null
                || (typeof cache.lastError === 'string' && cache.lastError.length > 0);
            if (typeof cache.lastError === 'string' && cache.lastError)
                reason = boundedReason(cache.lastError);
            else if (parseIso(cache.lastSuccessfulCheckAt) !== null)
                reason = 'the last successful check is more than a day old';
        }
        return { kind: 'CHECK_FAILED', currentVersion, reason, attempted };
    }
    const latestVersion = cache.latestVersion;
    if (!isStrictlyOlder(currentVersion, latestVersion)) {
        return { kind: 'UP_TO_DATE', currentVersion, latestVersion };
    }
    const snooze = readSnooze(dir);
    if (snooze && snooze.target === latestVersion) {
        const until = snoozeExpiresAt(snooze);
        if (now.getTime() < until) {
            return { kind: 'SNOOZED', currentVersion, latestVersion, until: new Date(until).toISOString(), level: snooze.level };
        }
    }
    return { kind: 'UPGRADE_AVAILABLE', currentVersion, latestVersion };
}
//# sourceMappingURL=update-notice.js.map