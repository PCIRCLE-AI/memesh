export declare const SESSION_HANDOFF_TYPE = "session-handoff";
export declare const HANDOFF_STALE_HOURS = 72;
export declare const HANDOFF_MAX_AGE_DAYS = 14;
export declare const HANDOFF_FUTURE_SKEW_MINUTES = 5;
export declare const HANDOFF_MAX_CHARS = 800;
export declare const HANDOFF_MIN_CHARS = 80;
export declare const HANDOFF_TRANSCRIPT_TAIL_BYTES: number;
export declare function sessionHandoffName(project: string): string;
export declare function cleanHandoffText(raw: string): string;
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
export type HandoffStatus = 'shown' | 'stale' | 'expired' | 'undatable' | 'future' | 'empty';
export declare function handoffView(record: HandoffRecord | null | undefined, now?: Date): {
    lines: string[];
    status: HandoffStatus;
};
export declare function handoffLines(record: HandoffRecord | null | undefined, now?: Date): string[];
//# sourceMappingURL=session-handoff.d.ts.map