import { type RouterDelivery, type RouterHostConnection } from './router-client.js';
import { ClaudeTranscriptReader } from './claude-transcript.js';
import type { AgentJsonObject } from '../core/agent-messaging.js';
export declare function createClaudeInboxDeliver(options: {
    socketPath?: string;
    sessionId: string;
    reader: ClaudeTranscriptReader | (() => ClaudeTranscriptReader);
    timeoutMs?: number;
    currentSession?: () => string | undefined;
}): (delivery: RouterDelivery) => Promise<AgentJsonObject>;
export declare function startClaudeInboxPresence(rootUris: readonly string[] | null): Promise<RouterHostConnection | undefined>;
//# sourceMappingURL=claude-inbox.d.ts.map