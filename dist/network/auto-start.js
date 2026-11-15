import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { probeBridge } from './control-socket.js';
import { logPath } from './bridge-state.js';
import { startBridge } from './bridge-control.js';
import { readConfig } from './store.js';
import { networkDir, childEnv } from './types.js';
export async function bootstrapNetworkBridge(ctx, cliEntry) {
    let directory;
    try {
        directory = fs.lstatSync(networkDir(ctx.dataDir));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return 'not-joined';
        throw error;
    }
    if (!directory.isDirectory() || directory.isSymbolicLink()
        || (process.platform !== 'win32' && (directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0)))
        throw new Error('Unsafe network directory');
    const probe = await probeBridge(ctx.dataDir, 200);
    if (probe.kind === 'running')
        return 'running';
    if (probe.kind === 'unresponsive')
        throw new Error('Network bridge unresponsive; bootstrap refused');
    const fd = fs.openSync(logPath(ctx.dataDir), fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || (process.platform !== 'win32' && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)))
            throw new Error('Unsafe network log');
        const child = spawn(process.execPath, [cliEntry, 'network', 'up'], { env: childEnv(ctx), detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref();
        return 'starting';
    }
    finally {
        fs.closeSync(fd);
    }
}
const RETRY_AFTER_MS = 30_000;
let lastTriedAt = Number.NEGATIVE_INFINITY;
export function maybeStartNetworkBridge(options) {
    if (!fs.existsSync(networkDir(options.dataDir)))
        return 'not-joined';
    let joined;
    try {
        joined = readConfig(options.db) !== null;
    }
    catch {
        joined = false;
    }
    if (!joined)
        return 'not-joined';
    const now = (options.now ?? Date.now)();
    if (now - lastTriedAt < RETRY_AFTER_MS)
        return 'recently-tried';
    lastTriedAt = now;
    const ctx = {
        dataDir: options.dataDir,
        dbPath: options.dbPath,
        bridgeEntry: path.join(options.networkDistDir, 'bridge.js'),
        assetsDir: options.networkDistDir,
    };
    const report = options.report ?? ((message) => { try {
        process.stderr.write(`${message}\n`);
    }
    catch { } });
    void (options.start ?? startBridge)(ctx).catch((err) => {
        report(`MeMesh router could not start the network bridge: ${err instanceof Error ? err.message : String(err)}`);
    });
    return 'starting';
}
export function resetAutoStartForTests() {
    lastTriedAt = Number.NEGATIVE_INFINITY;
}
//# sourceMappingURL=auto-start.js.map