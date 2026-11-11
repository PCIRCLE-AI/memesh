export type ProjectScope = string | readonly string[] | null;
export declare const noProjectTag: (alias?: string) => string;
export declare const ownFolderNote: (alias?: string) => string;
export declare const folderNoteMayTravel: (alias?: string) => string;
export declare function projectScopeFilter(scope: ProjectScope, alias?: string): {
    sql: string;
    params: string[];
};
//# sourceMappingURL=project-scope.d.ts.map