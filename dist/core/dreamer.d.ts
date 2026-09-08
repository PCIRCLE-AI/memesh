import type { MemeshDatabase } from '../storage/sqlite.js';
interface ProposedDigest {
    name: string;
    type: string;
    observations: string[];
    tags: string[];
}
type WorkPackageInput = {
    action: 'prepare';
    project: string;
    kind: 'digest' | 'transcript';
} | ({
    package_id: string;
    ref: {
        kind: 'digest';
        project: string;
        source_ids: number[];
        source_hash: string;
    } | {
        kind: 'transcript';
        project: string;
        session_id: string;
        modified_at: string;
        source_hash: string;
        workspace_hash: string;
    };
} & ({
    action: 'submit';
    result: ProposedDigest & {
        type: 'digest' | 'decision' | 'lesson_learned' | 'fact';
    };
} | {
    action: 'defer';
    reason: 'not_now';
}));
export interface WorkPackageContext {
    transcriptWorkspace?: string;
    transcriptWorkspaceError?: 'workspace_unavailable' | 'workspace_ambiguous';
}
export declare function executeWorkPackage(db: MemeshDatabase, input: WorkPackageInput, context?: WorkPackageContext): Record<string, unknown>;
export interface ApplyResult {
    proposalId: number;
    digestEntityName: string;
    sourcesArchived: number;
    sourcesLinked: number;
    sourcesAlreadyCompacted?: number;
    kind: 'digest' | 'pattern_emergent' | 'relation' | 'guard' | 'product_improvement';
}
type ProposalEntityWriter = {
    createEntity: (name: string, type: string, opts: {
        observations: string[];
        tags: string[];
        metadata: Record<string, unknown>;
        title?: string | null;
        namespace?: string;
        trustOverride?: 'trusted' | 'untrusted';
    }) => number;
};
export declare function applyProposal(db: MemeshDatabase, proposalId: number, kg: ProposalEntityWriter): ApplyResult;
export declare class NothingToClaimError extends Error {
    readonly proposalId: number;
    readonly reason: string;
    constructor(proposalId: number, reason: string);
}
export declare function rejectProposal(db: MemeshDatabase, proposalId: number, reason?: string): void;
export interface ProposalSummary {
    id: number;
    project: string;
    cluster_key: string;
    source_count: number;
    digest_name: string;
    digest_observations_preview: string | null;
    status: string;
    created_at: string;
    kind: 'digest' | 'pattern_emergent' | 'relation' | 'guard' | 'product_improvement';
    source_kind: string;
}
export declare function listProposals(db: MemeshDatabase, status?: string): ProposalSummary[];
export interface ProposalDetail {
    id: number;
    project: string;
    cluster_key: string;
    source_kind: string;
    status: string;
    created_at: string;
    source: unknown;
    digest: ProposedDigest;
    kind: 'digest' | 'pattern_emergent' | 'relation' | 'guard' | 'product_improvement';
    relation?: unknown;
}
export declare function getProposalDetail(db: MemeshDatabase, id: number): ProposalDetail | null;
export {};
//# sourceMappingURL=dreamer.d.ts.map