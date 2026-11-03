import { execFileSync } from 'child_process';
const DEFAULT_READBACK_TIMEOUT_MS = 30 * 1000;
function parseSemver(version) {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].+)?$/.exec(version.trim());
    if (!m)
        return null;
    return {
        major: Number(m[1]),
        minor: Number(m[2]),
        patch: Number(m[3]),
    };
}
export function classifyBump(from, to) {
    const a = parseSemver(from);
    const b = parseSemver(to);
    if (!a || !b)
        return null;
    if (b.major > a.major)
        return 'major';
    if (b.major < a.major)
        return null;
    if (b.minor > a.minor)
        return 'minor';
    if (b.minor < a.minor)
        return null;
    if (b.patch > a.patch)
        return 'patch';
    return null;
}
function parseInstalledGlobalVersion(raw) {
    const parsed = JSON.parse(raw);
    return parsed.dependencies?.['@pcircle/memesh']?.version ?? null;
}
export function getInstalledGlobalVersion(options = {}) {
    const { execFileSyncImpl = execFileSync, readbackTimeoutMs = DEFAULT_READBACK_TIMEOUT_MS, } = options;
    try {
        const raw = execFileSyncImpl('npm', ['ls', '-g', '@pcircle/memesh', '--json', '--depth=0'], { encoding: 'utf8', timeout: readbackTimeoutMs });
        return parseInstalledGlobalVersion(raw);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=updater.js.map