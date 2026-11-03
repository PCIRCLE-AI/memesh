import { execFileSync } from 'child_process';
type ExecFileSyncLike = typeof execFileSync;
interface ReadbackOptions {
    execFileSyncImpl?: ExecFileSyncLike;
    readbackTimeoutMs?: number;
}
export type AutoUpdatePolicy = 'off' | 'patch' | 'minor' | 'major';
export declare function classifyBump(from: string, to: string): 'patch' | 'minor' | 'major' | null;
export declare function getInstalledGlobalVersion(options?: ReadbackOptions): string | null;
export {};
//# sourceMappingURL=updater.d.ts.map