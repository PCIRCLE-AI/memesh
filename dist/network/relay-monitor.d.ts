import type { BridgeStatus, RelayState } from './bridge-state.js';
export declare const RELAY_PING_INTERVAL_MS = 15000;
export interface RelaySignals {
    online: boolean;
    deadlinePassed: boolean;
    reachable: boolean | null;
}
export declare function relayStateOf(signals: RelaySignals): RelayState;
export declare function relayComplaint(relayUrl: string): string;
export declare function applyRelayState(status: Pick<BridgeStatus, 'relay_state' | 'last_error' | 'last_error_at'>, signals: RelaySignals, relayUrl: string): boolean;
export declare function pingRelay(relayUrl: string, fetchImpl?: typeof fetch): Promise<boolean>;
//# sourceMappingURL=relay-monitor.d.ts.map