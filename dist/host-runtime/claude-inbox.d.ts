import { type RouterDelivery, type RouterHostConnection } from './router-client.js';
import { ClaudeTranscriptReader } from './claude-transcript.js';
import type { AgentJsonObject } from '../core/agent-messaging.js';
export declare function readRegistrySession(): {
    sessionId: string;
    cwd: string;
} | undefined;
export declare class NoticeNotConfirmedError extends Error {
    readonly code = "notice_not_confirmed";
    constructor();
}
export declare class NoticeHeldError extends Error {
    readonly code = "notice_held";
    constructor();
}
export declare class TranscriptUnreadableError extends Error {
    readonly code: 'transcript_unavailable' | 'transcript_not_found';
    constructor(code: 'transcript_unavailable' | 'transcript_not_found', message: string);
}
export declare function createClaudeInboxDeliver(options: {
    socketPath?: string;
    sessionId: string;
    reader: ClaudeTranscriptReader | (() => ClaudeTranscriptReader);
    timeoutMs?: number;
    currentSession?: () => string | undefined;
    heldLimit?: number;
}): (delivery: RouterDelivery) => Promise<AgentJsonObject>;
export declare function startClaudeInboxPresence(rootUris: readonly string[] | null): Promise<RouterHostConnection | undefined>;
//# sourceMappingURL=claude-inbox.d.ts.map