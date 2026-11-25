import { SIGNED_ROSTER_MAX_BYTES } from './roster.js';
import { deadline, toBytes } from './endpoint.js';
export function parseConversationFrame(bytes) {
    if (bytes.length > FRAME_MAX_BYTES)
        throw new FrameError('frame_too_large', 'Frame too large');
    let raw;
    try {
        raw = JSON.parse(bytes.toString('utf8'));
    }
    catch {
        throw new FrameError('frame_invalid', 'Invalid conversation JSON');
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 2)
        throw new FrameError('frame_invalid', 'Unsupported conversation frame');
    if (raw.kind === 'conversations' && exactKeys(raw, ['version', 'kind', 'relay', 'addrs', 'entries'])
        && isOptionalText(raw.relay) && Array.isArray(raw.addrs) && raw.addrs.length <= 64 && raw.addrs.every((a) => isText(a, 64))
        && Array.isArray(raw.entries) && raw.entries.every((r) => r && typeof r === 'object'
        && !Array.isArray(r) && exactKeys(r, ['id', 'host', 'online']) && isText(r.id)
        && ['claude-code', 'codex', 'hermes'].includes(String(r.host)) && typeof r.online === 'boolean'))
        return raw;
    if (raw.kind === 'conversation-message' && exactKeys(raw, ['version', 'kind', 'row'])
        && raw.row && typeof raw.row === 'object' && !Array.isArray(raw.row)
        && exactKeys(raw.row, ['network_id', 'sender_machine_id', 'recipient_machine_id', 'message']))
        return raw;
    if (raw.kind === 'conversation-receipt' && exactKeys(raw, ['version', 'kind', 'receipt'])
        && raw.receipt && typeof raw.receipt === 'object' && !Array.isArray(raw.receipt)
        && exactKeys(raw.receipt, ['message_id', 'event', 'actor', 'at']))
        return raw;
    throw new FrameError('frame_invalid', 'Invalid conversation frame');
}
export function conversationPresenceFrames(relay, addrs, entries) {
    const frames = [];
    let frame = { version: 2, kind: 'conversations', relay, addrs, entries: [] };
    for (const entry of entries) {
        const next = { ...frame, entries: [...frame.entries, entry] };
        if (Buffer.byteLength(JSON.stringify(next)) > FRAME_MAX_BYTES) {
            if (!frame.entries.length)
                throw new FrameError('frame_too_large', 'Presence entry too large');
            frames.push(frame);
            frame = { ...frame, entries: [entry] };
            parseConversationFrame(Buffer.from(JSON.stringify(frame)));
        }
        else
            frame = next;
    }
    frames.push(frame);
    return frames;
}
export const ROSTER_EXCHANGE_MAX_BYTES = SIGNED_ROSTER_MAX_BYTES + 1024;
export function parseRosterExchange(bytes) {
    if (bytes.length > ROSTER_EXCHANGE_MAX_BYTES)
        throw new FrameError('roster_invalid', 'Roster exchange too large.');
    const raw = JSON.parse(bytes.toString('utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
        || Object.keys(raw).sort().join(',') !== 'roster_json,signature'
        || typeof raw.roster_json !== 'string'
        || Buffer.byteLength(raw.roster_json) > SIGNED_ROSTER_MAX_BYTES
        || typeof raw.signature !== 'string'
        || raw.signature.length > 256) {
        throw new FrameError('roster_invalid', 'Invalid roster exchange.');
    }
    return raw;
}
export async function exchangeRosterStream(stream, local, accept, timeoutMs) {
    const write = async (signed) => {
        const bytes = Buffer.from(JSON.stringify(signed));
        parseRosterExchange(bytes);
        await deadline(stream.send.writeAll(toBytes(bytes)), timeoutMs, 'sending roster');
        await deadline(stream.send.finish(), timeoutMs, 'finishing roster');
    };
    if (local)
        await write(local);
    const received = Buffer.from(await deadline(stream.recv.readToEnd(ROSTER_EXCHANGE_MAX_BYTES), timeoutMs, 'receiving roster'));
    const selected = accept(parseRosterExchange(received));
    if (!local)
        await write(selected);
}
export const FRAME_MAX_BYTES = 72 * 1024;
export const ACK_MAX_BYTES = 1024;
const FIELD_MAX = 200;
export class FrameError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
const isText = (value, max = FIELD_MAX) => typeof value === 'string' && value.length > 0 && value.length <= max;
const isOptionalText = (value) => value === null || isText(value);
function exactKeys(value, keys) {
    const own = Object.keys(value);
    return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
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