import type { MemeshDatabase } from './storage/sqlite.js';
export type { Entity, Relation, CreateEntityInput, SearchOptions } from './core/types.js';
import type { Entity, Relation, CreateEntityInput, SearchOptions } from './core/types.js';
export interface SearchResult {
    entities: Entity[];
    fallback: 'index_out_of_date' | null;
}
export declare class KnowledgeGraph {
    private db;
    constructor(db: MemeshDatabase);
    updateEntityMetadata(name: string, updater: (currentMetadata: Record<string, unknown>) => Record<string, unknown> | null | undefined): void;
    createEntity(name: string, type: string, opts?: {
        observations?: string[];
        tags?: string[];
        metadata?: Record<string, unknown>;
        namespace?: string;
        title?: string | null;
        trustOverride?: 'trusted' | 'untrusted';
    }): number;
    private createEntityInner;
    createEntitiesBatch(entities: CreateEntityInput[]): void;
    createRelation(fromName: string, toName: string, relationType: string): void;
    getEntity(name: string): Entity | null;
    getEntitiesByIds(ids: number[], opts?: {
        includeArchived?: boolean;
        namespace?: string;
        tag?: string;
    }): Entity[];
    getRelations(entityName: string): Relation[];
    search(query?: string, opts?: SearchOptions): Entity[];
    searchWithFacts(query?: string, opts?: SearchOptions): SearchResult;
    private scanActiveRows;
    trackAccess(entityIds: number[]): void;
    findConflicts(entityNames: string[]): string[];
    listRecent(limit?: number, includeArchived?: boolean, namespace?: string, countAsAccess?: boolean): Entity[];
    listByType(type: string, limit?: number, includeArchived?: boolean, namespace?: string): Entity[];
    private listRecentInScope;
    private listRecentByTag;
    clearEntityData(name: string): void;
    archiveEntity(name: string): {
        archived: boolean;
        name?: string;
        previousStatus?: string;
    };
    removeObservation(entityName: string, observationContent: string): {
        removed: boolean;
        remainingObservations: number;
        entityFound: boolean;
    };
    deleteEntity(name: string): {
        deleted: boolean;
    };
    private parseMetadata;
    private rebuildFts;
}
//# sourceMappingURL=knowledge-graph.d.ts.map