export declare const MIN_TOOL_CALLS = 3;
export declare const HEAVY_SESSION_TOOL_CALLS = 20;
export interface SessionActivity {
    filesEdited: string[];
    bashCommands: string[];
    errorsEncountered: string[];
    toolCallCount: number;
    unrecognizedTools: string[];
}
export interface InsightEntity {
    name: string;
    type: 'session-insight';
    title: string;
    observations: string[];
    tags: string[];
}
export declare function bashEditedPaths(cmd: unknown): string[];
export declare function activityFromChatMessages(messages: unknown): SessionActivity;
export interface InsightContext {
    sessionId: string;
    baseTags: string[];
    titleLabel: string;
    date?: string;
}
export declare function buildSessionInsights(activity: SessionActivity, ctx: InsightContext): InsightEntity[];
export interface ChatSessionCaptureResult {
    outcome: 'wrote' | 'skipped';
    reason?: string;
    written: string[];
    toolCallCount: number;
    filesEdited: number;
    errorsEncountered: number;
    unrecognizedTools: string[];
}
export declare function captureChatSession(input: {
    sessionId: string;
    messages: unknown;
    sourceHost: string;
    baseTags: string[];
    titleLabel: string;
}): ChatSessionCaptureResult;
//# sourceMappingURL=session-insight.d.ts.map