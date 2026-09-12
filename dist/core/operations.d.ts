import type { RememberInput, RememberResult, RecallInput, ForgetInput, ForgetResult, LearnInput, LearnResult, Entity } from './types.js';
export declare function remember(input: RememberInput): RememberResult;
export declare const REPLACED_HISTORY_MAX = 20;
export declare const REPLACED_HISTORY_MAX_BYTES: number;
export interface ReplacedVersion {
    replaced_at: string;
    title: string | null;
    observations: string[];
    tags: string[];
    truncated?: boolean;
}
export declare function recall(args: RecallInput): Entity[];
export interface RetrievalMeta {
    mode: 'fts';
    degraded: false;
    truncated: boolean;
}
export declare function recallEnhanced(args: RecallInput): Promise<{
    entities: Entity[];
    retrieval: RetrievalMeta;
}>;
export declare function recallWithConflicts(args: RecallInput): Promise<{
    entities: Entity[];
    conflicts: string[];
    retrieval: RetrievalMeta;
}>;
export { exportMemories, importMemories } from './serializer.js';
export declare function learn(args: LearnInput): LearnResult;
export declare function forget(args: ForgetInput): ForgetResult;
export declare function setPinned(name: string, pinned: boolean): {
    name: string;
    pinned: boolean | null;
    found: boolean;
};
//# sourceMappingURL=operations.d.ts.map