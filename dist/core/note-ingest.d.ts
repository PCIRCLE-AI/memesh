export declare const NOTE_FILE_TAG = "source:note-file";
export declare const NOTE_FILE_MISSING_TAG = "source:note-file:missing";
export declare const NOTE_FILE_MAX_BYTES: number;
export declare const NOTE_DIR_MAX_FILES = 500;
export interface NoteIngestOptions {
    dir: string;
    project?: string;
    maxFiles?: number;
    maxBytes?: number;
}
export interface NoteIngestResult {
    dirId: string;
    discovered: number;
    created: string[];
    replaced: string[];
    unchanged: number;
    markedMissing: string[];
    skipped: Array<{
        path: string;
        reason: string;
    }>;
    more: number;
}
export interface Frontmatter {
    data: Record<string, string | Record<string, string>>;
    body: string;
}
export declare function parseFrontmatter(text: string): Frontmatter | null;
export declare function ingestNoteDirectory(opts: NoteIngestOptions): NoteIngestResult;
export declare function summarizeNoteIngest(r: NoteIngestResult): string;
//# sourceMappingURL=note-ingest.d.ts.map