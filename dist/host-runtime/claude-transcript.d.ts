export declare class ClaudeTranscriptReader {
    private readonly projectsDir;
    private readonly projectSlug?;
    private session;
    private file?;
    private offset;
    private identity;
    private pending;
    private plan?;
    private calls;
    constructor(projectsDir: string, projectSlug?: string | undefined);
    currentTask(session: string): string | undefined;
    private reset;
    private consume;
}
//# sourceMappingURL=claude-transcript.d.ts.map