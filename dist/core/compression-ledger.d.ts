import type { MemeshDatabase } from '../storage/sqlite.js';
export declare const COMPRESSION_WEEK_FORMAT = "%Y-W%W";
export declare const UNMARKED_COMPRESSED_KEY = "compression_unmarked_counts";
export type UnmarkedWeeks = Record<string, {
    before: string;
    counts: Record<string, number>;
}>;
export declare function writeUnmarkedCompressedCounts(db: MemeshDatabase, weeks: UnmarkedWeeks): void;
export declare function unmarkedCompressedCommits(db: MemeshDatabase): number;
export declare function releaseCompressedRecord(db: MemeshDatabase, entityId: number): void;
//# sourceMappingURL=compression-ledger.d.ts.map