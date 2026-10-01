import fs from 'fs';
export declare function diagnoseDatabaseFailure(err: unknown, databasePath: string, existsSyncImpl?: (p: fs.PathLike) => boolean, statSyncImpl?: typeof fs.statSync): {
    diagnosis: string;
    fix: string;
};
//# sourceMappingURL=database-diagnosis.d.ts.map