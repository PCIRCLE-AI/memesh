import type { MemeshDatabase } from '../storage/sqlite.js';
export declare function runAutoDecay(db: MemeshDatabase): {
    decayed: number;
};
export declare function getDecayStatus(db: MemeshDatabase): {
    lastDecayAt: string | null;
    entitiesBelowThreshold: number;
};
declare const PRESERVED_TYPES: Set<string>;
declare const NOISE_TYPES: Set<string>;
export declare function compressWeeklyNoise(db: MemeshDatabase): {
    compressed: number;
    weeksProcessed: number;
};
export declare const AUTO_ARCHIVE_TYPES: readonly ["commit", "session-insight", "session-summary"];
export declare const AUTO_ARCHIVE_UNUSED_DAYS = 14;
export declare const AUTO_ARCHIVE_AT_KEY = "last_auto_archive_at";
export declare const AUTO_ARCHIVE_RUN_KEY = "last_auto_archive_run";
export interface AutoArchiveRun {
    at: string;
    unusedDays: number;
    archived: number;
    byType: Record<string, number>;
    keptCited: number;
    ids: number[];
}
export declare function archiveUnusedAutoCaptured(db: MemeshDatabase, now?: Date): AutoArchiveRun | null;
export declare class AutoArchiveRecordUnreadable extends Error {
    constructor(detail: string);
}
export declare function readLastAutoArchiveRun(db: {
    prepare(sql: string): {
        get(): unknown;
    };
}): AutoArchiveRun | null;
export { PRESERVED_TYPES, NOISE_TYPES };
//# sourceMappingURL=lifecycle.d.ts.map