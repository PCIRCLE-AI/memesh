import fs from 'node:fs';
import path from 'node:path';
import { startBridge } from './bridge-control.js';
import { readConfig } from './store.js';
import { networkDir } from './types.js';
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