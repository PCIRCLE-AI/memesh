export declare const START_TAG_PREFIX = "v2:";
type PsExec = (file: string, args: string[], options: {
    env?: NodeJS.ProcessEnv;
} & Record<string, unknown>) => string;
export declare function runRealPsStart(pid: number, exec?: PsExec): string;
export declare function clearStartTagCache(): void;
export declare function processStartTag(pid: number, read?: (pid: number) => string, now?: () => number): string | null;
export declare function startTagComparable(started: string | null | undefined): started is string;
export declare function sameProcessAlive(pid: number, started: string | null | undefined, pidAlive: (pid: number) => boolean, read?: (pid: number) => string | null): boolean;
export {};
//# sourceMappingURL=process-identity.d.ts.map