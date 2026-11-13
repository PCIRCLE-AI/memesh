import type { MemeshDatabase } from '../storage/sqlite.js';
export declare const PROMPT_RECALL_MAX_LINES = 2;
export declare const PROMPT_RECALL_MAX_BYTES = 4096;
export declare const PROMPT_RECALL_MIN_COVERAGE = 0.5;
export declare const PROMPT_RECALL_MIN_TERMS = 2;
export declare const PROMPT_RECALL_SKIP_TYPES: ReadonlySet<string>;
export declare const PROMPT_RECALL_MAX_PROJECT_AGE_DAYS = 30;
export interface ScoredMemory {
    id: number;
    name: string;
    type: string;
    title: string | null;
    coverage: number;
    matched: string[];
    mass: number;
    inTitle: boolean;
    rank: number;
    conversationRole?: 'user' | 'assistant';
}
export interface PromptRecallOptions {
    project: string | null;
    platform?: 'hermes';
    cwd?: string | null;
    exclude?: ReadonlySet<number>;
    minCoverage?: number;
    minTerms?: number;
    maxLines?: number;
    createdBefore?: number;
    excludeConversationSession?: string;
    skipTypes?: ReadonlySet<string>;
    maxProjectAgeDays?: number | null;
    projectAgeFromNoteDate?: boolean;
}
export interface PromptRecallResult {
    text: string;
    ids: number[];
    reason?: 'no-terms' | 'no-candidates' | 'below-threshold' | 'stale' | 'already-shown';
    scored: ScoredMemory[];
    terms: string[];
}
export declare function scorePrompt(db: MemeshDatabase, prompt: string, options: Pick<PromptRecallOptions, 'project' | 'platform' | 'cwd' | 'createdBefore' | 'skipTypes' | 'maxProjectAgeDays' | 'projectAgeFromNoteDate' | 'excludeConversationSession'>): {
    scored: ScoredMemory[];
    terms: string[];
};
export declare function selectPromptRecall(db: MemeshDatabase, prompt: string, options: PromptRecallOptions): PromptRecallResult;
//# sourceMappingURL=prompt-recall.d.ts.map