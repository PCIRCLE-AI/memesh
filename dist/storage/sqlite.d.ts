declare const DatabaseSync: typeof import('node:sqlite').DatabaseSync;
export declare const MIN_NODE_VERSION = "22.16.0";
export declare const MIN_NODE_SERIES: string;
export declare class UnsupportedNodeError extends Error {
    readonly code = "NODE_TOO_OLD";
    constructor(message: string);
}
export declare function isUnsupportedNode(err: unknown): boolean;
export declare function fts5ProbeResult(createFtsTable: () => void): boolean;
export declare function nodeSupportProblem(version?: string, fts5Available?: () => boolean): string | null;
export declare function assertNodeSupported(): void;
export type SqliteStatement = import('node:sqlite').StatementSync;
export type SqlOutputValue = import('node:sqlite').SQLOutputValue;
export type SqlInputValue = import('node:sqlite').SQLInputValue;
export interface OpenOptions {
    readOnly?: boolean;
}
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
export {};
//# sourceMappingURL=sqlite.d.ts.map