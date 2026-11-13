import type { MemeshDatabase } from '../storage/sqlite.js';
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
//# sourceMappingURL=conversation-message-migration.d.ts.map