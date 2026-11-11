export declare const MAX_CALL_LINE_BYTES: number;
export declare const PRE_COMPACT_READ_BUDGET_MS = 6000;
export declare function deadlineFor(budgetMs: number, nowMs?: number, uptimeMs?: number): number;
export declare function forEachTranscriptLine(filePath: string, deadlineAt: number, onLine: (line: Buffer) => void): {
    timedOut: boolean;
    longLines: number;
};
//# sourceMappingURL=transcript-lines.d.ts.map