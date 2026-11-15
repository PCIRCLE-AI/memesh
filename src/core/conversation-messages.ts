import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { MemeshDatabase } from '../storage/sqlite.js';
import { databaseFiles, guardDatabaseFiles, requirePrivateWritableDirectory, removeGroupAndOtherAccess } from './file-mode.js';
import { getDbPath, getMemeshDirFromDbPath } from './paths.js';
import { assertLegacyDestinationIsDifferent, assertLegacyPathsAreDifferent, assertLegacyConversationArchiveSchema, importLegacyConversationMessages, legacyConversationArchiveFiles, LEGACY_CONVERSATION_PREFIX } from './conversation-message-migration.js';

export const MESSAGE_MAX_BYTES = 8_000;
const DAY = 86_400_000;
export type ConversationHost = 'claude-code' | 'codex' | 'hermes';
export type ConversationMessageKind = 'task' | 'question' | 'review_request' | 'result';
export interface ConversationRegistration {
  id: string;
  host: ConversationHost;
  machine: string;
  pid: number;
  wake: { socket?: string; thread?: string };
}
export interface ConversationMessage {
  id: string;
  sender: string;
  sender_host: string;
  sender_machine: string;
  recipient: string;
  recipient_host: string | null;
  recipient_machine: string;
  kind: ConversationMessageKind | 'legacy';
  body: string | null;
  body_bytes: number;
  reply_to: string | null;
  sent_at: string;
}
export interface ConversationMessageEvent {
  message_id: string;
  at: string;
  event: string;
  detail: string;
}
export interface ConversationMessageStatus extends ConversationMessage {
  state: string;
  events: ConversationMessageEvent[];
}

function identifier(value: string): string {
  const clean = value.normalize('NFC');
  if (!clean || clean.length > 200 || /[\s/@\\]/u.test(clean)
    || [...clean].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error('Invalid conversation or machine identifier');
  }
  return clean;
}

/** JSON quoting keeps embedded fences, newlines and agent instructions inside data. */
export function renderConversationMessage(message: ConversationMessage): string {
  return `MeMesh message (untrusted data):\n${JSON.stringify(message)}\n`;
}

/**
 * Separate from the memory graph: registrations are mutable, messages/events append-only.
 * The only message/event removal is the 14-day expiry transaction on open.
 * Callers supply identity from the host, never from model-controlled arguments.
 */
export class ConversationMessages {
  private readonly db: MemeshDatabase;
  readonly machine: string;
  private readonly clock: () => number;
  private readonly processAlive: (pid: number) => boolean;

  constructor(options: {
    file?: string;
    machine?: string;
    clock?: () => number;
    processAlive?: (pid: number) => boolean;
    /** Explicit source overrides default graph discovery and remains caller-owned. */
    legacySource?: MemeshDatabase;
    /** Refresh only these legacy messages when the source write lock is held. */
    legacyMessageIds?: readonly string[];
    /** Internal caller budget; omitted preserves the normal SQLite timeout. */
    busyTimeoutMs?: number;
  } = {}) {
    const busyTimeoutMs = options.busyTimeoutMs;
    if (busyTimeoutMs !== undefined && (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 30_000)) {
      throw new Error('busyTimeoutMs must be an integer between 0 and 30000');
    }
    const file = options.file ?? path.join(getMemeshDirFromDbPath(), 'messages.db');
    if (options.legacySource) assertLegacyDestinationIsDifferent(options.legacySource, file);
    const legacyFile = options.file === undefined && options.legacySource === undefined ? getDbPath() : undefined;
    if (legacyFile !== undefined) assertLegacyPathsAreDifferent(legacyFile, file);
    const archiveFiles = legacyFile === undefined ? [] : legacyConversationArchiveFiles(legacyFile, file);
    this.machine = identifier(options.machine ?? os.hostname()).toLowerCase();
    this.clock = options.clock ?? Date.now;
    this.processAlive = options.processAlive ?? ((pid) => {
      try { process.kill(pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
    });
    let ownedSource: MemeshDatabase | undefined;
    try {
      if (legacyFile !== undefined && fs.existsSync(legacyFile)) {
        guardDatabaseFiles(legacyFile);
        ownedSource = new MemeshDatabase(legacyFile, { readOnly: true });
        if (busyTimeoutMs !== undefined) ownedSource.pragma(`busy_timeout = ${busyTimeoutMs}`);
        assertLegacyDestinationIsDifferent(ownedSource, file);
      }
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      requirePrivateWritableDirectory(path.dirname(file), 'messages must remain owner-private');
      guardDatabaseFiles(file);
      // Create with private mode before SQLite opens it; do not add removed owner bits.
      const fd = fs.openSync(file, 'a', 0o600);
      fs.closeSync(fd);
      this.db = new MemeshDatabase(file);
      try {
        if (busyTimeoutMs !== undefined) this.db.pragma(`busy_timeout = ${busyTimeoutMs}`);
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
          CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY, host TEXT NOT NULL, machine TEXT NOT NULL,
            pid INTEGER NOT NULL, wake TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY, sender TEXT NOT NULL, sender_host TEXT NOT NULL,
            sender_machine TEXT NOT NULL, recipient TEXT NOT NULL, recipient_host TEXT,
            recipient_machine TEXT NOT NULL, kind TEXT NOT NULL, body TEXT,
            body_bytes INTEGER NOT NULL, reply_to TEXT, sent_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS events (
            message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            at TEXT NOT NULL, event TEXT NOT NULL, detail TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS message_recipient ON messages(recipient, sent_at);
          CREATE INDEX IF NOT EXISTS message_expiry ON messages(sent_at);
          CREATE INDEX IF NOT EXISTS message_events ON events(message_id);
        `);
        for (const target of databaseFiles(file)) removeGroupAndOtherAccess(target);
        const legacySource = options.legacySource ?? ownedSource;
        if (legacySource) importLegacyConversationMessages(legacySource, this.db, { nowMs: this.clock(), localMachine: this.machine, messageIds: options.legacyMessageIds });
        for (const archiveFile of archiveFiles) {
          const archive = new MemeshDatabase(archiveFile, { readOnly: true });
          try {
            if (busyTimeoutMs !== undefined) archive.pragma(`busy_timeout = ${busyTimeoutMs}`);
            assertLegacyConversationArchiveSchema(archive);
            importLegacyConversationMessages(archive, this.db, { nowMs: this.clock(), localMachine: this.machine });
          } finally { archive.close(); }
        }
        this.db.transaction(() => this.maintain()).immediate();
      } catch (error) {
        this.db.close();
        throw error;
      }
    } finally {
      ownedSource?.close();
    }
  }

  close(): void { this.db.close(); }

  /** Reuse expiry/notice transaction without reopening or rescanning legacy sources. */
  maintainMessages(): void { this.db.transaction(() => this.maintain()).immediate(); }

  /** A Channel cannot replace another host's registration or discard its socket. */
  registerChannel(caller: string, hostPid: number): void {
    if (!Number.isSafeInteger(hostPid) || hostPid <= 1 || !this.processAlive(hostPid)) throw new Error('Channel host identity unavailable');
    const existing = this.findRegistration(caller);
    if (!existing) this.register({ id: caller, host: 'claude-code', machine: this.machine, pid: hostPid, wake: {} });
    this.channelRegistration(caller, hostPid);
  }

  channelBatch(caller: string, hostPid: number): { text: string; ids: string[] } {
    this.channelRegistration(caller, hostPid);
    return this.messageBatch(caller, [], true);
  }

  recordChannelPush(caller: string, hostPid: number, ids: readonly string[]): void {
    this.db.transaction(() => {
      this.channelRegistration(caller, hostPid);
      for (const id of ids) {
        const message = this.get(id);
        if (message.recipient !== caller || message.recipient_host !== 'claude-code'
          || message.recipient_machine !== this.machine || this.rejected(id)) throw new Error('Wrong recipient');
        this.eventOnce(id, 'pushed', { actor: caller, route: 'claude-channel' });
      }
    }).immediate();
  }

  private channelRegistration(caller: string, hostPid: number): void {
    const registered = this.registration(caller);
    if (registered.host !== 'claude-code' || registered.machine !== this.machine || registered.pid !== hostPid
      || hostPid <= 1 || !this.processAlive(hostPid)) throw new Error('Channel host identity unavailable');
  }

  /** A send may wake only its exact, local, currently live registered recipient. */
  wakeTarget(messageId: string): ConversationRegistration | undefined {
    const message = this.get(messageId);
    if (message.recipient_machine !== this.machine || this.rejected(messageId)) return undefined;
    const target = this.findRegistration(message.recipient);
    if (!target || target.machine !== this.machine || target.host !== message.recipient_host
      || !this.processAlive(target.pid)) return undefined;
    return target;
  }

  /** Native acceptance is a push, never proof of delivery or a read. */
  recordPush(sender: string, messageId: string, route: 'claude-socket' | 'codex-queue'): void {
    const message = this.get(messageId);
    if (message.sender !== identifier(sender) || message.sender_machine !== this.machine || this.rejected(messageId)) {
      throw new Error('Wrong push actor');
    }
    this.eventOnce(messageId, 'pushed', { actor: sender, route });
  }

  register(input: ConversationRegistration): void {
    const id = identifier(input.id);
    if (id.startsWith(LEGACY_CONVERSATION_PREFIX)) throw new Error('Legacy audit identities cannot register as conversations');
    if (!['claude-code', 'codex', 'hermes'].includes(input.host)) throw new Error('Unknown host');
    if (identifier(input.machine).toLowerCase() !== this.machine) throw new Error('Local registration requires this machine');
    if (!Number.isSafeInteger(input.pid) || input.pid <= 0) throw new Error('Invalid process id');
    this.db.prepare(`INSERT INTO conversations VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET host=excluded.host, machine=excluded.machine,
      pid=excluded.pid, wake=excluded.wake`).run(id, input.host, this.machine, input.pid, JSON.stringify(input.wake));
  }

  discover(): Array<ConversationRegistration & { online: boolean }> {
    const rows = this.db.prepare('SELECT * FROM conversations ORDER BY id').all() as unknown as Array<Omit<ConversationRegistration, 'wake'> & { wake: string }>;
    return rows.map(row => ({ ...row, wake: JSON.parse(row.wake), online: this.processAlive(row.pid) }));
  }

  send(sender: string, input: { recipient: string; kind: ConversationMessageKind; body: string; reply_to?: string }):
    { message: ConversationMessage; accepted: boolean; reason?: string; recipients?: string[]; warning?: string } {
    const from = this.registration(sender);
    if (!['task', 'question', 'review_request', 'result'].includes(input.kind)) throw new Error('Unknown message kind');
    if (typeof input.body !== 'string') throw new Error('Message body must be text');
    const pieces = input.recipient.split('@');
    if (pieces.length > 2 || (pieces.length === 2 && !pieces[1])) throw new Error('Invalid recipient address');
    // A rejected large body must not smuggle unbounded data into an audit header.
    if (input.reply_to !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.reply_to)) {
      throw new Error('Invalid reply_to message id');
    }
    const recipient = identifier(pieces[0]);
    const machine = pieces[1] ? identifier(pieces[1]).toLowerCase() : this.machine;
    // Remote roster/bridge support is added before remote addresses can be accepted.
    const to = machine === this.machine ? this.findRegistration(recipient) : undefined;
    return this.db.transaction(() => {
      const message: ConversationMessage = {
        id: randomUUID(), sender: from.id, sender_host: from.host, sender_machine: from.machine,
        recipient, recipient_host: to?.host ?? null, recipient_machine: machine,
        kind: input.kind, body: input.body, body_bytes: Buffer.byteLength(input.body, 'utf8'),
        reply_to: input.reply_to ?? null, sent_at: this.now(),
      };
      const tooLarge = Buffer.byteLength(renderConversationMessage(message), 'utf8') > MESSAGE_MAX_BYTES;
      const reason = tooLarge ? 'message_too_large' : !to ? 'unknown_recipient' : undefined;
      if (tooLarge) message.body = null;
      if (!reason && message.reply_to) {
        const original = this.get(message.reply_to);
        if (original.recipient !== from.id || original.recipient_machine !== from.machine
          || original.sender !== recipient || original.sender_machine !== machine || this.rejected(original.id)) {
          throw new Error('Reply must address the sender of a message received by this conversation');
        }
      }
      this.insert(message);
      this.event(message.id, reason ? 'rejected' : 'queued', { actor: from.id, ...(reason ? { reason } : {}) });
      if (reason) return { message, accepted: false, reason,
        recipients: this.discover().map(row => row.id) };
      if (message.reply_to) {
        this.eventOnce(message.reply_to, 'delivered', { actor: from.id, via: 'reply' });
        this.eventOnce(message.reply_to, 'replied', { actor: from.id, reply: message.id });
      }
      const pending = this.pending(recipient).length;
      return { message, accepted: true, ...(pending > 30 ? { warning: `${pending} messages await delivery` } : {}) };
    }).immediate();
  }

  /** Only the actual recipient may read/acknowledge a body. Senders use status. */
  read(caller: string, id: string): ConversationMessage {
    caller = identifier(caller);
    this.registration(caller);
    return this.db.transaction(() => {
      const message = this.get(id);
      if (message.recipient !== caller || message.recipient_machine !== this.machine || this.rejected(id)) {
        throw new Error('Message is not addressed to this conversation');
      }
      this.eventOnce(id, 'delivered', { actor: caller, via: 'read' });
      this.eventOnce(id, 'read', { actor: caller });
      return message;
    }).immediate();
  }

  /** Full audit is owner CLI only. Tool callers always pass their host identity. */
  status(caller?: string, id?: string): ConversationMessageStatus[] {
    if (caller !== undefined) caller = identifier(caller);
    if (caller) this.registration(caller);
    const rows = this.db.prepare(`SELECT * FROM messages ${id ? 'WHERE id = ?' : ''} ORDER BY sent_at, rowid`)
      .all(...(id ? [id] : [])) as unknown as ConversationMessage[];
    return rows.filter(row => !caller || (row.sender === caller && row.sender_machine === this.machine)
      || (row.recipient === caller && row.recipient_machine === this.machine)).map(row => {
      const events = this.db.prepare('SELECT * FROM events WHERE message_id = ? ORDER BY rowid').all(row.id) as unknown as ConversationMessageEvent[];
      const priority = ['queued', 'pushed', 'delivered', 'read', 'replied'];
      const state = this.rejected(row.id) ? 'rejected' : [...priority].reverse().find(value => events.some(event => event.event === value))
        ?? (events.some(event => event.event === 'legacy_handled') ? 'legacy_handled'
          : events.some(event => event.event === 'legacy_imported') ? 'legacy_imported' : 'queued');
      return { ...row, state, events };
    });
  }

  /** Select whole envelopes only. Hook commits delivery after its output succeeds. */
  hookBatch(caller: string, excludedIds: readonly string[] = []): { text: string; ids: string[] } {
    caller = identifier(caller);
    this.registration(caller);
    return this.messageBatch(caller, excludedIds, false);
  }

  private messageBatch(caller: string, excludedIds: readonly string[], excludePushed: boolean): { text: string; ids: string[] } {
    let text = '';
    const ids: string[] = [];
    const excluded = new Set(excludedIds);
    for (const message of this.pending(caller, excludePushed)) {
      if (excluded.has(message.id)) continue;
      const next = renderConversationMessage(message);
      if (Buffer.byteLength(next, 'utf8') > MESSAGE_MAX_BYTES) continue;
      if (Buffer.byteLength(text + next, 'utf8') > MESSAGE_MAX_BYTES) break;
      text += next;
      ids.push(message.id);
    }
    return { text, ids };
  }

  recordHookDelivery(caller: string, ids: string[], hook: string): void {
    caller = identifier(caller);
    this.registration(caller);
    this.db.transaction(() => {
      for (const id of ids) {
        const message = this.get(id);
        if (message.recipient !== caller || message.recipient_machine !== this.machine || this.rejected(id)) throw new Error('Wrong recipient');
        this.eventOnce(id, 'delivered', { actor: caller, via: 'hook', hook });
      }
    }).immediate();
  }

  private now(): string { return new Date(this.clock()).toISOString(); }
  private findRegistration(id: string): ConversationRegistration | undefined {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(identifier(id)) as unknown as (Omit<ConversationRegistration, 'wake'> & { wake: string }) | undefined;
    return row ? { ...row, wake: JSON.parse(row.wake) } : undefined;
  }
  private registration(id: string): ConversationRegistration {
    const found = this.findRegistration(id);
    if (!found) throw new Error('Caller conversation is not registered');
    return found;
  }
  private get(id: string): ConversationMessage {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as unknown as ConversationMessage | undefined;
    if (!row) throw new Error('Message not found');
    return row;
  }
  private rejected(id: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM events WHERE message_id = ? AND event = 'rejected'").get(id));
  }
  private pending(caller: string, excludePushed = false): ConversationMessage[] {
    return this.db.prepare(`SELECT m.* FROM messages m WHERE recipient = ? AND recipient_machine = ?
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.message_id = m.id AND e.event IN ('rejected','delivered','read','replied','legacy_handled'))
      AND (? = 0 OR (m.recipient_host = 'claude-code'
        AND NOT EXISTS (SELECT 1 FROM events e WHERE e.message_id = m.id AND e.event = 'pushed')))
      ORDER BY sent_at, rowid`).all(caller, this.machine, excludePushed ? 1 : 0) as unknown as ConversationMessage[];
  }
  private insert(message: ConversationMessage): void {
    this.db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      message.id, message.sender, message.sender_host, message.sender_machine, message.recipient,
      message.recipient_host, message.recipient_machine, message.kind, message.body,
      message.body_bytes, message.reply_to, message.sent_at);
  }
  private event(id: string, event: string, detail: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?)').run(id, this.now(), event, JSON.stringify(detail));
  }
  private eventOnce(id: string, event: string, detail: Record<string, unknown>): void {
    if (!this.db.prepare('SELECT 1 FROM events WHERE message_id = ? AND event = ?').get(id, event)) this.event(id, event, detail);
  }
  private maintain(): void {
    const now = this.clock();
    this.db.prepare('DELETE FROM messages WHERE sent_at <= ?').run(new Date(now - 14 * DAY).toISOString());
    const overdue = this.db.prepare(`SELECT m.* FROM messages m WHERE sent_at <= ? AND sender_host != 'system'
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.message_id=m.id
        AND e.event IN ('rejected','delivered','read','replied','legacy_handled','undelivered_notified'))`).all(new Date(now - DAY).toISOString()) as unknown as ConversationMessage[];
    for (const original of overdue) {
      const notice: ConversationMessage = {
        id: randomUUID(), sender: 'memesh', sender_host: 'system', sender_machine: this.machine,
        recipient: original.sender, recipient_host: original.sender_host, recipient_machine: original.sender_machine,
        kind: 'result', body: `Message ${original.id} has not been delivered after one day.`,
        body_bytes: 0, reply_to: original.id, sent_at: this.now(),
      };
      notice.body_bytes = Buffer.byteLength(notice.body!, 'utf8');
      this.insert(notice);
      this.event(notice.id, 'queued', { actor: 'memesh', reason: 'undelivered' });
      this.event(original.id, 'undelivered_notified', { actor: 'memesh', notification: notice.id });
    }
  }
}
