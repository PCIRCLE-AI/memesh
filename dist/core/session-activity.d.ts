export declare function formatSessionActivity(fields: {
    repo?: string;
    status?: string;
    title?: string;
    task?: string;
}): string | undefined;
export declare function readCodexTitle(codexHome: string, session: string): string | undefined;
export declare function readCodexPlanActivity(dataDir: string, session: string, workspace: string): string | undefined;
export declare const defaultClaudeDir: () => string;
export declare function startsMatch(actual: string, recorded: string): boolean;
export declare function readClaudeRegistry(pid: number, claudeDir?: string): Record<string, unknown> | undefined;
export declare function createClaudeActivity(pid: number, workspace: string, claudeDir?: string): () => string | undefined;
export declare function createCodexActivity(session: string, workspace: string, dataDir: string, codexHome?: string): () => string | undefined;
//# sourceMappingURL=session-activity.d.ts.map