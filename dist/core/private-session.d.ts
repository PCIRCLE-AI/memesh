export declare const PRIVATE_SESSION_TOOL = "private_session";
export declare const PRIVATE_WINDOW_MS: number;
export declare const PARENT_NOT_FOUND_PERSISTENT_MS: number;
export declare const PRIVATE_CHECK_MAX_BYTES: number;
export declare const MAX_CALL_LINE_BYTES: number;
export type UncheckedReason = 'marker_unreadable' | 'unreadable' | 'timeout' | 'parent_not_found' | 'parent_unreadable' | 'too_large' | 'parent_too_large' | 'fork_too_deep' | 'header_unreadable' | 'no_zstd' | 'no_session_id';
export type UncheckedKind = 'transient' | 'persistent';
export declare const UNCHECKED_KIND: Readonly<Record<UncheckedReason, UncheckedKind>>;
export declare function uncheckedKind(reason: UncheckedReason, since?: number, now?: number): UncheckedKind;
export type PrivacyEvidence = 'marker' | 'transcript' | 'subagent' | 'fork_parent' | 'messages';
export type Unchecked = {
    state: 'unchecked';
    reason: UncheckedReason;
    kind: UncheckedKind;
    detail: string;
};
export type PrivacyState = {
    state: 'yes';
    evidence: PrivacyEvidence;
} | {
    state: 'no';
} | Unchecked;
export declare function isPrivateToolName(name: string): boolean;
export declare function sessionFileName(sessionId: string): string;
export declare function privateMarkerPath(memeshDir: string, sessionId: string): string;
export declare function chatCallsPrivateTool(messages: unknown): boolean;
export declare function forEachTranscriptLine(filePath: string, deadlineAt: number, onLine: (line: Buffer) => void): {
    timedOut: boolean;
    longLines: number;
};
export declare function prunePrivateCheckCache(cacheDir: string, now?: number): number;
export declare function sessionTranscriptFiles(transcriptPath: string): string[];
export declare function sessionLastWriteMs(transcriptPath: string): number | undefined;
export declare function findCodexRollout(codexHome: string, id: string, deadlineAt?: number): {
    file: string;
    zst: boolean;
} | undefined;
export declare function decidePrivacy(input: {
    sessionId?: string;
    transcriptPath?: string;
    snapshot?: Uint8Array;
    messages?: unknown;
    memeshDir: string;
    deadlineAt: number;
    cacheDir?: string;
}): PrivacyState;
//# sourceMappingURL=private-session.d.ts.map