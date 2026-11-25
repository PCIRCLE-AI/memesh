import type { MemeshDatabase } from '../storage/sqlite.js';
import type { NetworkConfig } from './store.js';
import type { Roster } from './types.js';

export interface Joined { config: NetworkConfig; roster: Roster }

export function rememberPeer(db: MemeshDatabase, machineId: string, relay: string | null, addrs: string[], now: number): void {
  db.prepare(`
    INSERT INTO agent_network_peers (machine_id, relay_url, addrs_json, seen_at_ms) VALUES (?, ?, ?, ?)
    ON CONFLICT(machine_id) DO UPDATE SET relay_url = excluded.relay_url, addrs_json = excluded.addrs_json, seen_at_ms = excluded.seen_at_ms
  `).run(machineId, relay, JSON.stringify(addrs), now);
}

export function peerRoute(db: MemeshDatabase, machineId: string): { relay: string | null; addrs: string[] } | null {
  const row = db.prepare('SELECT relay_url, addrs_json FROM agent_network_peers WHERE machine_id = ?').get(machineId) as
    { relay_url: string | null; addrs_json: string } | undefined;
  if (!row) return null;
  try {
    return { relay: row.relay_url, addrs: JSON.parse(row.addrs_json) as string[] };
  } catch {
    return { relay: row.relay_url, addrs: [] };
  }
}
