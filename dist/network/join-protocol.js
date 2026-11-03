import { consumeInvite, hashToken } from './invites.js';
import { addMember, assertValidName, findMember, signRoster, SIGNED_ROSTER_MAX_BYTES, verifyRoster } from './roster.js';
import { readConfig, saveRoster, signedRosterOf } from './store.js';
import { NetworkError, errorMessage } from './types.js';
export const JOIN_REQUEST_MAX_BYTES = 4 * 1024;
export const JOIN_REPLY_MAX_BYTES = SIGNED_ROSTER_MAX_BYTES + 1024;
const OWNER_SIDE_FAULTS = new Set(['roster_invalid', 'not_owner', 'identity_invalid']);
export function encodeJoinRequest(request) {
    return Buffer.from(JSON.stringify(request));
}
function parseJoinRequest(bytes) {
    let raw;
    try {
        raw = JSON.parse(bytes.toString('utf8'));
    }
    catch {
        throw new NetworkError('bad_request', 'The join request is not JSON.');
    }
    if (raw === null || typeof raw !== 'object' || typeof raw.network_id !== 'string' || typeof raw.token !== 'string') {
        throw new NetworkError('bad_request', 'The join request is missing fields.');
    }
    assertValidName('machine name', raw.name);
    assertValidName('person', raw.person);
    return { network_id: raw.network_id, token: raw.token, name: raw.name, person: raw.person };
}
export function handleJoinRequest(db, identity, remoteMachineId, bytes, now) {
    const decide = db.transaction(() => {
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
        if (findMember(roster, remoteMachineId))
            return current;
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
    }
    catch (err) {
        if (err instanceof NetworkError && !OWNER_SIDE_FAULTS.has(err.code))
            return { ok: false, error: err.code };
        throw new Error(`Join could not be recorded: ${errorMessage(err)}`, { cause: err });
    }
}
const REFUSALS = new Map([
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
export function parseJoinReply(bytes) {
    let raw;
    try {
        raw = JSON.parse(bytes.toString('utf8'));
    }
    catch {
        throw new NetworkError('bad_request', "The network owner's machine sent a reply that could not be read.");
    }
    if (raw?.ok === true && raw.roster !== null && typeof raw.roster === 'object') {
        return { ok: true, roster: raw.roster };
    }
    if (raw?.ok === false) {
        const code = raw.error;
        return { ok: false, error: REFUSALS.has(code) ? code : 'unknown_refusal' };
    }
    throw new NetworkError('bad_request', "The network owner's machine sent a reply that could not be read.");
}
export function refusalMessage(code) {
    return REFUSALS.get(code) ?? REFUSALS.get('unknown_refusal');
}
//# sourceMappingURL=join-protocol.js.map