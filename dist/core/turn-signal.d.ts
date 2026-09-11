export type TurnSignalKind = 'decision' | 'lesson';
export interface TurnSignal {
    kind: TurnSignalKind;
    cue: string;
}
export declare function classifyTurn(userText: string, assistantText: string): TurnSignal | null;
export declare const TURN_TEXT_CAP = 2000;
export interface ChatTurnCaptureResult {
    outcome: 'wrote' | 'skipped';
    reason?: string;
    name?: string;
    kind?: TurnSignalKind;
}
export declare function captureChatTurn(input: {
    sessionId: string;
    userText: string;
    assistantText: string;
    sourceHost: string;
    namePrefix: string;
    baseTags: string[];
}): ChatTurnCaptureResult;
//# sourceMappingURL=turn-signal.d.ts.map