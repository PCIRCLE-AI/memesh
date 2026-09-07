export declare const MAX_TRANSCRIPT_SOURCE_BYTES: number;
export declare const MAX_TRANSCRIPT_SCAN_BYTES: number;
export declare const MAX_TRANSCRIPT_CANDIDATES = 256;
export interface TranscriptSnapshot {
    bytes: Buffer;
    modifiedAt: string;
    sizeBytes: number;
    device: string;
    inode: string;
    modifiedAtNanoseconds: string;
    changedAtNanoseconds: string;
}
export declare function readTranscriptSnapshot(transcriptPath: string, expected?: Omit<TranscriptSnapshot, 'bytes'>): TranscriptSnapshot | null;
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
    device: string;
    inode: string;
    modifiedAtNanoseconds: string;
    changedAtNanoseconds: string;
}
export interface ScanOptions {
    cwd: string;
    windowDays?: number;
    now?: Date;
}
export declare function scanTranscripts(opts: ScanOptions): TranscriptSession[];
//# sourceMappingURL=transcript-source.d.ts.map