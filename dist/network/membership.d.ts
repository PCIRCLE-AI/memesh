import type { MemeshDatabase } from '../storage/sqlite.js';
import type { Identity } from './identity.js';
import { type NetworkConfig } from './store.js';
import { type SignedRoster } from './types.js';
export declare const MEMBERSHIP_MAX_BYTES: number;
export declare const MEMBERSHIP_ACK_MAX_BYTES = 512;
export declare const MEMBERSHIP_DEADLINE_MS = 5000;
export type MembershipFrame = {
    version: 1;
    op: 'leave-self' | 'self-status';
    network_id: string;
} | {
    version: 1;
    op: 'roster';
    network_id: string;
    roster: SignedRoster;
};
export interface MembershipAck {
    version: 1;
    network_id: string;
    roster_version: number;
    member: boolean;
}
export interface MembershipAction {
    action: 'leave' | 'remove';
    network_id: string;
    machine_id: string;
    target?: string;
}
export interface MembershipResult {
    action: 'leave' | 'remove';
    network_id: string;
    roster_version: number;
    removed: string;
    already_removed: boolean;
    unsynchronized: string[] | null;
}
export declare function parseMembershipFrame(bytes: Buffer): MembershipFrame;
export declare function parseMembershipAck(bytes: Buffer, networkId: string): MembershipAck;
export declare function parseMembershipAction(raw: unknown): MembershipAction;
export declare function membershipConfig(db: MemeshDatabase, expected: Pick<NetworkConfig, 'network_id' | 'machine_id' | 'owner_id'>): NetworkConfig;
export declare function removeMember(db: MemeshDatabase, identity: Identity, expected: NetworkConfig, target: string): {
    signed: SignedRoster;
    removed: string;
    alreadyRemoved: boolean;
    priorMembers: string[];
};
export declare function clearMembership(db: MemeshDatabase, expected: NetworkConfig, confirmedVersion?: number): void;
export declare function receiveMembershipRoster(db: MemeshDatabase, expected: NetworkConfig, incoming: SignedRoster): {
    version: number;
    member: boolean;
};
//# sourceMappingURL=membership.d.ts.map