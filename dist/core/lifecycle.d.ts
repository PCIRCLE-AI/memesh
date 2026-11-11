import type { MemeshDatabase } from '../storage/sqlite.js';
import { type UnmarkedWeeks } from './compression-ledger.js';
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
export declare function markCompressedRows(db: MemeshDatabase, opts?: {
    dryRun?: boolean;
}): {
    marked: number;
    unresolved: number;
    unmarkedCounts: UnmarkedWeeks;
};
export declare function backfillCompressionMarkers(db: MemeshDatabase): void;
export { PRESERVED_TYPES, NOISE_TYPES };
//# sourceMappingURL=lifecycle.d.ts.map