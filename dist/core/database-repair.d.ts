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
export declare function repairDatabase(database: string, options?: {
    fromBackup?: string | true;
    sqliteExecutable?: string;
    replaceFile?: (from: string, to: string) => void;
}): RepairResult;
//# sourceMappingURL=database-repair.d.ts.map