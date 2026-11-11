import type { MemeshDatabase } from '../storage/sqlite.js';
export interface AgentMessageStorageReportOptions {
    databasePath?: string;
    nowMs?: number;
}
export interface AgentMessageStorageReport {
    message_count: number;
    delivery_count: number;
    event_count: number;
    receipt_count: number;
    cursor_count: number;
    principal_count: number;
    session_instance_count: number;
    session_connection_count: number;
    presence_fact_count: number;
    dispatch_attempt_count: number;
    host_accept_count: number;
    ack_fact_count: number;
    workflow_fact_count: number;
    retention_fact_count: number;
    payload_bytes: number;
    original_payload_bytes: number;
    tombstoned_message_count: number;
    protected_unresolved_message_count: number;
    terminal_retained_message_count: number;
    expired_pending_message_count: number;
    reconciled_message_count: number;
    page_count: number;
    page_size: number;
    freelist_count: number;
    allocated_database_bytes: number;
    reusable_freelist_bytes: number;
    database_file_bytes: number | null;
    wal_file_bytes: number | null;
}
export interface AgentMessageStorageQuotaInput {
    quotaBytes: number;
    additionalPayloadBytes: number;
}
export declare class AgentMessageStorageError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare class AgentMessageStorageQuotaExceededError extends AgentMessageStorageError {
    readonly quotaBytes: number;
    readonly usedBytes: number;
    readonly requestedBytes: number;
    constructor(quotaBytes: number, usedBytes: number, requestedBytes: number);
}
export declare function getAgentMessageStorageReport(db: MemeshDatabase, options: AgentMessageStorageReportOptions): AgentMessageStorageReport;
export declare function enforceAgentMessageStorageQuota(db: MemeshDatabase, input: AgentMessageStorageQuotaInput): void;
export declare function agentMessagePayloadStorageBytes(payloadJson: string): number;
//# sourceMappingURL=agent-message-storage.d.ts.map