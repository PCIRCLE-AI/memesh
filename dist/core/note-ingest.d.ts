import { PRIVATE_STATE_BUSY } from './private-state-lock.js';
export declare const NOTE_FILE_TAG = "source:note-file";
export declare const NOTE_FILE_MISSING_TAG = "source:note-file:missing";
export declare const NOTE_FILE_MAX_BYTES: number;
export declare const NOTE_DIR_MAX_FILES = 500;
export interface NoteIngestOptions {
    dir: string;
    project?: string;
    maxFiles?: number;
    maxBytes?: number;
    now?: number;
    deadlineAt?: number;
}
export interface NoteIngestResult {
    dirId: string;
    discovered: number;
    created: string[];
    replaced: string[];
    unchanged: number;
    repathed: string[];
    restored: string[];
    markedMissing: string[];
    skipped: Array<{
        path: string;
        reason: string;
    }>;
    pendingPrivate: number;
    held: {
        private: number;
        unchecked: number;
    };
    redecideLeft: number;
    refusedNow: number;
    more: number;
}
export interface Frontmatter {
    data: Record<string, string | Record<string, string>>;
    body: string;
}
export declare function parseFrontmatter(text: string): Frontmatter | null;
export declare const NOTE_MARKERS_UNREADABLE = "MEMESH_NOTE_MARKERS_UNREADABLE";
export declare const NOTE_MARKERS_DIR_UNREADABLE = "MEMESH_NOTE_MARKERS_DIR_UNREADABLE";
export declare const NOTE_MARKER_UNWRITABLE = "MEMESH_NOTE_MARKER_UNWRITABLE";
export declare const NOTE_HOLDS_UNREADABLE = "MEMESH_NOTE_HOLDS_UNREADABLE";
export declare const NOTE_HOLDS_DIR_UNREADABLE = "MEMESH_NOTE_HOLDS_DIR_UNREADABLE";
export declare const NOTE_HOLDS_UNWRITABLE = "MEMESH_NOTE_HOLDS_UNWRITABLE";
export declare const NOTE_FOLDER_UNREADABLE = "MEMESH_NOTE_FOLDER_UNREADABLE";
export { PRIVATE_STATE_BUSY };
export declare const NOTE_PRIVATE_HOLD_REASON = "held out by a private session \u2014 not imported";
export declare const NOTE_UNCHECKED_HOLD_REASON = "held while a session could not be checked \u2014 not imported yet";
export declare function realPathOrExpected(dir: string): string;
export declare const projectsRootOf: (memoryDir: string) => string;
export declare function projectMemoryFolders(projectsRoot: string): string[];
export declare function markPrivateSession(opts: {
    sessionId: string;
    dirs?: readonly string[];
    projectsRoot?: string;
    transcript?: string;
    now?: number;
    holdsAt?: number;
    rebuildFrom?: number;
    deadlineAt?: number;
}): number;
export declare function renewPrivateSession(sessionId: string, now?: number, deadlineAt?: number): boolean;
export declare function endPrivateSession(sessionId: string, now?: number, deadlineAt?: number): void;
export declare function removeStalePrivateStateTemps(now?: number): void;
export declare function holdOutNoteFiles(opts: {
    dir?: string;
    sessionId: string;
    paths: readonly string[];
    sinceMs?: number;
    untilMs?: number;
    transcript?: string;
    tentative?: {
        reason: string;
        projectsRoot?: string;
        holdsAt?: number;
    };
    now?: number;
    deadlineAt?: number;
}): number;
export declare function settleTentativeHolds(sessionId: string, verdict: 'yes' | 'no', opts?: {
    expectRev?: number;
    deadlineAt?: number;
}): boolean;
export declare function endTentativeWait(sessionId: string, now?: number, deadlineAt?: number): void;
export interface PrivateHoldSummary {
    sessions: number;
    notes: number;
    holdsFolder: string;
    markersFolder: string;
    unsettled: Array<{
        session: string;
        file: string;
        reason: string;
        reasonText: string;
        kind: 'transient' | 'persistent';
        since: number;
        notes: number;
        transcript?: string;
        waitSince?: number;
        lastHeard: number;
    }>;
    waitingOnUnreadable: Array<{
        file: string;
        notes: number;
        since: number;
    }>;
    heldInPlaceOfUnreadable: Array<{
        file: string;
        notes: number;
    }>;
    damaged: Array<{
        folder: 'holds' | 'markers';
        file: string;
        cause: 'permission' | 'damaged';
    }>;
    unreadableFolders: Array<'holds' | 'markers'>;
}
export declare function summarizeNoteHolds(now?: number): PrivateHoldSummary;
export declare function ingestNoteDirectory(opts: NoteIngestOptions): NoteIngestResult;
export declare function summarizeNoteIngest(r: NoteIngestResult): string;
//# sourceMappingURL=note-ingest.d.ts.map