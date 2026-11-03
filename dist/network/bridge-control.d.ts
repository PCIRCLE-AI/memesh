import { type NetworkContext } from './types.js';
export declare function describeChildDeath(code: number | null, signal: NodeJS.Signals | null): string;
export declare function startBridge(ctx: NetworkContext): Promise<{
    pid: number;
    started: boolean;
}>;
export declare function stopBridge(ctx: NetworkContext): Promise<{
    stopped: boolean;
    pid: number | null;
    forced: boolean;
}>;
//# sourceMappingURL=bridge-control.d.ts.map