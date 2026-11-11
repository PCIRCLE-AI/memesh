import { AgentMessagingError } from '../core/agent-messaging.js';
import { formatNetworkAddress, parseNetworkAddress, projectHash } from './address.js';
import { verifyRoster } from './roster.js';
import { readConfig, signedRosterOf } from './store.js';
import { RELAY_OFF } from './types.js';
export const PRESENCE_TTL_MS = 3 * 60_000;
export function joinedNetwork(db) {
    let config;
    try {
        config = readConfig(db);
    }
    catch {
        return null;
    }
    if (!config)
        return null;
    return { config, roster: verifyRoster(signedRosterOf(config), config.owner_id, config.network_id) };
}
export class NetworkRecipientError extends AgentMessagingError {
}
export function resolveNetworkRecipient(db, recipient) {
    const address = parseNetworkAddress(recipient);
    if (address === null)
        return null;
    const joined = joinedNetwork(db);
    if (joined === null)
        return null;
    const member = joined.roster.members.find((candidate) => candidate.name === address.machine);
    if (!member)
        return null;
    if (member.machine_id === joined.config.machine_id) {
        throw new NetworkRecipientError(`${recipient} is this machine. Send to ${JSON.stringify(address.target)} directly.`);
    }
    if (member.person !== address.person) {
        throw new NetworkRecipientError(`Machine ${JSON.stringify(address.machine)} belongs to ${JSON.stringify(member.person)} in this network, not ${JSON.stringify(address.person)}. `
            + `Use ${formatNetworkAddress(member.person, address.target, address.machine)}.`);
    }
    const path = joined.config.relay_url === RELAY_OFF ? 'directly' : 'through the relay or directly';
    return {
        address,
        member,
        note: `This goes to machine ${address.machine} ${path}; while that machine is offline it is retried for up to one day.`,
    };
}
export function networkReceiptFact(db, deliveryId) {
    let row;
    try {
        row = db.prepare(`
      SELECT delivery_id, message_id, state, attempts, last_error_code, delivered_at_ms, path
      FROM agent_network_outbox WHERE delivery_id = ? AND state != 'local'
    `).get(deliveryId);
    }
    catch {
        return null;
    }
    if (!row)
        return null;
    const deliveredAt = row.delivered_at_ms === null ? null : new Date(row.delivered_at_ms).toISOString();
    return {
        receipt_kind: 'network',
        fact_source: 'agent_network_outbox',
        message_id: row.message_id,
        delivery_id: row.delivery_id,
        network: {
            state: row.state,
            attempts: row.attempts,
            last_error_code: row.last_error_code,
            delivered_at: deliveredAt,
            path: row.path,
        },
        created_at: deliveredAt ?? new Date().toISOString(),
    };
}
export function networkDeliveryOf(db, delivery) {
    const fact = networkReceiptFact(db, delivery.delivery_id);
    const network = fact?.network;
    try {
        const address = parseNetworkAddress(delivery.recipient);
        if (network)
            return { state: network.state, code: network.last_error_code, machine: address?.machine ?? 'the other machine' };
        const local = db.prepare("SELECT 1 FROM agent_network_outbox WHERE delivery_id = ? AND state = 'local'").get(delivery.delivery_id);
        if (local || !address || !resolveNetworkRecipient(db, delivery.recipient))
            return null;
        return { state: 'pending', code: null, machine: address.machine };
    }
    catch {
        return null;
    }
}
export function remoteDiscoverCards(db, project, now = Date.now()) {
    const joined = joinedNetwork(db);
    if (joined === null)
        return [];
    const rows = db.prepare(`
    SELECT machine_id, principal, handle, host_kind, connected FROM agent_network_presence
    WHERE project_hash = ? AND expires_at_ms > ? ORDER BY machine_id, handle
  `).all(projectHash(joined.config.network_id, project), now);
    const cards = [];
    for (const row of rows) {
        const member = joined.roster.members.find((candidate) => candidate.machine_id === row.machine_id);
        if (!member || member.machine_id === joined.config.machine_id)
            continue;
        cards.push({
            remote: true,
            address: formatNetworkAddress(member.person, row.handle, member.name),
            principal_address: formatNetworkAddress(member.person, row.principal, member.name),
            machine: member.name,
            person: member.person,
            principal_id: row.principal,
            handle: row.handle,
            host_kind: row.host_kind,
            active: row.connected === 1,
        });
    }
    return cards;
}
//# sourceMappingURL=outbound.js.map