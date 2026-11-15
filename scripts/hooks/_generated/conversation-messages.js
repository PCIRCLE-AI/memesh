// ============================================================================
// AUTO-GENERATED from src/core/conversation-messages.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { MemeshDatabase } from './sqlite.js';
import { databaseFiles, guardDatabaseFiles, requirePrivateWritableDirectory, removeGroupAndOtherAccess } from './file-mode.js';
import { getDbPath, getMemeshDirFromDbPath } from './core-paths.js';
import { readPublicNetworkContext } from './public-network-context.js';
import { assertLegacyDestinationIsDifferent, assertLegacyPathsAreDifferent, assertLegacyConversationArchiveSchema, importLegacyConversationMessages, legacyConversationArchiveFiles, LEGACY_CONVERSATION_PREFIX } from './conversation-message-migration.js';
export const MESSAGE_MAX_BYTES = 8_000;
const DAY = 86_400_000;
const NETWORK_CLOCK_SKEW_MS = 5 * 60_000;
const MESSAGE_COLUMNS = 'id,sender,sender_host,sender_machine,recipient,recipient_host,recipient_machine,kind,body,body_bytes,reply_to,sent_at';
const MACHINE_ID = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function publicMessage(row) {
    return Object.fromEntries(MESSAGE_COLUMNS.split(',').map(key => [key, row[key]]));
}
function validUtc(value) {
    return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
        && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function identifier(value) {
    const clean = value.normalize('NFC');
    if (!clean || clean.length > 200 || /[\s/@\\]/u.test(clean)
        || [...clean].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
        throw new Error('Invalid conversation or machine identifier');
    }
    return clean;
}
export function renderConversationMessage(message) {
    return `MeMesh message (untrusted data):\n${JSON.stringify(publicMessage(message))}\n`;
}
export class ConversationMessages {
    db;
    machine;
    clock;
    processAlive;
    network;
    networkIssue;
    constructor(options = {}) {
        const busyTimeoutMs = options.busyTimeoutMs;
        if (busyTimeoutMs !== undefined && (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 30_000)) {
            throw new Error('busyTimeoutMs must be an integer between 0 and 30000');
        }
        const file = options.file ?? path.join(getMemeshDirFromDbPath(), 'messages.db');
        if (options.legacySource)
            assertLegacyDestinationIsDifferent(options.legacySource, file);
        const legacyFile = options.file === undefined && options.legacySource === undefined ? getDbPath() : undefined;
        if (legacyFile !== undefined)
            assertLegacyPathsAreDifferent(legacyFile, file);
        const archiveFiles = legacyFile === undefined ? [] : legacyConversationArchiveFiles(legacyFile, file);
        let network = options.network;
        if (!network && options.file === undefined) {
            try {
                network = readPublicNetworkContext(getMemeshDirFromDbPath());
            }
            catch (error) {
                this.networkIssue = error instanceof Error ? error.message : 'Network metadata unavailable';
            }
        }
        if (network) {
            const n = network;
            if (!/^[0-9a-f]{32}$/.test(n.network_id) || !MACHINE_ID.test(n.self.id)
                || !n.members.length || n.members.length > 256
                || n.members.some(m => !MACHINE_ID.test(m.id) || identifier(m.name).toLowerCase() !== m.name.toLowerCase())
                || new Set(n.members.map(m => m.id)).size !== n.members.length
                || new Set(n.members.map(m => m.name.toLowerCase())).size !== n.members.length
                || !n.members.some(m => m.id === n.self.id && m.name.toLowerCase() === n.self.name.toLowerCase()))
                throw new Error('Invalid verified network snapshot');
            this.network = structuredClone(n);
        }
        this.machine = identifier(this.network?.self.name ?? options.machine ?? os.hostname()).toLowerCase();
        this.clock = options.clock ?? Date.now;
        this.processAlive = options.processAlive ?? ((pid) => {
            try {
                process.kill(pid, 0);
                return true;
            }
            catch (error) {
                return error.code === 'EPERM';
            }
        });
        let ownedSource;
        try {
            if (legacyFile !== undefined && fs.existsSync(legacyFile)) {
                guardDatabaseFiles(legacyFile);
                ownedSource = new MemeshDatabase(legacyFile, { readOnly: true });
                if (busyTimeoutMs !== undefined)
                    ownedSource.pragma(`busy_timeout = ${busyTimeoutMs}`);
                assertLegacyDestinationIsDifferent(ownedSource, file);
            }
            fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
            requirePrivateWritableDirectory(path.dirname(file), 'messages must remain owner-private');
            guardDatabaseFiles(file);
            const fd = fs.openSync(file, 'a', 0o600);
            fs.closeSync(fd);
            this.db = new MemeshDatabase(file);
            try {
                if (busyTimeoutMs !== undefined)
                    this.db.pragma(`busy_timeout = ${busyTimeoutMs}`);
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
                this.upgradeRoutingSchema();
                for (const target of databaseFiles(file))
                    removeGroupAndOtherAccess(target);
                const legacySource = options.legacySource ?? ownedSource;
                if (legacySource)
                    importLegacyConversationMessages(legacySource, this.db, { nowMs: this.clock(), localMachine: this.machine, messageIds: options.legacyMessageIds });
                for (const archiveFile of archiveFiles) {
                    const archive = new MemeshDatabase(archiveFile, { readOnly: true });
                    try {
                        if (busyTimeoutMs !== undefined)
                            archive.pragma(`busy_timeout = ${busyTimeoutMs}`);
                        assertLegacyConversationArchiveSchema(archive);
                        importLegacyConversationMessages(archive, this.db, { nowMs: this.clock(), localMachine: this.machine });
                    }
                    finally {
                        archive.close();
                    }
                }
                this.db.transaction(() => this.maintain()).immediate();
            }
            catch (error) {
                this.db.close();
                throw error;
            }
        }
        finally {
            ownedSource?.close();
        }
    }
    close() { this.db.close(); }
    upgradeRoutingSchema() {
        this.db.transaction(() => {
            const columns = this.db.prepare('PRAGMA table_info(messages)').all();
            if (columns.some(c => c.name === 'sender_local'))
                return;
            this.db.exec(`ALTER TABLE messages ADD COLUMN sender_local INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE messages ADD COLUMN recipient_local INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE messages ADD COLUMN network_id TEXT;
        ALTER TABLE messages ADD COLUMN sender_machine_id TEXT;
        ALTER TABLE messages ADD COLUMN recipient_machine_id TEXT;
        UPDATE messages SET sender_local=1 WHERE kind != 'legacy';
        UPDATE messages SET recipient_local=1 WHERE kind != 'legacy' AND recipient_host IS NOT NULL;
        UPDATE messages SET sender_local=1 WHERE kind='legacy' AND sender_machine!='unknown' AND sender NOT LIKE 'legacy:%';
        UPDATE messages SET recipient_local=1 WHERE kind='legacy' AND recipient_machine!='unknown' AND recipient NOT LIKE 'legacy:%';
        ALTER TABLE conversations RENAME TO conversations_before_routing;
        CREATE TABLE conversations (
          id TEXT NOT NULL, host TEXT NOT NULL, machine TEXT NOT NULL, pid INTEGER NOT NULL, wake TEXT NOT NULL,
          is_local INTEGER NOT NULL, machine_id TEXT NOT NULL, network_id TEXT NOT NULL, online INTEGER NOT NULL,
          PRIMARY KEY(id,is_local,machine_id,network_id));
        INSERT INTO conversations SELECT id,host,machine,pid,wake,1,'','',0 FROM conversations_before_routing;
        DROP TABLE conversations_before_routing;`);
        }).immediate();
    }
    maintainMessages() { this.db.transaction(() => this.maintain()).immediate(); }
    registerChannel(caller, hostPid) {
        if (!Number.isSafeInteger(hostPid) || hostPid <= 1 || !this.processAlive(hostPid))
            throw new Error('Channel host identity unavailable');
        const existing = this.findRegistration(caller);
        if (!existing)
            this.register({ id: caller, host: 'claude-code', machine: this.machine, pid: hostPid, wake: {} });
        this.channelRegistration(caller, hostPid);
    }
    channelBatch(caller, hostPid) {
        this.channelRegistration(caller, hostPid);
        return this.messageBatch(caller, [], true);
    }
    recordChannelPush(caller, hostPid, ids) {
        this.db.transaction(() => {
            this.channelRegistration(caller, hostPid);
            for (const id of ids) {
                const message = this.get(id);
                if (message.recipient !== caller || message.recipient_host !== 'claude-code'
                    || !message.recipient_local || this.rejected(id))
                    throw new Error('Wrong recipient');
                this.eventOnce(id, 'pushed', { actor: caller, route: 'claude-channel' });
            }
        }).immediate();
    }
    channelRegistration(caller, hostPid) {
        const registered = this.registration(caller);
        if (registered.host !== 'claude-code' || registered.pid !== hostPid
            || hostPid <= 1 || !this.processAlive(hostPid))
            throw new Error('Channel host identity unavailable');
    }
    wakeTarget(messageId) {
        const message = this.get(messageId);
        if (!message.recipient_local || this.rejected(messageId))
            return undefined;
        const target = this.findRegistration(message.recipient);
        if (!target || target.host !== message.recipient_host
            || !this.processAlive(target.pid))
            return undefined;
        return target;
    }
    recordPush(sender, messageId, route) {
        const message = this.get(messageId);
        if (message.sender !== identifier(sender) || !message.sender_local || this.rejected(messageId)) {
            throw new Error('Wrong push actor');
        }
        this.eventOnce(messageId, 'pushed', { actor: sender, route });
    }
    register(input) {
        const id = identifier(input.id);
        if (id.startsWith(LEGACY_CONVERSATION_PREFIX))
            throw new Error('Legacy audit identities cannot register as conversations');
        if (!['claude-code', 'codex', 'hermes'].includes(input.host))
            throw new Error('Unknown host');
        if (identifier(input.machine).toLowerCase() !== this.machine)
            throw new Error('Local registration requires this machine');
        if (!Number.isSafeInteger(input.pid) || input.pid <= 0)
            throw new Error('Invalid process id');
        this.db.prepare(`INSERT INTO conversations (id,host,machine,pid,wake,is_local,machine_id,network_id,online) VALUES (?, ?, ?, ?, ?,1,'','',0)
      ON CONFLICT(id,is_local,machine_id,network_id) DO UPDATE SET host=excluded.host, machine=excluded.machine,
      pid=excluded.pid, wake=excluded.wake`).run(id, input.host, this.machine, input.pid, JSON.stringify(input.wake));
    }
    discover() {
        const rows = this.db.prepare('SELECT * FROM conversations ORDER BY id').all();
        return rows.filter(row => row.is_local || (row.network_id === this.network?.network_id && this.member(row.machine_id)))
            .map(row => ({ id: row.id, host: row.host, machine: row.is_local ? this.machine : this.member(row.machine_id).name.toLowerCase(),
            pid: row.is_local ? row.pid : 0, wake: row.is_local ? JSON.parse(row.wake) : {}, online: row.is_local ? this.processAlive(row.pid) : Boolean(row.online) }));
    }
    send(sender, input) {
        const from = this.registration(sender);
        if (!['task', 'question', 'review_request', 'result'].includes(input.kind))
            throw new Error('Unknown message kind');
        if (typeof input.body !== 'string')
            throw new Error('Message body must be text');
        const pieces = input.recipient.split('@');
        if (pieces.length > 2 || (pieces.length === 2 && !pieces[1]))
            throw new Error('Invalid recipient address');
        if (input.reply_to !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.reply_to)) {
            throw new Error('Invalid reply_to message id');
        }
        const recipient = identifier(pieces[0]);
        let machine = pieces[1] ? identifier(pieces[1]).toLowerCase() : this.machine;
        let remoteId = pieces[1] && machine !== this.machine ? this.network?.members.find(m => m.name.toLowerCase() === machine)?.id : undefined;
        let local = !pieces[1] || machine === this.machine;
        const original = input.reply_to ? this.findMessage(input.reply_to) : undefined;
        if (original) {
            if (!original.recipient_local || original.recipient !== from.id || original.sender !== recipient || this.rejected(original.id)) {
                throw new Error('Reply must address the sender of a message received by this conversation');
            }
            if (original.sender_local) {
                if (pieces[1] && machine !== original.sender_machine && machine !== this.machine)
                    throw new Error('Wrong reply machine');
                local = true;
                remoteId = undefined;
                machine = this.machine;
            }
            else {
                const member = original.network_id === this.network?.network_id ? this.member(original.sender_machine_id) : undefined;
                if (!pieces[1] || (machine !== original.sender_machine && machine !== member?.name.toLowerCase()))
                    throw new Error('Wrong reply machine');
                local = false;
                remoteId = member?.id;
                machine = member?.name.toLowerCase() ?? machine;
            }
        }
        const to = local ? this.findRegistration(recipient) : remoteId ? this.remoteRegistration(remoteId, recipient) : undefined;
        return this.db.transaction(() => {
            const message = {
                id: randomUUID(), sender: from.id, sender_host: from.host, sender_machine: this.machine,
                recipient, recipient_host: to?.host ?? null, recipient_machine: machine,
                kind: input.kind, body: input.body, body_bytes: Buffer.byteLength(input.body, 'utf8'),
                reply_to: input.reply_to ?? null, sent_at: this.now(),
            };
            const tooLarge = Buffer.byteLength(renderConversationMessage(message), 'utf8') > MESSAGE_MAX_BYTES;
            const reason = tooLarge ? 'message_too_large' : !to ? 'unknown_recipient' : undefined;
            if (tooLarge)
                message.body = null;
            this.insert(message, { sender_local: 1, recipient_local: local && Boolean(to) ? 1 : 0,
                network_id: !local ? this.network?.network_id ?? null : null,
                sender_machine_id: !local ? this.network?.self.id ?? null : null, recipient_machine_id: remoteId ?? null });
            this.event(message.id, reason ? 'rejected' : 'queued', { actor: from.id, ...(reason ? { reason } : {}) });
            if (reason)
                return { message, accepted: false, reason,
                    recipients: this.discover().map(row => row.machine === this.machine ? row.id : `${row.id}@${row.machine}`) };
            if (original) {
                this.eventOnce(original.id, 'delivered', { actor: from.id, via: 'reply' });
                this.eventOnce(original.id, 'replied', { actor: from.id, reply: message.id });
            }
            const pending = local ? this.pending(recipient).length : this.db.prepare(`SELECT COUNT(*) AS count FROM messages m
        WHERE recipient=? AND recipient_local=0 AND network_id=? AND recipient_machine_id=?
        AND NOT EXISTS (SELECT 1 FROM events e WHERE e.message_id=m.id
          AND e.event IN ('rejected','delivered','read','replied','legacy_handled'))`)
                .get(recipient, this.network.network_id, remoteId).count;
            return { message, accepted: true, ...(pending > 30 ? { warning: `${pending} messages await delivery` } : {}) };
        }).immediate();
    }
    read(caller, id) {
        caller = identifier(caller);
        this.registration(caller);
        return this.db.transaction(() => {
            const message = this.get(id);
            if (message.recipient !== caller || !message.recipient_local || this.rejected(id)) {
                throw new Error('Message is not addressed to this conversation');
            }
            this.eventOnce(id, 'delivered', { actor: caller, via: 'read' });
            this.eventOnce(id, 'read', { actor: caller });
            return publicMessage(message);
        }).immediate();
    }
    status(caller, id) {
        if (caller !== undefined)
            caller = identifier(caller);
        if (caller)
            this.registration(caller);
        const rows = this.db.prepare(`SELECT * FROM messages ${id ? 'WHERE id = ?' : ''} ORDER BY sent_at, rowid`)
            .all(...(id ? [id] : []));
        return rows.filter(row => !caller || (row.sender === caller && row.sender_local)
            || (row.recipient === caller && row.recipient_local)).map(row => {
            const events = this.db.prepare('SELECT * FROM events WHERE message_id = ? ORDER BY rowid').all(row.id);
            const priority = ['queued', 'pushed', 'delivered', 'read', 'replied'];
            const state = this.rejected(row.id) ? 'rejected' : [...priority].reverse().find(value => events.some(event => event.event === value))
                ?? (events.some(event => event.event === 'legacy_handled') ? 'legacy_handled'
                    : events.some(event => event.event === 'legacy_imported') ? 'legacy_imported' : 'queued');
            return { ...publicMessage(row), state, events };
        });
    }
    hookBatch(caller, excludedIds = []) {
        caller = identifier(caller);
        this.registration(caller);
        return this.messageBatch(caller, excludedIds, false);
    }
    messageBatch(caller, excludedIds, excludePushed) {
        let text = '';
        const ids = [];
        const excluded = new Set(excludedIds);
        for (const message of this.pending(caller, excludePushed)) {
            if (excluded.has(message.id))
                continue;
            const next = renderConversationMessage(message);
            if (Buffer.byteLength(next, 'utf8') > MESSAGE_MAX_BYTES)
                continue;
            if (Buffer.byteLength(text + next, 'utf8') > MESSAGE_MAX_BYTES)
                break;
            text += next;
            ids.push(message.id);
        }
        return { text, ids };
    }
    recordHookDelivery(caller, ids, hook) {
        caller = identifier(caller);
        this.registration(caller);
        this.db.transaction(() => {
            for (const id of ids) {
                const message = this.get(id);
                if (message.recipient !== caller || !message.recipient_local || this.rejected(id))
                    throw new Error('Wrong recipient');
                this.eventOnce(id, 'delivered', { actor: caller, via: 'hook', hook });
            }
        }).immediate();
    }
    exportRegistrations() {
        const rows = this.db.prepare('SELECT id,host,pid FROM conversations WHERE is_local=1 ORDER BY id').all();
        return rows.map(row => ({ id: row.id, host: row.host, online: this.processAlive(row.pid) }));
    }
    replaceRemoteRegistrations(peerId, registrations) {
        this.writeRemoteRegistrations(peerId, registrations, true);
    }
    upsertRemoteRegistrations(peerId, registrations) {
        this.writeRemoteRegistrations(peerId, registrations, false);
    }
    writeRemoteRegistrations(peerId, registrations, replace) {
        const peer = this.requirePeer(peerId);
        const ids = new Set();
        for (const row of registrations) {
            if (Object.keys(row).sort().join(',') !== 'host,id,online' || identifier(row.id).startsWith(LEGACY_CONVERSATION_PREFIX)
                || !['claude-code', 'codex', 'hermes'].includes(row.host) || typeof row.online !== 'boolean' || ids.has(row.id))
                throw new Error('Invalid remote registration snapshot');
            ids.add(row.id);
        }
        this.db.transaction(() => {
            if (replace)
                this.db.prepare('DELETE FROM conversations WHERE is_local=0 AND network_id=? AND machine_id=?').run(this.network.network_id, peerId);
            const insert = this.db.prepare(`INSERT INTO conversations (id,host,machine,pid,wake,is_local,machine_id,network_id,online) VALUES (?,?,?,0,'{}',0,?,?,?)
        ON CONFLICT(id,is_local,machine_id,network_id) DO UPDATE SET host=excluded.host,machine=excluded.machine,online=excluded.online`);
            for (const row of registrations)
                insert.run(row.id, row.host, peer.name.toLowerCase(), peerId, this.network.network_id, row.online ? 1 : 0);
        }).immediate();
    }
    outgoingFor(peerId) {
        this.requirePeer(peerId);
        const rows = this.db.prepare(`SELECT m.* FROM messages m WHERE sender_local=1 AND recipient_local=0
      AND network_id=? AND sender_machine_id=? AND recipient_machine_id=? AND sent_at>?
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.message_id=m.id AND e.event IN ('rejected','network_accepted'))
      ORDER BY sent_at,rowid`).all(this.network.network_id, this.network.self.id, peerId, new Date(this.clock() - 14 * DAY).toISOString());
        return rows.map(row => ({ network_id: row.network_id, sender_machine_id: row.sender_machine_id, recipient_machine_id: row.recipient_machine_id, message: publicMessage(row) }));
    }
    receiveFrom(peerId, wire) {
        const peer = this.requirePeer(peerId);
        if (wire.network_id !== this.network.network_id || wire.sender_machine_id !== peerId || wire.recipient_machine_id !== this.network.self.id)
            throw new Error('Wrong network message binding');
        const m = wire.message;
        if (!m || Object.keys(m).sort().join(',') !== MESSAGE_COLUMNS.split(',').sort().join(',')
            || !UUID.test(m.id) || identifier(m.sender).startsWith(LEGACY_CONVERSATION_PREFIX) || identifier(m.recipient).startsWith(LEGACY_CONVERSATION_PREFIX)
            || !['claude-code', 'codex', 'hermes'].includes(m.sender_host)
            || !['task', 'question', 'review_request', 'result'].includes(m.kind)
            || typeof m.body !== 'string' || m.body_bytes !== Buffer.byteLength(m.body, 'utf8')
            || !validUtc(m.sent_at) || Date.parse(m.sent_at) <= this.clock() - 14 * DAY || Date.parse(m.sent_at) > this.clock() + NETWORK_CLOCK_SKEW_MS
            || (m.reply_to !== null && !UUID.test(m.reply_to)))
            throw new Error('Invalid or expired network message');
        const message = { ...publicMessage(m), sender_machine: peer.name.toLowerCase(), recipient_machine: this.machine };
        if (Buffer.byteLength(renderConversationMessage(message), 'utf8') > MESSAGE_MAX_BYTES)
            throw new Error('Network message too large');
        return this.db.transaction(() => {
            const prior = this.db.prepare('SELECT * FROM messages WHERE id=?').get(m.id);
            if (prior) {
                const content = (row) => JSON.stringify(MESSAGE_COLUMNS.split(',').filter(k => k !== 'sender_machine' && k !== 'recipient_machine').map(k => row[k]));
                if (prior.sender_local || !prior.recipient_local || prior.network_id !== wire.network_id
                    || prior.sender_machine_id !== peerId || prior.recipient_machine_id !== wire.recipient_machine_id || this.rejected(prior.id)
                    || content(prior) !== content(message))
                    throw new Error('Network message id collision');
                return 'duplicate';
            }
            const from = this.remoteRegistration(peerId, m.sender), to = this.findRegistration(m.recipient);
            if (!from || from.host !== m.sender_host || !to || to.host !== m.recipient_host)
                throw new Error('Unregistered network conversation');
            const original = m.reply_to ? this.findMessage(m.reply_to) : undefined;
            if (original) {
                if (!original.sender_local || original.recipient_local || original.network_id !== wire.network_id
                    || original.sender_machine_id !== this.network.self.id || original.recipient_machine_id !== peerId
                    || original.sender !== m.recipient || original.recipient !== m.sender || this.rejected(original.id))
                    throw new Error('Wrong network reply binding');
                this.eventOnce(original.id, 'delivered', { actor: m.sender, peer: peerId, via: 'reply' });
                this.eventOnce(original.id, 'replied', { actor: m.sender, peer: peerId, reply: m.id });
            }
            this.insert(message, { sender_local: 0, recipient_local: 1, network_id: wire.network_id, sender_machine_id: peerId, recipient_machine_id: wire.recipient_machine_id });
            this.event(message.id, 'queued', { actor: m.sender, peer: peerId, via: 'network' });
            return 'accepted';
        }).immediate();
    }
    recordCopyAccepted(peerId, messageId) {
        this.outboundMessage(peerId, messageId);
        this.eventOnce(messageId, 'network_accepted', { peer: peerId, network_id: this.network.network_id });
    }
    recordNetworkPush(peerId, messageId, route) {
        this.requirePeer(peerId);
        const message = this.get(messageId);
        if (!message.recipient_local || message.sender_local || message.network_id !== this.network.network_id
            || message.sender_machine_id !== peerId || message.recipient_machine_id !== this.network.self.id || this.rejected(messageId))
            throw new Error('Wrong network push binding');
        this.eventOnce(messageId, 'pushed', { actor: message.recipient, peer: peerId, route });
    }
    receiptsFor(peerId) {
        this.requirePeer(peerId);
        const rows = this.db.prepare(`SELECT e.message_id,e.event,e.at,e.detail FROM events e JOIN messages m ON m.id=e.message_id
      WHERE m.sender_local=0 AND m.recipient_local=1 AND m.network_id=? AND m.sender_machine_id=? AND m.recipient_machine_id=?
      AND m.sent_at>? AND e.event IN ('delivered','read') ORDER BY e.rowid`).all(this.network.network_id, peerId, this.network.self.id, new Date(this.clock() - 14 * DAY).toISOString());
        return rows.map(row => ({ message_id: row.message_id, event: row.event, at: row.at, actor: JSON.parse(row.detail).actor }))
            .filter(receipt => !this.receiptAcknowledged(receipt));
    }
    recordReceiptAccepted(peerId, receipt) {
        this.requirePeer(peerId);
        const message = this.get(receipt.message_id);
        if (message.sender_local || !message.recipient_local || message.network_id !== this.network.network_id
            || message.sender_machine_id !== peerId || message.recipient_machine_id !== this.network.self.id
            || receipt.actor !== message.recipient)
            throw new Error('Wrong receipt acknowledgement binding');
        const actual = this.db.prepare('SELECT at,detail FROM events WHERE message_id=? AND event=?').get(receipt.message_id, receipt.event);
        if (!['delivered', 'read'].includes(receipt.event) || !actual || actual.at !== receipt.at
            || JSON.parse(actual.detail).actor !== receipt.actor)
            throw new Error('Unknown receipt acknowledgement');
        if (this.receiptAcknowledged(receipt))
            return;
        if (!this.receiptsFor(peerId).some(r => this.receiptKey(r) === this.receiptKey(receipt)))
            throw new Error('Unknown receipt acknowledgement');
        this.event(receipt.message_id, 'network_receipt_acked', { receipt: this.receiptKey(receipt), peer: peerId });
    }
    receiveReceipt(peerId, receipt) {
        const message = this.outboundMessage(peerId, receipt.message_id);
        if (Object.keys(receipt).sort().join(',') !== 'actor,at,event,message_id' || !['delivered', 'read'].includes(receipt.event)
            || receipt.actor !== message.recipient || !validUtc(receipt.at)
            || Date.parse(receipt.at) < Date.parse(message.sent_at) - NETWORK_CLOCK_SKEW_MS
            || Date.parse(receipt.at) > this.clock() + NETWORK_CLOCK_SKEW_MS)
            throw new Error('Invalid network receipt');
        return this.db.transaction(() => {
            const previous = this.db.prepare('SELECT at,detail FROM events WHERE message_id=? AND event=?').get(message.id, receipt.event);
            if (previous) {
                const detail = JSON.parse(previous.detail);
                if (detail.via === 'network_receipt' && previous.at !== receipt.at)
                    throw new Error('Network receipt conflict');
                return 'duplicate';
            }
            this.db.prepare('INSERT INTO events (message_id,at,event,detail) VALUES (?,?,?,?)').run(message.id, receipt.at, receipt.event, JSON.stringify({ actor: receipt.actor, peer: peerId, via: 'network_receipt' }));
            return 'accepted';
        }).immediate();
    }
    member(id) {
        return this.network?.members.find(m => m.id === id && id !== this.network?.self.id);
    }
    requirePeer(id) {
        const peer = this.member(id);
        if (!peer)
            throw new Error('Peer is not a current network member');
        return peer;
    }
    remoteRegistration(peerId, id) {
        this.requirePeer(peerId);
        return this.db.prepare('SELECT id,host FROM conversations WHERE is_local=0 AND network_id=? AND machine_id=? AND id=?')
            .get(this.network.network_id, peerId, identifier(id));
    }
    outboundMessage(peerId, id) {
        this.requirePeer(peerId);
        const message = this.get(id);
        if (!message.sender_local || message.recipient_local || message.network_id !== this.network.network_id
            || message.sender_machine_id !== this.network.self.id || message.recipient_machine_id !== peerId
            || Date.parse(message.sent_at) <= this.clock() - 14 * DAY || this.rejected(id))
            throw new Error('Wrong outbound message binding');
        return message;
    }
    receiptKey(receipt) {
        return JSON.stringify([receipt.message_id, receipt.event, receipt.at, receipt.actor]);
    }
    receiptAcknowledged(receipt) {
        return Boolean(this.db.prepare("SELECT 1 FROM events WHERE message_id=? AND event='network_receipt_acked' AND json_extract(detail,'$.receipt')=?")
            .get(receipt.message_id, this.receiptKey(receipt)));
    }
    now() { return new Date(this.clock()).toISOString(); }
    findRegistration(id) {
        const row = this.db.prepare('SELECT id,host,machine,pid,wake FROM conversations WHERE id = ? AND is_local=1').get(identifier(id));
        return row ? { ...row, machine: this.machine, wake: JSON.parse(row.wake) } : undefined;
    }
    registration(id) {
        const found = this.findRegistration(id);
        if (!found)
            throw new Error('Caller conversation is not registered');
        return found;
    }
    get(id) {
        const row = this.findMessage(id);
        if (!row)
            throw new Error('Message not found');
        return row;
    }
    findMessage(id) {
        return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    }
    rejected(id) {
        return Boolean(this.db.prepare("SELECT 1 FROM events WHERE message_id = ? AND event = 'rejected'").get(id));
    }
    pending(caller, excludePushed = false) {
        return this.db.prepare(`SELECT m.* FROM messages m WHERE recipient = ? AND recipient_local=1
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.message_id = m.id AND e.event IN ('rejected','delivered','read','replied','legacy_handled'))
      AND (? = 0 OR (m.recipient_host = 'claude-code'
        AND NOT EXISTS (SELECT 1 FROM events e WHERE e.message_id = m.id AND e.event = 'pushed')))
      ORDER BY sent_at, rowid`).all(caller, excludePushed ? 1 : 0);
    }
    insert(message, route = {
        sender_local: 1, recipient_local: 1, network_id: null, sender_machine_id: null, recipient_machine_id: null,
    }) {
        this.db.prepare(`INSERT INTO messages (${MESSAGE_COLUMNS},sender_local,recipient_local,network_id,sender_machine_id,recipient_machine_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,?,?,?,?,?)`).run(message.id, message.sender, message.sender_host, message.sender_machine, message.recipient, message.recipient_host, message.recipient_machine, message.kind, message.body, message.body_bytes, message.reply_to, message.sent_at, route.sender_local, route.recipient_local, route.network_id, route.sender_machine_id, route.recipient_machine_id);
    }
    event(id, event, detail) {
        this.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?)').run(id, this.now(), event, JSON.stringify(detail));
    }
    eventOnce(id, event, detail) {
        if (!this.db.prepare('SELECT 1 FROM events WHERE message_id = ? AND event = ?').get(id, event))
            this.event(id, event, detail);
    }
    maintain() {
        const now = this.clock();
        this.db.prepare('DELETE FROM messages WHERE sent_at <= ?').run(new Date(now - 14 * DAY).toISOString());
        const overdue = this.db.prepare(`SELECT m.* FROM messages m WHERE sent_at <= ? AND sender_host != 'system' AND sender_local=1
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.message_id=m.id
        AND e.event IN ('rejected','delivered','read','replied','legacy_handled','undelivered_notified'))`).all(new Date(now - DAY).toISOString());
        for (const original of overdue) {
            const notice = {
                id: randomUUID(), sender: 'memesh', sender_host: 'system', sender_machine: this.machine,
                recipient: original.sender, recipient_host: original.sender_host, recipient_machine: original.sender_machine,
                kind: 'result', body: `Message ${original.id} has not been delivered after one day.`,
                body_bytes: 0, reply_to: original.id, sent_at: this.now(),
            };
            notice.body_bytes = Buffer.byteLength(notice.body, 'utf8');
            this.insert(notice);
            this.event(notice.id, 'queued', { actor: 'memesh', reason: 'undelivered' });
            this.event(original.id, 'undelivered_notified', { actor: 'memesh', notification: notice.id });
        }
    }
}
