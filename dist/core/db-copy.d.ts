import type { MemeshDatabase } from '../storage/sqlite.js';
export declare const DB_COPIES_KEPT = 3;
export declare function backupDirectoryFor(dbPath: string): string;
export type DbCopyOutcome = {
    kind: 'ready';
    path: string;
} | {
    kind: 'failed';
    reason: string;
};
export declare function copyDatabaseBefore(db: MemeshDatabase, prefix: string, inCopy?: (schema: string) => void): DbCopyOutcome;
//# sourceMappingURL=db-copy.d.ts.map