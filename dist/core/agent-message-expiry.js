import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, MemeshDatabase } from '../storage/sqlite.js';
import { removeGroupAndOtherAccess } from './file-mode.js';
import { AGENT_MESSAGE_TTL_MS, agentMessageExpiryCutoff } from './agent-message-ttl.js';
import { AgentMessagingError, sendAgentMessage } from './agent-messaging.js';
import { DEFAULT_DB_FILE } from './paths.js';
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
const DUE_SLACK_MS = 10_000;
const AGENT_MESSAGE_EXPIRY_NOTICE_SENDER = 'memesh';
const AGENT_MESSAGE_EXPIRY_TRANSPORT = 'expiry';
const NOTICE_OWED_SQL = `was_read = 0 AND notice_message_id IS NULL AND sender <> '${AGENT_MESSAGE_EXPIRY_NOTICE_SENDER}'`;
export const AGENT_MESSAGE_EXPIRY_FAILED_OUTCOMES = new Set([
    'failed', 'archive_failed', 'archive_unavailable', 'no_message_tables', 'read_only',
]);
export const AGENT_MESSAGE_EXPIRY_DONE_OUTCOMES = new Set([
    'deleted', 'presence_cleared', 'archive_purged', 'notices_sent', 'nothing_expired', 'deferred_in_flight',
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
                    OR c.sender IN (SELECT s.session_instance_id FROM agent_session_instances s
                                    WHERE s.project = m.project AND s.principal_id = m.recipient)
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
const STALE_FACTS_SQL = `(julianday(created_at) < julianday(:cutoff) AND connection_id NOT IN (${LIVE_CONNECTIONS_SQL}))
  OR connection_id IN (${DEAD_CONNECTIONS_SQL})`;
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
const unrecorded = new Map();
const abandonedLeases = new Set();
export async function runAgentMessageExpiry(db, options) {
    const startedAtMs = Date.now();
    const clockMs = options.nowMs ?? startedAtMs;
    const tally = { expired: 0, unread: 0, notices: 0, unaddressable: 0, unreadableTimes: 0, presenceFacts: 0, connections: 0 };
    const file = databaseFile(db);
    let pass = null;
    let archiveFile = null;
    const holder = randomUUID();
    let holdsLease = false;
    let startedRunId = null;
    let stopped = false;
    const finish = (outcome, detail = null) => {
        const result = {
            outcome,
            expired_message_count: tally.expired,
            unread_message_count: tally.unread,
            notice_count: tally.notices,
            presence_fact_count: tally.presenceFacts,
            connection_count: tally.connections,
            backup_path: tally.expired > 0 ? archiveFile : null,
            detail,
        };
        if (stopped)
            return { ...result, run_id: startedRunId };
        return { ...result, run_id: recordRun(pass, file, { startedAtMs, endedAtMs: Date.now(), trigger: options.trigger, result, startedRunId }) };
    };
    const stop = () => {
        stopped = true;
        if (pass === null)
            return;
        try {
            if (startedRunId !== null) {
                pass.prepare(`
          UPDATE agent_message_expiry_runs
          SET outcome = 'interrupted', finished_at_ms = ?, expired_message_count = ?, unread_message_count = ?, notice_count = ?,
              detail = 'the process stopped during this pass; what it had deleted is kept and the next pass does the rest'
          WHERE run_id = ? AND outcome = 'started'
        `).run(Date.now(), tally.expired, tally.unread, tally.notices, startedRunId);
            }
            if (holdsLease)
                pass.prepare('DELETE FROM agent_message_expiry_lease WHERE lease_id = 1 AND holder = ?').run(holder);
        }
        catch (error) {
            reportProblem(`could not close the pass of a process that is stopping (${errorText(error)}); the next pass closes it once its lease runs out`);
        }
        if (pass !== db)
            closeQuietly(pass);
    };
    options.signal?.addEventListener('abort', stop, { once: true });
    try {
        pass = file === '' ? db : openPassConnection(file);
        const work = pass;
        if (!tablesExist(work))
            return finish('no_message_tables', 'agent_messages, agent_message_expiry_runs, agent_message_expiries or agent_message_expiry_lease is missing');
        const cutoff = agentMessageExpiryCutoff(clockMs);
        const inFlightCutoff = new Date(clockMs - IN_FLIGHT_GRACE_MS).toISOString();
        const presenceParams = presenceBindings(cutoff, clockMs);
        archiveFile = archiveLocation(file);
        const shared = archiveFile === null ? null : sharedArchive(archiveFile);
        const purges = archiveFile === null ? [] : [[archiveFile, false], ...(shared === null ? [] : [[shared, true]])];
        const measure = () => ({
            deletable: work.prepare(`SELECT EXISTS (SELECT 1 FROM agent_messages m WHERE m.created_at < ? AND NOT ${IN_FLIGHT_SQL}) AS n`).get(cutoff, inFlightCutoff).n === 1,
            presence: hasStalePresence(work, presenceParams),
            purgeable: purges.some(([file, ownOnly]) => archiveHasPurgeableRows(work, file, Date.now(), ownOnly)),
            owed: work.prepare(`SELECT EXISTS (SELECT 1 FROM agent_message_expiries WHERE ${NOTICE_OWED_SQL}) AS n`).get().n === 1,
        });
        const idle = (m) => !m.deletable && !m.presence && !m.purgeable && !m.owed;
        const idleOutcome = () => (work.prepare('SELECT EXISTS (SELECT 1 FROM agent_messages WHERE created_at < ?) AS n').get(cutoff).n === 1 ? 'deferred_in_flight' : 'nothing_expired');
        let seen = measure();
        if (idle(seen)) {
            interruptDeadRuns(work, holder);
            return finish(idleOutcome());
        }
        if (seen.deletable && archiveFile === null) {
            return finish('archive_unavailable', 'the database has no file path, so there is nowhere to archive to and nothing was deleted');
        }
        try {
            probeWritable(work);
        }
        catch (error) {
            if (isBusy(error))
                return finish('database_busy', `the database was locked by another process, so nothing was deleted this time (${errorText(error)})`);
            return finish('read_only', `the database cannot be written, so nothing was archived or deleted (${errorText(error)})`);
        }
        const held = acquireLease(work, holder);
        if (held !== null)
            return finish('skipped_concurrent', `another process is running the pass (its lease runs until ${new Date(held).toISOString()})`);
        holdsLease = true;
        interruptDeadRuns(work, holder);
        seen = measure();
        if (idle(seen))
            return finish(idleOutcome());
        startedRunId = beginRun(work, startedAtMs, options.trigger, seen.deletable ? archiveFile : null);
        const notes = [];
        let purgeFailed = false;
        for (const [file, ownOnly] of purges) {
            try {
                const purged = await purgeArchive(work, file, holder, ownOnly);
                if (purged > 0)
                    notes.push(`removed ${purged} archived message(s) past their extra day${ownOnly ? ` from ${file}, the archive an earlier MeMesh shared between databases` : ''}`);
            }
            catch (error) {
                if (isBusy(error))
                    throw error;
                purgeFailed = true;
                notes.push(`could not remove archive rows older than a day (${file}: ${errorText(error)}); they stay until the next pass`);
            }
        }
        let archiveFailure = null;
        if (seen.deletable && archiveFile !== null) {
            for (let batch = 1; batch <= MAX_BATCHES_PER_PASS; batch++) {
                const rows = selectBatch(work, cutoff, inFlightCutoff);
                if (rows.length === 0)
                    break;
                try {
                    archiveRows(work, archiveFile, rows.map((row) => row.message_id), batch, options);
                }
                catch (error) {
                    if (isBusy(error))
                        throw error;
                    archiveFailure = `could not archive the rows of ${rows.length} message(s) before deleting them (${archiveFile}: ${errorText(error)}); nothing in this batch was deleted`;
                    break;
                }
                work.transaction(() => {
                    renewLease(work, holder);
                    deleteBatch(work, rows, tally);
                    saveRunProgress(work, startedRunId, tally, archiveFile);
                }).immediate();
                await options.fault?.afterBatch?.(batch);
                await yieldTurn();
            }
        }
        if (tally.unreadableTimes > 0)
            notes.push(`${tally.unreadableTimes} message(s) had a creation time that cannot be read; readers already treated them as past their day, so they were archived and deleted`);
        const written = work.transaction(() => {
            renewLease(work, holder);
            const counts = writeOwedNotices(work);
            saveRunProgress(work, startedRunId, { ...tally, notices: tally.notices + counts.notices }, archiveFile);
            return counts;
        }).immediate();
        tally.notices += written.notices;
        tally.unaddressable += written.unaddressable;
        if (tally.unaddressable > 0)
            notes.push(`${tally.unaddressable} sender(s) could not be addressed, so no notice was written for them`);
        work.transaction(() => {
            renewLease(work, holder);
            tally.presenceFacts = deletePresence(work, presenceParams, 'facts');
            tally.connections = deletePresence(work, presenceParams, 'connections');
        }).immediate();
        const remaining = work.prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE created_at < ?').get(cutoff).n;
        if (remaining > 0)
            notes.push(`${remaining} expired message(s) left for the next pass`);
        if (archiveFailure !== null)
            notes.unshift(archiveFailure);
        const detail = notes.length > 0 ? notes.join('; ') : null;
        const outcome = archiveFailure !== null ? 'archive_failed'
            : tally.expired > 0 ? 'deleted'
                : tally.presenceFacts + tally.connections > 0 ? 'presence_cleared'
                    : seen.purgeable ? (purgeFailed ? 'failed' : 'archive_purged')
                        : tally.notices > 0 ? 'notices_sent'
                            : remaining > 0 ? 'deferred_in_flight' : 'nothing_expired';
        return finish(outcome, detail);
    }
    catch (error) {
        if (isBusy(error)) {
            return finish('database_busy', `the database was locked by another process, so the pass stopped here; every batch it finished is kept and the next pass does the rest (${errorText(error)})`);
        }
        return finish('failed', errorText(error));
    }
    finally {
        options.signal?.removeEventListener('abort', stop);
        if (pass !== null && !stopped) {
            if (holdsLease)
                releaseLease(pass, holder);
            if (pass !== db)
                closeQuietly(pass);
        }
    }
}
function openPassConnection(file) {
    const pass = new MemeshDatabase(file);
    pass.pragma(`busy_timeout = ${LOCK_WAIT_MS}`);
    return pass;
}
function closeQuietly(db) {
    try {
        db.close();
    }
    catch { }
}
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
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
    let running = null;
    const tick = () => {
        const db = getDb();
        if (!db || running)
            return;
        const current = new AbortController();
        running = current;
        void runAgentMessageExpiryIfDue(db, { trigger: options.trigger, signal: current.signal }).finally(() => { running = null; });
    };
    const first = setTimeout(tick, options.firstRunDelayMs ?? 1_000);
    const every = setInterval(tick, options.intervalMs ?? AGENT_MESSAGE_EXPIRY_INTERVAL_MS);
    first.unref();
    every.unref();
    return () => {
        clearTimeout(first);
        clearInterval(every);
        running?.abort();
        recordLatePasses(getDb());
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
        const messages = readArchive(db, file, (archive, hasLog) => (hasLog ? archive.prepare('SELECT COUNT(*) AS n FROM archive_log').get().n : 0));
        if (messages === undefined)
            return { kind: 'missing' };
        try {
            fs.accessSync(file, fs.constants.W_OK);
        }
        catch {
            return { kind: 'unusable', reason: 'this user cannot write it' };
        }
        return { kind: 'held', messages };
    }
    catch (error) {
        if (isBusy(error))
            return { kind: 'busy' };
        const code = error.syscall === undefined ? undefined : error.code;
        return { kind: 'unusable', reason: code === undefined ? errorText(error) : `it cannot be read (${code})` };
    }
}
function readArchive(db, file, read) {
    if (fs.lstatSync(file, { throwIfNoEntry: false }) === undefined)
        return undefined;
    refuseUnsafeArchive(db, file);
    const archive = new DatabaseSync(file, { readOnly: true });
    try {
        const hasLog = archive.prepare("SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'archive_log') AS n").get().n === 1;
        return read(archive, hasLog);
    }
    finally {
        archive.close();
    }
}
function selectBatch(db, cutoff, inFlightCutoff) {
    return db.prepare(`
    SELECT m.message_id, m.project, m.sender, m.recipient, m.created_at,
           CASE WHEN json_valid(m.provenance_json)
                THEN COALESCE(json_extract(m.provenance_json, '$.transport') = '${AGENT_MESSAGE_EXPIRY_TRANSPORT}', 0)
                ELSE 0 END AS is_notice,
           ${WAS_READ_SQL} AS was_read,
           CASE WHEN json_valid(m.provenance_json) THEN json_extract(m.provenance_json, '$.fallback_of_message_id') END AS fallback_of
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
    const copies = new Map(rows.filter((row) => row.fallback_of !== null).map((row) => [row.fallback_of, row]));
    const copied = db.prepare(`UPDATE agent_message_expiries SET notice_message_id = '${NO_NOTICE}', was_read = MAX(was_read, ?) WHERE message_id = ? AND notice_message_id IS NULL`);
    const now = Date.now();
    for (const row of rows) {
        const copy = copies.get(row.message_id);
        const wasRead = row.was_read !== 0 || (copy !== undefined && copy.was_read !== 0);
        const unread = !wasRead && row.is_notice === 0;
        const owesNotice = unread && copy === undefined;
        const sent = owesNotice ? delivery.get(row.message_id) : undefined;
        const network = sent ? networkDeliveryOf(db, sent) : null;
        const told = network !== null && bridgeTold.get(row.message_id) !== undefined;
        remember.run(row.message_id, row.project, row.created_at, now, wasRead ? 1 : 0, told || copy !== undefined ? NO_NOTICE : null, row.sender, row.recipient, network ? JSON.stringify(network) : null);
        if (unread)
            tally.unread += 1;
        if (row.fallback_of !== null)
            copied.run(row.was_read !== 0 ? 1 : 0, row.fallback_of);
        if (Number.isNaN(Date.parse(sqliteUtcToIso(row.created_at))))
            tally.unreadableTimes += 1;
    }
    const deleted = db.prepare('DELETE FROM agent_messages WHERE message_id IN (SELECT value FROM json_each(?))').run(JSON.stringify(rows.map((row) => row.message_id)));
    if (Number(deleted.changes) !== rows.length) {
        throw new Error(`expected to delete ${rows.length} message(s), deleted ${deleted.changes}; nothing in this batch was kept`);
    }
    tally.expired += rows.length;
}
function writeOwedNotices(db) {
    const written = { notices: 0, unaddressable: 0 };
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
            written.unaddressable += 1;
        else
            written.notices += 1;
        mark.run(noticeId ?? NO_NOTICE, JSON.stringify(group.map((row) => row.message_id)));
    }
    return written;
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
  `).run(tally.expired, tally.unread, tally.notices, tally.expired > 0 ? archiveFile : null, runId);
}
function archiveLocation(databasePath) {
    if (databasePath === '')
        return null;
    const base = path.basename(databasePath);
    return path.join(path.dirname(databasePath), 'backups', base === DEFAULT_DB_FILE ? AGENT_MESSAGE_ARCHIVE_FILE : `agent-messages-expired-${base}`);
}
function sharedArchive(archive) {
    return path.basename(archive) === AGENT_MESSAGE_ARCHIVE_FILE ? null : path.join(path.dirname(archive), AGENT_MESSAGE_ARCHIVE_FILE);
}
const SQLITE_HEADER = 'SQLite format 3\u0000';
function refuseUnsafeArchive(db, file) {
    const link = fs.lstatSync(file, { throwIfNoEntry: false });
    if (link === undefined)
        return;
    if (link.isSymbolicLink()) {
        throw new Error(`${file} is a symlink; MeMesh never reads or writes its archive through a symlink, wherever it points, and leaves it as it is (move it away)`);
    }
    if (!link.isFile())
        throw new Error(`${file} is not a plain file`);
    const main = databaseFile(db);
    const mainStat = main === '' ? undefined : fs.statSync(main, { throwIfNoEntry: false });
    if (mainStat && mainStat.dev === link.dev && mainStat.ino === link.ino) {
        throw new Error(`${file} is the database itself, so it cannot hold a copy of what is deleted from it`);
    }
    if (link.size > 0) {
        const head = Buffer.alloc(SQLITE_HEADER.length);
        const fd = fs.openSync(file, 'r');
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
function archiveHasPurgeableRows(db, file, nowMs, ownOnly) {
    try {
        return readArchive(db, file, (archive, hasLog) => {
            if (!hasLog)
                return false;
            if (ownOnly)
                archive.prepare('ATTACH DATABASE ? AS live').run(databaseFile(db));
            return archive.prepare(`SELECT EXISTS (SELECT 1 FROM archive_log WHERE archived_at_ms < ?${ownOnly ? ' AND message_id IN (SELECT message_id FROM live.agent_message_expiries)' : ''}) AS n`)
                .get(nowMs - AGENT_MESSAGE_TTL_MS).n === 1;
        }) ?? false;
    }
    catch {
        return false;
    }
}
async function purgeArchive(db, file, holder, ownOnly) {
    let purged = 0;
    for (;;) {
        if (fs.lstatSync(file, { throwIfNoEntry: false }) === undefined)
            return purged;
        attachArchive(db, file);
        let removed;
        try {
            removed = db.transaction(() => {
                renewLease(db, holder);
                const batch = db.prepare(`
          SELECT message_id FROM ${ARCHIVE}.archive_log WHERE archived_at_ms < ?
          ${ownOnly ? 'AND message_id IN (SELECT message_id FROM main.agent_message_expiries)' : ''} LIMIT ?
        `).all(Date.now() - AGENT_MESSAGE_TTL_MS, BATCH_SIZE).map((row) => row.message_id);
                const ids = JSON.stringify(batch);
                for (const table of [...ARCHIVED_TABLES].reverse()) {
                    db.prepare(`DELETE FROM ${ARCHIVE}.${table.name} WHERE ${where(ARCHIVE, table.by)}`).run(ids);
                }
                db.prepare(`DELETE FROM ${ARCHIVE}.archive_log WHERE message_id IN (SELECT value FROM json_each(?))`).run(ids);
                return batch.length;
            }).immediate();
            if (removed > 0)
                db.exec(`PRAGMA ${ARCHIVE}.incremental_vacuum`);
        }
        finally {
            db.exec(`DETACH DATABASE ${ARCHIVE}`);
        }
        if (removed === 0)
            return purged;
        purged += removed;
        await yieldTurn();
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
        if (row && row.expires_at_ms > now && !abandonedLeases.has(row.holder))
            return row.expires_at_ms;
        if (row)
            abandonedLeases.delete(row.holder);
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
        if (isBusy(error))
            abandonedLeases.add(holder);
        reportProblem(`could not release the expiry lease (${errorText(error)}); it runs out on its own`);
    }
}
function presenceBindings(cutoff, clockMs) {
    return {
        dead: { cutoff, dead_lease_ms: clockMs - AGENT_MESSAGE_TTL_MS },
        facts: { cutoff, dead_lease_ms: clockMs - AGENT_MESSAGE_TTL_MS, now_ms: clockMs },
    };
}
function hasStalePresence(db, bind) {
    return db.prepare(`
    SELECT EXISTS (SELECT 1 FROM agent_presence_facts WHERE ${STALE_FACTS_SQL}) OR EXISTS (${DEAD_CONNECTIONS_SQL}) AS n
  `).get(bind.facts).n === 1;
}
function deletePresence(db, bind, what) {
    if (what === 'connections') {
        return Number(db.prepare(`DELETE FROM agent_session_connections WHERE connection_id IN (${DEAD_CONNECTIONS_SQL})`).run(bind.dead).changes);
    }
    return Number(db.prepare(`DELETE FROM agent_presence_facts WHERE ${STALE_FACTS_SQL}`).run(bind.facts).changes);
}
function trimBookkeeping(db, nowMs) {
    db.prepare(`DELETE FROM agent_message_expiries WHERE expired_at_ms < ? AND (${NOTICE_OWED_SQL}) IS NOT 1`).run(nowMs - AGENT_MESSAGE_EXPIRED_ID_KEEP_MS);
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
        if (isBusy(error))
            throw error;
        reportProblem(`could not record that a pass started: ${errorText(error)}`);
        return null;
    }
}
function recordRun(pass, file, record) {
    const late = unrecorded.get(file) ?? [];
    try {
        if (pass === null)
            throw new Error('the database could not be opened');
        const runId = pass.transaction(() => {
            for (const missed of late)
                writeRun(pass, missed, true);
            return writeRun(pass, record, false);
        }).immediate();
        unrecorded.delete(file);
        return runId;
    }
    catch (error) {
        const { outcome, detail } = record.result;
        const ended = `pass ended ${outcome}${detail ? ` (${detail})` : ''}`;
        if (file !== '' && isBusy(error)) {
            unrecorded.set(file, [...late, record]);
            reportProblem(`${ended} and could not be recorded now (${errorText(error)}); the next pass that can write records it`);
        }
        else {
            reportProblem(`${ended} and could not be recorded: ${errorText(error)}`);
        }
        return null;
    }
}
function recordLatePasses(db) {
    let pass = null;
    try {
        const file = db === null ? '' : databaseFile(db);
        const late = unrecorded.get(file);
        if (file === '' || late === undefined)
            return;
        const work = pass = openPassConnection(file);
        work.transaction(() => { for (const missed of late)
            writeRun(work, missed, true); }).immediate();
        unrecorded.delete(file);
    }
    catch (error) {
        reportProblem(`a pass that met a lock could still not be recorded as the process stopped (${errorText(error)})`);
    }
    finally {
        if (pass !== null)
            closeQuietly(pass);
    }
}
function writeRun(db, record, late) {
    const { result } = record;
    const detail = late
        ? `recorded late: the database was locked by another process when this pass ended at ${new Date(record.endedAtMs).toISOString()}${result.detail ? `; ${result.detail}` : ''}`
        : result.detail;
    const values = [
        late ? record.endedAtMs : Date.now(), result.outcome, result.expired_message_count, result.unread_message_count,
        result.notice_count, result.presence_fact_count, result.connection_count, result.backup_path, detail,
    ];
    let runId = null;
    if (record.startedRunId !== null) {
        const updated = db.prepare(`
      UPDATE agent_message_expiry_runs
      SET finished_at_ms = ?, outcome = ?, expired_message_count = ?, unread_message_count = ?,
          notice_count = ?, presence_fact_count = ?, connection_count = ?, backup_path = ?, detail = ?
      WHERE run_id = ?
    `).run(...values, record.startedRunId);
        if (Number(updated.changes) === 1)
            runId = record.startedRunId;
    }
    if (runId === null) {
        runId = Number(db.prepare(`
      INSERT INTO agent_message_expiry_runs (
        started_at_ms, trigger_source, finished_at_ms, outcome, expired_message_count, unread_message_count,
        notice_count, presence_fact_count, connection_count, backup_path, detail
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.startedAtMs, record.trigger, ...values).lastInsertRowid);
    }
    trimBookkeeping(db, record.startedAtMs);
    trimRunLog(db);
    return runId;
}
function trimRunLog(db) {
    db.prepare(`
    DELETE FROM agent_message_expiry_runs
    WHERE run_id <= (SELECT run_id FROM agent_message_expiry_runs ORDER BY run_id DESC LIMIT 1 OFFSET ?)
  `).run(RUN_LOG_KEEP);
}
function interruptDeadRuns(db, holder) {
    try {
        db.prepare(`
      UPDATE agent_message_expiry_runs
      SET outcome = 'interrupted', detail = 'the process stopped before this pass finished'
      WHERE outcome = 'started'
        AND NOT EXISTS (SELECT 1 FROM agent_message_expiry_lease WHERE expires_at_ms > ? AND holder <> ?)
    `).run(Date.now(), holder);
    }
    catch (error) {
        if (isBusy(error))
            throw error;
        reportProblem(`could not close a pass that never finished: ${errorText(error)}`);
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