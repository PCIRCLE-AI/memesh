import type { SignedRoster } from './types.js';
import type { BiStream } from './iroh-types.js';
import type { NetworkConversationMessage, ConversationDeliveryReceipt, RemoteConversationRegistration } from '../core/conversation-messages.js';
export type ConversationFrame = {
    version: 2;
    kind: 'conversations';
    relay: string | null;
    addrs: string[];
    entries: RemoteConversationRegistration[];
} | {
    version: 2;
    kind: 'peer-routes';
    routes: PeerRoute[];
} | {
    version: 2;
    kind: 'conversation-message';
    row: NetworkConversationMessage;
} | {
    version: 2;
    kind: 'conversation-receipt';
    receipt: ConversationDeliveryReceipt;
};
export interface PeerRoute {
    machine_id: string;
    relay: string | null;
    addrs: string[];
}
export declare function parseConversationFrame(bytes: Buffer): ConversationFrame;
export declare function peerRouteFrames(routes: PeerRoute[]): ConversationFrame[];
export declare function conversationPresenceFrames(relay: string | null, addrs: string[], entries: RemoteConversationRegistration[]): ConversationFrame[];
export declare const ROSTER_EXCHANGE_MAX_BYTES: number;
export declare function parseRosterExchange(bytes: Buffer): SignedRoster;
export declare function exchangeRosterStream(stream: BiStream, local: SignedRoster | null, accept: (incoming: SignedRoster) => SignedRoster, timeoutMs: number): Promise<void>;
export declare const FRAME_MAX_BYTES: number;
export declare const ACK_MAX_BYTES = 1024;
export type AckResult = 'accepted' | 'duplicate' | 'rejected' | 'retry';
export interface Ack {
    result: AckResult;
    code?: string;
}
export declare class FrameError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function parseAck(bytes: Buffer): Ack;
//# sourceMappingURL=frames.d.ts.map