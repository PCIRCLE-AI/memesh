// The join exchange on ALPN memesh/join/1, without any transport: bytes in,
// bytes out. The joining machine's id is a parameter that comes from the
// authenticated connection, so nothing a joiner writes can claim another identity.

import type { MemeshDatabase } from '../storage/sqlite.js';
import type { Identity } from './identity.js';
import { consumeInvite, hashToken } from './invites.js';
import { addMember, assertValidName, findMember, signRoster, SIGNED_ROSTER_MAX_BYTES, verifyRoster } from './roster.js';
import { readConfig, saveRoster, signedRosterOf } from './store.js';
import { NetworkError, errorMessage, type NetworkErrorCode, type SignedRoster } from './types.js';

export const JOIN_REQUEST_MAX_BYTES = 4 * 1024;
export const JOIN_REPLY_MAX_BYTES = SIGNED_ROSTER_MAX_BYTES + 1024;

export interface JoinRequest {
  network_id: string;
  token: string;
  name: string;
  person: string;
}

export type JoinReply =
  | { ok: true; roster: SignedRoster }
  | { ok: false; error: NetworkErrorCode };

/** Faults in the owner's own state. They say nothing about the joiner, so they are the owner's to see. */
const OWNER_SIDE_FAULTS = new Set<NetworkErrorCode>(['roster_invalid', 'not_owner', 'identity_invalid']);

export function encodeJoinRequest(request: JoinRequest): Buffer {
  return Buffer.from(JSON.stringify(request));
}

function parseJoinRequest(bytes: Buffer): JoinRequest {
  let raw: Partial<JoinRequest> | null;
  try {
    raw = JSON.parse(bytes.toString('utf8')) as Partial<JoinRequest> | null;
  } catch {
    throw new NetworkError('bad_request', 'The join request is not JSON.');
  }
  if (raw === null || typeof raw !== 'object' || typeof raw.network_id !== 'string' || typeof raw.token !== 'string') {
    throw new NetworkError('bad_request', 'The join request is missing fields.');
  }
  assertValidName('machine name', raw.name);
  assertValidName('person', raw.person);
  return { network_id: raw.network_id, token: raw.token, name: raw.name, person: raw.person };
}

/**
 * Decide one join. Everything runs in one write transaction: a refusal after
 * the invite was consumed (a taken name, say) rolls the consumption back, so a
 * person can correct the name and reuse the link.
 */
export function handleJoinRequest(
  db: MemeshDatabase,
  identity: Identity,
  remoteMachineId: string,
  bytes: Buffer,
  now: number,
): JoinReply {
  const decide = db.transaction((): SignedRoster => {
    const config = readConfig(db);
    if (!config || config.owner_id !== identity.machineId) {
      throw new NetworkError('not_owner', 'This machine does not own a network.');
    }
    const request = parseJoinRequest(bytes);
    if (request.network_id !== config.network_id) {
      throw new NetworkError('wrong_network', 'This link is for a different network.');
    }
    const current = signedRosterOf(config);
    const roster = verifyRoster(current, config.owner_id, config.network_id);
    // Already a member: the machine id is authenticated, and the only way to be
    // here is a reply that never arrived. Hand the list back instead of leaving
    // that machine holding a used link and no way to learn it got in.
    if (findMember(roster, remoteMachineId)) return current;
    consumeInvite(db, hashToken(request.token), now);
    const next = signRoster(identity, addMember(roster, {
      machine_id: remoteMachineId,
      name: request.name,
      person: request.person,
      joined_at: new Date(now).toISOString(),
    }));
    saveRoster(db, next);
    return next;
  });
  try {
    return { ok: true, roster: decide.immediate() };
  } catch (err) {
    if (err instanceof NetworkError && !OWNER_SIDE_FAULTS.has(err.code)) return { ok: false, error: err.code };
    // The caller records it; a joiner learns only that it failed.
    throw new Error(`Join could not be recorded: ${errorMessage(err)}`, { cause: err });
  }
}

const REFUSALS = new Map<NetworkErrorCode, string>([
  ['invite_used', 'This invite link has already been used. Ask for a new one.'],
  ['invite_expired', 'This invite link has expired. Ask for a new one.'],
  ['invite_unknown', 'The network owner does not recognise this invite link. Ask for a new one.'],
  ['name_taken', 'That machine name is already in this network. Run join again with a different --name; the link still works.'],
  ['wrong_network', 'This link is for a different network than the machine it reached.'],
  ['invalid_name', 'The network owner refused that machine name or person.'],
  ['bad_request', "The network owner's machine could not read the request. Update MeMesh on both machines."],
  ['roster_full', 'That network has no room for another machine.'],
  ['internal', "The network owner's machine could not record the join. Its `memesh network status` shows why. Trying again with the same link is safe."],
  ['unknown_refusal', 'The network owner refused the join for a reason this version of MeMesh does not know.'],
]);

export function parseJoinReply(bytes: Buffer): JoinReply {
  let raw: { ok?: unknown; error?: unknown; roster?: unknown } | null;
  try {
    raw = JSON.parse(bytes.toString('utf8')) as typeof raw;
  } catch {
    throw new NetworkError('bad_request', "The network owner's machine sent a reply that could not be read.");
  }
  if (raw?.ok === true && raw.roster !== null && typeof raw.roster === 'object') {
    return { ok: true, roster: raw.roster as SignedRoster };
  }
  if (raw?.ok === false) {
    // A reply is whatever the machine at the other end chose to send. Only codes
    // from the table above go further; anything else is reported as a fixed string.
    const code = raw.error as NetworkErrorCode;
    return { ok: false, error: REFUSALS.has(code) ? code : 'unknown_refusal' };
  }
  throw new NetworkError('bad_request', "The network owner's machine sent a reply that could not be read.");
}

export function refusalMessage(code: NetworkErrorCode): string {
  return REFUSALS.get(code) ?? (REFUSALS.get('unknown_refusal') as string);
}
