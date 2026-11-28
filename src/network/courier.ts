import type { MemeshDatabase } from '../storage/sqlite.js';
import type { NetworkConfig } from './store.js';
import type { Roster } from './types.js';
import { FrameError, type PeerRoute } from './frames.js';

export interface Joined { config: NetworkConfig; roster: Roster }

export function memberRoutes(db: MemeshDatabase, joined: Joined, target: string): PeerRoute[] {
  return joined.roster.members.flatMap(member => {
    if (member.machine_id === joined.config.machine_id || member.machine_id === target) return [];
    const route = peerRoute(db, member.machine_id);
    return route ? [{ machine_id: member.machine_id, ...route }] : [];
  });
}

/** Only the authenticated owner can introduce other current members; a hint grants no access. */
export function receivePeerRoutes(db: MemeshDatabase, joined: Joined, sender: string, routes: PeerRoute[]): void {
  if (sender !== joined.config.owner_id) throw new FrameError('route_forbidden', 'Only the owner may introduce peer routes');
  if (routes.some(route => route.machine_id === joined.config.machine_id || route.machine_id === joined.config.owner_id
    || !joined.roster.members.some(member => member.machine_id === route.machine_id))) {
    throw new FrameError('route_forbidden', 'Route is not for another current member');
  }
  db.transaction(() => {
    // Owner hints bootstrap discovery; they must not replace a peer's own newer announcement.
    for (const route of routes) if (!peerRoute(db, route.machine_id)) rememberPeer(db, route.machine_id, route.relay, route.addrs, Date.now());
  })();
}

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
