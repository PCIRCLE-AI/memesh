import type { MemeshDatabase } from '../storage/sqlite.js';
import { startBridge } from './bridge-control.js';
import { type NetworkContext } from './types.js';
export declare function bootstrapNetworkBridge(ctx: NetworkContext, cliEntry: string): Promise<'not-joined' | 'running' | 'starting'>;
export interface AutoStartOptions {
    dataDir: string;
    dbPath: string;
    db: MemeshDatabase;
    networkDistDir: string;
    start?: typeof startBridge;
    report?: (message: string) => void;
    now?: () => number;
}
export type AutoStartResult = 'not-joined' | 'recently-tried' | 'starting';
export declare function maybeStartNetworkBridge(options: AutoStartOptions): AutoStartResult;
export declare function resetAutoStartForTests(): void;
//# sourceMappingURL=auto-start.d.ts.map