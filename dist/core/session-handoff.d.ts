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
export interface HandoffRecord {
    id: number;
    text: string;
    observedAt: string | null | undefined;
}
export type HandoffStatus = 'shown' | 'stale' | 'expired' | 'undatable' | 'future' | 'empty';
export declare function handoffView(record: HandoffRecord | null | undefined, now?: Date): {
    lines: string[];
    status: HandoffStatus;
};
export declare function handoffLines(record: HandoffRecord | null | undefined, now?: Date): string[];
//# sourceMappingURL=session-handoff.d.ts.map