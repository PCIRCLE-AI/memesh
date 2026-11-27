// Version-2 conversation frames and the shared bounded roster/ACK streams.

import { SIGNED_ROSTER_MAX_BYTES } from './roster.js';
import type { SignedRoster } from './types.js';
import type { BiStream } from './iroh-types.js';
import { deadline, toBytes } from './endpoint.js';
import { isMachineId } from './identity.js';
import type { NetworkConversationMessage, ConversationDeliveryReceipt, RemoteConversationRegistration } from '../core/conversation-messages.js';

export type ConversationFrame =
  | { version: 2; kind: 'conversations'; relay: string | null; addrs: string[]; entries: RemoteConversationRegistration[] }
  | { version: 2; kind: 'peer-routes'; routes: PeerRoute[] }
  | { version: 2; kind: 'conversation-message'; row: NetworkConversationMessage }
  | { version: 2; kind: 'conversation-receipt'; receipt: ConversationDeliveryReceipt };

export interface PeerRoute { machine_id: string; relay: string | null; addrs: string[] }

/** NET/2 contains messages, minimal presence and owner-provided connection hints. */
export function parseConversationFrame(bytes: Buffer): ConversationFrame {
  if (bytes.length > FRAME_MAX_BYTES) throw new FrameError('frame_too_large', 'Frame too large');
  let raw;
  try { raw = JSON.parse(bytes.toString('utf8')); }
  catch { throw new FrameError('frame_invalid', 'Invalid conversation JSON'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 2) throw new FrameError('frame_invalid', 'Unsupported conversation frame');
  if (raw.kind === 'conversations' && exactKeys(raw, ['version','kind','relay','addrs','entries'])
    && isOptionalText(raw.relay) && Array.isArray(raw.addrs) && raw.addrs.length <= 64 && raw.addrs.every((a: unknown) => isText(a, 64))
    && Array.isArray(raw.entries) && raw.entries.every((r: Record<string, unknown>) => r && typeof r === 'object'
      && !Array.isArray(r) && exactKeys(r, ['id','host','online']) && isText(r.id)
      && ['claude-code','codex','hermes'].includes(String(r.host)) && typeof r.online === 'boolean')) return raw;
  if (raw.kind === 'conversation-message' && exactKeys(raw, ['version','kind','row'])
    && raw.row && typeof raw.row === 'object' && !Array.isArray(raw.row)
    && exactKeys(raw.row, ['network_id','sender_machine_id','recipient_machine_id','message'])) return raw;
  if (raw.kind === 'conversation-receipt' && exactKeys(raw, ['version','kind','receipt'])
    && raw.receipt && typeof raw.receipt === 'object' && !Array.isArray(raw.receipt)
    && exactKeys(raw.receipt, ['message_id','event','actor','at'])) return raw;
  if (raw.kind === 'peer-routes' && exactKeys(raw, ['version','kind','routes'])
    && Array.isArray(raw.routes) && raw.routes.length <= 256
    && raw.routes.every((r: Record<string, unknown>) => r && typeof r === 'object' && !Array.isArray(r)
      && exactKeys(r, ['machine_id','relay','addrs']) && isMachineId(r.machine_id) && isOptionalText(r.relay)
      && Array.isArray(r.addrs) && r.addrs.length <= 64 && r.addrs.every((a: unknown) => isText(a, 64)))
    && new Set(raw.routes.map((r: PeerRoute) => r.machine_id)).size === raw.routes.length) return raw;
  throw new FrameError('frame_invalid', 'Invalid conversation frame');
}

export function peerRouteFrames(routes: PeerRoute[]): ConversationFrame[] {
  const frames: ConversationFrame[] = [];
  let frame: Extract<ConversationFrame, { kind: 'peer-routes' }> = { version: 2, kind: 'peer-routes', routes: [] };
  for (const route of routes) {
    const next = { ...frame, routes: [...frame.routes, route] };
    if (Buffer.byteLength(JSON.stringify(next)) > FRAME_MAX_BYTES || next.routes.length > 256) {
      if (!frame.routes.length) throw new FrameError('frame_too_large', 'Peer route too large');
      frames.push(frame); frame = { ...frame, routes: [route] };
      parseConversationFrame(Buffer.from(JSON.stringify(frame)));
    } else frame = next;
  }
  if (frame.routes.length) frames.push(frame);
  return frames;
}

export function conversationPresenceFrames(relay: string | null, addrs: string[], entries: RemoteConversationRegistration[]): ConversationFrame[] {
  const frames: ConversationFrame[] = [];
  let frame: Extract<ConversationFrame, { kind: 'conversations' }> = { version: 2, kind: 'conversations', relay, addrs, entries: [] };
  for (const entry of entries) {
    const next = { ...frame, entries: [...frame.entries, entry] };
    if (Buffer.byteLength(JSON.stringify(next)) > FRAME_MAX_BYTES) {
      if (!frame.entries.length) throw new FrameError('frame_too_large', 'Presence entry too large');
      frames.push(frame); frame = { ...frame, entries: [entry] };
      parseConversationFrame(Buffer.from(JSON.stringify(frame)));
    } else frame = next;
  }
  frames.push(frame);
  return frames;
}

export const ROSTER_EXCHANGE_MAX_BYTES = SIGNED_ROSTER_MAX_BYTES + 1024;

/** Only the bounded signed document is permitted before membership authorization. */
export function parseRosterExchange(bytes: Buffer): SignedRoster {
  if (bytes.length > ROSTER_EXCHANGE_MAX_BYTES) throw new FrameError('roster_invalid', 'Roster exchange too large.');
  const raw: unknown = JSON.parse(bytes.toString('utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).sort().join(',') !== 'roster_json,signature'
    || typeof (raw as SignedRoster).roster_json !== 'string'
    || Buffer.byteLength((raw as SignedRoster).roster_json) > SIGNED_ROSTER_MAX_BYTES
    || typeof (raw as SignedRoster).signature !== 'string'
    || (raw as SignedRoster).signature.length > 256) {
    throw new FrameError('roster_invalid', 'Invalid roster exchange.');
  }
  return raw as SignedRoster;
}

/** A separate bounded stream completes before the caller opens a business stream. */
export async function exchangeRosterStream(
  stream: BiStream, local: SignedRoster | null,
  accept: (incoming: SignedRoster) => SignedRoster, timeoutMs: number,
): Promise<void> {
  const write = async (signed: SignedRoster): Promise<void> => {
    const bytes = Buffer.from(JSON.stringify(signed));
    parseRosterExchange(bytes);
    await deadline(stream.send.writeAll(toBytes(bytes)), timeoutMs, 'sending roster');
    await deadline(stream.send.finish(), timeoutMs, 'finishing roster');
  };
  if (local) await write(local);
  const received = Buffer.from(await deadline(stream.recv.readToEnd(ROSTER_EXCHANGE_MAX_BYTES), timeoutMs, 'receiving roster'));
  const selected = accept(parseRosterExchange(received));
  if (!local) await write(selected);
}

// Preserve the existing bounded stream size for conversation presence batches.
export const FRAME_MAX_BYTES = 72 * 1024;
export const ACK_MAX_BYTES = 1024;
const FIELD_MAX = 200;

export type AckResult = 'accepted' | 'duplicate' | 'rejected' | 'retry';
export interface Ack { result: AckResult; code?: string }

export class FrameError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const isText = (value: unknown, max = FIELD_MAX): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const isOptionalText = (value: unknown): value is string | null => value === null || isText(value);

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
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
