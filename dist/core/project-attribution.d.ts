export declare const PROJECT_TAG_PREFIX = "project:";
export declare const MIN_NAME_PROJECT_LENGTH = 2;
export declare const KNOWN_ERROR_PATTERNS: readonly ["null-reference", "type-error", "import-missing", "config-error", "test-failure", "build-error", "other"];
export declare function extractProjectFromName(name: string): string | null;
export declare function extractProjectFromEntity(tags: string[] | null | undefined, name: string): {
    project: string | null;
    source: 'tag' | 'heuristic' | null;
};
//# sourceMappingURL=project-attribution.d.ts.map