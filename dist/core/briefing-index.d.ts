export declare const INDEX_MAX_LINES = 40;
export declare const INDEX_MAX_BYTES = 3072;
export declare const INDEX_STALE_DAYS = 180;
export declare const INDEX_LINE_MAX_CHARS = 120;
export declare const INDEX_SNIPPET_FETCH_CHARS = 4000;
export declare const INDEX_CANDIDATE_CAP = 2000;
export declare const INDEX_EXCLUDED_TYPES: readonly string[];
export declare function isIndexableType(type: string | null | undefined): boolean;
export interface IndexCandidate {
    id: number;
    type: string | null;
    title?: string | null;
    snippet?: string | null;
    lastActivity: string | null;
    metadata?: unknown;
}
export interface BriefingIndex {
    lines: string[];
    shown: number;
    more: number;
    older: number;
    truncated: boolean;
    bytes: number;
    tokens: number;
    ids: number[];
}
export declare function buildBriefingIndex(candidates: readonly IndexCandidate[], projectName: string, now: number, options?: {
    truncated?: boolean;
}): BriefingIndex;
//# sourceMappingURL=briefing-index.d.ts.map