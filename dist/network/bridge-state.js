import fs from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';
import { networkDir } from './types.js';
export function restartBindAddresses(status) {
    if (!status || typeof status !== 'object')
        return [];
    const saved = status.bind_addresses;
    const addresses = saved === undefined ? status.direct_addresses : saved;
    if (!Array.isArray(addresses))
        return [];
    const result = [];
    const families = new Set();
    for (const address of addresses) {
        if (typeof address !== 'string')
            continue;
        const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(address);
        if (!match)
            continue;
        const host = match[1] ?? match[2];
        const family = isIP(host);
        const port = Number(match[3]);
        if (!family || (family === 6) !== Boolean(match[1]) || port < 1 || port > 65_535 || families.has(family))
            continue;
        if (saved !== undefined && host !== (family === 4 ? '0.0.0.0' : '::'))
            continue;
        families.add(family);
        result.push(family === 4 ? `0.0.0.0:${port}` : `[::]:${port}`);
    }
    return result;
}
export function statusPath(dataDir) {
    return path.join(networkDir(dataDir), 'bridge-status.json');
}
export function logPath(dataDir) {
    return path.join(networkDir(dataDir), 'bridge.log');
}
export function writeStatus(dataDir, status) {
    const file = statusPath(dataDir);
    const temporary = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(status)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
}
export function readStatus(dataDir) {
    try {
        return JSON.parse(fs.readFileSync(statusPath(dataDir), 'utf8'));
    }
    catch {
        return null;
    }
}
export function reportedPid(status) {
    if (status?.state === 'stopped')
        return null;
    const pid = status?.pid;
    return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}
//# sourceMappingURL=bridge-state.js.map