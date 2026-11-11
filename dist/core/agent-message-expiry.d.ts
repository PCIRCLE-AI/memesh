import { MemeshDatabase } from '../storage/sqlite.js';
export declare const AGENT_MESSAGE_EXPIRY_INTERVAL_MS: number;
export type AgentMessageExpiryOutcome = 'deleted' | 'presence_cleared' | 'archive_purged' | 'notices_sent' | 'read_only' | 'database_busy' | 'skipped_concurrent' | 'nothing_expired' | 'deferred_in_flight' | 'archive_failed' | 'archive_unavailable' | 'no_message_tables' | 'failed';
export declare const AGENT_MESSAGE_EXPIRY_FAILED_OUTCOMES: ReadonlySet<string>;
export declare const AGENT_MESSAGE_EXPIRY_DONE_OUTCOMES: ReadonlySet<string>;
export interface AgentMessageExpiryResult {
    run_id: number | null;
    outcome: AgentMessageExpiryOutcome;
    expired_message_count: number;
    unread_message_count: number;
    notice_count: number;
    presence_fact_count: number;
    connection_count: number;
    backup_path: string | null;
    detail: string | null;
}
export interface AgentMessageExpiryOptions {
    trigger: string;
    nowMs?: number;
    signal?: AbortSignal;
    fault?: {
        beforeArchiveCheck?(archivePath: string, batch: number): void;
        afterBatch?(batch: number): void | Promise<void>;
    };
}
export declare function runAgentMessageExpiry(db: MemeshDatabase, options: AgentMessageExpiryOptions): Promise<AgentMessageExpiryResult>;
export declare function runAgentMessageExpiryIfDue(db: MemeshDatabase, options: AgentMessageExpiryOptions): Promise<AgentMessageExpiryResult | null>;
export declare function startAgentMessageExpiryScheduler(getDb: () => MemeshDatabase | null, options: {
    trigger: string;
    intervalMs?: number;
    firstRunDelayMs?: number;
}): () => void;
export declare function lastAgentMessageExpiryRun(db: MemeshDatabase): (AgentMessageExpiryResult & {
    started_at_ms: number;
    finished_at_ms: number;
    trigger_source: string;
}) | null;
export declare function latestAgentMessageExpiryArchive(db: MemeshDatabase): string | null;
export type AgentMessageArchiveState = {
    kind: 'missing';
} | {
    kind: 'unusable';
    reason: string;
} | {
    kind: 'busy';
} | {
    kind: 'held';
    messages: number;
};
export declare function inspectAgentMessageArchive(db: MemeshDatabase, file: string): AgentMessageArchiveState;
export declare function databaseFile(db: MemeshDatabase): string;
//# sourceMappingURL=agent-message-expiry.d.ts.map