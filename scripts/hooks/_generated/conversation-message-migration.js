// ============================================================================
// AUTO-GENERATED from src/core/conversation-message-migration.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sqliteUtcToIso } from './time-utils.js';
import { refuseMismatchedSidecars } from './file-mode.js';
export function legacyConversationArchiveFiles(graph, target) {
    const directory = path.dirname(path.resolve(graph));
    if (directory !== path.dirname(path.resolve(target)))
        throw new Error('Legacy archive and message store must share a data directory');
    const backups = path.join(directory, 'backups');
    const names = new Set([path.basename(graph) === 'knowledge-graph.db'
            ? 'agent-messages-expired.db' : `agent-messages-expired-${path.basename(graph)}`, 'agent-messages-expired.db']);
    const privateEntry = (file, directoryEntry) => {
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink() || !(directoryEntry ? stat.isDirectory() : stat.isFile())
            || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0
                || (typeof process.getuid === 'function' && stat.uid !== process.getuid())))) {
            throw new Error(`Unsafe legacy archive path: ${file}`);
        }
    };
    const candidates = [...names].map(name => path.join(backups, name)).filter(file => {
        try {
            return fs.lstatSync(file) !== undefined;
        }
        catch (error) {
            const code = error.code;
            if (code === 'ENOENT' || code === 'ENOTDIR')
                return false;
            throw error;
        }
    });
    if (candidates.length === 0)
        return [];
    privateEntry(directory, true);
    privateEntry(backups, true);
    const files = [];
    for (const file of candidates) {
        privateEntry(file, false);
        assertLegacyPathsAreDifferent(file, graph);
        assertLegacyPathsAreDifferent(file, target);
        for (const suffix of ['-wal', '-shm', '-journal']) {
            if (fs.lstatSync(file + suffix, { throwIfNoEntry: false }))
                privateEntry(file + suffix, false);
        }
        refuseMismatchedSidecars(file, { readOnly: true });
        files.push(file);
    }
    return files;
}
export function assertLegacyConversationArchiveSchema(source) {
    const tables = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    for (const name of ['agent_messages', 'agent_message_deliveries', 'agent_network_outbox', 'agent_message_events',
        'agent_message_idempotency', 'agent_message_receipts', 'agent_retention_facts', 'agent_dispatch_attempts',
        'agent_host_accepts', 'agent_ack_facts', 'agent_workflow_facts', 'archive_log']) {
        if (!tables.has(name))
            throw new Error(`Invalid legacy archive: missing ${name}`);
    }
}
export const LEGACY_CONVERSATION_PREFIX = 'legacy:';
function historicalHostMatches(adapter, host, origin) {
    const family = adapter === 'codex-cli-queue' ? 'codex'
        : adapter === 'claude-channel' || adapter === 'claude-inbox' ? 'claude' : undefined;
    if (family === undefined)
        return false;
    const matches = (value) => value === 'cli' ? origin.transport === 'cli'
        : family === 'codex' ? value === 'codex' || value === 'codex-mcp-client' : value === 'claude-code';
    return matches(host) && (origin.source_host === undefined || matches(origin.source_host));
}
function provenance(message) {
    const value = JSON.parse(text(message.provenance_json, 'provenance_json'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function text(value, field) {
    if (typeof value !== 'string')
        throw new Error(`Legacy message has invalid ${field}`);
    return value;
}
function utc(value) {
    const raw = text(value, 'timestamp');
    const iso = sqliteUtcToIso(raw);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(iso) || !Number.isFinite(Date.parse(iso))) {
        throw new Error('Legacy message has invalid timestamp');
    }
    const result = new Date(iso).toISOString();
    if (result !== (iso.includes('.') ? iso : iso.replace('Z', '.000Z')))
        throw new Error('Legacy timestamp is not a calendar instant');
    return result;
}
function session(value) {
    if (typeof value !== 'string' || !value || value.length > 200 || value.startsWith(LEGACY_CONVERSATION_PREFIX)
        || /[\s/@\\]/u.test(value) || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
        || value !== value.normalize('NFC'))
        return undefined;
    return value;
}
function legacyIdentity(project, name) {
    return LEGACY_CONVERSATION_PREFIX + createHash('sha256').update(JSON.stringify([project, name])).digest('hex');
}
function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
        throw new Error('Legacy row contains an unsupported value');
    return encoded;
}
const databaseFile = (db) => db.prepare("SELECT file FROM pragma_database_list WHERE name = 'main'").get()?.file;
export function assertLegacyDestinationIsDifferent(source, targetFile) {
    const sourceFile = databaseFile(source);
    if (!sourceFile || !targetFile)
        return;
    assertLegacyPathsAreDifferent(sourceFile, targetFile);
}
export function assertLegacyPathsAreDifferent(sourceFile, targetFile) {
    if (path.resolve(sourceFile) === path.resolve(targetFile))
        throw new Error('Legacy source and target must be different files');
    let a, b;
    try {
        a = fs.statSync(sourceFile);
        b = fs.statSync(targetFile);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw error;
    }
    if (a.dev === b.dev && a.ino === b.ino)
        throw new Error('Legacy source and target must be different files');
}
export function importLegacyConversationMessages(source, target, options) {
    if (source === target)
        throw new Error('Legacy source and target must be different databases');
    const targetFile = databaseFile(target);
    if (targetFile)
        assertLegacyDestinationIsDifferent(source, targetFile);
    const at = new Date(options.nowMs).toISOString();
    const snapshots = source.transaction(() => {
        const tables = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
        if (!tables.has('agent_messages'))
            return [];
        const rows = (table, column, values) => tables.has(table)
            ? source.prepare(`SELECT * FROM ${table} WHERE ${column} IN (SELECT value FROM json_each(?))`).all(JSON.stringify(values))
                .sort((a, b) => canonical(a).localeCompare(canonical(b))) : [];
        const messages = options.messageIds === undefined
            ? source.prepare('SELECT * FROM agent_messages ORDER BY message_id').all()
            : source.prepare('SELECT * FROM agent_messages WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY message_id').all(JSON.stringify(options.messageIds));
        return messages.flatMap(message => {
            const sentAt = utc(message.created_at);
            if (Date.parse(sentAt) <= options.nowMs - 14 * 86_400_000)
                return [];
            const id = text(message.message_id, 'message_id');
            const facts = {};
            for (const table of ['agent_message_deliveries', 'agent_message_events', 'agent_message_receipts',
                'agent_message_idempotency', 'agent_retention_facts', 'agent_network_outbox', 'agent_message_expiries']) {
                facts[table] = rows(table, 'message_id', [id]);
            }
            const deliveries = facts.agent_message_deliveries.map(row => row.delivery_id);
            for (const table of ['agent_dispatch_attempts', 'agent_host_accepts', 'agent_ack_facts', 'agent_workflow_facts']) {
                facts[table] = rows(table, 'delivery_id', deliveries);
            }
            const connections = facts.agent_dispatch_attempts.map(row => row.connection_id);
            facts.agent_session_connections = rows('agent_session_connections', 'connection_id', connections);
            facts.agent_presence_facts = rows('agent_presence_facts', 'connection_id', connections);
            const project = text(message.project, 'project');
            const identities = new Set([message.sender, message.recipient, provenance(message).sender_session,
                ...facts.agent_message_deliveries.flatMap(row => [row.recipient, row.intended_session]),
                ...facts.agent_session_connections.map(row => row.session_instance_id)]);
            facts.agent_session_instances = tables.has('agent_session_instances')
                ? source.prepare('SELECT * FROM agent_session_instances WHERE project = ?').all(project)
                    .filter(row => identities.has(row.session_instance_id) || identities.has(row.principal_id))
                    .sort((a, b) => canonical(a).localeCompare(canonical(b))) : [];
            facts.agent_principals = rows('agent_principals', 'project', [project])
                .filter(row => identities.has(row.principal_id));
            return [{ message, facts }];
        });
    })();
    return target.transaction(() => {
        let imported = 0, alreadyImported = 0;
        for (const snapshot of snapshots) {
            const { message: original, facts } = snapshot;
            const project = text(original.project, 'project');
            const id = text(original.message_id, 'message_id');
            const senderName = text(original.sender, 'sender');
            const recipientName = text(original.recipient, 'recipient');
            const explicitTargets = [...new Set(facts.agent_message_deliveries.map(row => row.target_kind === 'session' ? session(row.recipient) : session(row.intended_session)).filter(value => value !== undefined))];
            if (explicitTargets.length > 1)
                throw new Error('Legacy message has multiple conversation targets');
            const recipient = explicitTargets[0] ?? legacyIdentity(project, recipientName);
            const origin = provenance(original);
            const senderSession = session(origin.sender_session);
            const matchingSenders = facts.agent_session_instances.filter(row => row.session_instance_id === senderSession
                && row.project === project && (row.principal_id === senderName || row.session_instance_id === senderName)
                && historicalHostMatches(row.adapter_kind, original.sender_host, origin));
            const localSender = senderSession !== undefined && matchingSenders.length === 1
                && origin.via !== 'network'
                && origin.from_machine === undefined && origin.origin_message_id === undefined;
            const sender = localSender ? senderSession : legacyIdentity(project, senderName);
            const payload = text(original.payload_json, 'payload_json');
            const decoded = JSON.parse(payload);
            const body = original.content_type === 'text/plain' && original.payload_tombstoned_at == null
                ? text(decoded, 'text payload') : payload;
            const mapped = {
                id, sender, sender_host: typeof original.sender_host === 'string' && original.sender_host ? original.sender_host : 'unknown',
                sender_machine: localSender ? options.localMachine : 'unknown', recipient, recipient_host: null,
                recipient_machine: explicitTargets.length === 1 ? options.localMachine : 'unknown',
                kind: 'legacy', body, body_bytes: Buffer.byteLength(body, 'utf8'),
                reply_to: original.reply_to_message_id == null ? null : text(original.reply_to_message_id, 'reply_to'),
                sent_at: utc(original.created_at),
            };
            const detail = canonical({ version: 1, source: snapshot, mapped });
            const existing = target.prepare('SELECT id,sender,sender_host,sender_machine,recipient,recipient_host,recipient_machine,kind,body,body_bytes,reply_to,sent_at FROM messages WHERE id = ?').get(id);
            if (existing) {
                const receipts = target.prepare("SELECT detail FROM events WHERE message_id = ? AND event = 'legacy_imported'").all(id);
                const initial = receipts.length === 1 ? JSON.parse(receipts[0].detail) : undefined;
                const routing = (deliveries) => deliveries.map(row => canonical({
                    delivery_id: row.delivery_id ?? null, message_id: row.message_id ?? null, project: row.project ?? null,
                    recipient: row.recipient ?? null, target_kind: row.target_kind ?? 'principal', intended_session: row.intended_session ?? null,
                })).sort();
                if (!initial?.source?.message || !initial.mapped || !initial.source.facts?.agent_message_deliveries
                    || canonical(existing) !== canonical(initial.mapped) || canonical(initial.source.message) !== canonical(original)
                    || canonical(routing(initial.source.facts.agent_message_deliveries)) !== canonical(routing(facts.agent_message_deliveries))) {
                    throw new Error(`Legacy migration conflict for message ${id}`);
                }
                alreadyImported++;
            }
            else {
                target.prepare('INSERT INTO messages (id,sender,sender_host,sender_machine,recipient,recipient_host,recipient_machine,kind,body,body_bytes,reply_to,sent_at,sender_local,recipient_local) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
                    .run(mapped.id, mapped.sender, mapped.sender_host, mapped.sender_machine, mapped.recipient, mapped.recipient_host, mapped.recipient_machine, mapped.kind, mapped.body, mapped.body_bytes, mapped.reply_to, mapped.sent_at, localSender ? 1 : 0, explicitTargets.length === 1 ? 1 : 0);
                target.prepare('INSERT INTO events (message_id,at,event,detail) VALUES (?,?,?,?)').run(id, at, 'legacy_imported', detail);
                imported++;
            }
            const priorRows = target.prepare("SELECT event,detail FROM events WHERE message_id = ? AND event IN ('legacy_fact','legacy_handled')").all(id);
            const prior = new Set(priorRows.map(row => `${row.event}:${row.detail}`));
            for (const [table, records] of Object.entries(facts))
                for (const row of records) {
                    const handled = (table === 'agent_message_receipts' && ['intake', 'ack', 'disposition'].includes(String(row.receipt_kind)))
                        || table === 'agent_ack_facts' || table === 'agent_workflow_facts';
                    const event = handled ? 'legacy_handled' : 'legacy_fact';
                    const fact = canonical({ table, row });
                    const key = `${event}:${fact}`;
                    if (!prior.has(key)) {
                        target.prepare('INSERT INTO events (message_id,at,event,detail) VALUES (?,?,?,?)').run(id, at, event, fact);
                        prior.add(key);
                    }
                }
        }
        return { imported, alreadyImported };
    }).immediate();
}
