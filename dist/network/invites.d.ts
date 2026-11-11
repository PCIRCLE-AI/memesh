import type { MemeshDatabase } from '../storage/sqlite.js';
import type { Identity } from './identity.js';
export declare const DEFAULT_INVITE_TTL_HOURS = 24;
export declare const MAX_INVITE_TTL_HOURS: number;
export interface InviteLink {
    v: number;
    network_id: string;
    owner_id: string;
    relay: string | null;
    token: string;
    expires_at_ms: number;
    addrs?: string[];
}
export declare function hashToken(token: string): string;
export declare function createInvite(db: MemeshDatabase, ttlMs: number, now: number): {
    token: string;
    expiresAtMs: number;
};
export declare function consumeInvite(db: MemeshDatabase, tokenHash: string, now: number): void;
export declare function encodeLink(identity: Identity, link: InviteLink): string;
export declare function parseLink(text: string): InviteLink;
//# sourceMappingURL=invites.d.ts.map