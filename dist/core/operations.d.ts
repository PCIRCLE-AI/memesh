import type { RememberInput, RememberResult, RecallInput, ForgetInput, ForgetResult, LearnInput, LearnResult, Entity } from './types.js';
export declare function remember(args: RememberInput): RememberResult;
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