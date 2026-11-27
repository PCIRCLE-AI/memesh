export interface RepairTable {
    name: string;
    copied: number;
    complete: boolean;
}
export interface RepairBackup {
    file: string;
    at: string;
    memories: number;
}
export interface RepairResult {
    status: 'healthy' | 'repaired';
    method?: 'sqlite3' | 'built-in' | 'backup';
    reason?: string;
    damagedCopy?: string;
    tables?: RepairTable[];
    backup?: RepairBackup;
}
export declare function usableMemoryBackups(database: string): RepairBackup[];
type Replacement = (from: string, to: string, commit: () => void | Promise<void>) => void | Promise<void>;
export declare class DatabaseReplacementOutcomeError extends Error {
}
export declare function repairDatabase(database: string, options?: {
    fromBackup?: string | true;
    sqliteExecutable?: string;
    replaceFile?: Replacement;
}): Promise<RepairResult>;
export {};
//# sourceMappingURL=database-repair.d.ts.map