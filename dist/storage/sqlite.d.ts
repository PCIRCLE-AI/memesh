export declare const DatabaseSync: typeof import('node:sqlite').DatabaseSync;
export declare const MIN_NODE_VERSION = "22.16.0";
export declare const MIN_NODE_SERIES: string;
export interface NodeProblem {
    kind: 'too-old' | 'sqlite-switched-off' | 'no-fts5';
    message: string;
    fix: string;
}
export declare class UnsupportedNodeError extends Error {
    readonly code = "NODE_TOO_OLD";
    readonly fix: string;
    constructor(problem: NodeProblem);
}
export declare function isUnsupportedNode(err: unknown): err is UnsupportedNodeError;
export declare class SqliteSelfCheckError extends Error {
    readonly code = "SQLITE_SELF_CHECK_FAILED";
    readonly advice = "Your database is not the problem. Run the command again; if it keeps failing, free some memory or restart, then run `memesh doctor`.";
    constructor(cause: unknown);
}
export declare function isSqliteSelfCheckFailure(err: unknown): err is SqliteSelfCheckError;
export declare function fts5ProbeResult(createFtsTable: () => void): boolean;
export declare function nodeProblem(version?: string, fts5Available?: () => boolean, sqliteLoaded?: boolean): NodeProblem | null;
export declare function nodeSupportProblem(version?: string, fts5Available?: () => boolean, sqliteLoaded?: boolean): string | null;
export declare function assertNodeSupported(): void;
export type SqliteStatement = import('node:sqlite').StatementSync;
export type SqlOutputValue = import('node:sqlite').SQLOutputValue;
export type SqlInputValue = import('node:sqlite').SQLInputValue;
export interface OpenOptions {
    readOnly?: boolean;
}
export declare const BUSY_TIMEOUT_MS = 30000;
export interface TransactionFunction<A extends unknown[], R> {
    (...args: A): R;
    immediate(...args: A): R;
}
export declare class MemeshDatabase extends DatabaseSync {
    #private;
    constructor(path: string, options?: OpenOptions);
    pragma(statement: string): void;
    transaction<A extends unknown[], R>(fn: (...args: A) => R): TransactionFunction<A, R>;
}
//# sourceMappingURL=sqlite.d.ts.map