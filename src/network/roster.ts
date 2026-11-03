// The roster: one document, signed by the owner. Who may connect is read from
// here and nowhere else, so nothing is trusted until its signature checks out.

import type { Identity } from './identity.js';
import { isMachineId, verifySignature } from './identity.js';
import { NetworkError, type Roster, type RosterMember, type SignedRoster } from './types.js';

const SIGNATURE_DOMAIN = 'memesh-roster-v1\n';
const MAX_MEMBERS = 256;
// No `/` and no `@`, so `person/handle@machine` splits exactly one way.
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NETWORK_ID = /^[0-9a-f]{32}$/;
// The exact form Date#toISOString writes. Date.parse alone also accepts free text in parentheses.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const SIGNED_ROSTER_MAX_BYTES = 128 * 1024;

/** Sorted keys, no whitespace: one value has exactly one byte form to sign. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function isNetworkId(value: unknown): value is string {
  return typeof value === 'string' && NETWORK_ID.test(value);
}

export function assertValidName(kind: 'machine name' | 'person', value: unknown): asserts value is string {
  if (typeof value !== 'string' || !NAME.test(value)) {
    throw new NetworkError(
      'invalid_name',
      `The ${kind} must start with a letter or digit and use only letters, digits, ".", "_" and "-" (at most 64 characters).`,
    );
  }
}

function invalid(detail: string): NetworkError {
  return new NetworkError('roster_invalid', `The team list is not valid: ${detail}.`);
}

function parseMember(raw: unknown): RosterMember {
  const member = raw as Partial<RosterMember> | null;
  if (member === null || typeof member !== 'object') throw invalid('a member is not an object');
  if (!isMachineId(member.machine_id)) throw invalid('a member has a bad machine id');
  try {
    assertValidName('machine name', member.name);
    assertValidName('person', member.person);
  } catch {
    throw invalid('a member has a bad name or person');
  }
  if (typeof member.joined_at !== 'string' || !ISO_TIMESTAMP.test(member.joined_at) || !Number.isFinite(Date.parse(member.joined_at))) {
    throw invalid('a member has a bad joined_at');
  }
  return { machine_id: member.machine_id, name: member.name as string, person: member.person as string, joined_at: member.joined_at };
}

export function parseRoster(rosterJson: string): Roster {
  let raw: Partial<Roster>;
  try {
    raw = JSON.parse(rosterJson) as Partial<Roster>;
  } catch {
    throw invalid('it is not JSON');
  }
  if (raw === null || typeof raw !== 'object') throw invalid('it is not an object');
  if (!isNetworkId(raw.network_id)) throw invalid('bad network id');
  if (!isMachineId(raw.owner_id)) throw invalid('bad owner id');
  if (!Number.isSafeInteger(raw.version) || (raw.version as number) < 1) throw invalid('bad version');
  if (!Array.isArray(raw.members) || raw.members.length > MAX_MEMBERS) throw invalid('bad member list');
  const members = raw.members.map(parseMember);
  const names = new Set(members.map((member) => member.name.toLowerCase()));
  const ids = new Set(members.map((member) => member.machine_id));
  if (names.size !== members.length) throw invalid('two machines share a name');
  if (ids.size !== members.length) throw invalid('a machine is listed twice');
  if (!ids.has(raw.owner_id)) throw invalid('the owner is not a member');
  return {
    network_id: raw.network_id,
    owner_id: raw.owner_id,
    version: raw.version as number,
    members,
  };
}

export function createRoster(networkId: string, owner: RosterMember): Roster {
  return { network_id: networkId, owner_id: owner.machine_id, version: 1, members: [owner] };
}

export function signRoster(identity: Identity, roster: Roster): SignedRoster {
  const rosterJson = canonicalJson(roster);
  return { roster_json: rosterJson, signature: identity.sign(Buffer.from(SIGNATURE_DOMAIN + rosterJson)) };
}

/**
 * Parse a roster only if `expectedOwnerId` signed these exact bytes. The owner
 * to check against always comes from the caller (the link, or the stored
 * config), never from the document being checked.
 */
export function verifyRoster(signed: SignedRoster, expectedOwnerId: string, expectedNetworkId: string): Roster {
  if (typeof signed?.roster_json !== 'string' || !verifySignature(expectedOwnerId, Buffer.from(SIGNATURE_DOMAIN + signed.roster_json), signed.signature)) {
    throw new NetworkError('roster_invalid', 'The team list is not signed by the network owner.');
  }
  const roster = parseRoster(signed.roster_json);
  if (roster.owner_id !== expectedOwnerId) throw invalid('it names a different owner');
  if (roster.network_id !== expectedNetworkId) throw invalid('it belongs to a different network');
  return roster;
}

/**
 * Verify a roster received from a peer and decide whether it replaces `current`.
 * Lower is refused. The same version must be the same document: two different
 * documents at one version mean someone is presenting a fork.
 */
export function acceptRoster(current: SignedRoster | null, incoming: SignedRoster, ownerId: string, networkId: string): Roster {
  const roster = verifyRoster(incoming, ownerId, networkId);
  if (current) {
    const held = verifyRoster(current, ownerId, networkId);
    if (roster.version < held.version) {
      throw new NetworkError('roster_downgrade', `Refused an older team list (version ${roster.version}, this machine has ${held.version}).`);
    }
    if (roster.version === held.version && incoming.roster_json !== current.roster_json) {
      throw new NetworkError('roster_downgrade', `Refused a team list that differs from the one this machine has at version ${held.version}.`);
    }
  }
  return roster;
}

export function findMember(roster: Roster, machineId: string): RosterMember | undefined {
  return roster.members.find((member) => member.machine_id === machineId);
}

/** The next roster, one version up. Names compare case-insensitively so `Mac` and `mac` cannot both exist. */
export function addMember(roster: Roster, member: RosterMember): Roster {
  const wanted = member.name.toLowerCase();
  if (roster.members.some((existing) => existing.name.toLowerCase() === wanted)) {
    throw new NetworkError('name_taken', `A machine named "${member.name}" is already in this network. Pick another name.`);
  }
  if (roster.members.length >= MAX_MEMBERS) {
    throw new NetworkError('roster_full', `This network already has ${MAX_MEMBERS} machines.`);
  }
  return { ...roster, version: roster.version + 1, members: [...roster.members, member] };
}
