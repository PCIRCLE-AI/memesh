export interface ChatTurnCaptureResult {
    outcome: 'wrote' | 'skipped';
    reason?: string;
    names?: string[];
}
export declare function captureChatTurn(input: {
    sessionId: string;
    userText: string;
    assistantText: string;
    sourceHost: string;
    namePrefix: string;
    baseTags: string[];
}): ChatTurnCaptureResult;
//# sourceMappingURL=chat-turn.d.ts.map