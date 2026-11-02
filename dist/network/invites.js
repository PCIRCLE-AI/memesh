import { createHash, randomBytes } from 'node:crypto';
import { isMachineId, verifySignature } from './identity.js';
import { canonicalJson } from './roster.js';
import { NetworkError, RELAY_OFF } from './types.js';
const LINK_PREFIX = 'memesh://join/';
const LINK_VERSION = 1;
const LINK_MAX_CHARS = 8192;
const LINK_MAX_ADDRESSES = 64;
const SIGNATURE_DOMAIN = 'memesh-join-link-v1\n';
const TOKEN_BYTES = 32;
const ADDRESS = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:.%a-zA-Z]+\]):\d{1,5}$/;
export const DEFAULT_INVITE_TTL_HOURS = 24;
export const MAX_INVITE_TTL_HOURS = 24 * 30;
export function hashToken(token) {
    return createHash('sha256').update(token).digest('hex');
}
export function createInvite(db, ttlMs, now) {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const expiresAtMs = now + ttlMs;
    db.prepare('INSERT INTO agent_network_invites (hash, expires_at_ms, used_at) VALUES (?, ?, NULL)').run(hashToken(token), expiresAtMs);
    return { token, expiresAtMs };
}
export function consumeInvite(db, tokenHash, now) {
    const { changes } = db
        .prepare('UPDATE agent_network_invites SET used_at = ? WHERE hash = ? AND used_at IS NULL AND expires_at_ms > ?')
        .run(now, tokenHash, now);
    if (Number(changes) === 1)
        return;
    const row = db.prepare('SELECT used_at FROM agent_network_invites WHERE hash = ?').get(tokenHash);
    if (!row)
        throw new NetworkError('invite_unknown', 'This invite link is not one this network created.');
    if (row.used_at !== null)
        throw new NetworkError('invite_used', 'This invite link has already been used. Ask for a new one.');
    throw new NetworkError('invite_expired', 'This invite link has expired. Ask for a new one.');
}
function signedPayload(link) {
    return Buffer.from(SIGNATURE_DOMAIN + canonicalJson(link));
}
export function encodeLink(identity, link) {
    const signature = identity.sign(signedPayload(link));
    return LINK_PREFIX + Buffer.from(JSON.stringify({ ...link, sig: signature })).toString('base64url');
}
function malformed(detail) {
    return new NetworkError('link_malformed', `This is not a valid MeMesh invite link: ${detail}. Copy the whole link and try again.`);
}
function isRelay(value) {
    if (value === null)
        return true;
    if (typeof value !== 'string' || value === RELAY_OFF)
        return false;
    try {
        const { protocol } = new URL(value);
        return protocol === 'https:' || protocol === 'http:';
    }
    catch {
        return false;
    }
}
export function parseLink(text) {
    if (typeof text !== 'string' || !text.startsWith(LINK_PREFIX))
        throw malformed(`it does not start with ${LINK_PREFIX}`);
    if (text.length > LINK_MAX_CHARS)
        throw malformed('it is too long');
    const encoded = text.slice(LINK_PREFIX.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded))
        throw malformed('it contains characters a link cannot have');
    let raw;
    try {
        raw = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    }
    catch {
        throw malformed('its contents cannot be read');
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        throw malformed('its contents cannot be read');
    if (raw.v !== LINK_VERSION) {
        throw new NetworkError('link_version', 'This invite link was made by a different version of MeMesh. Update MeMesh on both machines.');
    }
    const { sig, ...fields } = raw;
    const link = fields;
    if (typeof link.network_id !== 'string' || link.network_id.length === 0)
        throw malformed('no network id');
    if (!isMachineId(link.owner_id))
        throw malformed('no owner id');
    if (!isRelay(link.relay))
        throw malformed('bad relay address');
    if (typeof link.token !== 'string' || Buffer.from(link.token, 'base64url').length !== TOKEN_BYTES)
        throw malformed('bad token');
    if (!Number.isSafeInteger(link.expires_at_ms))
        throw malformed('bad expiry');
    if (link.addrs !== undefined) {
        const addrs = link.addrs;
        if (!Array.isArray(addrs) || addrs.length > LINK_MAX_ADDRESSES || !addrs.every((a) => typeof a === 'string' && ADDRESS.test(a))) {
            throw malformed('bad addresses');
        }
    }
    if (typeof sig !== 'string' || !verifySignature(link.owner_id, signedPayload(link), sig)) {
        throw new NetworkError('link_tampered', 'This invite link has been altered and cannot be trusted. Ask for a new one.');
    }
    return link;
}
//# sourceMappingURL=invites.js.map