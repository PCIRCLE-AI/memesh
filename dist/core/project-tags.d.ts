import { MemeshDatabase } from '../storage/sqlite.js';
export interface ProjectTagCount {
    project: string;
    count: number;
}
export interface RenameProjectResult {
    fromTag: string;
    toTag: string;
    affectedEntities: number;
    merged: number;
    renamed: number;
    applied: boolean;
    affectedNames: string[];
    messageRows: number;
    messageRowsBlocked: number;
}
export declare function listProjectTags(db?: MemeshDatabase): ProjectTagCount[];
export declare function sameProjectRefusal(from: string, to: string): string | null;
export declare function renameProjectTag(from: string, to: string, opts?: {
    apply?: boolean;
    db?: MemeshDatabase;
}): RenameProjectResult;
export declare function hasRenameWork(from: string, db?: MemeshDatabase): boolean;
export declare function openReadOnlyForPreview(dbPath: string, openHandle?: (target: string) => MemeshDatabase): MemeshDatabase;
//# sourceMappingURL=project-tags.d.ts.map