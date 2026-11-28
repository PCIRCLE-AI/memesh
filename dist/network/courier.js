import { FrameError } from './frames.js';
export function memberRoutes(db, joined, target) {
    return joined.roster.members.flatMap(member => {
        if (member.machine_id === joined.config.machine_id || member.machine_id === target)
            return [];
        const route = peerRoute(db, member.machine_id);
        return route ? [{ machine_id: member.machine_id, ...route }] : [];
    });
}
export function receivePeerRoutes(db, joined, sender, routes) {
    if (sender !== joined.config.owner_id)
        throw new FrameError('route_forbidden', 'Only the owner may introduce peer routes');
    if (routes.some(route => route.machine_id === joined.config.machine_id || route.machine_id === joined.config.owner_id
        || !joined.roster.members.some(member => member.machine_id === route.machine_id))) {
        throw new FrameError('route_forbidden', 'Route is not for another current member');
    }
    db.transaction(() => {
        for (const route of routes)
            if (!peerRoute(db, route.machine_id))
                rememberPeer(db, route.machine_id, route.relay, route.addrs, Date.now());
    })();
}
export function rememberPeer(db, machineId, relay, addrs, now) {
    db.prepare(`
    INSERT INTO agent_network_peers (machine_id, relay_url, addrs_json, seen_at_ms) VALUES (?, ?, ?, ?)
    ON CONFLICT(machine_id) DO UPDATE SET relay_url = excluded.relay_url, addrs_json = excluded.addrs_json, seen_at_ms = excluded.seen_at_ms
  `).run(machineId, relay, JSON.stringify(addrs), now);
}
export function peerRoute(db, machineId) {
    const row = db.prepare('SELECT relay_url, addrs_json FROM agent_network_peers WHERE machine_id = ?').get(machineId);
    if (!row)
        return null;
    try {
        return { relay: row.relay_url, addrs: JSON.parse(row.addrs_json) };
    }
    catch {
        return { relay: row.relay_url, addrs: [] };
    }
}
//# sourceMappingURL=courier.js.map