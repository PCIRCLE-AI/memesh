export type RelayState = 'off' | 'connecting' | 'online' | 'unreachable';
export interface BridgeStatus {
    pid: number;
    started_at: string;
    updated_at: string;
    state: 'starting' | 'running' | 'stopped' | 'failed';
    relay_state: RelayState;
    last_error: string | null;
    last_error_at: string | null;
    direct_addresses: string[];
    joins_accepted: number;
    joins_refused: number;
    non_member_refused: number;
    member_stub_served: number;
}
export declare function statusPath(dataDir: string): string;
export declare function logPath(dataDir: string): string;
export declare function writeStatus(dataDir: string, status: BridgeStatus): void;
export declare function readStatus(dataDir: string): BridgeStatus | null;
//# sourceMappingURL=bridge-state.d.ts.map