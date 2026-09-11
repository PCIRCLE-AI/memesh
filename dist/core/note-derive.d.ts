export declare const NOTE_OBSERVATION_MAX_CHARS = 10000;
export declare const NOTE_MAX_OBSERVATIONS = 100;
export declare const NOTE_MAX_CHARS = 20000;
export declare const NOTE_DEFAULT_TYPE = "note";
export interface DerivedNote {
    text: string;
    title: string;
    observations: string[];
    name: string;
}
export declare function sanitizeNoteText(raw: string): string;
export declare function splitObservations(body: string): string[];
export declare function deriveNote(raw: string): DerivedNote | null;
//# sourceMappingURL=note-derive.d.ts.map