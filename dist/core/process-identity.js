import { execFileSync } from 'child_process';
const CACHE_TTL_MS = 30_000;
const cache = new Map();
export const START_TAG_PREFIX = 'v2:';
export function runRealPsStart(pid, exec = execFileSync) {
    return exec('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
    });
}
export function clearStartTagCache() {
    cache.clear();
}
export function processStartTag(pid, read = runRealPsStart, now = Date.now) {
    if (process.platform === 'win32' || !Number.isSafeInteger(pid) || pid <= 0)
        return null;
    const hit = cache.get(pid);
    if (hit && now() - hit.at < CACHE_TTL_MS)
        return hit.tag;
    let tag = null;
    try {
        const out = read(pid).trim();
        tag = out === '' ? null : `${START_TAG_PREFIX}${out}`;
    }
    catch { }
    cache.set(pid, { tag, at: now() });
    return tag;
}
export function startTagComparable(started) {
    return typeof started === 'string' && started.startsWith(START_TAG_PREFIX);
}
export function sameProcessAlive(pid, started, pidAlive, read = processStartTag) {
    if (!pidAlive(pid))
        return false;
    if (!startTagComparable(started))
        return true;
    const now = read(pid);
    return now === null ? true : now === started;
}
//# sourceMappingURL=process-identity.js.map