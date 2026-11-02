import { isMachineId, verifySignature } from './identity.js';
import { NetworkError } from './types.js';
const SIGNATURE_DOMAIN = 'memesh-roster-v1\n';
const MAX_MEMBERS = 256;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const SIGNED_ROSTER_MAX_BYTES = 128 * 1024;
export function canonicalJson(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        const record = value;
        const fields = Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
        return `{${fields.join(',')}}`;
    }
    return JSON.stringify(value);
}
export function assertValidName(kind, value) {
    if (typeof value !== 'string' || !NAME.test(value)) {
        throw new NetworkError('invalid_name', `The ${kind} must start with a letter or digit and use only letters, digits, ".", "_" and "-" (at most 64 characters).`);
    }
}
function invalid(detail) {
    return new NetworkError('roster_invalid', `The team list is not valid: ${detail}.`);
}
function parseMember(raw) {
    const member = raw;
    if (member === null || typeof member !== 'object')
        throw invalid('a member is not an object');
    if (!isMachineId(member.machine_id))
        throw invalid('a member has a bad machine id');
    try {
        assertValidName('machine name', member.name);
        assertValidName('person', member.person);
    }
    catch {
        throw invalid('a member has a bad name or person');
    }
    if (typeof member.joined_at !== 'string' || !Number.isFinite(Date.parse(member.joined_at))) {
        throw invalid('a member has a bad joined_at');
    }
    return { machine_id: member.machine_id, name: member.name, person: member.person, joined_at: member.joined_at };
}
export function parseRoster(rosterJson) {
    let raw;
    try {
        raw = JSON.parse(rosterJson);
    }
    catch {
        throw invalid('it is not JSON');
    }
    if (raw === null || typeof raw !== 'object')
        throw invalid('it is not an object');
    if (typeof raw.network_id !== 'string' || raw.network_id.length === 0)
        throw invalid('no network id');
    if (!isMachineId(raw.owner_id))
        throw invalid('bad owner id');
    if (!Number.isSafeInteger(raw.version) || raw.version < 1)
        throw invalid('bad version');
    if (!Number.isSafeInteger(raw.invite_epoch) || raw.invite_epoch < 0)
        throw invalid('bad invite epoch');
    if (!Array.isArray(raw.members) || raw.members.length > MAX_MEMBERS)
        throw invalid('bad member list');
    const members = raw.members.map(parseMember);
    const names = new Set(members.map((member) => member.name.toLowerCase()));
    const ids = new Set(members.map((member) => member.machine_id));
    if (names.size !== members.length)
        throw invalid('two machines share a name');
    if (ids.size !== members.length)
        throw invalid('a machine is listed twice');
    if (!ids.has(raw.owner_id))
        throw invalid('the owner is not a member');
    return {
        network_id: raw.network_id,
        owner_id: raw.owner_id,
        version: raw.version,
        members,
        invite_epoch: raw.invite_epoch,
    };
}
export function createRoster(networkId, owner) {
    return { network_id: networkId, owner_id: owner.machine_id, version: 1, members: [owner], invite_epoch: 0 };
}
export function signRoster(identity, roster) {
    const rosterJson = canonicalJson(roster);
    return { roster_json: rosterJson, signature: identity.sign(Buffer.from(SIGNATURE_DOMAIN + rosterJson)) };
}
export function verifyRoster(signed, expectedOwnerId, expectedNetworkId) {
    if (typeof signed?.roster_json !== 'string' || !verifySignature(expectedOwnerId, Buffer.from(SIGNATURE_DOMAIN + signed.roster_json), signed.signature)) {
        throw new NetworkError('roster_invalid', 'The team list is not signed by the network owner.');
    }
    const roster = parseRoster(signed.roster_json);
    if (roster.owner_id !== expectedOwnerId)
        throw invalid('it names a different owner');
    if (roster.network_id !== expectedNetworkId)
        throw invalid('it belongs to a different network');
    return roster;
}
export function acceptRoster(current, incoming, ownerId, networkId) {
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
export function findMember(roster, machineId) {
    return roster.members.find((member) => member.machine_id === machineId);
}
export function addMember(roster, member) {
    const wanted = member.name.toLowerCase();
    if (roster.members.some((existing) => existing.name.toLowerCase() === wanted)) {
        throw new NetworkError('name_taken', `A machine named "${member.name}" is already in this network. Pick another name.`);
    }
    if (roster.members.length >= MAX_MEMBERS) {
        throw new NetworkError('roster_full', `This network already has ${MAX_MEMBERS} machines.`);
    }
    return { ...roster, version: roster.version + 1, members: [...roster.members, member] };
}
//# sourceMappingURL=roster.js.map