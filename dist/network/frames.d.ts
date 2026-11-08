import { type AgentContentType, type AgentJsonValue } from '../core/agent-messaging.js';
export declare const FRAME_VERSION = 1;
export declare const FRAME_MAX_BYTES: number;
export declare const ACK_MAX_BYTES = 1024;
export declare const PRESENCE_MAX_ENTRIES = 256;
export declare const MESSAGE_FRAME_KEYS: readonly ["version", "kind", "project_hash", "sender", "target", "target_kind", "idempotency_key", "content_type", "payload", "correlation_id", "reply_to_origin", "origin_message_id", "created_at"];
export declare const PRESENCE_FRAME_KEYS: readonly ["version", "kind", "relay", "addrs", "entries"];
export declare const PRESENCE_ENTRY_KEYS: readonly ["project_hash", "principal", "handle", "host_kind", "connected"];
export interface MessageFrame {
    version: 1;
    kind: 'message';
    project_hash: string;
    sender: string;
    target: string;
    target_kind: 'principal';
    idempotency_key: string;
    content_type: AgentContentType;
    payload: AgentJsonValue;
    correlation_id: string | null;
    reply_to_origin: string | null;
    origin_message_id: string;
    created_at: string;
}
export interface PresenceEntry {
    project_hash: string;
    principal: string;
    handle: string;
    host_kind: string;
    connected: boolean;
}
export interface PresenceFrame {
    version: 1;
    kind: 'presence';
    relay: string | null;
    addrs: string[];
    entries: PresenceEntry[];
}
export type Frame = MessageFrame | PresenceFrame;
export type AckResult = 'accepted' | 'duplicate' | 'rejected' | 'retry';
export interface Ack {
    result: AckResult;
    code?: string;
}
export declare class FrameError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function parseFrame(bytes: Buffer): Frame;
export declare function encodeFrame(frame: Frame): Buffer;
export declare function parseAck(bytes: Buffer): Ack;
//# sourceMappingURL=frames.d.ts.map