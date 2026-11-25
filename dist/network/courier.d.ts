import type { MemeshDatabase } from '../storage/sqlite.js';
import type { NetworkConfig } from './store.js';
import type { Roster } from './types.js';
export interface Joined {
    config: NetworkConfig;
    roster: Roster;
}
export declare function rememberPeer(db: MemeshDatabase, machineId: string, relay: string | null, addrs: string[], now: number): void;
export declare function peerRoute(db: MemeshDatabase, machineId: string): {
    relay: string | null;
    addrs: string[];
} | null;
//# sourceMappingURL=courier.d.ts.map