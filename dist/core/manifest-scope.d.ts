export declare const MANIFEST_WIRING_FILES: readonly ["hooks/hooks.json", "hooks/native-memory.js", ".claude-plugin/mcp.json", ".claude-plugin/plugin.json", ".codex-plugin/mcp.json", ".codex-plugin/plugin.json"];
export declare const MANIFEST_SKILLS_DIR = "skills";
export declare const MANIFEST_HOOKS_DIR = "scripts/hooks";
export interface ManifestScope {
    files: string[];
    missingRequired: string[];
    symlinks: string[];
    unreadable: string[];
    strayFolders: string[];
    special: string[];
}
export declare function manifestScope(packageRoot: string): ManifestScope;
//# sourceMappingURL=manifest-scope.d.ts.map