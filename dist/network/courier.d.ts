import type { MemeshDatabase } from '../storage/sqlite.js';
import type { NetworkConfig } from './store.js';
import type { Roster } from './types.js';
import { type PeerRoute } from './frames.js';
export interface Joined {
    config: NetworkConfig;
    roster: Roster;
}
export declare function memberRoutes(db: MemeshDatabase, joined: Joined, target: string): PeerRoute[];
export declare function receivePeerRoutes(db: MemeshDatabase, joined: Joined, sender: string, routes: PeerRoute[]): void;
export declare function rememberPeer(db: MemeshDatabase, machineId: string, relay: string | null, addrs: string[], now: number): void;
export declare function peerRoute(db: MemeshDatabase, machineId: string): {
    relay: string | null;
    addrs: string[];
} | null;
//# sourceMappingURL=courier.d.ts.map