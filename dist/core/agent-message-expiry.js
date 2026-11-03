import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AGENT_MESSAGE_TTL_MS, agentMessageExpiryCutoff } from './agent-message-ttl.js';
import { AgentMessagingError, sendAgentMessage } from './agent-messaging.js';
import { sqliteUtcToIso } from './time-utils.js';
export const AGENT_MESSAGE_EXPIRY_INTERVAL_MS = 5 * 60 * 1000;
export const AGENT_MESSAGE_EXPIRED_ID_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
export const AGENT_MESSAGE_ARCHIVE_FILE = 'agent-messages-expired.db';
const RUN_LOG_KEEP = 500;
const LEASE_MS = 3 * 60 * 1000;
const BATCH_SIZE = 100;
const MAX_BATCHES_PER_PASS = 200;
const IN_FLIGHT_GRACE_MS = 10 * 60 * 1000;
const NOTICE_LIST_MAX = 20;
const ARCHIVE = 'expiry_archive';
export const AGENT_MESSAGE_EXPIRY_NOTICE_SENDER = 'memesh';
export const AGENT_MESSAGE_EXPIRY_TRANSPORT = 'expiry';
const WAS_READ_SQL = `(
  EXISTS (SELECT 1 FROM agent_message_receipts r
          WHERE r.message_id = m.message_id AND r.receipt_kind IN ('intake', 'ack', 'disposition'))
  OR EXISTS (SELECT 1 FROM agent_message_deliveries d JOIN agent_ack_facts a ON a.delivery_id = d.delivery_id
             WHERE d.message_id = m.message_id)
  OR EXISTS (SELECT 1 FROM agent_message_deliveries d JOIN agent_workflow_facts w ON w.delivery_id = d.delivery_id
             WHERE d.message_id = m.message_id)
  OR EXISTS (SELECT 1 FROM agent_messages c WHERE c.reply_to_message_id = m.message_id)
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
    { name: 'agent_message_events', unique: 'event_id', by: 'message' },
    { name: 'agent_message_idempotency', unique: 'project, sender, idempotency_key', by: 'message' },
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
    const tally = { expired: 0, unread: 0, notices: 0, unaddressable: 0, presenceFacts: 0, connections: 0 };
    let archivePath = null;
    const holder = randomUUID();
    let holdsLease = false;
    let startedRunId = null;
    const finish = (outcome, detail = null) => {
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
        return { ...base, run_id: recordRun(db, startedAtMs, options.trigger, base, startedRunId) };
    };
    try {
        if (!tablesExist(db))
            return finish('no_message_tables', 'agent_messages, agent_message_expiry_runs, agent_message_expiries or agent_message_expiry_lease is missing');
        const cutoff = agentMessageExpiryCutoff(clockMs);
        const inFlightCutoff = new Date(clockMs - IN_FLIGHT_GRACE_MS).toISOString();
        const presenceParams = presenceBindings(cutoff, clockMs);
        const archiveFile = archiveLocation(db, options);
        const measure = () => ({
            expired: db.prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE created_at < ?').get(cutoff).n,
            deletable: db.prepare(`SELECT COUNT(*) AS n FROM agent_messages m WHERE m.created_at < ? AND NOT ${IN_FLIGHT_SQL}`).get(cutoff, inFlightCutoff).n,
            presence: countStalePresence(db, presenceParams),
            purgeable: archiveFile === null ? 0 : countPurgeableArchiveMessages(db, archiveFile, Date.now()),
        });
        const idle = (m) => m.deletable === 0 && m.presence === 0 && m.purgeable === 0;
        const idleOutcome = (m) => (m.expired > 0 ? 'deferred_in_flight' : 'nothing_expired');
        let seen = measure();
        if (idle(seen)) {
            interruptDeadRuns(db);
            return finish(idleOutcome(seen));
        }
        if (seen.deletable > 0 && archiveFile === null) {
            return finish('archive_unavailable', 'the database has no file path and no archive directory was given, so nothing was deleted');
        }
        try {
            probeWritable(db);
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
        startedRunId = beginRun(db, startedAtMs, options.trigger, seen.deletable > 0 ? archiveFile : null);
        archivePath = seen.deletable > 0 ? archiveFile : null;
        const notes = [];
        const notices = new Map();
        if (seen.deletable > 0 && archiveFile !== null) {
            for (let batch = 1; batch <= MAX_BATCHES_PER_PASS; batch++) {
                const rows = selectBatch(db, cutoff, inFlightCutoff);
                if (rows.length === 0)
                    break;
                try {
                    archiveRows(db, archiveFile, rows.map((row) => row.message_id), batch, options);
                }
                catch (error) {
                    return finish('archive_failed', `could not archive the rows of ${rows.length} message(s) before deleting them (${error instanceof Error ? error.message : String(error)}); nothing in this batch was deleted`);
                }
                db.transaction(() => {
                    renewLease(db, holder);
                    deleteBatch(db, rows, notices, tally);
                    saveRunProgress(db, startedRunId, tally, archiveFile);
                }).immediate();
                await options.fault?.afterBatch?.(batch);
                await yieldTurn();
            }
            tally.notices = [...notices.values()].filter((state) => state.noticeId !== null).length;
            tally.unaddressable = [...notices.values()].filter((state) => state.noticeId === null).length;
            if (tally.unaddressable > 0)
                notes.push(`${tally.unaddressable} sender(s) could not be addressed, so no notice was written for them`);
        }
        let purgeFailed = false;
        if (archiveFile !== null) {
            try {
                purgeArchive(db, archiveFile, Date.now());
            }
            catch (error) {
                purgeFailed = true;
                notes.push(`could not remove archive rows older than a day (${error instanceof Error ? error.message : String(error)}); they stay until the next pass`);
            }
        }
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
                : seen.purgeable > 0 ? (purgeFailed ? 'failed' : 'archive_purged')
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
        if (last?.at != null && last.at <= startedAtMs && startedAtMs - last.at < AGENT_MESSAGE_EXPIRY_INTERVAL_MS)
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
function deleteBatch(db, rows, notices, tally) {
    const noticeFor = new Map();
    const touched = new Map();
    for (const row of rows) {
        if (row.was_read !== 0 || row.is_notice !== 0)
            continue;
        const key = `${row.project}\u0000${row.sender}`;
        const list = touched.get(key);
        if (list)
            list.push(row);
        else
            touched.set(key, [row]);
    }
    for (const [key, group] of touched) {
        const state = notices.get(key) ?? { noticeId: null, count: 0, listed: [] };
        const known = notices.has(key);
        state.count += group.length;
        for (const row of group) {
            if (state.listed.length >= NOTICE_LIST_MAX)
                break;
            const createdAt = sqliteUtcToIso(row.created_at);
            state.listed.push({
                message_id: row.message_id,
                recipient: row.recipient,
                created_at: createdAt,
                expired_at: new Date(Date.parse(createdAt) + AGENT_MESSAGE_TTL_MS).toISOString(),
            });
        }
        if (!known)
            state.noticeId = writeNotice(db, group[0], state);
        else if (state.noticeId !== null)
            updateNotice(db, state);
        notices.set(key, state);
        if (state.noticeId !== null)
            for (const row of group)
                noticeFor.set(row.message_id, state.noticeId);
    }
    const remember = db.prepare(`
    INSERT OR REPLACE INTO agent_message_expiries
      (message_id, project, created_at, expired_at_ms, was_read, notice_message_id, sender, recipient)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
    const now = Date.now();
    for (const row of rows) {
        remember.run(row.message_id, row.project, row.created_at, now, row.was_read !== 0 ? 1 : 0, noticeFor.get(row.message_id) ?? null, row.sender, row.recipient);
        if (row.was_read === 0 && row.is_notice === 0)
            tally.unread += 1;
    }
    const deleted = db.prepare('DELETE FROM agent_messages WHERE message_id IN (SELECT value FROM json_each(?))').run(JSON.stringify(rows.map((row) => row.message_id)));
    if (Number(deleted.changes) !== rows.length) {
        throw new Error(`expected to delete ${rows.length} message(s), deleted ${deleted.changes}; nothing in this batch was kept`);
    }
    tally.expired += rows.length;
}
function noticePayload(state) {
    const count = state.count;
    return {
        kind: 'message_expired',
        summary: `${count} message${count === 1 ? '' : 's'} you sent expired: MeMesh keeps a message for one day, and `
            + `${count === 1 ? 'its recipient' : 'their recipients'} recorded no intake, acknowledgement or disposition and sent no reply. `
            + 'Send it again if it still matters.',
        messages: state.listed,
        ...(count > state.listed.length ? { not_listed: count - state.listed.length } : {}),
    };
}
function writeNotice(db, first, state) {
    try {
        const sent = sendAgentMessage(db, {
            project: first.project,
            sender: AGENT_MESSAGE_EXPIRY_NOTICE_SENDER,
            sender_host: AGENT_MESSAGE_EXPIRY_NOTICE_SENDER,
            recipient: first.sender,
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
function updateNotice(db, state) {
    db.prepare('UPDATE agent_messages SET payload_json = ? WHERE message_id = ?').run(JSON.stringify(noticePayload(state)), state.noticeId);
}
function saveRunProgress(db, runId, tally, archiveFile) {
    if (runId === null)
        return;
    db.prepare(`
    UPDATE agent_message_expiry_runs
    SET expired_message_count = ?, unread_message_count = ?, backup_path = ?
    WHERE run_id = ?
  `).run(tally.expired, tally.unread, archiveFile, runId);
}
function archiveLocation(db, options) {
    const databasePath = options.databasePath ?? databaseFile(db);
    const directory = options.backupDir ?? (databasePath ? path.join(path.dirname(databasePath), 'backups') : null);
    return directory === null ? null : path.join(directory, AGENT_MESSAGE_ARCHIVE_FILE);
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
    const fresh = !fs.existsSync(file);
    if (fresh)
        fs.closeSync(fs.openSync(file, 'a', 0o600));
    fs.chmodSync(file, 0o600);
    db.prepare(`ATTACH DATABASE ? AS ${ARCHIVE}`).run(file);
    try {
        if (fresh)
            db.exec(`PRAGMA ${ARCHIVE}.auto_vacuum = INCREMENTAL`);
        for (const table of ARCHIVED_TABLES) {
            db.exec(`CREATE TABLE IF NOT EXISTS ${ARCHIVE}.${table.name} AS SELECT * FROM main.${table.name} WHERE 0`);
            const live = columnNames(db, 'main', table.name);
            const kept = new Set(columnNames(db, ARCHIVE, table.name));
            for (const column of live.filter((name) => !kept.has(name))) {
                db.exec(`ALTER TABLE ${ARCHIVE}.${table.name} ADD COLUMN "${column.replace(/"/g, '""')}"`);
            }
            db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${ARCHIVE}.ux_${table.name} ON ${table.name}(${table.unique})`);
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
function archiveRows(db, file, messageIds, batch, options) {
    const ids = JSON.stringify(messageIds);
    attachArchive(db, file);
    try {
        db.transaction(() => {
            for (const table of ARCHIVED_TABLES) {
                db.prepare(`INSERT OR IGNORE INTO ${ARCHIVE}.${table.name} SELECT * FROM main.${table.name} WHERE ${where('main', table.by)}`).run(ids);
            }
            db.prepare(`INSERT OR IGNORE INTO ${ARCHIVE}.archive_log (message_id, archived_at_ms) SELECT value, ? FROM json_each(?)`)
                .run(Date.now(), ids);
        })();
        options.fault?.beforeArchiveCheck?.(file, batch);
        for (const table of ARCHIVED_TABLES) {
            const source = db.prepare(`SELECT COUNT(*) AS n FROM main.${table.name} WHERE ${where('main', table.by)}`).get(ids).n;
            const archived = db.prepare(`SELECT COUNT(*) AS n FROM ${ARCHIVE}.${table.name} WHERE ${where(ARCHIVE, table.by)}`).get(ids).n;
            if (archived < source)
                throw new Error(`the archive holds ${archived} ${table.name} row(s) of this batch, the database ${source}`);
        }
    }
    finally {
        db.exec(`DETACH DATABASE ${ARCHIVE}`);
    }
}
function countPurgeableArchiveMessages(db, file, nowMs) {
    if (!fs.existsSync(file))
        return 0;
    db.prepare(`ATTACH DATABASE ? AS ${ARCHIVE}`).run(file);
    try {
        const hasLog = db.prepare(`SELECT COUNT(*) AS n FROM ${ARCHIVE}.sqlite_master WHERE type = 'table' AND name = 'archive_log'`).get().n;
        if (hasLog === 0)
            return 0;
        return db.prepare(`SELECT COUNT(*) AS n FROM ${ARCHIVE}.archive_log WHERE archived_at_ms < ?`).get(nowMs - AGENT_MESSAGE_TTL_MS).n;
    }
    finally {
        db.exec(`DETACH DATABASE ${ARCHIVE}`);
    }
}
function purgeArchive(db, file, nowMs) {
    if (!fs.existsSync(file))
        return 0;
    attachArchive(db, file);
    try {
        const cut = nowMs - AGENT_MESSAGE_TTL_MS;
        const old = `SELECT message_id FROM ${ARCHIVE}.archive_log WHERE archived_at_ms < ?`;
        const oldDeliveries = `SELECT delivery_id FROM ${ARCHIVE}.agent_message_deliveries WHERE message_id IN (${old})`;
        const count = db.prepare(`SELECT COUNT(*) AS n FROM (${old})`).get(cut).n;
        if (count === 0)
            return 0;
        db.transaction(() => {
            for (const table of [...ARCHIVED_TABLES].reverse()) {
                const scope = table.by === 'message' ? `message_id IN (${old})` : `delivery_id IN (${oldDeliveries})`;
                db.prepare(`DELETE FROM ${ARCHIVE}.${table.name} WHERE ${scope}`).run(cut);
            }
            db.prepare(`DELETE FROM ${ARCHIVE}.archive_log WHERE archived_at_ms < ?`).run(cut);
        })();
        db.exec(`PRAGMA ${ARCHIVE}.incremental_vacuum`);
        return count;
    }
    finally {
        db.exec(`DETACH DATABASE ${ARCHIVE}`);
    }
}
function isBusy(error) {
    const code = error?.errcode;
    return code === 5 || code === 6 || /database (table )?is locked|SQLITE_BUSY/i.test(error instanceof Error ? error.message : String(error));
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
function recordRun(db, startedAtMs, trigger, result, startedRunId) {
    try {
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
    }
    catch (error) {
        reportProblem(`pass ended ${result.outcome}${result.detail ? ` (${result.detail})` : ''} and could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
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