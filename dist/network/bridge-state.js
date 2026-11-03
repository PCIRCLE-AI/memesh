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
function isThisBridge(command, dataDir) {
    return command.replace(/"/g, '').trimEnd().endsWith(`bridge.js serve ${dataDir}`);
}
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function linuxCommandLine(pid) {
    try {
        return fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').join(' ');
    }
    catch {
        return null;
    }
}
function commandLineFrom(program, args) {
    try {
        return execFileSync(program, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    }
    catch {
        return null;
    }
}
function commandLineOf(pid) {
    if (process.platform === 'linux') {
        const command = linuxCommandLine(pid);
        if (command !== null)
            return command;
    }
    if (process.platform === 'win32') {
        return commandLineFrom('powershell', [
            '-NoProfile', '-NonInteractive', '-Command',
            `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
        ]);
    }
    return commandLineFrom('ps', ['-ww', '-o', 'command=', '-p', String(pid)]);
}
export function identifyProcess(pid, dataDir) {
    if (!isProcessAlive(pid))
        return 'not-bridge';
    const command = commandLineOf(pid);
    if (command === null)
        return isProcessAlive(pid) ? 'unknown' : 'not-bridge';
    return isThisBridge(command, dataDir) ? 'bridge' : 'not-bridge';
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
export function bridgeHolder(dataDir) {
    const pid = readLockPid(dataDir);
    if (pid === null)
        return { kind: 'none' };
    const identity = identifyProcess(pid, dataDir);
    if (identity === 'bridge')
        return { kind: 'bridge', pid };
    return identity === 'unknown' ? { kind: 'unknown', pid } : { kind: 'none' };
}
export function removeStaleLock(dataDir, stalePid) {
    const file = lockPath(dataDir);
    const aside = `${file}.stale-${process.pid}`;
    try {
        fs.renameSync(file, aside);
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return false;
        throw err;
    }
    try {
        const value = Number(fs.readFileSync(aside, 'utf8').trim());
        const taken = Number.isSafeInteger(value) && value > 0 ? value : null;
        if (taken === stalePid)
            return true;
        try {
            fs.linkSync(aside, file);
        }
        catch (err) {
            if (err.code !== 'EEXIST')
                throw err;
        }
        return false;
    }
    finally {
        fs.rmSync(aside, { force: true });
    }
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
            const pid = readLockPid(dataDir);
            if (pid !== null && pid !== process.pid) {
                const identity = identifyProcess(pid, dataDir);
                if (identity === 'bridge')
                    return 'held';
                if (identity === 'unknown')
                    return 'unconfirmed';
            }
            removeStaleLock(dataDir, pid);
            continue;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        return readLockPid(dataDir) === process.pid ? 'acquired' : 'held';
    }
    return 'held';
}
export function releaseLock(dataDir) {
    if (readLockPid(dataDir) === process.pid)
        fs.rmSync(lockPath(dataDir), { force: true });
}
//# sourceMappingURL=bridge-state.js.map