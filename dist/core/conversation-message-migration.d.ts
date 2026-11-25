import type { MemeshDatabase } from '../storage/sqlite.js';
export declare function legacyConversationArchiveFiles(graph: string, target: string): string[];
export declare function assertLegacyConversationArchiveSchema(source: MemeshDatabase): void;
export declare const LEGACY_CONVERSATION_PREFIX = "legacy:";
export declare function assertLegacyDestinationIsDifferent(source: MemeshDatabase, targetFile: string): void;
export declare function assertLegacyPathsAreDifferent(sourceFile: string, targetFile: string): void;
export declare function importLegacyConversationMessages(source: MemeshDatabase, target: MemeshDatabase, options: {
    nowMs: number;
    localMachine: string;
    messageIds?: readonly string[];
}): {
    imported: number;
    alreadyImported: number;
};
export declare const LEGACY_CONVERSATION_TABLES: readonly ["agent_messages", "agent_message_deliveries", "agent_message_events", "agent_message_idempotency", "agent_message_cursors", "agent_message_receipts", "agent_principals", "agent_session_instances", "agent_session_connections", "agent_presence_facts", "agent_dispatch_attempts", "agent_host_accepts", "agent_ack_facts", "agent_workflow_facts", "agent_retention_facts", "agent_message_expiry_runs", "agent_message_expiry_lease", "agent_message_expiries", "agent_network_outbox", "agent_network_presence"];
export declare function retireLegacyConversationTables(source: MemeshDatabase, target: MemeshDatabase, options: {
    nowMs: number;
    localMachine: string;
}): {
    imported: number;
    alreadyImported: number;
    retired: number;
};
//# sourceMappingURL=conversation-message-migration.d.ts.map