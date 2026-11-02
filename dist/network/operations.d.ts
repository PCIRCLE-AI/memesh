import { type BridgeStatus } from './bridge-state.js';
import { type InstallOptions } from './runtime.js';
import { type NetworkConfig } from './store.js';
import { type NetworkContext, type Roster, type RosterMember } from './types.js';
export interface CreateOptions extends InstallOptions {
    name: string;
    person: string;
    relay?: string;
}
export declare function createNetwork(ctx: NetworkContext, options: CreateOptions): {
    config: NetworkConfig;
    roster: Roster;
};
export interface LinkOptions {
    ttlHours?: number;
    ttlMs?: number;
    includeAddresses?: boolean;
}
export interface LinkResult {
    link: string;
    expiresAtMs: number;
    bridgeStarted: boolean;
    bridgePid: number;
}
export declare function createLink(ctx: NetworkContext, options?: LinkOptions): Promise<LinkResult>;
export interface JoinOptions extends InstallOptions {
    link: string;
    name: string;
    person: string;
    relay?: string;
}
export declare function joinNetwork(ctx: NetworkContext, options: JoinOptions): Promise<{
    config: NetworkConfig;
    roster: Roster;
    member: RosterMember;
}>;
export declare function bridgeUp(ctx: NetworkContext, options?: InstallOptions): Promise<{
    pid: number;
    started: boolean;
}>;
export type NetworkStatus = {
    joined: false;
} | JoinedStatus;
export interface JoinedStatus {
    joined: true;
    network_id: string;
    machine_id: string;
    machine_name: string;
    person: string;
    role: 'owner' | 'member';
    relay: string;
    roster_version: number;
    members: RosterMember[];
    bridge: {
        running: boolean;
        pid: number | null;
        started_at: string | null;
        relay_state: BridgeStatus['relay_state'] | null;
        last_error: string | null;
        last_error_at: string | null;
        joins_accepted: number;
        joins_refused: number;
        non_member_refused: number;
    };
}
export declare function getNetworkStatus(ctx: NetworkContext): NetworkStatus;
//# sourceMappingURL=operations.d.ts.map