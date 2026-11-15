import { type ConversationMessage, type ConversationRegistration } from '../core/conversation-messages.js';
export type ConversationWakeRoute = 'claude-socket' | 'codex-queue';
export type ConversationWakeResult = {
    pushed: true;
    route: ConversationWakeRoute;
} | {
    pushed: false;
    reason: 'unavailable' | 'failed';
};
export declare function wakeConversationMessage(message: ConversationMessage, target: ConversationRegistration | undefined, localMachine?: string): Promise<ConversationWakeResult>;
//# sourceMappingURL=conversation-wake.d.ts.map