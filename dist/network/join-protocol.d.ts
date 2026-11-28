import type { MemeshDatabase } from '../storage/sqlite.js';
import type { Identity } from './identity.js';
import { type NetworkErrorCode, type SignedRoster } from './types.js';
export declare const JOIN_REQUEST_MAX_BYTES: number;
export declare const JOIN_REPLY_MAX_BYTES: number;
export interface JoinRequest {
    network_id: string;
    token: string;
    name: string;
    person: string;
}
export type JoinReply = {
    ok: true;
    roster: SignedRoster;
} | {
    ok: false;
    error: NetworkErrorCode;
};
export declare function encodeJoinRequest(request: JoinRequest): Buffer;
export declare function handleJoinRequest(db: MemeshDatabase, identity: Identity, remoteMachineId: string, bytes: Buffer, now: number): JoinReply;
export declare function parseJoinReply(bytes: Buffer): JoinReply;
export declare function refusalMessage(code: NetworkErrorCode): string;
//# sourceMappingURL=join-protocol.d.ts.map