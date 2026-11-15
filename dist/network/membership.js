import { parseRosterExchange, ROSTER_EXCHANGE_MAX_BYTES } from './frames.js';
import { acceptRoster, findMember, signRoster, verifyRoster } from './roster.js';
import { readConfig, saveRoster, signedRosterOf } from './store.js';
import { NetworkError } from './types.js';
export const MEMBERSHIP_MAX_BYTES = ROSTER_EXCHANGE_MAX_BYTES + 256;
export const MEMBERSHIP_ACK_MAX_BYTES = 512;
export const MEMBERSHIP_DEADLINE_MS = 5_000;
const NETWORK = /^[0-9a-f]{32}$/;
const MACHINE = /^[0-9a-f]{64}$/;
function keys(value, expected) {
    return Object.keys(value).sort().join(',') === expected.sort().join(',');
}
function invalid() { throw new NetworkError('bad_request', 'Invalid membership request.'); }
export function parseMembershipFrame(bytes) {
    if (bytes.length > MEMBERSHIP_MAX_BYTES)
        invalid();
    const raw = JSON.parse(bytes.toString('utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1 || typeof raw.network_id !== 'string' || !NETWORK.test(raw.network_id))
        invalid();
    if ((raw.op === 'leave-self' || raw.op === 'self-status') && keys(raw, ['version', 'op', 'network_id']))
        return raw;
    if (raw.op === 'roster' && keys(raw, ['version', 'op', 'network_id', 'roster'])) {
        return { ...raw, roster: parseRosterExchange(Buffer.from(JSON.stringify(raw.roster))) };
    }
    invalid();
}
export function parseMembershipAck(bytes, networkId) {
    if (bytes.length > MEMBERSHIP_ACK_MAX_BYTES)
        invalid();
    const raw = JSON.parse(bytes.toString('utf8'));
    if (!raw || typeof raw !== 'object' || !keys(raw, ['version', 'network_id', 'roster_version', 'member'])
        || raw.version !== 1 || raw.network_id !== networkId || !Number.isSafeInteger(raw.roster_version)
        || raw.roster_version < 1 || typeof raw.member !== 'boolean')
        invalid();
    return raw;
}
export function parseMembershipAction(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        invalid();
    const value = raw;
    if (typeof value.network_id !== 'string' || typeof value.machine_id !== 'string' || !NETWORK.test(value.network_id) || !MACHINE.test(value.machine_id))
        invalid();
    if (value.action === 'leave' && keys(value, ['action', 'network_id', 'machine_id']))
        return value;
    if (value.action === 'remove' && keys(value, ['action', 'network_id', 'machine_id', 'target'])
        && typeof value.target === 'string' && value.target.length > 0 && value.target.length <= 64)
        return value;
    invalid();
}
export function membershipConfig(db, expected) {
    const current = readConfig(db);
    if (!current || current.network_id !== expected.network_id || current.machine_id !== expected.machine_id || current.owner_id !== expected.owner_id) {
        throw new NetworkError('wrong_network', 'Network changed during the membership operation.');
    }
    verifyRoster(signedRosterOf(current), current.owner_id, current.network_id);
    return current;
}
export function removeMember(db, identity, expected, target) {
    return db.transaction(() => {
        const current = membershipConfig(db, expected);
        if (current.owner_id !== identity.machineId || current.machine_id !== identity.machineId)
            throw new NetworkError('not_owner', 'Only the network owner can remove a member.');
        const held = verifyRoster(signedRosterOf(current), current.owner_id, current.network_id);
        const member = held.members.find(m => m.machine_id === target || m.name.toLowerCase() === target.toLowerCase());
        const removed = member?.machine_id ?? (MACHINE.test(target) ? target : invalid());
        if (removed === current.owner_id)
            throw new NetworkError('invalid_option', 'Owner departure is not supported; no membership was changed.');
        const signed = member ? signRoster(identity, { ...held, version: held.version + 1, members: held.members.filter(m => m.machine_id !== removed) }) : signedRosterOf(current);
        if (member)
            saveRoster(db, signed);
        return { signed, removed, alreadyRemoved: !member, priorMembers: held.members.map(m => m.machine_id) };
    }).immediate();
}
export function clearMembership(db, expected, confirmedVersion) {
    db.transaction(() => {
        const current = membershipConfig(db, expected);
        if (confirmedVersion !== undefined && verifyRoster(signedRosterOf(current), current.owner_id, current.network_id).version > confirmedVersion) {
            throw new Error('Membership changed after the owner confirmation');
        }
        db.exec('DELETE FROM agent_network_invites; DELETE FROM agent_network_peers; DELETE FROM agent_network_config;');
    }).immediate();
}
export function receiveMembershipRoster(db, expected, incoming) {
    return db.transaction(() => {
        const current = membershipConfig(db, expected);
        const roster = acceptRoster(signedRosterOf(current), incoming, current.owner_id, current.network_id);
        const member = Boolean(findMember(roster, current.machine_id));
        if (member)
            saveRoster(db, incoming);
        else
            clearMembership(db, current);
        return { version: roster.version, member };
    }).immediate();
}
//# sourceMappingURL=membership.js.map