// What one machine sends another on memesh/net/1: one frame per stream, and an
// answer. The keys are an allowlist, checked both ways: anything not listed here
// is never written and is refused when read.

import { AGENT_MESSAGE_JSON_MAX_BYTES, type AgentContentType, type AgentJsonValue } from '../core/agent-messaging.js';

export const FRAME_VERSION = 1;
/** The message payload limit plus room for the envelope around it. */
export const FRAME_MAX_BYTES = AGENT_MESSAGE_JSON_MAX_BYTES + 8 * 1024;
export const ACK_MAX_BYTES = 1024;
export const PRESENCE_MAX_ENTRIES = 256;
const FIELD_MAX = 200;

export const MESSAGE_FRAME_KEYS = [
  'version', 'kind', 'project_hash', 'sender', 'target', 'target_kind', 'idempotency_key', 'content_type',
  'payload', 'correlation_id', 'reply_to_origin', 'origin_message_id', 'created_at',
] as const;
export const PRESENCE_FRAME_KEYS = ['version', 'kind', 'relay', 'addrs', 'entries'] as const;
export const PRESENCE_ENTRY_KEYS = ['project_hash', 'principal', 'handle', 'host_kind', 'connected'] as const;

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
export interface Ack { result: AckResult; code?: string }

export class FrameError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const HASH = /^[0-9a-f]{64}$/;
const isText = (value: unknown, max = FIELD_MAX): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const isOptionalText = (value: unknown): value is string | null => value === null || isText(value);

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Read one frame, refusing anything outside the allowlist. */
export function parseFrame(bytes: Buffer): Frame {
  if (bytes.length > FRAME_MAX_BYTES) throw new FrameError('frame_too_large', 'The frame is too large.');
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new FrameError('frame_invalid', 'The frame is not JSON.');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== FRAME_VERSION) {
    throw new FrameError('frame_invalid', 'The frame has no supported version.');
  }
  if (raw.kind === 'message') {
    if (!exactKeys(raw, MESSAGE_FRAME_KEYS)) throw new FrameError('frame_invalid', 'The message frame has other keys than allowed.');
    const ok = isText(raw.project_hash) && HASH.test(raw.project_hash as string)
      && isText(raw.sender) && !/[/@\s]/.test(raw.sender as string)
      && isText(raw.target) && raw.target_kind === 'principal'
      && isText(raw.idempotency_key, 300)
      && (raw.content_type === 'text/plain' || raw.content_type === 'application/json')
      && isOptionalText(raw.correlation_id) && isOptionalText(raw.reply_to_origin)
      && isText(raw.origin_message_id) && isText(raw.created_at, 40)
      && Buffer.byteLength(JSON.stringify(raw.payload ?? null)) <= AGENT_MESSAGE_JSON_MAX_BYTES;
    if (!ok) throw new FrameError('frame_invalid', 'The message frame has a field of the wrong shape.');
    return raw as unknown as MessageFrame;
  }
  if (raw.kind === 'presence') {
    if (!exactKeys(raw, PRESENCE_FRAME_KEYS)) throw new FrameError('frame_invalid', 'The presence frame has other keys than allowed.');
    const entries = raw.entries;
    const addrs = raw.addrs;
    const ok = isOptionalText(raw.relay)
      && Array.isArray(addrs) && addrs.length <= 64 && addrs.every((addr) => isText(addr, 64))
      && Array.isArray(entries) && entries.length <= PRESENCE_MAX_ENTRIES
      && entries.every((entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry)
        && exactKeys(entry as Record<string, unknown>, PRESENCE_ENTRY_KEYS)
        && HASH.test(String((entry as PresenceEntry).project_hash))
        && isText((entry as PresenceEntry).principal) && isText((entry as PresenceEntry).handle)
        && isText((entry as PresenceEntry).host_kind, 20) && typeof (entry as PresenceEntry).connected === 'boolean');
    if (!ok) throw new FrameError('frame_invalid', 'The presence frame has a field of the wrong shape.');
    return raw as unknown as PresenceFrame;
  }
  throw new FrameError('frame_invalid', 'The frame kind is unknown.');
}

export function encodeFrame(frame: Frame): Buffer {
  return Buffer.from(JSON.stringify(frame));
}

export function parseAck(bytes: Buffer): Ack {
  try {
    const raw = JSON.parse(bytes.toString('utf8')) as Partial<Ack>;
    if (['accepted', 'duplicate', 'rejected', 'retry'].includes(String(raw.result))) {
      return { result: raw.result as AckResult, ...(typeof raw.code === 'string' ? { code: raw.code.slice(0, 64) } : {}) };
    }
  } catch { /* below */ }
  return { result: 'retry', code: 'ack_invalid' };
}
