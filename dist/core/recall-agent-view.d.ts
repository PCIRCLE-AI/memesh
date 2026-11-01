import type { Entity } from './types.js';
import type { RetrievalMeta } from './operations.js';
export declare const RECALL_ENTITY_CONTENT_MAX_BYTES: number;
export declare const RECALL_RESPONSE_MAX_BYTES: number;
export interface RecallTruncationInfo {
    observations?: {
        shown: number;
        total: number;
    };
    tags?: {
        shown: number;
        total: number;
    };
}
export type AgentRecallEntity = Entity & {
    truncated?: RecallTruncationInfo;
    projects?: string[];
};
export interface RecallScope {
    project: string | null;
    searched: string;
}
export interface RecallForAgentResult {
    results?: Array<{
        id: number;
        status: 'found' | 'archived' | 'unavailable' | 'omitted';
        reference?: string;
    }>;
    entities: AgentRecallEntity[];
    conflicts: string[];
    retrieval: RetrievalMeta;
    truncated?: true;
    entities_omitted?: {
        shown: number;
        total: number;
    };
    scope?: RecallScope;
}
export declare function capRecallForAgent(result: {
    entities: Entity[];
    conflicts: string[];
    retrieval: RetrievalMeta;
    results?: RecallForAgentResult['results'];
}, scope?: RecallScope): RecallForAgentResult;
export declare function agentRecallEnvelope(r: RecallForAgentResult): {
    scope?: RecallScope | undefined;
    entities_omitted?: {
        shown: number;
        total: number;
    } | undefined;
    truncated?: true | undefined;
    conflicts?: string[] | undefined;
    retrieval: RetrievalMeta;
    results?: {
        id: number;
        status: "found" | "archived" | "unavailable" | "omitted";
        reference?: string;
    }[] | undefined;
    entities: AgentRecallEntity[];
};
//# sourceMappingURL=recall-agent-view.d.ts.map