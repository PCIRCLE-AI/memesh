import { type JoinRequest } from './join-protocol.js';
import { type NetworkErrorCode } from './types.js';
export declare const JOIN_CHILD_INPUT_MAX_BYTES: number;
export interface JoinChildInput {
    request: JoinRequest;
    owner_id: string;
    owner_relay: string | null;
    owner_addrs: string[] | undefined;
    own_relay: string;
}
export type JoinChildResult = {
    ok: true;
    reply: string;
    relay_reached: boolean | null;
} | {
    ok: false;
    code: NetworkErrorCode;
    detail: string;
    relay_reached: boolean | null;
};
export declare function runJoinClient(dataDir: string, input: JoinChildInput): Promise<JoinChildResult>;
//# sourceMappingURL=bridge-join.d.ts.map