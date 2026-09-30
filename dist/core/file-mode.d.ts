import fs from 'fs';
export declare function removeGroupAndOtherAccess(target: string): void;
export declare function belongsToAnotherUser(stat: fs.Stats): boolean;
export declare function databaseFiles(dbPath: string): [string, string, string];
export declare function guardDatabaseFiles(dbPath: string): void;
export declare function requirePrivateWritableDirectory(dir: string, purpose: string): void;
export declare const SIDECAR_PERMISSIONS_CODE = "MEMESH_SIDECAR_PERMISSIONS";
export declare function refuseMismatchedSidecars(dbPath: string): void;
export declare function ownerWriteCommand(dbPath: string): string | undefined;
//# sourceMappingURL=file-mode.d.ts.map