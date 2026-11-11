import type { MemeshDatabase } from '../storage/sqlite.js';
import { type AgentMessagePostCommitNotifier } from '../core/agent-messaging.js';
import { type Ack, type MessageFrame, type PresenceEntry, type PresenceFrame } from './frames.js';
import type { NetworkConfig } from './store.js';
import type { Roster, RosterMember } from './types.js';
export declare const DELIVERY_WINDOW_MS: number;
export declare const NOTICE_SENDER = "memesh-network";
export interface Joined {
    config: NetworkConfig;
    roster: Roster;
}
export interface OutboxEntry {
    delivery_id: string;
    message_id: string;
    machine_id: string;
    attempts: number;
    expires_at_ms: number;
}
export declare function messagingAvailable(db: MemeshDatabase): boolean;
export declare function enqueueOutgoing(db: MemeshDatabase, joined: Joined, now: number): number;
export declare function dueMachines(db: MemeshDatabase, now: number): string[];
export declare function dueOutgoingFor(db: MemeshDatabase, machineId: string, now: number, limit?: number): OutboxEntry[];
export declare function retryNowFor(db: MemeshDatabase, machineId: string, now: number): void;
export declare function buildMessageFrame(db: MemeshDatabase, joined: Joined, entry: OutboxEntry): MessageFrame | string;
export type Outcome = 'delivered' | 'rejected' | 'pending' | 'expired';
export declare function recordAttempt(db: MemeshDatabase, entry: OutboxEntry, result: {
    ack?: Ack;
    failure?: string;
    path?: string | null;
}, now: number, notifier?: AgentMessagePostCommitNotifier): Outcome;
export declare function recordUnsendable(db: MemeshDatabase, entry: OutboxEntry, code: string, notifier?: AgentMessagePostCommitNotifier): void;
export declare function expireOverdue(db: MemeshDatabase, now: number, notifier?: AgentMessagePostCommitNotifier): number;
export declare function receiveMessage(db: MemeshDatabase, joined: Joined, member: RosterMember, frame: MessageFrame, notifier?: AgentMessagePostCommitNotifier): Ack;
export declare function localPresence(db: MemeshDatabase, joined: Joined, now: number): PresenceEntry[];
export declare function receivePresence(db: MemeshDatabase, member: RosterMember, frame: PresenceFrame, now: number): void;
export declare function rememberPeer(db: MemeshDatabase, machineId: string, relay: string | null, addrs: string[], now: number): void;
export declare function peerRoute(db: MemeshDatabase, machineId: string): {
    relay: string | null;
    addrs: string[];
} | null;
export declare function frameLabel(frame: {
    kind: string;
    origin_message_id?: string;
}): string;
//# sourceMappingURL=courier.d.ts.map