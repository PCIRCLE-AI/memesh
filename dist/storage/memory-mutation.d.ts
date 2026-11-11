import type { MemeshDatabase } from './sqlite.js';
export declare function projectOwnershipRefusal(db: MemeshDatabase, name: string, project: string | null, projectIds?: readonly string[]): string | undefined;
export declare function projectTagsOf(db: MemeshDatabase, entityId: number): string[];
export declare function filedUnder(projectTags: readonly string[], project: string, projectIds?: readonly string[]): string | undefined;
//# sourceMappingURL=memory-mutation.d.ts.map