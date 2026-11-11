import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { removeGroupAndOtherAccess } from './file-mode.js';
import { AGENT_MESSAGE_TTL_MS, agentMessageExpiryCutoff } from './agent-message-ttl.js';
import { AgentMessagingError, sendAgentMessage } from './agent-messaging.js';
import { sqliteUtcToIso } from './time-utils.js';
import { networkDeliveryOf } from '../network/outbound.js';
export const AGENT_MESSAGE_EXPIRY_INTERVAL_MS = 5 * 60 * 1000;
const AGENT_MESSAGE_EXPIRED_ID_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const AGENT_MESSAGE_ARCHIVE_FILE = 'agent-messages-expired.db';
const RUN_LOG_KEEP = 500;
const LEASE_MS = 3 * 60 * 1000;
const BATCH_SIZE = 100;
const MAX_BATCHES_PER_PASS = 200;
const IN_FLIGHT_GRACE_MS = 10 * 60 * 1000;
const NOTICE_LIST_MAX = 20;
const ARCHIVE = 'expiry_archive';
const LOCK_WAIT_MS = 100;
const RECORD_RETRY_MS = 30_000;
const DUE_SLACK_MS = 10_000;
const AGENT_MESSAGE_EXPIRY_NOTICE_SENDER = 'memesh';
const AGENT_MESSAGE_EXPIRY_TRANSPORT = 'expiry';
const NOTICE_OWED_SQL = `was_read = 0 AND notice_message_id IS NULL AND sender IS NOT NULL AND sender <> '${AGENT_MESSAGE_EXPIRY_NOTICE_SENDER}'`;
export const AGENT_MESSAGE_EXPIRY_FAILED_OUTCOMES = new Set([
    'failed', 'archive_failed', 'archive_unavailable', 'no_message_tables', 'read_only',
]);
const NO_NOTICE = '';
const WAS_READ_SQL = `(
  EXISTS (SELECT 1 FROM agent_message_receipts r
          WHERE r.message_id = m.message_id AND r.receipt_kind IN ('intake', 'ack', 'disposition'))
  OR EXISTS (SELECT 1 FROM agent_message_deliveries d JOIN agent_ack_facts a ON a.delivery_id = d.delivery_id
             WHERE d.message_id = m.message_id)
  OR EXISTS (SELECT 1 FROM agent_message_deliveries d JOIN agent_workflow_facts w ON w.delivery_id = d.delivery_id
             WHERE d.message_id = m.message_id)
  OR EXISTS (SELECT 1 FROM agent_messages c
             WHERE c.reply_to_message_id = m.message_id AND c.project = m.project
               AND (c.sender = m.recipient
                    OR c.sender IN (SELECT s.principal_id FROM agent_session_instances s
                                    WHERE s.project = m.project AND s.session_instance_id = m.recipient)))
)`;
const IN_FLIGHT_SQL = `EXISTS (
  SELECT 1 FROM agent_message_deliveries d JOIN agent_dispatch_attempts a ON a.delivery_id = d.delivery_id
  WHERE d.message_id = m.message_id AND a.result = 'started' AND a.completed_at IS NULL
    AND julianday(a.created_at) >= julianday(?)
)`;
const DEAD_CONNECTIONS_SQL = `
  SELECT c.connection_id FROM agent_session_connections c
  WHERE ((c.disconnected_at IS NOT NULL AND julianday(c.disconnected_at) < julianday(:cutoff))
      OR (c.disconnected_at IS NULL AND c.lease_expires_at_ms < :dead_lease_ms))
    AND NOT EXISTS (SELECT 1 FROM agent_dispatch_attempts a WHERE a.connection_id = c.connection_id)`;
const LIVE_CONNECTIONS_SQL = `
  SELECT c.connection_id FROM agent_session_connections c
  WHERE c.disconnected_at IS NULL AND c.lease_expires_at_ms > :now_ms`;
const ARCHIVED_TABLES = [
    { name: 'agent_messages', unique: 'message_id', by: 'message' },
    { name: 'agent_message_deliveries', unique: 'delivery_id', by: 'message' },
    { name: 'agent_network_outbox', unique: 'delivery_id', by: 'delivery' },
    { name: 'agent_message_events', unique: 'event_id', by: 'message' },
    { name: 'agent_message_idempotency', unique: 'message_id', by: 'message' },
    { name: 'agent_message_receipts', unique: 'receipt_id', by: 'message' },
    { name: 'agent_retention_facts', unique: 'retention_fact_id', by: 'message' },
    { name: 'agent_dispatch_attempts', unique: 'attempt_id', by: 'delivery' },
    { name: 'agent_host_accepts', unique: 'host_accept_id', by: 'delivery' },
    { name: 'agent_ack_facts', unique: 'ack_fact_id', by: 'delivery' },
    { name: 'agent_workflow_facts', unique: 'workflow_fact_id', by: 'delivery' },
];
export async function runAgentMessageExpiry(db, options) {
    const startedAtMs = Date.now();
    const clockMs = options.nowMs ?? startedAtMs;
    const tally = { expired: 0, unread: 0, notices: 0, unaddressable: 0, unreadableTimes: 0, presenceFacts: 0, connections: 0 };
    let archivePath = null;
    const holder = randomUUID();
    let holdsLease = false;
    let startedRunId = null;
    const finish = async (outcome, detail = null) => {
        const base = {
            outcome,
            expired_message_count: tally.expired,
            unread_message_count: tally.unread,
            notice_count: tally.notices,
            presence_fact_count: tally.presenceFacts,
            connection_count: tally.connections,
            backup_path: tally.expired > 0 ? archivePath : null,
            detail,
        };
        return { ...base, run_id: await recordRun(db, startedAtMs, options.trigger, base, startedRunId) };
    };
    try {
        if (!tablesExist(db))
            return finish('no_message_tables', 'agent_messages, agent_message_expiry_runs, agent_message_expiries or agent_message_expiry_lease is missing');
        const cutoff = agentMessageExpiryCutoff(clockMs);
        const inFlightCutoff = new Date(clockMs - IN_FLIGHT_GRACE_MS).toISOString();
        const presenceParams = presenceBindings(cutoff, clockMs);
        const archiveFile = archiveLocation(db, options);
        const measure = () => ({
            expired: db.prepare('SELECT EXISTS (SELECT 1 FROM agent_messages WHERE created_at < ?) AS n').get(cutoff).n === 1,
            deletable: db.prepare(`SELECT EXISTS (SELECT 1 FROM agent_messages m WHERE m.created_at < ? AND NOT ${IN_FLIGHT_SQL}) AS n`).get(cutoff, inFlightCutoff).n === 1,
            presence: countStalePresence(db, presenceParams),
            purgeable: archiveFile !== null && archiveHasPurgeableRows(db, archiveFile, Date.now()),
            owed: db.prepare(`SELECT EXISTS (SELECT 1 FROM agent_message_expiries WHERE ${NOTICE_OWED_SQL}) AS n`).get().n === 1,
        });
        const idle = (m) => !m.deletable && m.presence === 0 && !m.purgeable && !m.owed;
        const idleOutcome = (m) => (m.expired ? 'deferred_in_flight' : 'nothing_expired');
        let seen = measure();
        if (idle(seen)) {
            interruptDeadRuns(db);
            return finish(idleOutcome(seen));
        }
        if (seen.deletable && archiveFile === null) {
            return finish('archive_unavailable', 'the database has no file path and no archive directory was given, so nothing was deleted');
        }
        try {
            withoutWaiting(db, () => probeWritable(db));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (isBusy(error))
                return finish('database_busy', `the database was locked by another process, so nothing was deleted this time (${message})`);
            return finish('read_only', `the database cannot be written, so nothing was archived or deleted (${message})`);
        }
        const held = acquireLease(db, holder);
        if (held !== null)
            return finish('skipped_concurrent', `another process is running the pass (its lease runs until ${new Date(held).toISOString()})`);
        holdsLease = true;
        db.prepare("UPDATE agent_message_expiry_runs SET outcome = 'interrupted', detail = 'the process stopped before this pass finished' WHERE outcome = 'started'").run();
        seen = measure();
        if (idle(seen))
            return finish(idleOutcome(seen));
        startedRunId = beginRun(db, startedAtMs, options.trigger, seen.deletable ? archiveFile : null);
        archivePath = seen.deletable ? archiveFile : null;
        const notes = [];
        let purgeFailed = false;
        if (archiveFile !== null) {
            try {
                const purged = await purgeArchive(db, archiveFile);
                if (purged > 0)
                    notes.push(`removed ${purged} archived message(s) past their extra day`);
            }
            catch (error) {
                purgeFailed = true;
                notes.push(`could not remove archive rows older than a day (${archiveFile}: ${error instanceof Error ? error.message : String(error)}); they stay until the next pass`);
            }
        }
        if (seen.deletable && archiveFile !== null) {
            for (let batch = 1; batch <= MAX_BATCHES_PER_PASS; batch++) {
                const rows = selectBatch(db, cutoff, inFlightCutoff);
                if (rows.length === 0)
                    break;
                try {
                    archiveRows(db, archiveFile, rows.map((row) => row.message_id), batch, options);
                }
                catch (error) {
                    return finish('archive_failed', `could not archive the rows of ${rows.length} message(s) before deleting them (${archiveFile}: ${error instanceof Error ? error.message : String(error)}); nothing in this batch was deleted`);
                }
                db.transaction(() => {
                    renewLease(db, holder);
                    deleteBatch(db, rows, tally);
                    saveRunProgress(db, startedRunId, tally, archiveFile);
                }).immediate();
                await options.fault?.afterBatch?.(batch);
                await yieldTurn();
            }
        }
        if (tally.unreadableTimes > 0)
            notes.push(`${tally.unreadableTimes} message(s) had a creation time that cannot be read; readers already treated them as past their day, so they were archived and deleted`);
        db.transaction(() => {
            renewLease(db, holder);
            writeOwedNotices(db, tally);
            saveRunProgress(db, startedRunId, tally, archivePath);
        }).immediate();
        if (tally.unaddressable > 0)
            notes.push(`${tally.unaddressable} sender(s) could not be addressed, so no notice was written for them`);
        db.transaction(() => {
            renewLease(db, holder);
            tally.presenceFacts = deletePresence(db, presenceParams, 'facts');
            tally.connections = deletePresence(db, presenceParams, 'connections');
        }).immediate();
        const remaining = db.prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE created_at < ?').get(cutoff).n;
        if (remaining > 0)
            notes.push(`${remaining} expired message(s) left for the next pass`);
        const detail = notes.length > 0 ? notes.join('; ') : null;
        const outcome = tally.expired > 0 ? 'deleted'
            : tally.presenceFacts + tally.connections > 0 ? 'presence_cleared'
                : seen.purgeable ? (purgeFailed ? 'failed' : 'archive_purged')
                    : tally.notices > 0 ? 'notices_sent'
                        : remaining > 0 ? 'deferred_in_flight' : 'nothing_expired';
        return finish(outcome, detail);
    }
    catch (error) {
        return finish('failed', error instanceof Error ? error.message : String(error));
    }
    finally {
        if (holdsLease)
            releaseLease(db, holder);
    }
}
export async function runAgentMessageExpiryIfDue(db, options) {
    try {
        const startedAtMs = Date.now();
        const last = db.prepare("SELECT MAX(started_at_ms) AS at FROM agent_message_expiry_runs WHERE outcome <> 'started'").get();
        if (last?.at != null && last.at <= startedAtMs && startedAtMs - last.at < AGENT_MESSAGE_EXPIRY_INTERVAL_MS - DUE_SLACK_MS)
            return null;
        return await runAgentMessageExpiry(db, options);
    }
    catch (error) {
        reportProblem(`could not check whether a pass is due: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}
export function startAgentMessageExpiryScheduler(getDb, options) {
    let running = false;
    const tick = () => {
        const db = getDb();
        if (!db || running)
            return;
        running = true;
        void runAgentMessageExpiryIfDue(db, { trigger: options.trigger }).finally(() => { running = false; });
    };
    const first = setTimeout(tick, options.firstRunDelayMs ?? 1_000);
    const every = setInterval(tick, options.intervalMs ?? AGENT_MESSAGE_EXPIRY_INTERVAL_MS);
    first.unref();
    every.unref();
    return () => {
        clearTimeout(first);
        clearInterval(every);
    };
}
export function lastAgentMessageExpiryRun(db) {
    try {
        const row = db.prepare(`
      SELECT run_id, started_at_ms, finished_at_ms, trigger_source, outcome, expired_message_count,
             unread_message_count, notice_count, presence_fact_count, connection_count, backup_path, detail
      FROM agent_message_expiry_runs WHERE outcome NOT IN ('skipped_concurrent', 'started') ORDER BY run_id DESC LIMIT 1
    `).get();
        return row ?? null;
    }
    catch {
        return null;
    }
}
export function latestAgentMessageExpiryArchive(db) {
    try {
        const row = db.prepare('SELECT backup_path FROM agent_message_expiry_runs WHERE backup_path IS NOT NULL ORDER BY run_id DESC LIMIT 1').get();
        return row?.backup_path ?? null;
    }
    catch {
        return null;
    }
}
export function inspectAgentMessageArchive(db, file) {
    try {
        fs.statSync(file);
    }
    catch (error) {
        const code = error.code;
        return code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unusable', reason: `it cannot be read (${code ?? String(error)})` };
    }
    try {
        refuseUnsafeArchive(db, file);
        const handle = new DatabaseSync(file, { readOnly: true });
        try {
            handle.exec('PRAGMA busy_timeout = 1000');
            const hasLog = handle.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'archive_log'").get().n;
            return { kind: 'held', messages: hasLog === 0 ? 0 : handle.prepare('SELECT COUNT(*) AS n FROM archive_log').get().n };
        }
        finally {
            handle.close();
        }
    }
    catch (error) {
        return { kind: 'unusable', reason: error instanceof Error ? error.message : String(error) };
    }
}
function selectBatch(db, cutoff, inFlightCutoff) {
    return db.prepare(`
    SELECT m.message_id, m.project, m.sender, m.recipient, m.created_at,
           CASE WHEN json_valid(m.provenance_json)
                THEN COALESCE(json_extract(m.provenance_json, '$.transport') = '${AGENT_MESSAGE_EXPIRY_TRANSPORT}', 0)
                ELSE 0 END AS is_notice,
           ${WAS_READ_SQL} AS was_read
    FROM agent_messages m
    WHERE m.created_at < ? AND NOT ${IN_FLIGHT_SQL}
    ORDER BY m.created_at
    LIMIT ?
  `).all(cutoff, inFlightCutoff, BATCH_SIZE);
}
function deleteBatch(db, rows, tally) {
    const remember = db.prepare(`
    INSERT OR REPLACE INTO agent_message_expiries
      (message_id, project, created_at, expired_at_ms, was_read, notice_message_id, sender, recipient, network_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    const delivery = db.prepare('SELECT delivery_id, recipient FROM agent_message_deliveries WHERE message_id = ? LIMIT 1');
    const bridgeTold = db.prepare("SELECT 1 FROM agent_messages WHERE reply_to_message_id = ? AND json_extract(provenance_json, '$.via') = 'network-notice' LIMIT 1");
    const now = Date.now();
    for (const row of rows) {
        const owesNotice = row.was_read === 0 && row.is_notice === 0;
        const sent = owesNotice ? delivery.get(row.message_id) : undefined;
        const network = sent ? networkDeliveryOf(db, sent) : null;
        const told = network !== null && bridgeTold.get(row.message_id) !== undefined;
        remember.run(row.message_id, row.project, row.created_at, now, row.was_read !== 0 ? 1 : 0, row.is_notice !== 0 || told ? NO_NOTICE : null, row.sender, row.recipient, network ? JSON.stringify(network) : null);
        if (owesNotice)
            tally.unread += 1;
        if (Number.isNaN(Date.parse(sqliteUtcToIso(row.created_at))))
            tally.unreadableTimes += 1;
    }
    const deleted = db.prepare('DELETE FROM agent_messages WHERE message_id IN (SELECT value FROM json_each(?))').run(JSON.stringify(rows.map((row) => row.message_id)));
    if (Number(deleted.changes) !== rows.length) {
        throw new Error(`expected to delete ${rows.length} message(s), deleted ${deleted.changes}; nothing in this batch was kept`);
    }
    tally.expired += rows.length;
}
function writeOwedNotices(db, tally) {
    const owed = db.prepare(`
    SELECT message_id, project, sender, recipient, created_at, network_json FROM agent_message_expiries
    WHERE ${NOTICE_OWED_SQL} ORDER BY project, sender, created_at, message_id
  `).all();
    const groups = new Map();
    for (const row of owed) {
        const key = `${row.project}\u0000${row.sender}`;
        const group = groups.get(key);
        if (group)
            group.push(row);
        else
            groups.set(key, [row]);
    }
    const mark = db.prepare('UPDATE agent_message_expiries SET notice_message_id = ? WHERE message_id IN (SELECT value FROM json_each(?))');
    for (const group of groups.values()) {
        const facts = group.map((row) => (row.network_json === null ? null : JSON.parse(row.network_json)));
        const state = {
            count: group.length,
            facts,
            listed: group.slice(0, NOTICE_LIST_MAX).map((row, index) => {
                const createdAt = sqliteUtcToIso(row.created_at);
                const sentMs = Date.parse(createdAt);
                return {
                    message_id: row.message_id,
                    recipient: row.recipient,
                    created_at: createdAt,
                    expired_at: Number.isNaN(sentMs) ? null : new Date(sentMs + AGENT_MESSAGE_TTL_MS).toISOString(),
                    ...(facts[index] ? { network: facts[index] } : {}),
                };
            }),
        };
        const noticeId = writeNotice(db, group[0].project, group[0].sender, state);
        if (noticeId === null)
            tally.unaddressable += 1;
        else
            tally.notices += 1;
        mark.run(noticeId ?? NO_NOTICE, JSON.stringify(group.map((row) => row.message_id)));
    }
}
function noticeSummary(state) {
    const count = state.count;
    const plural = (n) => (n === 1 ? '' : 's');
    const remote = state.facts.filter((fact) => fact !== null);
    if (remote.length === 0) {
        return `${count} message${plural(count)} you sent expired: MeMesh keeps a message for one day, and `
            + `${count === 1 ? 'its recipient' : 'their recipients'} recorded no intake, acknowledgement or disposition and sent no reply. `
            + 'Send it again if it still matters.';
    }
    const parts = [];
    const local = count - remote.length;
    if (local > 0)
        parts.push(`For ${local} sent to a recipient on this machine, the recipient recorded no intake, acknowledgement or disposition and sent no reply.`);
    const unique = (values) => [...new Set(values.filter((value) => value !== null))];
    const delivered = remote.filter((fact) => fact.state === 'delivered');
    const undelivered = remote.filter((fact) => fact.state !== 'delivered');
    if (undelivered.length > 0) {
        const codes = unique(undelivered.map((fact) => fact.code));
        parts.push(`${undelivered.length} sent to machine ${unique(undelivered.map((fact) => fact.machine)).join(', ')} ${undelivered.length === 1 ? 'was' : 'were'} not delivered `
            + `(${codes.length > 0 ? `last error: ${codes.join(', ')}` : 'no delivery attempt was recorded'}).`);
    }
    if (delivered.length > 0) {
        parts.push(`${delivered.length} ${delivered.length === 1 ? 'was' : 'were'} delivered to machine ${unique(delivered.map((fact) => fact.machine)).join(', ')}, `
            + 'but no reply from there was seen on this machine.');
    }
    return `${count} message${plural(count)} you sent expired: MeMesh keeps a message for one day. ${parts.join(' ')} Send it again if it still matters.`;
}
function noticePayload(state) {
    const count = state.count;
    return {
        kind: 'message_expired',
        summary: noticeSummary(state),
        messages: state.listed,
        ...(count > state.listed.length ? { not_listed: count - state.listed.length } : {}),
    };
}
function writeNotice(db, project, sender, state) {
    try {
        const sent = sendAgentMessage(db, {
            project,
            sender: AGENT_MESSAGE_EXPIRY_NOTICE_SENDER,
            sender_host: AGENT_MESSAGE_EXPIRY_NOTICE_SENDER,
            recipient: sender,
            idempotency_key: `expiry-notice-${randomUUID()}`,
            content_type: 'application/json',
            payload: noticePayload(state),
            provenance: { transport: AGENT_MESSAGE_EXPIRY_TRANSPORT, source_host: AGENT_MESSAGE_EXPIRY_NOTICE_SENDER },
        }, { skip_conversation_loop_limit: true });
        return sent.message_id;
    }
    catch (error) {
        if (error instanceof AgentMessagingError)
            return null;
        throw error;
    }
}
function saveRunProgress(db, runId, tally, archiveFile) {
    if (runId === null)
        return;
    db.prepare(`
    UPDATE agent_message_expiry_runs
    SET expired_message_count = ?, unread_message_count = ?, notice_count = ?, backup_path = ?
    WHERE run_id = ?
  `).run(tally.expired, tally.unread, tally.notices, archiveFile, runId);
}
function archiveLocation(db, options) {
    const databasePath = databaseFile(db);
    const directory = options.backupDir ?? (databasePath ? path.join(path.dirname(databasePath), 'backups') : null);
    if (directory === null)
        return null;
    const base = path.basename(databasePath);
    return path.join(directory, base === '' || base === 'knowledge-graph.db' ? AGENT_MESSAGE_ARCHIVE_FILE : `agent-messages-expired-${base}`);
}
const SQLITE_HEADER = 'SQLite format 3\u0000';
function refuseUnsafeArchive(db, file) {
    let link;
    try {
        link = fs.lstatSync(file);
    }
    catch {
        return;
    }
    const real = link.isSymbolicLink() ? (fs.existsSync(file) ? fs.realpathSync(file) : null) : file;
    if (real === null)
        throw new Error(`${file} is a symlink to a file that does not exist; MeMesh does not create the archive through a symlink`);
    const target = fs.statSync(real);
    if (!target.isFile())
        throw new Error(`${file} is not a plain file`);
    const main = databaseFile(db);
    const mainStat = main === '' ? undefined : fs.statSync(main, { throwIfNoEntry: false });
    if (mainStat && mainStat.dev === target.dev && mainStat.ino === target.ino) {
        throw new Error(`${file} is the database itself, so it cannot hold a copy of what is deleted from it`);
    }
    if (target.size > 0) {
        const head = Buffer.alloc(SQLITE_HEADER.length);
        const fd = fs.openSync(real, 'r');
        try {
            fs.readSync(fd, head, 0, head.length, 0);
        }
        finally {
            fs.closeSync(fd);
        }
        if (head.toString('latin1') !== SQLITE_HEADER)
            throw new Error(`${file} is not a database (it has no SQLite header), so it is not a MeMesh archive; MeMesh leaves it as it is (move it away)`);
    }
}
export function databaseFile(db) {
    const row = db.prepare("SELECT file FROM pragma_database_list WHERE name = 'main'").get();
    return row?.file ?? '';
}
function where(schema, by) {
    return by === 'message'
        ? 'message_id IN (SELECT value FROM json_each(?))'
        : `delivery_id IN (SELECT delivery_id FROM ${schema}.agent_message_deliveries WHERE message_id IN (SELECT value FROM json_each(?)))`;
}
function attachArchive(db, file) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    refuseUnsafeArchive(db, file);
    const fresh = !fs.existsSync(file);
    if (fresh)
        fs.closeSync(fs.openSync(file, 'a', 0o600));
    removeGroupAndOtherAccess(file);
    db.prepare(`ATTACH DATABASE ? AS ${ARCHIVE}`).run(file);
    try {
        if (fresh)
            db.exec(`PRAGMA ${ARCHIVE}.auto_vacuum = INCREMENTAL`);
        for (const table of ARCHIVED_TABLES) {
            db.exec(`CREATE TABLE IF NOT EXISTS ${ARCHIVE}.${table.name} AS SELECT * FROM main.${table.name} WHERE 0`);
            const live = columnNames(db, 'main', table.name);
            const kept = new Set(columnNames(db, ARCHIVE, table.name));
            for (const column of live.filter((name) => !kept.has(name))) {
                db.exec(`ALTER TABLE ${ARCHIVE}.${table.name} ADD COLUMN ${quoted(column)}`);
            }
            const indexed = db.prepare(`SELECT name FROM pragma_index_info('ux_${table.name}', '${ARCHIVE}')`).all()
                .map((row) => row.name).join(', ');
            if (indexed !== '' && indexed !== table.unique)
                db.exec(`DROP INDEX ${ARCHIVE}.ux_${table.name}`);
            db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${ARCHIVE}.ux_${table.name} ON ${table.name}(${table.unique})`);
            const lookup = `${table.by}_id`;
            if (lookup !== table.unique)
                db.exec(`CREATE INDEX IF NOT EXISTS ${ARCHIVE}.by_${table.name} ON ${table.name}(${lookup})`);
        }
        db.exec(`CREATE TABLE IF NOT EXISTS ${ARCHIVE}.archive_log (message_id TEXT PRIMARY KEY, archived_at_ms INTEGER NOT NULL)`);
    }
    catch (error) {
        db.exec(`DETACH DATABASE ${ARCHIVE}`);
        throw error;
    }
}
function columnNames(db, schema, table) {
    return db.prepare(`SELECT name FROM pragma_table_info('${table}', '${schema}')`).all().map((row) => row.name);
}
function quoted(column) {
    return `"${column.replace(/"/g, '""')}"`;
}
function archiveRows(db, file, messageIds, batch, options) {
    const ids = JSON.stringify(messageIds);
    attachArchive(db, file);
    try {
        const columns = new Map(ARCHIVED_TABLES.map((table) => [table.name, columnNames(db, 'main', table.name).map(quoted).join(', ')]));
        db.transaction(() => {
            for (const table of ARCHIVED_TABLES) {
                const list = columns.get(table.name);
                db.prepare(`INSERT OR REPLACE INTO ${ARCHIVE}.${table.name} (${list}) SELECT ${list} FROM main.${table.name} WHERE ${where('main', table.by)}`).run(ids);
            }
            db.prepare(`
        INSERT INTO ${ARCHIVE}.archive_log (message_id, archived_at_ms) SELECT value, ? FROM json_each(?) WHERE true
        ON CONFLICT(message_id) DO UPDATE SET archived_at_ms = excluded.archived_at_ms
      `).run(Date.now(), ids);
        })();
        options.fault?.beforeArchiveCheck?.(file, batch);
        for (const table of ARCHIVED_TABLES) {
            const list = columns.get(table.name);
            const missing = db.prepare(`
        SELECT COUNT(*) AS n FROM (
          SELECT ${list} FROM main.${table.name} WHERE ${where('main', table.by)}
          EXCEPT SELECT ${list} FROM ${ARCHIVE}.${table.name} WHERE ${where(ARCHIVE, table.by)}
        )
      `).get(ids, ids).n;
            if (missing > 0)
                throw new Error(`${missing} ${table.name} row(s) of this batch are not in the archive as they are in the database`);
        }
    }
    finally {
        db.exec(`DETACH DATABASE ${ARCHIVE}`);
    }
}
function archiveHasPurgeableRows(db, file, nowMs) {
    if (!fs.existsSync(file))
        return false;
    try {
        refuseUnsafeArchive(db, file);
        db.prepare(`ATTACH DATABASE ? AS ${ARCHIVE}`).run(file);
    }
    catch {
        return false;
    }
    try {
        const hasLog = db.prepare(`SELECT COUNT(*) AS n FROM ${ARCHIVE}.sqlite_master WHERE type = 'table' AND name = 'archive_log'`).get().n;
        if (hasLog === 0)
            return false;
        return db.prepare(`SELECT EXISTS (SELECT 1 FROM ${ARCHIVE}.archive_log WHERE archived_at_ms < ?) AS n`).get(nowMs - AGENT_MESSAGE_TTL_MS).n === 1;
    }
    catch {
        return false;
    }
    finally {
        db.exec(`DETACH DATABASE ${ARCHIVE}`);
    }
}
async function purgeArchive(db, file) {
    let purged = 0;
    for (;;) {
        if (!fs.existsSync(file))
            return purged;
        attachArchive(db, file);
        try {
            const cut = Date.now() - AGENT_MESSAGE_TTL_MS;
            const batch = db.prepare(`SELECT message_id FROM ${ARCHIVE}.archive_log WHERE archived_at_ms < ? LIMIT ?`)
                .all(cut, BATCH_SIZE).map((row) => row.message_id);
            if (batch.length === 0)
                return purged;
            const ids = JSON.stringify(batch);
            db.transaction(() => {
                for (const table of [...ARCHIVED_TABLES].reverse()) {
                    db.prepare(`DELETE FROM ${ARCHIVE}.${table.name} WHERE ${where(ARCHIVE, table.by)}`).run(ids);
                }
                db.prepare(`DELETE FROM ${ARCHIVE}.archive_log WHERE message_id IN (SELECT value FROM json_each(?))`).run(ids);
            })();
            purged += batch.length;
            db.exec(`PRAGMA ${ARCHIVE}.incremental_vacuum`);
        }
        finally {
            db.exec(`DETACH DATABASE ${ARCHIVE}`);
        }
        await yieldTurn();
    }
}
function isBusy(error) {
    const code = error?.errcode;
    return code === 5 || code === 6 || /database (table )?is locked|SQLITE_BUSY/i.test(error instanceof Error ? error.message : String(error));
}
function withoutWaiting(db, fn) {
    const previous = db.prepare('PRAGMA busy_timeout').get().timeout;
    db.pragma(`busy_timeout = ${LOCK_WAIT_MS}`);
    try {
        return fn();
    }
    finally {
        db.pragma(`busy_timeout = ${previous}`);
    }
}
function probeWritable(db) {
    db.exec('SAVEPOINT expiry_probe');
    try {
        db.prepare(`
      INSERT INTO agent_message_expiry_runs (started_at_ms, finished_at_ms, trigger_source, outcome)
      VALUES (0, 0, 'probe', 'probe')
    `).run();
    }
    finally {
        db.exec('ROLLBACK TO expiry_probe');
        db.exec('RELEASE expiry_probe');
    }
}
function acquireLease(db, holder) {
    return db.transaction(() => {
        const now = Date.now();
        const row = db.prepare('SELECT holder, expires_at_ms FROM agent_message_expiry_lease WHERE lease_id = 1')
            .get();
        if (row && row.expires_at_ms > now)
            return row.expires_at_ms;
        db.prepare('INSERT OR REPLACE INTO agent_message_expiry_lease (lease_id, holder, expires_at_ms) VALUES (1, ?, ?)')
            .run(holder, now + LEASE_MS);
        return null;
    }).immediate();
}
function renewLease(db, holder) {
    const renewed = db.prepare('UPDATE agent_message_expiry_lease SET expires_at_ms = ? WHERE lease_id = 1 AND holder = ?')
        .run(Date.now() + LEASE_MS, holder);
    if (Number(renewed.changes) !== 1) {
        throw new Error('another process took over the expiry lease; this pass stopped before deleting more');
    }
}
function releaseLease(db, holder) {
    try {
        db.prepare('DELETE FROM agent_message_expiry_lease WHERE lease_id = 1 AND holder = ?').run(holder);
    }
    catch (error) {
        reportProblem(`could not release the expiry lease (${error instanceof Error ? error.message : String(error)}); it runs out on its own`);
    }
}
function presenceBindings(cutoff, clockMs) {
    return {
        dead: { cutoff, dead_lease_ms: clockMs - AGENT_MESSAGE_TTL_MS },
        facts: { cutoff, dead_lease_ms: clockMs - AGENT_MESSAGE_TTL_MS, now_ms: clockMs },
    };
}
function countStalePresence(db, bind) {
    const facts = db.prepare(`
    SELECT COUNT(*) AS n FROM agent_presence_facts
    WHERE (julianday(created_at) < julianday(:cutoff) AND connection_id NOT IN (${LIVE_CONNECTIONS_SQL}))
       OR connection_id IN (${DEAD_CONNECTIONS_SQL})
  `).get(bind.facts);
    const connections = db.prepare(`SELECT COUNT(*) AS n FROM (${DEAD_CONNECTIONS_SQL})`).get(bind.dead);
    return facts.n + connections.n;
}
function deletePresence(db, bind, what) {
    if (what === 'connections') {
        return Number(db.prepare(`DELETE FROM agent_session_connections WHERE connection_id IN (${DEAD_CONNECTIONS_SQL})`).run(bind.dead).changes);
    }
    return Number(db.prepare(`
    DELETE FROM agent_presence_facts
    WHERE (julianday(created_at) < julianday(:cutoff) AND connection_id NOT IN (${LIVE_CONNECTIONS_SQL}))
       OR connection_id IN (${DEAD_CONNECTIONS_SQL})
  `).run(bind.facts).changes);
}
function trimBookkeeping(db, nowMs) {
    db.prepare('DELETE FROM agent_message_expiries WHERE expired_at_ms < ?').run(nowMs - AGENT_MESSAGE_EXPIRED_ID_KEEP_MS);
}
function tablesExist(db) {
    const found = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('agent_messages', 'agent_message_expiry_runs', 'agent_message_expiries', 'agent_message_expiry_lease')").get();
    return found.n === 4;
}
function beginRun(db, startedAtMs, trigger, archiveFile) {
    try {
        const inserted = db.prepare(`
      INSERT INTO agent_message_expiry_runs (started_at_ms, finished_at_ms, trigger_source, outcome, backup_path)
      VALUES (?, ?, ?, 'started', ?)
    `).run(startedAtMs, startedAtMs, trigger, archiveFile);
        return Number(inserted.lastInsertRowid);
    }
    catch (error) {
        reportProblem(`could not record that a pass started: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}
async function recordRun(db, startedAtMs, trigger, result, startedRunId) {
    const deadline = Date.now() + RECORD_RETRY_MS;
    for (;;) {
        try {
            return withoutWaiting(db, () => writeRun(db, startedAtMs, trigger, result, startedRunId));
        }
        catch (error) {
            if (isBusy(error) && Date.now() < deadline) {
                await new Promise((resolve) => { setTimeout(resolve, 1_000).unref(); });
                continue;
            }
            reportProblem(`pass ended ${result.outcome}${result.detail ? ` (${result.detail})` : ''} and could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }
}
function writeRun(db, startedAtMs, trigger, result, startedRunId) {
    return db.transaction(() => {
        if (startedRunId !== null) {
            db.prepare(`
        UPDATE agent_message_expiry_runs
        SET finished_at_ms = ?, outcome = ?, expired_message_count = ?, unread_message_count = ?,
            notice_count = ?, presence_fact_count = ?, connection_count = ?, backup_path = ?, detail = ?
        WHERE run_id = ?
      `).run(Date.now(), result.outcome, result.expired_message_count, result.unread_message_count, result.notice_count, result.presence_fact_count, result.connection_count, result.backup_path, result.detail, startedRunId);
            trimBookkeeping(db, startedAtMs);
            trimRunLog(db);
            return startedRunId;
        }
        const inserted = db.prepare(`
      INSERT INTO agent_message_expiry_runs (
        started_at_ms, finished_at_ms, trigger_source, outcome, expired_message_count, unread_message_count,
        notice_count, presence_fact_count, connection_count, backup_path, detail
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(startedAtMs, Date.now(), trigger, result.outcome, result.expired_message_count, result.unread_message_count, result.notice_count, result.presence_fact_count, result.connection_count, result.backup_path, result.detail);
        trimBookkeeping(db, startedAtMs);
        trimRunLog(db);
        return Number(inserted.lastInsertRowid);
    }).immediate();
}
function trimRunLog(db) {
    db.prepare(`
    DELETE FROM agent_message_expiry_runs
    WHERE run_id <= (SELECT run_id FROM agent_message_expiry_runs ORDER BY run_id DESC LIMIT 1 OFFSET ?)
  `).run(RUN_LOG_KEEP);
}
function interruptDeadRuns(db) {
    try {
        db.prepare(`
      UPDATE agent_message_expiry_runs
      SET outcome = 'interrupted', detail = 'the process stopped before this pass finished'
      WHERE outcome = 'started'
        AND NOT EXISTS (SELECT 1 FROM agent_message_expiry_lease WHERE expires_at_ms > ?)
    `).run(Date.now());
    }
    catch (error) {
        reportProblem(`could not close a pass that never finished: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function yieldTurn() {
    return new Promise((resolve) => setImmediate(resolve));
}
function reportProblem(message) {
    try {
        process.stderr.write(`MeMesh message expiry: ${message}\n`);
    }
    catch { }
}
//# sourceMappingURL=agent-message-expiry.js.map