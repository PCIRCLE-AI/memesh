// The network as the message tool sees it: whether a recipient is on another
// machine, what to tell the sender, and the network's part of receipts and
// discover. Runs in the CLI, MCP and HTTP processes, so it never loads the native
// transport and never fails a local send.

import type { MemeshDatabase } from '../storage/sqlite.js';
import { AgentMessagingError, type AgentJsonObject } from '../core/agent-messaging.js';
import { formatNetworkAddress, parseNetworkAddress, projectHash, type NetworkAddress } from './address.js';
import { verifyRoster } from './roster.js';
import { readConfig, signedRosterOf, type NetworkConfig } from './store.js';
import { RELAY_OFF, type Roster, type RosterMember } from './types.js';

export const PRESENCE_TTL_MS = 3 * 60_000;

interface Joined { config: NetworkConfig; roster: Roster }

/** This machine's network, or null when it has not joined. Never throws for a machine that never joined. */
export function joinedNetwork(db: MemeshDatabase): Joined | null {
  let config: NetworkConfig | null;
  try {
    config = readConfig(db);
  } catch {
    return null; // An older database without the network tables.
  }
  if (!config) return null;
  return { config, roster: verifyRoster(signedRosterOf(config), config.owner_id, config.network_id) };
}

export class NetworkRecipientError extends AgentMessagingError {}

export interface NetworkRecipient {
  address: NetworkAddress;
  member: RosterMember;
  note: string;
}

/**
 * Is this recipient on another machine? Only when all three hold: this machine
 * has joined, the recipient is `person/target@machine`, and the machine names a
 * member. Anything else is an ordinary local recipient, exactly as before.
 */
export function resolveNetworkRecipient(db: MemeshDatabase, recipient: string): NetworkRecipient | null {
  const address = parseNetworkAddress(recipient);
  if (address === null) return null;
  const joined = joinedNetwork(db);
  if (joined === null) return null;
  const member = joined.roster.members.find((candidate) => candidate.name === address.machine);
  if (!member) return null;
  if (member.machine_id === joined.config.machine_id) {
    throw new NetworkRecipientError(`${recipient} is this machine. Send to ${JSON.stringify(address.target)} directly.`);
  }
  if (member.person !== address.person) {
    throw new NetworkRecipientError(
      `Machine ${JSON.stringify(address.machine)} belongs to ${JSON.stringify(member.person)} in this network, not ${JSON.stringify(address.person)}. `
      + `Use ${formatNetworkAddress(member.person, address.target, address.machine)}.`,
    );
  }
  const path = joined.config.relay_url === RELAY_OFF ? 'directly' : 'through the relay or directly';
  return {
    address,
    member,
    note: `This goes to machine ${address.machine} ${path}; while that machine is offline it is retried for up to one day.`,
  };
}

interface OutboxRow {
  delivery_id: string;
  message_id: string;
  state: string;
  attempts: number;
  last_error_code: string | null;
  delivered_at_ms: number | null;
  path: string | null;
}

/** The network's fact for `receipts`, when this delivery went to another machine. */
export function networkReceiptFact(db: MemeshDatabase, deliveryId: string): AgentJsonObject | null {
  let row: OutboxRow | undefined;
  try {
    row = db.prepare(`
      SELECT delivery_id, message_id, state, attempts, last_error_code, delivered_at_ms, path
      FROM agent_network_outbox WHERE delivery_id = ? AND state != 'local'
    `).get(deliveryId) as OutboxRow | undefined;
  } catch {
    return null;
  }
  if (!row) return null;
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

/**
 * Where a delivery stands on the network, from the same fact `receipts` shows. `null` for a local recipient.
 * With no outbox row yet, a recipient on another machine is already handed to the network (the courier
 * writes its row on its next pass); a row marked `local` is a message that stays on this machine.
 */
export function networkDeliveryOf(db: MemeshDatabase, delivery: { delivery_id: string; recipient: string }): { state: string; code: string | null; machine: string } | null {
  const fact = networkReceiptFact(db, delivery.delivery_id);
  const network = fact?.network as { state: string; last_error_code: string | null } | undefined;
  try {
    const address = parseNetworkAddress(delivery.recipient);
    if (network) return { state: network.state, code: network.last_error_code, machine: address?.machine ?? 'the other machine' };
    const local = db.prepare("SELECT 1 FROM agent_network_outbox WHERE delivery_id = ? AND state = 'local'").get(delivery.delivery_id);
    if (local || !address || !resolveNetworkRecipient(db, delivery.recipient)) return null;
    return { state: 'pending', code: null, machine: address.machine };
  } catch {
    return null;
  }
}

/**
 * Live agents on other machines in this project, as discover cards. Only for a
 * project this machine has: presence carries a hash, and the hash of this project
 * is the only one asked for. No work summary or title ever crosses.
 */
export function remoteDiscoverCards(db: MemeshDatabase, project: string, now = Date.now()): AgentJsonObject[] {
  const joined = joinedNetwork(db);
  if (joined === null) return [];
  const rows = db.prepare(`
    SELECT machine_id, principal, handle, host_kind, connected FROM agent_network_presence
    WHERE project_hash = ? AND expires_at_ms > ? ORDER BY machine_id, handle
  `).all(projectHash(joined.config.network_id, project), now) as Array<{
    machine_id: string; principal: string; handle: string; host_kind: string; connected: number;
  }>;
  const cards: AgentJsonObject[] = [];
  for (const row of rows) {
    const member = joined.roster.members.find((candidate) => candidate.machine_id === row.machine_id);
    if (!member || member.machine_id === joined.config.machine_id) continue;
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
