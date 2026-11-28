export declare const SESSION_HANDOFF_TYPE = "session-handoff";
export declare const HANDOFF_SESSION_LIMIT = 3;
export declare const HANDOFF_MAX_BYTES = 600;
export declare const HANDOFF_TRANSCRIPT_TAIL_BYTES: number;
export declare function lastAssistantText(jsonl: string): string | null;
export declare const AGENT_TEXT_OMITTED = "[text from an agent message omitted]";
export declare const AGENT_QUOTE_MIN_CHARS = 24;
export declare const CHANNEL_SCAN_MAX_CHARS: number;
export declare function agentMessageTexts(jsonl: string): {
    texts: string[];
    unreadTags: number;
};
export declare function omitAgentMessageText(text: string, payloads: readonly string[]): {
    text: string;
    omitted: number;
};
export interface HandoffRecord {
    id: number;
    text: string;
    observedAt: string | null | undefined;
    metadata?: string | null;
}
export declare function handoffView(record: HandoffRecord | null | undefined, now?: Date): {
    lines: string[];
    status: 'shown' | 'empty';
};
export declare function handoffLines(record: HandoffRecord | null | undefined, now?: Date): string[];
//# sourceMappingURL=session-handoff.d.ts.map