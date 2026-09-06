import { MemeshDatabase } from './storage/sqlite.js';
import { runOnceMigration, FTS_SEGMENTATION_VERSION } from './storage/schema.js';
export { runOnceMigration, FTS_SEGMENTATION_VERSION };
export declare function openDatabase(dbPath?: string): MemeshDatabase;
export declare function reindexFts(): {
    entities: number;
};
export declare function closeDatabase(): void;
export declare function getDatabase(): MemeshDatabase;
export declare function isDatabaseOpen(): boolean;
//# sourceMappingURL=db.d.ts.map