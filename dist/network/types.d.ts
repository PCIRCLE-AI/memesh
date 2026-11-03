export declare const JOIN_ALPN = "memesh/join/1";
export declare const NET_ALPN = "memesh/net/1";
export declare const DEFAULT_RELAY_URL = "https://relay.memesh.ai/";
export declare const RELAY_OFF = "off";
export declare const EXIT_ALREADY_RUNNING = 3;
export declare const EXIT_LOCK_UNCONFIRMED = 4;
export declare const SINGLE_MACHINE_NOTE = "Single-machine MeMesh keeps working.";
export type NetworkErrorCode = 'invite_used' | 'invite_expired' | 'invite_unknown' | 'name_taken' | 'wrong_network' | 'invalid_name' | 'bad_request' | 'not_owner' | 'roster_full' | 'internal' | 'unknown_refusal' | 'link_malformed' | 'link_tampered' | 'link_version' | 'roster_invalid' | 'roster_downgrade' | 'identity_invalid' | 'not_joined' | 'already_joined' | 'needs_person' | 'invalid_option' | 'owner_unreachable' | 'relay_unreachable' | 'join_interrupted' | 'join_timed_out' | 'runtime_unsupported' | 'runtime_install_failed' | 'runtime_load_failed' | 'bridge_failed' | 'bridge_unconfirmed';
export declare class NetworkError extends Error {
    readonly code: NetworkErrorCode;
    constructor(code: NetworkErrorCode, message: string);
}
export interface RosterMember {
    machine_id: string;
    name: string;
    person: string;
    joined_at: string;
}
export interface Roster {
    network_id: string;
    owner_id: string;
    version: number;
    members: RosterMember[];
}
export interface SignedRoster {
    roster_json: string;
    signature: string;
}
export interface NetworkContext {
    dataDir: string;
    dbPath: string;
    bridgeEntry: string;
    assetsDir: string;
    env?: NodeJS.ProcessEnv;
}
export declare function networkDir(dataDir: string): string;
export declare function runtimeDir(dataDir: string): string;
export declare function childEnv(ctx: NetworkContext): NodeJS.ProcessEnv;
export declare function safeForTerminal(text: string): string;
export declare function errorMessage(err: unknown): string;
//# sourceMappingURL=types.d.ts.map