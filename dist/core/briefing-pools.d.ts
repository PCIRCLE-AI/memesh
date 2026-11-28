import type { MemeshDatabase } from '../storage/sqlite.js';
import { type IndexCandidate } from './briefing-index.js';
import { type TopologyEntity } from './work-topology.js';
export declare const USER_CONVERSATION_TITLE_LIMIT = 10;
export interface PoolRow {
    id: number;
    name: string;
    type: string | null;
    title: string | null;
    metadata: string | null;
    access_count?: number;
    last_accessed_at?: string;
    confidence?: number;
    recall_hits?: number;
    recall_misses?: number;
    created_at?: string;
    recency?: string | null;
    project?: string;
}
export interface HandoffRow {
    id: number;
    name: string;
    metadata: string | null;
    text: string;
    observedAt: string;
    sessionId: string;
}
export interface BriefingPools {
    handoffs: HandoffRow[];
    lessonCount: number;
    lessons: PoolRow[];
    project: PoolRow[];
    noProject: PoolRow[];
    shared: PoolRow[];
    global: PoolRow[];
    recent: PoolRow[];
    userConversations: PoolRow[];
}
export interface PoolOptions {
    projectIds?: readonly string[];
    projectLimit: number;
    global: boolean;
    foreign: boolean;
    onError?: (label: 'handoff' | 'decisions' | 'lessons' | 'shared', err: unknown) => void;
}
export declare function selectBriefingPools(db: MemeshDatabase, projectName: string, options: PoolOptions): BriefingPools;
export interface Snippet {
    first: string | null;
    fix: string | null;
    why?: string | null;
    lastAddedAt?: string | null;
}
export declare function readSnippets(db: MemeshDatabase, ids: readonly number[]): Map<number, Snippet>;
export declare function toTopologyEntity(row: PoolRow, snippets: ReadonlyMap<number, Snippet>, now?: number): TopologyEntity;
export declare function readIndexCandidates(db: MemeshDatabase, projectName: string, projectIds?: readonly string[]): {
    candidates: Array<IndexCandidate & {
        name: string;
    }>;
    truncated: boolean;
};
//# sourceMappingURL=briefing-pools.d.ts.map