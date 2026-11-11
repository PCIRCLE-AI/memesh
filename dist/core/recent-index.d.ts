import type { MemeshDatabase } from '../storage/sqlite.js';
export declare const RECENT_INDEX_SIZE = 30;
export declare const STALE_SUPERSEDE_TAU = 0.2;
export declare const STALE_PENDING_MAX_DAYS = 0;
export declare const RECENT_TITLE_CHARS = 120;
export declare const AUTO_CONTEXT_EXCLUDED_TYPES: readonly string[];
export declare const RECENT_INDEX_SKIP_TYPES: readonly string[];
export declare const PENDING_TITLE: RegExp;
export declare function projectAliases(project: string | null, cwd?: string | null): string[];
export declare function autoContextScope(aliases: readonly string[]): {
    sql: string;
    params: string[];
};
export declare function sqliteInstant(ms: number): string;
export declare function tableColumns(db: MemeshDatabase, table: string): Set<string>;
export interface RecentRow {
    id: number;
    name: string;
    type: string;
    title: string | null;
    createdMs: number;
    lastMs: number;
    projects: string[];
}
export declare const shownText: (row: Pick<RecentRow, "title" | "name">) => string;
export declare function readRecentPool(db: MemeshDatabase, aliases: readonly string[], asOf: number): RecentRow[];
export declare function readRecentRows(db: MemeshDatabase, ids: readonly number[], asOf: number, aliases: readonly string[]): RecentRow[];
export declare function staleReason(row: RecentRow, shownWith: readonly RecentRow[], asOf: number): 'superseded' | 'waiting' | null;
export declare function recentTitle(row: Pick<RecentRow, 'title' | 'name'>): string;
export declare function recentLine(row: Pick<RecentRow, 'id' | 'title' | 'name'>): string;
export interface RecentIndex {
    poolIds: number[];
    shown: RecentRow[];
    removed: Array<{
        id: number;
        reason: 'superseded' | 'waiting';
    }>;
    lines: string[];
}
export declare function buildRecentIndex(db: MemeshDatabase, project: string | null, asOf?: number, cwd?: string | null): RecentIndex;
//# sourceMappingURL=recent-index.d.ts.map