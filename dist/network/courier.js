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