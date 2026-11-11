import type { MemeshDatabase } from '../storage/sqlite.js';
import { AgentMessagingError, type AgentJsonObject } from '../core/agent-messaging.js';
import { type NetworkAddress } from './address.js';
import { type NetworkConfig } from './store.js';
import { type Roster, type RosterMember } from './types.js';
export declare const PRESENCE_TTL_MS: number;
interface Joined {
    config: NetworkConfig;
    roster: Roster;
}
export declare function joinedNetwork(db: MemeshDatabase): Joined | null;
export declare class NetworkRecipientError extends AgentMessagingError {
}
export interface NetworkRecipient {
    address: NetworkAddress;
    member: RosterMember;
    note: string;
}
export declare function resolveNetworkRecipient(db: MemeshDatabase, recipient: string): NetworkRecipient | null;
export declare function networkReceiptFact(db: MemeshDatabase, deliveryId: string): AgentJsonObject | null;
export declare function networkDeliveryOf(db: MemeshDatabase, delivery: {
    delivery_id: string;
    recipient: string;
}): {
    state: string;
    code: string | null;
    machine: string;
} | null;
export declare function remoteDiscoverCards(db: MemeshDatabase, project: string, now?: number): AgentJsonObject[];
export {};
//# sourceMappingURL=outbound.d.ts.map