import fs from 'fs';
export declare function isDamagedDatabaseError(message: string): boolean;
export declare function damagedDatabaseSteps(databasePath: string): {
    copy: string;
    restore?: string;
    salvage: string;
    replace: string;
};
export declare function damagedDatabaseFix(databasePath: string): string;
export declare function diagnoseDatabaseFailure(err: unknown, databasePath: string, existsSyncImpl?: (p: fs.PathLike) => boolean, statSyncImpl?: typeof fs.statSync): {
    diagnosis: string;
    fix: string;
};
export declare function databaseOpenFailureReport(err: unknown, databasePath: string): string;
//# sourceMappingURL=database-diagnosis.d.ts.map