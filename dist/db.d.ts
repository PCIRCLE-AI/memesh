import { MemeshDatabase } from './storage/sqlite.js';
import { runOnceMigration, FTS_SEGMENTATION_VERSION } from './storage/schema.js';
export { runOnceMigration, FTS_SEGMENTATION_VERSION };
export declare function openDatabase(dbPath?: string, opts?: {
    busyTimeoutMs?: number;
    readOnly?: boolean;
}): MemeshDatabase;
export declare function openInitialisedDatabase(resolvedPath: string, opts?: {
    busyTimeoutMs?: number;
}, mode?: {
    immutableFile?: string;
    readOnly?: boolean;
}): MemeshDatabase;
export declare function reindexFts(): {
    entities: number;
};
export declare function closeDatabase(): void;
export declare function explainReadOnlyRefusal(err: unknown): string | null;
export declare function failureMessage(err: unknown): string;
export declare function readOnlyFolderState(): {
    note: string;
    reason: string;
    fix: string;
} | null;
export declare function getDatabase(): MemeshDatabase;
export declare function isDatabaseOpen(): boolean;
//# sourceMappingURL=db.d.ts.map