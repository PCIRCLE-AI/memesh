export declare const SESSION_HANDOFF_TYPE = "session-handoff";
export declare const HANDOFF_MAX_CHARS = 800;
export declare const HANDOFF_MIN_CHARS = 80;
export declare const HANDOFF_TRANSCRIPT_TAIL_BYTES: number;
export declare function sessionHandoffName(project: string): string;
export declare function cleanHandoffText(raw: string): string;
export declare function lastAssistantText(jsonl: string): string | null;
//# sourceMappingURL=session-handoff.d.ts.map