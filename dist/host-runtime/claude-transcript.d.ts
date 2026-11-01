export interface ClaudeTranscriptMark {
    session: string;
    file: string;
    dev: number;
    ino: number;
    offset: number;
    pending: Buffer;
    discardPartial: boolean;
}
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
    private locate;
    mark(session: string): ClaudeTranscriptMark | undefined;
    readNew(session: string, mark: ClaudeTranscriptMark): unknown[] | undefined;
    currentTask(session: string): string | undefined;
    private reset;
    private consume;
}
//# sourceMappingURL=claude-transcript.d.ts.map