import type { Identity } from './identity.js';
import { type Roster, type RosterMember, type SignedRoster } from './types.js';
export declare const NAME: RegExp;
export declare const SIGNED_ROSTER_MAX_BYTES: number;
export declare function canonicalJson(value: unknown): string;
export declare function isNetworkId(value: unknown): value is string;
export declare function assertValidName(kind: 'machine name' | 'person', value: unknown): asserts value is string;
export declare function parseRoster(rosterJson: string): Roster;
export declare function createRoster(networkId: string, owner: RosterMember): Roster;
export declare function signRoster(identity: Identity, roster: Roster): SignedRoster;
export declare function verifyRoster(signed: SignedRoster, expectedOwnerId: string, expectedNetworkId: string): Roster;
export declare function acceptRoster(current: SignedRoster | null, incoming: SignedRoster, ownerId: string, networkId: string): Roster;
export declare function findMember(roster: Roster, machineId: string): RosterMember | undefined;
export declare function addMember(roster: Roster, member: RosterMember): Roster;
//# sourceMappingURL=roster.d.ts.map