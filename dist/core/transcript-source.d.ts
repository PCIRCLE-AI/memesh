export declare const MAX_TRANSCRIPT_SOURCE_BYTES: number;
export interface TranscriptSnapshot {
    bytes: Buffer;
    modifiedAt: string;
    sizeBytes: number;
}
export declare function readTranscriptSnapshot(transcriptPath: string, expected?: {
    modifiedAt: string;
    sizeBytes: number;
}): TranscriptSnapshot | null;
export declare function claudeProjectsDir(): string;
export declare function projectTranscriptSlug(cwd: string): string;
export declare function recordedCwd(text: string): string | null;
export declare function transcriptMatchesProject(bytes: Buffer, cwd: string): boolean;
export interface TranscriptSession {
    sessionId: string;
    path: string;
    modifiedAt: string;
    lineCount: number;
    sizeBytes: number;
}
export interface ScanOptions {
    cwd?: string;
    windowDays?: number;
    now?: Date;
}
export declare function scanTranscripts(opts?: ScanOptions): TranscriptSession[];
//# sourceMappingURL=transcript-source.d.ts.map