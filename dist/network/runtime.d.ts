import { type NetworkContext } from './types.js';
export declare function isPlatformSupported(lockText: string, platform: string, arch: string, libc: string | null): boolean;
export declare function explainInstallFailure(spawnError: NodeJS.ErrnoException | undefined, output: string): string;
export declare function checkRuntime(ctx: NetworkContext, timeoutMs?: number): void;
export declare function npmInvocation(args: string[], platform?: NodeJS.Platform, execPath?: string, exists?: (file: string) => boolean): {
    command: string;
    args: string[];
} | null;
export interface InstallOptions {
    force?: boolean;
    checkTimeoutMs?: number;
    onProgress?: (message: string) => void;
}
export declare function ensureRuntime(ctx: NetworkContext, options?: InstallOptions): void;
//# sourceMappingURL=runtime.d.ts.map