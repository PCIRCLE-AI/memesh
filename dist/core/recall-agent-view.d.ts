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
};
export interface RecallForAgentResult {
    entities: AgentRecallEntity[];
    conflicts: string[];
    retrieval: RetrievalMeta;
    truncated?: true;
    entities_omitted?: {
        shown: number;
        total: number;
    };
}
export declare function capRecallForAgent(result: {
    entities: Entity[];
    conflicts: string[];
    retrieval: RetrievalMeta;
}): RecallForAgentResult;
export declare function agentRecallEnvelope(r: RecallForAgentResult): {
    entities_omitted?: {
        shown: number;
        total: number;
    } | undefined;
    truncated?: true | undefined;
    conflicts?: string[] | undefined;
    entities: AgentRecallEntity[];
    retrieval: RetrievalMeta;
};
//# sourceMappingURL=recall-agent-view.d.ts.map