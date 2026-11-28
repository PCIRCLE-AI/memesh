import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ConversationMessages } from '../core/conversation-messages.js';
export declare const CONVERSATION_CHANNEL_INSTRUCTIONS: string;
type ChannelServer = Pick<Server, 'connect' | 'close' | 'notification'> & {
    oninitialized?: () => void;
    onclose?: () => void;
};
export declare function startConversationChannel(dependencies?: {
    server?: ChannelServer;
    transport?: Transport;
    store?: ConversationMessages;
    env?: NodeJS.ProcessEnv;
    hostPid?: number;
    onError?: (error: unknown) => void;
}): Promise<{
    close(): Promise<void>;
    readonly phase: string;
}>;
export {};
//# sourceMappingURL=conversation-channel.d.ts.map