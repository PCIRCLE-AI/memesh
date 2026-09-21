export type BriefingLevel = 'minimal' | 'standard' | 'full';
export declare const BRIEFING_LEVELS: readonly BriefingLevel[];
export declare const DEFAULT_BRIEFING_LEVEL: BriefingLevel;
export declare function isBriefingLevel(value: unknown): value is BriefingLevel;
export interface BriefingLevelResolution {
    level: BriefingLevel;
    invalid: {
        source: 'env' | 'config';
        value: string;
    } | null;
}
export declare function resolveBriefingLevel(envValue: string | undefined, configValue: unknown): BriefingLevelResolution;
export interface BriefingLevelPolicy {
    global: boolean;
    foreign: boolean;
    taskState: boolean;
    index: boolean;
    workPackageNotice: boolean;
}
export declare function briefingLevelPolicy(level: BriefingLevel): BriefingLevelPolicy;
export declare function sessionStartAppendsWorkPackageNotice(level: BriefingLevel): boolean;
//# sourceMappingURL=briefing-level.d.ts.map