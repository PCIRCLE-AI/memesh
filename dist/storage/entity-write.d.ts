import type { MemeshDatabase } from './sqlite.js';
export interface EntityRowState {
    id: number;
    isNew: boolean;
    type: string;
    title: string | null;
    status: string;
    namespace: string | null;
    metadata: string | null;
}
export declare function runEntityWrite<T>(db: MemeshDatabase, write: () => T): T;
export declare function insertOrGetEntity(db: MemeshDatabase, entity: {
    name: string;
    type: string;
    metadataJson: string;
    title: string | null;
    namespace?: string;
}): EntityRowState | null;
export declare function appendObservations(db: MemeshDatabase, entityId: number, observations: readonly string[], options: {
    dedupe: boolean;
    readExisting: boolean;
    exclude?: (observation: string) => boolean;
}): string[];
export declare function addTags(db: MemeshDatabase, entityId: number, tags: readonly string[]): void;
export declare function reindexEntityFts(db: MemeshDatabase, entityId: number, name: string, previous: {
    observationsText: string;
    title: string | null | undefined;
} | undefined, current?: {
    observationsText?: string;
    title?: string | null;
}): void;
//# sourceMappingURL=entity-write.d.ts.map