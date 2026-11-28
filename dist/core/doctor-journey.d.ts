import { spawnSync } from 'node:child_process';
export type JourneyStepId = 'prepare' | 'remember' | 'recall' | 'send' | 'fetch';
export interface JourneyStep {
    id: JourneyStepId;
    did: string;
    ok: boolean;
    result: string;
    reason?: string;
    fix?: string;
    ms: number;
}
export interface JourneyResult {
    ok: boolean;
    steps: JourneyStep[];
    failedStep?: JourneyStepId;
    timedOut: boolean;
    elapsedMs: number;
    scratchDir: string;
    cleaned: boolean;
    cleanupError?: string;
}
export interface JourneyOptions {
    packageRoot: string;
}
export interface JourneyTestHooks {
    cliEntry?: string;
    timeoutMs?: number;
}
export declare const JOURNEY_TIMEOUT_MS = 30000;
export declare const JOURNEY_SKIP_ENV = "MEMESH_SKIP_POST_INSTALL_JOURNEY";
export declare function journeyEnv(scratch: string, base?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): NodeJS.ProcessEnv;
export type KillCommand = {
    kind: 'group';
    pid: number;
} | {
    kind: 'taskkill';
    command: string;
    args: string[];
};
export declare function killCommandFor(platform: NodeJS.Platform, pid: number, systemRoot?: string): KillCommand;
export interface KillTarget {
    pid?: number | undefined;
    exitCode?: number | null;
    signalCode?: NodeJS.Signals | null;
    kill(signal?: NodeJS.Signals | number): boolean;
}
export declare function descendantPids(root: number, run?: typeof spawnSync): number[];
export declare function killTree(child: KillTarget, platform?: NodeJS.Platform, run?: typeof spawnSync, outputOpen?: boolean): boolean;
export declare function timeoutReason(budgetMs: number, unstoppedPid?: number): string;
export declare function formatBudget(ms: number): string;
export declare function runInstallJourney(options: JourneyOptions, testHooks?: JourneyTestHooks): Promise<JourneyResult>;
export declare function formatJourney(result: JourneyResult): string[];
export interface JourneyRecord {
    ok: boolean;
    at: string;
    version: string;
    trigger: 'install-hooks' | 'setup' | 'doctor';
    failedStep?: JourneyStepId;
    reason?: string;
    fix?: string;
}
export declare function journeyRecordPath(dir?: string): string;
export declare function toJourneyRecord(result: JourneyResult, version: string, trigger: JourneyRecord['trigger'], now?: Date): JourneyRecord;
export declare function writeJourneyRecord(record: JourneyRecord, dir?: string): void;
export declare function readJourneyRecord(dir?: string): JourneyRecord | undefined | {
    unreadable: string;
};
export declare function refreshExistingJourneyRecord(result: JourneyResult, version: string): void;
export declare function journeySkipped(flagNoJourney: boolean | undefined, env?: NodeJS.ProcessEnv): boolean;
export declare function runPostInstallJourney(input: {
    packageRoot: string;
    version: string;
    trigger: 'install-hooks' | 'setup';
    journeyFlag?: boolean;
}, testHooks?: JourneyTestHooks): Promise<void>;
//# sourceMappingURL=doctor-journey.d.ts.map