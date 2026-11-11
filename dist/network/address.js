import { createHash } from 'node:crypto';
import { NAME } from './roster.js';
const TARGET = /^[^/@\s]{1,200}$/;
export function parseNetworkAddress(value) {
    const at = value.lastIndexOf('@');
    if (at <= 0)
        return null;
    const machine = value.slice(at + 1);
    const left = value.slice(0, at);
    const slash = left.indexOf('/');
    if (slash <= 0)
        return null;
    const person = left.slice(0, slash);
    const target = left.slice(slash + 1);
    if (!NAME.test(person) || !NAME.test(machine) || !TARGET.test(target))
        return null;
    return { person, target, machine };
}
export function formatNetworkAddress(person, target, machine) {
    return `${person}/${target}@${machine}`;
}
export function projectHash(networkId, project) {
    return createHash('sha256').update(`${networkId}:${project}`).digest('hex');
}
export function isLocalSenderName(value) {
    return TARGET.test(value);
}
//# sourceMappingURL=address.js.map