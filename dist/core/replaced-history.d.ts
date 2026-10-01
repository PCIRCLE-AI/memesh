export interface ReplacedVersion {
    replaced_at: string;
    title: string | null;
    observations: string[];
    tags: string[];
    truncated?: boolean;
}
export declare const REPLACED_HISTORY_MAX = 20;
export declare const REPLACED_HISTORY_MAX_BYTES: number;
export declare function boundReplacedHistory(history: ReplacedVersion[]): ReplacedVersion[];
//# sourceMappingURL=replaced-history.d.ts.map