import type { MemeshDatabase } from '../storage/sqlite.js';
export declare const RECENT_INDEX_SIZE = 30;
export declare const RECENT_TITLE_CHARS = 120;
export declare const AUTO_CONTEXT_EXCLUDED_TYPES: readonly string[];
export declare const RECENT_INDEX_SKIP_TYPES: readonly string[];
export declare function projectAliases(project: string | null, scope?: string | readonly string[] | null): string[];
export declare function autoContextScope(aliases: readonly string[], platform?: 'hermes'): {
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
export declare function recentTitle(row: Pick<RecentRow, 'title' | 'name'>): string;
export declare function recentLine(row: Pick<RecentRow, 'id' | 'title' | 'name'>): string;
export interface RecentIndex {
    poolIds: number[];
    shown: RecentRow[];
    lines: string[];
}
export declare function buildRecentIndex(db: MemeshDatabase, project: string | null, asOf?: number, scope?: string | readonly string[] | null): RecentIndex;
//# sourceMappingURL=recent-index.d.ts.map