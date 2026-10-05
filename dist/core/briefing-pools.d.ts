import type { MemeshDatabase } from '../storage/sqlite.js';
import { type IndexCandidate } from './briefing-index.js';
import { type TopologyEntity } from './work-topology.js';
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
    recency?: string | null;
}
export interface HandoffRow {
    id: number;
    name: string;
    metadata: string | null;
    text: string;
    observedAt: string;
}
export interface BriefingPools {
    handoff: HandoffRow | undefined;
    handoffHidden: 'untrusted' | undefined;
    lessonCount: number;
    lessons: PoolRow[];
    project: PoolRow[];
    noProject: PoolRow[];
    global: PoolRow[];
    recent: PoolRow[];
}
export interface PoolOptions {
    projectLimit: number;
    global: boolean;
    foreign: boolean;
    onError?: (label: 'handoff' | 'decisions' | 'lessons', err: unknown) => void;
}
export declare function selectBriefingPools(db: MemeshDatabase, projectName: string, options: PoolOptions): BriefingPools;
export interface Snippet {
    first: string | null;
    fix: string | null;
    why?: string | null;
}
export declare function readSnippets(db: MemeshDatabase, ids: readonly number[]): Map<number, Snippet>;
export declare function toTopologyEntity(row: PoolRow, snippets: ReadonlyMap<number, Snippet>, now?: number): TopologyEntity;
export declare function readIndexCandidates(db: MemeshDatabase, projectName: string): {
    candidates: Array<IndexCandidate & {
        name: string;
    }>;
    truncated: boolean;
};
//# sourceMappingURL=briefing-pools.d.ts.map