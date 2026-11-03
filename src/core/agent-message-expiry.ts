// =============================================================================
// One-day expiry of agent messages
// =============================================================================
//
// The rule: a message, read or unread, is kept at most one day from creation
// (agent-message-ttl.ts), then the whole row is deleted. If its recipient
// recorded nothing and did not reply, its sender is told.
//
// This module is the pass that deletes. It runs without anyone asking:
// `startAgentMessageExpiryScheduler` is started by the router daemon, the MCP
// server and `memesh serve`, the long-lived processes a real install runs.
// Readers do not wait for the pass: poll, fetch, receipts, the hooks' unread
// count and the router's drain all treat a message past its day as gone
// already, so what the pass changes is the disk, not what anyone can see.
//
// What one pass does, in order:
//   1. Measure. Nothing to do -> record that and return.
//   2. Take the lease (one process at a time). Mark any run left "started" by
//      a process that died as interrupted.
//   3. In batches of BATCH_SIZE: copy the batch's rows (the message and
//      everything that is deleted with it) into the archive file, commit that,
//      check the archive holds them, and only then, in one transaction on the
//      main database, write the notices, remember the ids and delete the
//      messages. Foreign keys cascade to deliveries, events, idempotency keys,
//      receipts, retention facts, dispatch attempts, host accepts, acks and
//      workflow facts. The archive and the main database are two files, so
//      their commits are separate steps, in that order: a crash between them
//      leaves rows in both, and the next pass copies them again harmlessly
//      (INSERT OR IGNORE).
//   4. Remove archive rows that were archived more than one day ago. So a
//      message's content exists for about two days: one as a message, one in
//      the archive.
//   5. Delete presence facts and session connections that are old and no
//      longer live.
// Every pass, and every early return, leaves one row in
// `agent_message_expiry_runs`, which `memesh doctor` reads.
//
// Left alone on purpose: `agent_message_cursors` (a client may still hold the
// token; the cursor is a sequence number and keeps working after the events it
// pointed at are gone) and `agent_session_instances` / `agent_principals`
// (they answer "is this recipient known", and are one small row per session).

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MemeshDatabase } from '../storage/sqlite.js';
import { AGENT_MESSAGE_TTL_MS, agentMessageExpiryCutoff } from './agent-message-ttl.js';
import { AgentMessagingError, sendAgentMessage } from './agent-messaging.js';
import { sqliteUtcToIso } from './time-utils.js';

/** A pass is due when the last one started this long ago or more. */
export const AGENT_MESSAGE_EXPIRY_INTERVAL_MS = 5 * 60 * 1000;
/** How long the id of a deleted message is remembered, for a clear answer to a late read or reply. */
export const AGENT_MESSAGE_EXPIRED_ID_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** The archive of deleted messages, in `backups/` beside the database. */
export const AGENT_MESSAGE_ARCHIVE_FILE = 'agent-messages-expired.db';

const RUN_LOG_KEEP = 500;
/** How long one process may hold the right to run a pass; renewed with every batch. */
const LEASE_MS = 3 * 60 * 1000;
const BATCH_SIZE = 100;
const MAX_BATCHES_PER_PASS = 200;
/** A dispatch started this recently may still be in flight; its message waits for the next pass. */
const IN_FLIGHT_GRACE_MS = 10 * 60 * 1000;
const NOTICE_LIST_MAX = 20;
const ARCHIVE = 'expiry_archive';

/** The sender of an expiry notice, and the `provenance.transport` that marks one. */
export const AGENT_MESSAGE_EXPIRY_NOTICE_SENDER = 'memesh';
export const AGENT_MESSAGE_EXPIRY_TRANSPORT = 'expiry';

export type AgentMessageExpiryOutcome =
  | 'deleted'
  | 'presence_cleared'
  | 'archive_purged'
  | 'read_only'
  | 'database_busy'
  | 'skipped_concurrent'
  | 'nothing_expired'
  | 'deferred_in_flight'
  | 'archive_failed'
  | 'archive_unavailable'
  | 'no_message_tables'
  | 'failed';

export interface AgentMessageExpiryResult {
  run_id: number | null;
  outcome: AgentMessageExpiryOutcome;
  expired_message_count: number;
  unread_message_count: number;
  notice_count: number;
  presence_fact_count: number;
  connection_count: number;
  /** The archive the deleted rows went to (column `backup_path`); null when the pass deleted no message. */
  backup_path: string | null;
  detail: string | null;
}

export interface AgentMessageExpiryOptions {
  /** Who started the pass: 'router', 'mcp-server', 'test'... Recorded with the run. */
  trigger: string;
  /** The clock for what has expired. The run's own start time is always the real clock. */
  nowMs?: number;
  /** The database file, when the handle cannot say (an in-memory handle). */
  databasePath?: string;
  /** Where the archive goes. Default: `backups/` beside the database. */
  backupDir?: string;
  /** Test seams. */
  fault?: {
    /** Runs after a batch is archived and committed, before the archive is checked. */
    beforeArchiveCheck?(archivePath: string, batch: number): void;
    /** Runs after each committed batch; `batch` counts from 1. */
    afterBatch?(batch: number): void | Promise<void>;
  };
}

interface Tally {
  expired: number;
  unread: number;
  notices: number;
  unaddressable: number;
  presenceFacts: number;
  connections: number;
}

interface ExpiredRow {
  message_id: string;
  project: string;
  sender: string;
  recipient: string;
  created_at: string;
  is_notice: number;
  was_read: number;
}

/** What one sender is told, built up over the batches of one pass. */
interface NoticeState {
  /** The notice message; null when the sender is not an address a message can go to. */
  noticeId: string | null;
  count: number;
  listed: Array<{ message_id: string; recipient: string; created_at: string; expired_at: string }>;
}

// "Read" is the recipient having done something with it: recorded intake,
// acknowledged it, answered it (a reply points at it), or a workflow fact. A
// host accepting a push is not reading.
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

// A connection is dead when it ended (or its lease ran out with no goodbye) more
// than a day ago, and no dispatch attempt that is still kept points at it.
const DEAD_CONNECTIONS_SQL = `
  SELECT c.connection_id FROM agent_session_connections c
  WHERE ((c.disconnected_at IS NOT NULL AND julianday(c.disconnected_at) < julianday(:cutoff))
      OR (c.disconnected_at IS NULL AND c.lease_expires_at_ms < :dead_lease_ms))
    AND NOT EXISTS (SELECT 1 FROM agent_dispatch_attempts a WHERE a.connection_id = c.connection_id)`;

const LIVE_CONNECTIONS_SQL = `
  SELECT c.connection_id FROM agent_session_connections c
  WHERE c.disconnected_at IS NULL AND c.lease_expires_at_ms > :now_ms`;

// Every table a message delete cascades through, with the column that is unique
// in it and how its rows are found from a list of message ids. Order: parents first.
const ARCHIVED_TABLES: ReadonlyArray<{ name: string; unique: string; by: 'message' | 'delivery' }> = [
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

/**
 * One pass. It gives the event loop a turn between batches, so a server that
 * runs it keeps answering requests while a large backlog is worked off. Tests
 * and other callers await it.
 */
export async function runAgentMessageExpiry(db: MemeshDatabase, options: AgentMessageExpiryOptions): Promise<AgentMessageExpiryResult> {
  const startedAtMs = Date.now();
  const clockMs = options.nowMs ?? startedAtMs;
  const tally: Tally = { expired: 0, unread: 0, notices: 0, unaddressable: 0, presenceFacts: 0, connections: 0 };
  let archivePath: string | null = null;
  const holder = randomUUID();
  let holdsLease = false;
  let startedRunId: number | null = null;

  const finish = (outcome: AgentMessageExpiryOutcome, detail: string | null = null): AgentMessageExpiryResult => {
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
    if (!tablesExist(db)) return finish('no_message_tables', 'agent_messages, agent_message_expiry_runs, agent_message_expiries or agent_message_expiry_lease is missing');

    const cutoff = agentMessageExpiryCutoff(clockMs);
    const inFlightCutoff = new Date(clockMs - IN_FLIGHT_GRACE_MS).toISOString();
    const presenceParams = presenceBindings(cutoff, clockMs);
    const archiveFile = archiveLocation(db, options);
    const measure = (): { expired: number; deletable: number; presence: number; purgeable: number } => ({
      expired: (db.prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE created_at < ?').get(cutoff) as { n: number }).n,
      deletable: (db.prepare(
        `SELECT COUNT(*) AS n FROM agent_messages m WHERE m.created_at < ? AND NOT ${IN_FLIGHT_SQL}`,
      ).get(cutoff, inFlightCutoff) as { n: number }).n,
      presence: countStalePresence(db, presenceParams),
      purgeable: archiveFile === null ? 0 : countPurgeableArchiveMessages(db, archiveFile, Date.now()),
    });
    type Seen = ReturnType<typeof measure>;
    const idle = (m: Seen): boolean => m.deletable === 0 && m.presence === 0 && m.purgeable === 0;
    const idleOutcome = (m: Seen): AgentMessageExpiryOutcome => (m.expired > 0 ? 'deferred_in_flight' : 'nothing_expired');

    let seen = measure();
    if (idle(seen)) {
      interruptDeadRuns(db);
      return finish(idleOutcome(seen));
    }
    if (seen.deletable > 0 && archiveFile === null) {
      return finish('archive_unavailable', 'the database has no file path and no archive directory was given, so nothing was deleted');
    }

    // A database that cannot be written would otherwise do half a pass and
    // fail. Find out first, and tell "locked right now" from "cannot be written".
    try {
      probeWritable(db);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isBusy(error)) return finish('database_busy', `the database was locked by another process, so nothing was deleted this time (${message})`);
      return finish('read_only', `the database cannot be written, so nothing was archived or deleted (${message})`);
    }

    // One process at a time. A pass that finds the lease held by another
    // process records that and stops; a lease whose holder died runs out and
    // is taken over.
    const held = acquireLease(db, holder);
    if (held !== null) return finish('skipped_concurrent', `another process is running the pass (its lease runs until ${new Date(held).toISOString()})`);
    holdsLease = true;
    // A row still "started" belongs to a process that died: the lease is ours,
    // so nobody else is running. Its counts (kept up to the last batch) stay.
    db.prepare("UPDATE agent_message_expiry_runs SET outcome = 'interrupted', detail = 'the process stopped before this pass finished' WHERE outcome = 'started'").run();

    // The other process may have finished while this one waited to ask.
    seen = measure();
    if (idle(seen)) return finish(idleOutcome(seen));

    // The run is written down before anything is archived or deleted, and its
    // counts follow every batch, so a process killed half way leaves a row that
    // says what it had done.
    startedRunId = beginRun(db, startedAtMs, options.trigger, seen.deletable > 0 ? archiveFile : null);
    archivePath = seen.deletable > 0 ? archiveFile : null;

    const notes: string[] = [];
    const notices = new Map<string, NoticeState>();
    if (seen.deletable > 0 && archiveFile !== null) {
      for (let batch = 1; batch <= MAX_BATCHES_PER_PASS; batch++) {
        const rows = selectBatch(db, cutoff, inFlightCutoff);
        if (rows.length === 0) break;
        try {
          archiveRows(db, archiveFile, rows.map((row) => row.message_id), batch, options);
        } catch (error) {
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
      if (tally.unaddressable > 0) notes.push(`${tally.unaddressable} sender(s) could not be addressed, so no notice was written for them`);
    }

    let purgeFailed = false;
    if (archiveFile !== null) {
      try {
        purgeArchive(db, archiveFile, Date.now());
      } catch (error) {
        purgeFailed = true;
        notes.push(`could not remove archive rows older than a day (${error instanceof Error ? error.message : String(error)}); they stay until the next pass`);
      }
    }

    db.transaction(() => {
      renewLease(db, holder);
      tally.presenceFacts = deletePresence(db, presenceParams, 'facts');
      tally.connections = deletePresence(db, presenceParams, 'connections');
    }).immediate();

    const remaining = (db.prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE created_at < ?').get(cutoff) as { n: number }).n;
    if (remaining > 0) notes.push(`${remaining} expired message(s) left for the next pass`);
    const detail = notes.length > 0 ? notes.join('; ') : null;
    const outcome = tally.expired > 0 ? 'deleted'
      : tally.presenceFacts + tally.connections > 0 ? 'presence_cleared'
        : seen.purgeable > 0 ? (purgeFailed ? 'failed' : 'archive_purged')
          : remaining > 0 ? 'deferred_in_flight' : 'nothing_expired';
    return finish(outcome, detail);
  } catch (error) {
    return finish('failed', error instanceof Error ? error.message : String(error));
  } finally {
    if (holdsLease) releaseLease(db, holder);
  }
}

/**
 * Runs a pass when the last one is at least one interval old. Never throws: a
 * caller on a timer must not fail because of housekeeping. "Not due" is the
 * schedule itself and leaves no row; every pass that starts does.
 */
export async function runAgentMessageExpiryIfDue(
  db: MemeshDatabase,
  options: AgentMessageExpiryOptions,
): Promise<AgentMessageExpiryResult | null> {
  try {
    const startedAtMs = Date.now();
    // A row still "started" belongs to a pass that is running (then the lease stops this one) or died (then its
    // dead row must not hold the next pass off); neither is a reason to wait.
    const last = db.prepare("SELECT MAX(started_at_ms) AS at FROM agent_message_expiry_runs WHERE outcome <> 'started'").get() as { at: number | null } | undefined;
    // A last pass that "started" in the future means the clock was set back: that is not a reason to wait either.
    if (last?.at != null && last.at <= startedAtMs && startedAtMs - last.at < AGENT_MESSAGE_EXPIRY_INTERVAL_MS) return null;
    return await runAgentMessageExpiry(db, options);
  } catch (error) {
    reportProblem(`could not check whether a pass is due: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Runs a pass shortly after start, then every interval, until the returned
 * function is called. The timers never keep the process alive, and a tick that
 * arrives while the previous pass is still working does nothing.
 */
export function startAgentMessageExpiryScheduler(
  getDb: () => MemeshDatabase | null,
  options: { trigger: string; intervalMs?: number; firstRunDelayMs?: number },
): () => void {
  let running = false;
  const tick = (): void => {
    const db = getDb();
    if (!db || running) return;
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

/** The most recent pass that finished (or failed), for `memesh doctor`; a skipped_concurrent or still-started row is not one. */
export function lastAgentMessageExpiryRun(db: MemeshDatabase): (AgentMessageExpiryResult & { started_at_ms: number; finished_at_ms: number; trigger_source: string }) | null {
  try {
    const row = db.prepare(`
      SELECT run_id, started_at_ms, finished_at_ms, trigger_source, outcome, expired_message_count,
             unread_message_count, notice_count, presence_fact_count, connection_count, backup_path, detail
      FROM agent_message_expiry_runs WHERE outcome NOT IN ('skipped_concurrent', 'started') ORDER BY run_id DESC LIMIT 1
    `).get() as (AgentMessageExpiryResult & { started_at_ms: number; finished_at_ms: number; trigger_source: string }) | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/** The archive the newest run that deleted messages wrote to, for `memesh doctor`; null when none. The file may be gone. */
export function latestAgentMessageExpiryArchive(db: MemeshDatabase): string | null {
  try {
    const row = db.prepare(
      'SELECT backup_path FROM agent_message_expiry_runs WHERE backup_path IS NOT NULL ORDER BY run_id DESC LIMIT 1',
    ).get() as { backup_path: string } | undefined;
    return row?.backup_path ?? null;
  } catch {
    return null;
  }
}

/** The next batch of expired messages, oldest first. */
function selectBatch(db: MemeshDatabase, cutoff: string, inFlightCutoff: string): ExpiredRow[] {
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
  `).all(cutoff, inFlightCutoff, BATCH_SIZE) as unknown as ExpiredRow[];
}

/**
 * Deletes one batch, in the transaction the caller opened: the notices (one
 * per project and sender for the whole pass; a later batch of the same sender
 * updates it), the remembered ids, the messages.
 */
function deleteBatch(db: MemeshDatabase, rows: ExpiredRow[], notices: Map<string, NoticeState>, tally: Tally): void {
  const noticeFor = new Map<string, string>();
  const touched = new Map<string, ExpiredRow[]>();
  for (const row of rows) {
    // A notice that expires unread does not produce another notice.
    if (row.was_read !== 0 || row.is_notice !== 0) continue;
    const key = `${row.project}\u0000${row.sender}`;
    const list = touched.get(key);
    if (list) list.push(row); else touched.set(key, [row]);
  }
  for (const [key, group] of touched) {
    const state = notices.get(key) ?? { noticeId: null, count: 0, listed: [] };
    const known = notices.has(key);
    state.count += group.length;
    for (const row of group) {
      if (state.listed.length >= NOTICE_LIST_MAX) break;
      const createdAt = sqliteUtcToIso(row.created_at);
      state.listed.push({
        message_id: row.message_id,
        recipient: row.recipient,
        created_at: createdAt,
        expired_at: new Date(Date.parse(createdAt) + AGENT_MESSAGE_TTL_MS).toISOString(),
      });
    }
    if (!known) state.noticeId = writeNotice(db, group[0], state);
    else if (state.noticeId !== null) updateNotice(db, state);
    notices.set(key, state);
    if (state.noticeId !== null) for (const row of group) noticeFor.set(row.message_id, state.noticeId);
  }

  const remember = db.prepare(`
    INSERT OR REPLACE INTO agent_message_expiries
      (message_id, project, created_at, expired_at_ms, was_read, notice_message_id, sender, recipient)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  for (const row of rows) {
    remember.run(row.message_id, row.project, row.created_at, now, row.was_read !== 0 ? 1 : 0, noticeFor.get(row.message_id) ?? null, row.sender, row.recipient);
    if (row.was_read === 0 && row.is_notice === 0) tally.unread += 1;
  }
  const deleted = db.prepare(
    'DELETE FROM agent_messages WHERE message_id IN (SELECT value FROM json_each(?))',
  ).run(JSON.stringify(rows.map((row) => row.message_id)));
  if (Number(deleted.changes) !== rows.length) {
    throw new Error(`expected to delete ${rows.length} message(s), deleted ${deleted.changes}; nothing in this batch was kept`);
  }
  tally.expired += rows.length;
}

function noticePayload(state: NoticeState) {
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

/** Writes the notice to the sender; null when the sender is not an address a message can go to. */
function writeNotice(db: MemeshDatabase, first: ExpiredRow, state: NoticeState): string | null {
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
  } catch (error) {
    // A sender that is not a valid address (a path, say) cannot be written to.
    // That is counted in the run; any other failure aborts the batch.
    if (error instanceof AgentMessagingError) return null;
    throw error;
  }
}

/** A later batch of the same pass adds to the notice already written. */
function updateNotice(db: MemeshDatabase, state: NoticeState): void {
  db.prepare('UPDATE agent_messages SET payload_json = ? WHERE message_id = ?').run(JSON.stringify(noticePayload(state)), state.noticeId);
}

function saveRunProgress(db: MemeshDatabase, runId: number | null, tally: Tally, archiveFile: string): void {
  if (runId === null) return;
  db.prepare(`
    UPDATE agent_message_expiry_runs
    SET expired_message_count = ?, unread_message_count = ?, backup_path = ?
    WHERE run_id = ?
  `).run(tally.expired, tally.unread, archiveFile, runId);
}

// ---------------------------------------------------------------------------
// The archive
// ---------------------------------------------------------------------------

/** Where the archive is, or null when the database has no file and no directory was given. */
function archiveLocation(db: MemeshDatabase, options: AgentMessageExpiryOptions): string | null {
  const databasePath = options.databasePath ?? databaseFile(db);
  const directory = options.backupDir ?? (databasePath ? path.join(path.dirname(databasePath), 'backups') : null);
  return directory === null ? null : path.join(directory, AGENT_MESSAGE_ARCHIVE_FILE);
}

/** The main database's file; '' for an in-memory one. (`db.location()` needs Node 24.) */
export function databaseFile(db: MemeshDatabase): string {
  const row = db.prepare("SELECT file FROM pragma_database_list WHERE name = 'main'").get() as { file?: string } | undefined;
  return row?.file ?? '';
}

function where(schema: string, by: 'message' | 'delivery'): string {
  return by === 'message'
    ? 'message_id IN (SELECT value FROM json_each(?))'
    : `delivery_id IN (SELECT delivery_id FROM ${schema}.agent_message_deliveries WHERE message_id IN (SELECT value FROM json_each(?)))`;
}

/**
 * Attaches the archive (creating it, owner-only, when new) and makes sure it
 * has a table for everything a message delete cascades through, plus the log
 * of when each message was archived. The tables copy the columns of the live
 * ones without their constraints; a column a newer MeMesh added is added here.
 */
function attachArchive(db: MemeshDatabase, file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fresh = !fs.existsSync(file);
  if (fresh) fs.closeSync(fs.openSync(file, 'a', 0o600));
  fs.chmodSync(file, 0o600);
  db.prepare(`ATTACH DATABASE ? AS ${ARCHIVE}`).run(file);
  try {
    // Must come before the first table: the archive gives its pages back when rows are removed.
    if (fresh) db.exec(`PRAGMA ${ARCHIVE}.auto_vacuum = INCREMENTAL`);
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
  } catch (error) {
    db.exec(`DETACH DATABASE ${ARCHIVE}`);
    throw error;
  }
}

function columnNames(db: MemeshDatabase, schema: string, table: string): string[] {
  return (db.prepare(`SELECT name FROM pragma_table_info('${table}', '${schema}')`).all() as Array<{ name: string }>).map((row) => row.name);
}

/**
 * Copies one batch's rows into the archive and commits that, then checks every
 * table of the archive holds at least the rows the database holds for the batch.
 * Throws, and the batch is not deleted, when it does not.
 */
function archiveRows(db: MemeshDatabase, file: string, messageIds: string[], batch: number, options: AgentMessageExpiryOptions): void {
  const ids = JSON.stringify(messageIds);
  attachArchive(db, file);
  try {
    // A plain (deferred) transaction: only the archive file is written, so the
    // main database's write lock is not taken.
    db.transaction(() => {
      for (const table of ARCHIVED_TABLES) {
        db.prepare(`INSERT OR IGNORE INTO ${ARCHIVE}.${table.name} SELECT * FROM main.${table.name} WHERE ${where('main', table.by)}`).run(ids);
      }
      db.prepare(`INSERT OR IGNORE INTO ${ARCHIVE}.archive_log (message_id, archived_at_ms) SELECT value, ? FROM json_each(?)`)
        .run(Date.now(), ids);
    })();
    options.fault?.beforeArchiveCheck?.(file, batch);
    for (const table of ARCHIVED_TABLES) {
      const source = (db.prepare(`SELECT COUNT(*) AS n FROM main.${table.name} WHERE ${where('main', table.by)}`).get(ids) as { n: number }).n;
      const archived = (db.prepare(`SELECT COUNT(*) AS n FROM ${ARCHIVE}.${table.name} WHERE ${where(ARCHIVE, table.by)}`).get(ids) as { n: number }).n;
      if (archived < source) throw new Error(`the archive holds ${archived} ${table.name} row(s) of this batch, the database ${source}`);
    }
  } finally {
    db.exec(`DETACH DATABASE ${ARCHIVE}`);
  }
}

/** How many archived messages are past their extra day. 0 when there is no archive file. */
function countPurgeableArchiveMessages(db: MemeshDatabase, file: string, nowMs: number): number {
  if (!fs.existsSync(file)) return 0;
  db.prepare(`ATTACH DATABASE ? AS ${ARCHIVE}`).run(file);
  try {
    const hasLog = (db.prepare(`SELECT COUNT(*) AS n FROM ${ARCHIVE}.sqlite_master WHERE type = 'table' AND name = 'archive_log'`).get() as { n: number }).n;
    if (hasLog === 0) return 0;
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${ARCHIVE}.archive_log WHERE archived_at_ms < ?`).get(nowMs - AGENT_MESSAGE_TTL_MS) as { n: number }).n;
  } finally {
    db.exec(`DETACH DATABASE ${ARCHIVE}`);
  }
}

/**
 * Removes what was archived more than one day ago, by the time recorded in the
 * archive (never by file name). Rows archived by this pass are newer, so are
 * never touched. Returns how many messages went.
 */
function purgeArchive(db: MemeshDatabase, file: string, nowMs: number): number {
  if (!fs.existsSync(file)) return 0;
  attachArchive(db, file);
  try {
    const cut = nowMs - AGENT_MESSAGE_TTL_MS;
    const old = `SELECT message_id FROM ${ARCHIVE}.archive_log WHERE archived_at_ms < ?`;
    const oldDeliveries = `SELECT delivery_id FROM ${ARCHIVE}.agent_message_deliveries WHERE message_id IN (${old})`;
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM (${old})`).get(cut) as { n: number }).n;
    if (count === 0) return 0;
    db.transaction(() => {
      for (const table of [...ARCHIVED_TABLES].reverse()) {
        const scope = table.by === 'message' ? `message_id IN (${old})` : `delivery_id IN (${oldDeliveries})`;
        db.prepare(`DELETE FROM ${ARCHIVE}.${table.name} WHERE ${scope}`).run(cut);
      }
      db.prepare(`DELETE FROM ${ARCHIVE}.archive_log WHERE archived_at_ms < ?`).run(cut);
    })();
    db.exec(`PRAGMA ${ARCHIVE}.incremental_vacuum`);
    return count;
  } finally {
    db.exec(`DETACH DATABASE ${ARCHIVE}`);
  }
}

// ---------------------------------------------------------------------------
// Writable probe, lease, presence, bookkeeping
// ---------------------------------------------------------------------------

/** Is this SQLITE_BUSY: the database is locked by someone else right now, not unwritable? */
function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return code === 5 || code === 6 || /database (table )?is locked|SQLITE_BUSY/i.test(error instanceof Error ? error.message : String(error));
}

/**
 * Throws when this handle cannot write. `BEGIN IMMEDIATE` is not enough: a
 * read-only handle takes it without complaint, and only the first write fails.
 * The probe writes one row and rolls it back.
 */
function probeWritable(db: MemeshDatabase): void {
  db.exec('SAVEPOINT expiry_probe');
  try {
    db.prepare(`
      INSERT INTO agent_message_expiry_runs (started_at_ms, finished_at_ms, trigger_source, outcome)
      VALUES (0, 0, 'probe', 'probe')
    `).run();
  } finally {
    db.exec('ROLLBACK TO expiry_probe');
    db.exec('RELEASE expiry_probe');
  }
}

/**
 * Takes the one row that says which process is running a pass. Returns null
 * when it is now this process's, or the time the other holder's right runs out.
 * A database row, not a file lock: it survives a killed process by expiring,
 * and means the same on every platform.
 */
function acquireLease(db: MemeshDatabase, holder: string): number | null {
  return db.transaction(() => {
    const now = Date.now();
    const row = db.prepare('SELECT holder, expires_at_ms FROM agent_message_expiry_lease WHERE lease_id = 1')
      .get() as { holder: string; expires_at_ms: number } | undefined;
    if (row && row.expires_at_ms > now) return row.expires_at_ms;
    db.prepare('INSERT OR REPLACE INTO agent_message_expiry_lease (lease_id, holder, expires_at_ms) VALUES (1, ?, ?)')
      .run(holder, now + LEASE_MS);
    return null;
  }).immediate();
}

/** Extends this process's lease; throws, so the batch it guards rolls back, when another process took it over. */
function renewLease(db: MemeshDatabase, holder: string): void {
  const renewed = db.prepare('UPDATE agent_message_expiry_lease SET expires_at_ms = ? WHERE lease_id = 1 AND holder = ?')
    .run(Date.now() + LEASE_MS, holder);
  if (Number(renewed.changes) !== 1) {
    throw new Error('another process took over the expiry lease; this pass stopped before deleting more');
  }
}

function releaseLease(db: MemeshDatabase, holder: string): void {
  try {
    db.prepare('DELETE FROM agent_message_expiry_lease WHERE lease_id = 1 AND holder = ?').run(holder);
  } catch (error) {
    // Not fatal: the lease runs out by itself. Say so, so a stuck "skipped_concurrent" has an explanation.
    reportProblem(`could not release the expiry lease (${error instanceof Error ? error.message : String(error)}); it runs out on its own`);
  }
}

// node:sqlite refuses a named parameter the statement does not use, so each
// statement gets exactly the names it mentions.
function presenceBindings(cutoff: string, clockMs: number) {
  return {
    dead: { cutoff, dead_lease_ms: clockMs - AGENT_MESSAGE_TTL_MS },
    facts: { cutoff, dead_lease_ms: clockMs - AGENT_MESSAGE_TTL_MS, now_ms: clockMs },
  };
}

type PresenceBindings = ReturnType<typeof presenceBindings>;

function countStalePresence(db: MemeshDatabase, bind: PresenceBindings): number {
  const facts = db.prepare(`
    SELECT COUNT(*) AS n FROM agent_presence_facts
    WHERE (julianday(created_at) < julianday(:cutoff) AND connection_id NOT IN (${LIVE_CONNECTIONS_SQL}))
       OR connection_id IN (${DEAD_CONNECTIONS_SQL})
  `).get(bind.facts) as { n: number };
  const connections = db.prepare(`SELECT COUNT(*) AS n FROM (${DEAD_CONNECTIONS_SQL})`).get(bind.dead) as { n: number };
  return facts.n + connections.n;
}

function deletePresence(db: MemeshDatabase, bind: PresenceBindings, what: 'facts' | 'connections'): number {
  if (what === 'connections') {
    return Number(db.prepare(`DELETE FROM agent_session_connections WHERE connection_id IN (${DEAD_CONNECTIONS_SQL})`).run(bind.dead).changes);
  }
  return Number(db.prepare(`
    DELETE FROM agent_presence_facts
    WHERE (julianday(created_at) < julianday(:cutoff) AND connection_id NOT IN (${LIVE_CONNECTIONS_SQL}))
       OR connection_id IN (${DEAD_CONNECTIONS_SQL})
  `).run(bind.facts).changes);
}

function trimBookkeeping(db: MemeshDatabase, nowMs: number): void {
  db.prepare('DELETE FROM agent_message_expiries WHERE expired_at_ms < ?').run(nowMs - AGENT_MESSAGE_EXPIRED_ID_KEEP_MS);
}

function tablesExist(db: MemeshDatabase): boolean {
  const found = db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('agent_messages', 'agent_message_expiry_runs', 'agent_message_expiries', 'agent_message_expiry_lease')",
  ).get() as { n: number };
  return found.n === 4;
}

/** Writes the row for a pass that is about to start working; finish updates it. Null when it cannot be written. */
function beginRun(db: MemeshDatabase, startedAtMs: number, trigger: string, archiveFile: string | null): number | null {
  try {
    const inserted = db.prepare(`
      INSERT INTO agent_message_expiry_runs (started_at_ms, finished_at_ms, trigger_source, outcome, backup_path)
      VALUES (?, ?, ?, 'started', ?)
    `).run(startedAtMs, startedAtMs, trigger, archiveFile);
    return Number(inserted.lastInsertRowid);
  } catch (error) {
    reportProblem(`could not record that a pass started: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function recordRun(
  db: MemeshDatabase,
  startedAtMs: number,
  trigger: string,
  result: Omit<AgentMessageExpiryResult, 'run_id'>,
  startedRunId: number | null,
): number | null {
  try {
    if (startedRunId !== null) {
      db.prepare(`
        UPDATE agent_message_expiry_runs
        SET finished_at_ms = ?, outcome = ?, expired_message_count = ?, unread_message_count = ?,
            notice_count = ?, presence_fact_count = ?, connection_count = ?, backup_path = ?, detail = ?
        WHERE run_id = ?
      `).run(
        Date.now(), result.outcome, result.expired_message_count, result.unread_message_count,
        result.notice_count, result.presence_fact_count, result.connection_count, result.backup_path, result.detail,
        startedRunId,
      );
      trimBookkeeping(db, startedAtMs);
      trimRunLog(db);
      return startedRunId;
    }
    const inserted = db.prepare(`
      INSERT INTO agent_message_expiry_runs (
        started_at_ms, finished_at_ms, trigger_source, outcome, expired_message_count, unread_message_count,
        notice_count, presence_fact_count, connection_count, backup_path, detail
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      startedAtMs, Date.now(), trigger, result.outcome, result.expired_message_count, result.unread_message_count,
      result.notice_count, result.presence_fact_count, result.connection_count, result.backup_path, result.detail,
    );
    trimBookkeeping(db, startedAtMs);
    trimRunLog(db);
    return Number(inserted.lastInsertRowid);
  } catch (error) {
    // The run cannot be recorded (a read-only database, a missing table): say so
    // where an operator can see it rather than lose it.
    reportProblem(`pass ended ${result.outcome}${result.detail ? ` (${result.detail})` : ''} and could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function trimRunLog(db: MemeshDatabase): void {
  db.prepare(`
    DELETE FROM agent_message_expiry_runs
    WHERE run_id <= (SELECT run_id FROM agent_message_expiry_runs ORDER BY run_id DESC LIMIT 1 OFFSET ?)
  `).run(RUN_LOG_KEEP);
}

/**
 * A run still "started" whose process is gone (no lease is held) is marked
 * interrupted, so a pass that finds nothing to do still closes it. Best effort:
 * a database that cannot be written is reported by the pass itself.
 */
function interruptDeadRuns(db: MemeshDatabase): void {
  try {
    db.prepare(`
      UPDATE agent_message_expiry_runs
      SET outcome = 'interrupted', detail = 'the process stopped before this pass finished'
      WHERE outcome = 'started'
        AND NOT EXISTS (SELECT 1 FROM agent_message_expiry_lease WHERE expires_at_ms > ?)
    `).run(Date.now());
  } catch (error) {
    reportProblem(`could not close a pass that never finished: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Lets the event loop run once. */
function yieldTurn(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function reportProblem(message: string): void {
  try { process.stderr.write(`MeMesh message expiry: ${message}\n`); } catch { /* stderr gone */ }
}
