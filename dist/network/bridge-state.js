import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { networkDir } from './types.js';
export function statusPath(dataDir) {
    return path.join(networkDir(dataDir), 'bridge-status.json');
}
export function lockPath(dataDir) {
    return path.join(networkDir(dataDir), 'bridge.pid');
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
export function isBridgeProcess(pid) {
    try {
        process.kill(pid, 0);
    }
    catch {
        return false;
    }
    if (process.platform === 'win32')
        return true;
    try {
        const command = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
        return /bridge\.js serve/.test(command);
    }
    catch (err) {
        return err.status === undefined;
    }
}
export function readLockPid(dataDir) {
    try {
        const pid = Number(fs.readFileSync(lockPath(dataDir), 'utf8').trim());
        return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    }
    catch {
        return null;
    }
}
export function runningBridgePid(dataDir) {
    const pid = readLockPid(dataDir);
    return pid !== null && isBridgeProcess(pid) ? pid : null;
}
export async function acquireLock(dataDir) {
    const file = lockPath(dataDir);
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            fs.writeFileSync(file, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
        }
        catch (err) {
            if (err.code !== 'EEXIST')
                throw err;
            if (runningBridgePid(dataDir) !== null)
                return false;
            fs.rmSync(file, { force: true });
            continue;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        return readLockPid(dataDir) === process.pid;
    }
    return false;
}
export function releaseLock(dataDir) {
    if (readLockPid(dataDir) === process.pid)
        fs.rmSync(lockPath(dataDir), { force: true });
}
//# sourceMappingURL=bridge-state.js.map