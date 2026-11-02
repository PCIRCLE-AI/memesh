import { MemeshDatabase } from '../storage/sqlite.js';
import type { SignedRoster } from './types.js';
export interface NetworkConfig {
    network_id: string;
    owner_id: string;
    machine_id: string;
    machine_name: string;
    person: string;
    relay_url: string;
    roster_json: string;
    roster_signature: string;
}
export declare function openNetworkStore(dbPath: string): MemeshDatabase;
export declare function readConfig(db: MemeshDatabase): NetworkConfig | null;
export declare function insertConfig(db: MemeshDatabase, config: NetworkConfig, now: number): void;
export declare function saveRoster(db: MemeshDatabase, signed: SignedRoster): void;
export declare function signedRosterOf(config: NetworkConfig): SignedRoster;
//# sourceMappingURL=store.d.ts.map