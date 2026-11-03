import fs from 'node:fs';
import path from 'node:path';
import { networkDir } from './types.js';
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
//# sourceMappingURL=bridge-state.js.map