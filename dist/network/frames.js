import { AGENT_MESSAGE_JSON_MAX_BYTES } from '../core/agent-messaging.js';
export const FRAME_VERSION = 1;
export const FRAME_MAX_BYTES = AGENT_MESSAGE_JSON_MAX_BYTES + 8 * 1024;
export const ACK_MAX_BYTES = 1024;
export const PRESENCE_MAX_ENTRIES = 256;
const FIELD_MAX = 200;
export const MESSAGE_FRAME_KEYS = [
    'version', 'kind', 'project_hash', 'sender', 'target', 'target_kind', 'idempotency_key', 'content_type',
    'payload', 'correlation_id', 'reply_to_origin', 'origin_message_id', 'created_at',
];
export const PRESENCE_FRAME_KEYS = ['version', 'kind', 'relay', 'addrs', 'entries'];
export const PRESENCE_ENTRY_KEYS = ['project_hash', 'principal', 'handle', 'host_kind', 'connected'];
export class FrameError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
const HASH = /^[0-9a-f]{64}$/;
const isText = (value, max = FIELD_MAX) => typeof value === 'string' && value.length > 0 && value.length <= max;
const isOptionalText = (value) => value === null || isText(value);
function exactKeys(value, keys) {
    const own = Object.keys(value);
    return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
export function parseFrame(bytes) {
    if (bytes.length > FRAME_MAX_BYTES)
        throw new FrameError('frame_too_large', 'The frame is too large.');
    let raw;
    try {
        raw = JSON.parse(bytes.toString('utf8'));
    }
    catch {
        throw new FrameError('frame_invalid', 'The frame is not JSON.');
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== FRAME_VERSION) {
        throw new FrameError('frame_invalid', 'The frame has no supported version.');
    }
    if (raw.kind === 'message') {
        if (!exactKeys(raw, MESSAGE_FRAME_KEYS))
            throw new FrameError('frame_invalid', 'The message frame has other keys than allowed.');
        const ok = isText(raw.project_hash) && HASH.test(raw.project_hash)
            && isText(raw.sender) && !/[/@\s]/.test(raw.sender)
            && isText(raw.target) && raw.target_kind === 'principal'
            && isText(raw.idempotency_key, 300)
            && (raw.content_type === 'text/plain' || raw.content_type === 'application/json')
            && isOptionalText(raw.correlation_id) && isOptionalText(raw.reply_to_origin)
            && isText(raw.origin_message_id) && isText(raw.created_at, 40)
            && Buffer.byteLength(JSON.stringify(raw.payload ?? null)) <= AGENT_MESSAGE_JSON_MAX_BYTES;
        if (!ok)
            throw new FrameError('frame_invalid', 'The message frame has a field of the wrong shape.');
        return raw;
    }
    if (raw.kind === 'presence') {
        if (!exactKeys(raw, PRESENCE_FRAME_KEYS))
            throw new FrameError('frame_invalid', 'The presence frame has other keys than allowed.');
        const entries = raw.entries;
        const addrs = raw.addrs;
        const ok = isOptionalText(raw.relay)
            && Array.isArray(addrs) && addrs.length <= 64 && addrs.every((addr) => isText(addr, 64))
            && Array.isArray(entries) && entries.length <= PRESENCE_MAX_ENTRIES
            && entries.every((entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry)
                && exactKeys(entry, PRESENCE_ENTRY_KEYS)
                && HASH.test(String(entry.project_hash))
                && isText(entry.principal) && isText(entry.handle)
                && isText(entry.host_kind, 20) && typeof entry.connected === 'boolean');
        if (!ok)
            throw new FrameError('frame_invalid', 'The presence frame has a field of the wrong shape.');
        return raw;
    }
    throw new FrameError('frame_invalid', 'The frame kind is unknown.');
}
export function encodeFrame(frame) {
    return Buffer.from(JSON.stringify(frame));
}
export function parseAck(bytes) {
    try {
        const raw = JSON.parse(bytes.toString('utf8'));
        if (['accepted', 'duplicate', 'rejected', 'retry'].includes(String(raw.result))) {
            return { result: raw.result, ...(typeof raw.code === 'string' ? { code: raw.code.slice(0, 64) } : {}) };
        }
    }
    catch { }
    return { result: 'retry', code: 'ack_invalid' };
}
//# sourceMappingURL=frames.js.map