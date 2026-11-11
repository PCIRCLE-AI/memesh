export type McpProjectResolution = {
    project: string;
    directory?: string;
} | {
    error: 'workspace_unavailable' | 'workspace_ambiguous';
    reason: string;
    unbound?: true;
};
export declare function resolveMcpProject(launchRoot: string | undefined, rootUris: readonly string[] | null): McpProjectResolution;
//# sourceMappingURL=project-context.d.ts.map