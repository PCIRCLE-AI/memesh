import { type NetworkContext } from './types.js';
export declare function isPlatformSupported(lockText: string, platform: string, arch: string, libc: string | null): boolean;
export declare function explainInstallFailure(spawnError: NodeJS.ErrnoException | undefined, output: string): string;
export declare function checkRuntime(ctx: NetworkContext): void;
export interface InstallOptions {
    force?: boolean;
    onProgress?: (message: string) => void;
}
export declare function ensureRuntime(ctx: NetworkContext, options?: InstallOptions): void;
//# sourceMappingURL=runtime.d.ts.map