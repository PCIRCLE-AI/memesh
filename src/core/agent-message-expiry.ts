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
//   3. Remove archive rows that were archived more than one day ago, in
//      batches. First, so a batch that cannot be archived (a full disk) does
//      not also stop the archive from shrinking.
//   4. In batches of BATCH_SIZE: copy the batch's rows (the message and
//      everything that is deleted with it) into the archive file, column by
//      name, commit that, check the archive holds them with the same content,
//      and only then, in one transaction on the main database, remember the
//      ids (an unread one with its notice still owed) and delete the messages.
//      An archive path that is a symlink (wherever it points), the database
//      itself or not a database is refused, and nothing is deleted. Foreign keys cascade
//      to deliveries, events, idempotency keys, receipts, retention facts,
//      dispatch attempts, host accepts, acks and workflow facts. The archive
//      and the main database are two files, so their commits are separate
//      steps, in that order: a crash between them leaves rows in both, and the
//      next pass copies them again, replacing the old copy and starting its
//      extra day again. So a message's content exists for about two days: one
//      as a message, at least one in the archive.
//   5. Write one notice per project and sender for every remembered id that
//      still owes one (this pass's, and any a stopped pass left), and mark
//      them. A notice is written once and never changed.
//   6. Delete presence facts and session connections that are old and no
//      longer live.
// Every pass that can write leaves one row in `agent_message_expiry_runs`,
// which `memesh doctor` reads. A pass works on a connection of its own that
// waits at most LOCK_WAIT_MS for another process's lock, so it never holds this
// process's event loop: a lock at any step ends the pass as database_busy,
// keeping every batch it committed. When even its row cannot be written, stderr
// says so and the next pass of this process that writes its own row writes that
// one too, marked late. A process that stops mid-pass closes its row as
// interrupted and gives the lease back on the spot (the `signal` option).
//
// Left alone on purpose: `agent_message_cursors` (a client may still hold the
// token; the cursor is a sequence number and keeps working after the events it
// pointed at are gone) and `agent_session_instances` / `agent_principals`
// (they answer "is this recipient known", and are one small row per session).

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { MemeshDatabase } from '../storage/sqlite.js';
import { removeGroupAndOtherAccess } from './file-mode.js';
import { AGENT_MESSAGE_TTL_MS, agentMessageExpiryCutoff } from './agent-message-ttl.js';
import { AgentMessagingError, sendAgentMessage } from './agent-messaging.js';
import { DEFAULT_DB_FILE } from './paths.js';
import { sqliteUtcToIso } from './time-utils.js';
import { networkDeliveryOf } from '../network/outbound.js';

/** A pass is due when the last one started this long ago or more. */
export const AGENT_MESSAGE_EXPIRY_INTERVAL_MS = 5 * 60 * 1000;
/** How long the id of a deleted message is remembered, for a clear answer to a late read or reply. */
const AGENT_MESSAGE_EXPIRED_ID_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** The archive of deleted messages, in `backups/` beside the database. */
const AGENT_MESSAGE_ARCHIVE_FILE = 'agent-messages-expired.db';

const RUN_LOG_KEEP = 500;
/** How long one process may hold the right to run a pass; renewed with every batch. */
const LEASE_MS = 3 * 60 * 1000;
const BATCH_SIZE = 100;
const MAX_BATCHES_PER_PASS = 200;
/** A dispatch started this recently may still be in flight; its message waits for the next pass. */
const IN_FLIGHT_GRACE_MS = 10 * 60 * 1000;
const NOTICE_LIST_MAX = 20;
const ARCHIVE = 'expiry_archive';
/** How long any statement of a pass waits for another process's lock before the pass gives up for now: short, the wait blocks the event loop. */
const LOCK_WAIT_MS = 100;
/** A pass this much short of one interval old already counts as due. */
const DUE_SLACK_MS = 10_000;

/** The sender of an expiry notice, and the `provenance.transport` that marks one. */
const AGENT_MESSAGE_EXPIRY_NOTICE_SENDER = 'memesh';
const AGENT_MESSAGE_EXPIRY_TRANSPORT = 'expiry';

// An unread row that still owes its sender a notice (see NO_NOTICE). A row remembered before senders were
// kept has none (a NULL sender is never <> anything), and MeMesh's own notices never produce one.
const NOTICE_OWED_SQL = `was_read = 0 AND notice_message_id IS NULL AND sender <> '${AGENT_MESSAGE_EXPIRY_NOTICE_SENDER}'`;

export type AgentMessageExpiryOutcome =
  | 'deleted'
  | 'presence_cleared'
  | 'archive_purged'
  | 'notices_sent'
  | 'read_only'
  | 'database_busy'
  | 'skipped_concurrent'
  | 'nothing_expired'
  | 'deferred_in_flight'
  | 'archive_failed'
  | 'archive_unavailable'
  | 'no_message_tables'
  | 'failed';

/** The outcomes that mean the pass could not do its work, and nothing more is deleted while they last. */
export const AGENT_MESSAGE_EXPIRY_FAILED_OUTCOMES: ReadonlySet<string> = new Set<AgentMessageExpiryOutcome>([
  'failed', 'archive_failed', 'archive_unavailable', 'no_message_tables', 'read_only',
]);

/** The outcomes of a pass that did its work: what `memesh doctor` measures "keeping up" from. */
export const AGENT_MESSAGE_EXPIRY_DONE_OUTCOMES: ReadonlySet<string> = new Set<AgentMessageExpiryOutcome>([
  'deleted', 'presence_cleared', 'archive_purged', 'notices_sent', 'nothing_expired', 'deferred_in_flight',
]);

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
  /** Aborted when the process stops: the pass closes its row as interrupted and gives the lease back at once. */
  signal?: AbortSignal;
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
  /** Deleted messages whose creation time cannot be read (readers already treat them as past their day). */
  unreadableTimes: number;
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
  /** For the principal copy of a session send its session refused (`fallback_to_principal`): that send's id. */
  fallback_of: string | null;
}

/** What one sender is told: every message of theirs that expired unread and has not been in a notice yet. */
interface NoticeState {
  count: number;
  /** Per message of the whole group: where the network left it, or null for a recipient on this machine. */
  facts: Array<NetworkFact | null>;
  listed: Array<{ message_id: string; recipient: string; created_at: string; expired_at: string | null; network?: NetworkFact }>;
}

/** Where a message to another machine stood when it expired (`networkDeliveryOf`), kept on its id row for the notice. */
type NetworkFact = { state: string; code: string | null; machine: string };

/**
 * In `agent_message_expiries.notice_message_id`: no notice is owed for this row
 * (the bridge told its sender already, its principal copy carries it, or its
 * sender cannot be addressed). NULL on an unread row of a sender other than
 * MeMesh means a notice is still owed; a message id means it was written.
 */
const NO_NOTICE = '';

// "Read" is the recipient having done something with it: recorded intake,
// acknowledged it, answered it (a reply in the same project points at it, from
// the recipient, from a session of the recipient sending under its own session
// id, or from the principal of the session it went to), or a workflow fact. The
// sender's own follow-up or a third party's reply is not the recipient
// answering. A host accepting a push is not reading.
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

// A presence fact older than a day of a connection that is not live, or any fact of a dead connection.
const STALE_FACTS_SQL = `(julianday(created_at) < julianday(:cutoff) AND connection_id NOT IN (${LIVE_CONNECTIONS_SQL}))
  OR connection_id IN (${DEAD_CONNECTIONS_SQL})`;

// Every table a message delete cascades through, with the column that is unique
// in it and how its rows are found from a list of message ids. Order: parents first.
// The idempotency copy is keyed by message: a key is free again once its message
// expired, so the archive can hold two messages sent with one key.
const ARCHIVED_TABLES: ReadonlyArray<{ name: string; unique: string; by: 'message' | 'delivery' }> = [
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

/** A pass whose row could not be written because the database was locked: the next pass that writes its own row writes this one, marked late. */
interface PassRecord {
  startedAtMs: number;
  endedAtMs: number;
  trigger: string;
  result: Omit<AgentMessageExpiryResult, 'run_id'>;
  startedRunId: number | null;
}

/** Per database file, in this process only: a process that exits first has said so on stderr. */
const unrecorded = new Map<string, PassRecord[]>();
/** Leases this process could not give back (the database was locked): its own next pass takes them over at once. */
const abandonedLeases = new Set<string>();

/**
 * One pass. It works on a connection of its own (see the file header) and gives
 * the event loop a turn between batches, so a server that runs it keeps
 * answering requests while a large backlog is worked off. Tests and other
 * callers await it.
 */
export async function runAgentMessageExpiry(db: MemeshDatabase, options: AgentMessageExpiryOptions): Promise<AgentMessageExpiryResult> {
  const startedAtMs = Date.now();
  const clockMs = options.nowMs ?? startedAtMs;
  const tally: Tally = { expired: 0, unread: 0, notices: 0, unaddressable: 0, unreadableTimes: 0, presenceFacts: 0, connections: 0 };
  const file = databaseFile(db);
  let pass: MemeshDatabase | null = null;
  let archiveFile: string | null = null;
  const holder = randomUUID();
  let holdsLease = false;
  let startedRunId: number | null = null;
  let stopped = false;

  const finish = (outcome: AgentMessageExpiryOutcome, detail: string | null = null): AgentMessageExpiryResult => {
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
    // A stopped pass closed its own row on the way out.
    if (stopped) return { ...result, run_id: startedRunId };
    return { ...result, run_id: recordRun(pass, file, { startedAtMs, endedAtMs: Date.now(), trigger: options.trigger, result, startedRunId }) };
  };
  // The process is stopping and exits right after this returns: close the row and give the lease back now.
  const stop = (): void => {
    stopped = true;
    if (pass === null) return;
    try {
      if (startedRunId !== null) {
        pass.prepare(`
          UPDATE agent_message_expiry_runs
          SET outcome = 'interrupted', finished_at_ms = ?, expired_message_count = ?, unread_message_count = ?, notice_count = ?,
              detail = 'the process stopped during this pass; what it had deleted is kept and the next pass does the rest'
          WHERE run_id = ? AND outcome = 'started'
        `).run(Date.now(), tally.expired, tally.unread, tally.notices, startedRunId);
      }
      if (holdsLease) pass.prepare('DELETE FROM agent_message_expiry_lease WHERE lease_id = 1 AND holder = ?').run(holder);
    } catch (error) {
      reportProblem(`could not close the pass of a process that is stopping (${errorText(error)}); the next pass closes it once its lease runs out`);
    }
    // The pass goes no further: its next statement meets a closed connection.
    if (pass !== db) closeQuietly(pass);
  };
  options.signal?.addEventListener('abort', stop, { once: true });

  try {
    pass = file === '' ? db : openPassConnection(file);
    const work = pass;
    if (!tablesExist(work)) return finish('no_message_tables', 'agent_messages, agent_message_expiry_runs, agent_message_expiries or agent_message_expiry_lease is missing');

    const cutoff = agentMessageExpiryCutoff(clockMs);
    const inFlightCutoff = new Date(clockMs - IN_FLIGHT_GRACE_MS).toISOString();
    const presenceParams = presenceBindings(cutoff, clockMs);
    archiveFile = archiveLocation(file);
    // The archive, and the one an earlier MeMesh shared between all databases of a folder, which a database
    // with its own archive now still cleans its own rows out of.
    const shared = archiveFile === null ? null : sharedArchive(archiveFile);
    const purges: Array<[string, boolean]> = archiveFile === null ? [] : [[archiveFile, false], ...(shared === null ? [] : [[shared, true] as [string, boolean]])];
    // Only whether there is work, so EXISTS: a COUNT over a large backlog blocks the event loop for about a second.
    const measure = (): { deletable: boolean; presence: boolean; purgeable: boolean; owed: boolean } => ({
      deletable: (work.prepare(
        `SELECT EXISTS (SELECT 1 FROM agent_messages m WHERE m.created_at < ? AND NOT ${IN_FLIGHT_SQL}) AS n`,
      ).get(cutoff, inFlightCutoff) as { n: number }).n === 1,
      presence: hasStalePresence(work, presenceParams),
      // An archive that cannot be opened is not a reason to stop here: a batch that needs it fails on it, naming it.
      purgeable: purges.some(([file, ownOnly]) => archiveHasPurgeableRows(work, file, Date.now(), ownOnly)),
      owed: (work.prepare(`SELECT EXISTS (SELECT 1 FROM agent_message_expiries WHERE ${NOTICE_OWED_SQL}) AS n`).get() as { n: number }).n === 1,
    });
    type Seen = ReturnType<typeof measure>;
    const idle = (m: Seen): boolean => !m.deletable && !m.presence && !m.purgeable && !m.owed;
    // Idle with messages past their day: only ones still being delivered are left.
    const idleOutcome = (): AgentMessageExpiryOutcome => (
      (work.prepare('SELECT EXISTS (SELECT 1 FROM agent_messages WHERE created_at < ?) AS n').get(cutoff) as { n: number }).n === 1 ? 'deferred_in_flight' : 'nothing_expired');

    let seen = measure();
    if (idle(seen)) {
      interruptDeadRuns(work, holder);
      return finish(idleOutcome());
    }
    if (seen.deletable && archiveFile === null) {
      return finish('archive_unavailable', 'the database has no file path, so there is nowhere to archive to and nothing was deleted');
    }

    // A database that cannot be written would otherwise do half a pass and
    // fail. Find out first, and tell "locked right now" from "cannot be written".
    try {
      probeWritable(work);
    } catch (error) {
      if (isBusy(error)) return finish('database_busy', `the database was locked by another process, so nothing was deleted this time (${errorText(error)})`);
      return finish('read_only', `the database cannot be written, so nothing was archived or deleted (${errorText(error)})`);
    }

    // One process at a time. A pass that finds the lease held by another
    // process records that and stops; a lease whose holder died runs out and
    // is taken over.
    const held = acquireLease(work, holder);
    if (held !== null) return finish('skipped_concurrent', `another process is running the pass (its lease runs until ${new Date(held).toISOString()})`);
    holdsLease = true;
    // A row still "started" belongs to a process that died: the lease is ours,
    // so nobody else is running. Its counts (kept up to the last batch) stay.
    interruptDeadRuns(work, holder);

    // The other process may have finished while this one waited to ask.
    seen = measure();
    if (idle(seen)) return finish(idleOutcome());

    // The run is written down before anything is archived or deleted, and its
    // counts follow every batch, so a process killed half way leaves a row that
    // says what it had done.
    startedRunId = beginRun(work, startedAtMs, options.trigger, seen.deletable ? archiveFile : null);

    const notes: string[] = [];
    let purgeFailed = false;
    for (const [file, ownOnly] of purges) {
      try {
        const purged = await purgeArchive(work, file, holder, ownOnly);
        if (purged > 0) notes.push(`removed ${purged} archived message(s) past their extra day${ownOnly ? ` from ${file}, the archive an earlier MeMesh shared between databases` : ''}`);
      } catch (error) {
        if (isBusy(error)) throw error;
        purgeFailed = true;
        notes.push(`could not remove archive rows older than a day (${file}: ${errorText(error)}); they stay until the next pass`);
      }
    }

    let archiveFailure: string | null = null;
    if (seen.deletable && archiveFile !== null) {
      for (let batch = 1; batch <= MAX_BATCHES_PER_PASS; batch++) {
        const rows = selectBatch(work, cutoff, inFlightCutoff);
        if (rows.length === 0) break;
        try {
          archiveRows(work, archiveFile, rows.map((row) => row.message_id), batch, options);
        } catch (error) {
          if (isBusy(error)) throw error;
          // Nothing more is deleted. The notices and the presence below need no archive, so they still run.
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
    if (tally.unreadableTimes > 0) notes.push(`${tally.unreadableTimes} message(s) had a creation time that cannot be read; readers already treated them as past their day, so they were archived and deleted`);

    // One notice per project and sender for everything owed, this pass's batches and any a stopped pass left:
    // written once, never changed afterwards (a host may already have pushed it).
    // Counted once committed: a rollback writes none.
    const written = work.transaction(() => {
      renewLease(work, holder);
      const counts = writeOwedNotices(work);
      saveRunProgress(work, startedRunId, { ...tally, notices: tally.notices + counts.notices }, archiveFile);
      return counts;
    }).immediate();
    tally.notices += written.notices;
    tally.unaddressable += written.unaddressable;
    if (tally.unaddressable > 0) notes.push(`${tally.unaddressable} sender(s) could not be addressed, so no notice was written for them`);

    work.transaction(() => {
      renewLease(work, holder);
      tally.presenceFacts = deletePresence(work, presenceParams, 'facts');
      tally.connections = deletePresence(work, presenceParams, 'connections');
    }).immediate();

    const remaining = (work.prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE created_at < ?').get(cutoff) as { n: number }).n;
    if (remaining > 0) notes.push(`${remaining} expired message(s) left for the next pass`);
    if (archiveFailure !== null) notes.unshift(archiveFailure);
    const detail = notes.length > 0 ? notes.join('; ') : null;
    const outcome = archiveFailure !== null ? 'archive_failed'
      : tally.expired > 0 ? 'deleted'
      : tally.presenceFacts + tally.connections > 0 ? 'presence_cleared'
        : seen.purgeable ? (purgeFailed ? 'failed' : 'archive_purged')
          : tally.notices > 0 ? 'notices_sent'
            : remaining > 0 ? 'deferred_in_flight' : 'nothing_expired';
    return finish(outcome, detail);
  } catch (error) {
    if (isBusy(error)) {
      return finish('database_busy', `the database was locked by another process, so the pass stopped here; every batch it finished is kept and the next pass does the rest (${errorText(error)})`);
    }
    return finish('failed', errorText(error));
  } finally {
    options.signal?.removeEventListener('abort', stop);
    if (pass !== null && !stopped) {
      if (holdsLease) releaseLease(pass, holder);
      if (pass !== db) closeQuietly(pass);
    }
  }
}

/**
 * The pass's own connection: the database's file, waiting LOCK_WAIT_MS at most for a lock. Foreign
 * keys, which the delete cascades through, are on by default in node:sqlite.
 */
function openPassConnection(file: string): MemeshDatabase {
  const pass = new MemeshDatabase(file);
  pass.pragma(`busy_timeout = ${LOCK_WAIT_MS}`);
  return pass;
}

function closeQuietly(db: MemeshDatabase): void {
  try { db.close(); } catch { /* already closed */ }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    // The slack: the scheduler's ticks are one interval apart, and the first pass starts a second after the
    // first tick would have; without it every second tick finds the last pass a moment too young, and the
    // pass runs every ten minutes instead of five.
    if (last?.at != null && last.at <= startedAtMs && startedAtMs - last.at < AGENT_MESSAGE_EXPIRY_INTERVAL_MS - DUE_SLACK_MS) return null;
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
  let running: AbortController | null = null;
  const tick = (): void => {
    const db = getDb();
    if (!db || running) return;
    const current = new AbortController();
    running = current;
    void runAgentMessageExpiryIfDue(db, { trigger: options.trigger, signal: current.signal }).finally(() => { running = null; });
  };
  const first = setTimeout(tick, options.firstRunDelayMs ?? 1_000);
  const every = setInterval(tick, options.intervalMs ?? AGENT_MESSAGE_EXPIRY_INTERVAL_MS);
  first.unref();
  every.unref();
  // Called on the way out of the process: a running pass closes its row and gives its lease back, and the rows
  // of passes that met a lock get one more try, before this returns.
  return () => {
    clearTimeout(first);
    clearInterval(every);
    running?.abort();
    recordLatePasses(getDb());
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

/** What the archive file holds now, for `memesh doctor`. Read-only: it never creates, changes or repairs the file. */
export type AgentMessageArchiveState =
  | { kind: 'missing' }
  | { kind: 'unusable'; reason: string }
  /** Another process holds it locked this moment (a pass writing it): not a fault. */
  | { kind: 'busy' }
  | { kind: 'held'; messages: number };

export function inspectAgentMessageArchive(db: MemeshDatabase, file: string): AgentMessageArchiveState {
  try {
    const messages = readArchive(db, file, (archive, hasLog) => (hasLog ? (archive.prepare('SELECT COUNT(*) AS n FROM archive_log').get() as { n: number }).n : 0));
    if (messages === undefined) return { kind: 'missing' };
    // The next pass writes it.
    try { fs.accessSync(file, fs.constants.W_OK); } catch { return { kind: 'unusable', reason: 'this user cannot write it' }; }
    return { kind: 'held', messages };
  } catch (error) {
    if (isBusy(error)) return { kind: 'busy' };
    // EACCES (a folder without search permission) is not "gone": the file may well be there.
    const code = (error as NodeJS.ErrnoException).syscall === undefined ? undefined : (error as NodeJS.ErrnoException).code;
    return { kind: 'unusable', reason: code === undefined ? errorText(error) : `it cannot be read (${code})` };
  }
}

/**
 * Reads the archive through a read-only handle of its own, which does not wait for a lock:
 * undefined when there is no file, else what `read` returns (`hasLog` is false for a file that holds no
 * archive yet). Throws for a path MeMesh does not use as an archive (refuseUnsafeArchive) and for one it
 * cannot read. Changes nothing.
 */
function readArchive<T>(db: MemeshDatabase, file: string, read: (archive: DatabaseSync, hasLog: boolean) => T): T | undefined {
  if (fs.lstatSync(file, { throwIfNoEntry: false }) === undefined) return undefined;
  refuseUnsafeArchive(db, file);
  const archive = new DatabaseSync(file, { readOnly: true });
  try {
    const hasLog = (archive.prepare("SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'archive_log') AS n").get() as { n: number }).n === 1;
    return read(archive, hasLog);
  } finally {
    archive.close();
  }
}

/** The next batch of expired messages, oldest first. */
function selectBatch(db: MemeshDatabase, cutoff: string, inFlightCutoff: string): ExpiredRow[] {
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
  `).all(cutoff, inFlightCutoff, BATCH_SIZE) as unknown as ExpiredRow[];
}

/**
 * Deletes one batch, in the transaction the caller opened: remembers the ids
 * (an unread one with its notice still owed) and deletes the messages. The
 * notices are written after the batches, by writeOwedNotices.
 */
function deleteBatch(db: MemeshDatabase, rows: ExpiredRow[], tally: Tally): void {
  const remember = db.prepare(`
    INSERT OR REPLACE INTO agent_message_expiries
      (message_id, project, created_at, expired_at_ms, was_read, notice_message_id, sender, recipient, network_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const delivery = db.prepare('SELECT delivery_id, recipient FROM agent_message_deliveries WHERE message_id = ? LIMIT 1');
  // The bridge already told the sender when it refused or gave up on a message to another machine.
  const bridgeTold = db.prepare("SELECT 1 FROM agent_messages WHERE reply_to_message_id = ? AND json_extract(provenance_json, '$.via') = 'network-notice' LIMIT 1");
  // The principal copy of a session send its session refused (`fallback_to_principal`) is the message the
  // sender got back: its notice names the copy, and an answer to the copy answers the send too, so the send
  // owes no notice of its own. The copy is written after the send, so it is never older, and on one creation
  // second the index keeps the order rows were written in: the send is remembered first, in this batch with
  // its copy, or in an earlier one, whose row `copied` then settles.
  const copies = new Map(rows.filter((row) => row.fallback_of !== null).map((row) => [row.fallback_of, row]));
  const copied = db.prepare(`UPDATE agent_message_expiries SET notice_message_id = '${NO_NOTICE}', was_read = MAX(was_read, ?) WHERE message_id = ? AND notice_message_id IS NULL`);
  const now = Date.now();
  for (const row of rows) {
    const copy = copies.get(row.message_id);
    const wasRead = row.was_read !== 0 || (copy !== undefined && copy.was_read !== 0);
    // A notice that expires unread does not produce another notice.
    const unread = !wasRead && row.is_notice === 0;
    const owesNotice = unread && copy === undefined;
    // The outbox row goes with the delivery, so what the network knew is read now, for the notice written after the batches.
    const sent = owesNotice ? delivery.get(row.message_id) as { delivery_id: string; recipient: string } | undefined : undefined;
    const network = sent ? networkDeliveryOf(db, sent) : null;
    const told = network !== null && bridgeTold.get(row.message_id) !== undefined;
    remember.run(row.message_id, row.project, row.created_at, now, wasRead ? 1 : 0, told || copy !== undefined ? NO_NOTICE : null, row.sender, row.recipient, network ? JSON.stringify(network) : null);
    if (unread) tally.unread += 1;
    if (row.fallback_of !== null) copied.run(row.was_read !== 0 ? 1 : 0, row.fallback_of);
    if (Number.isNaN(Date.parse(sqliteUtcToIso(row.created_at)))) tally.unreadableTimes += 1;
  }
  const deleted = db.prepare(
    'DELETE FROM agent_messages WHERE message_id IN (SELECT value FROM json_each(?))',
  ).run(JSON.stringify(rows.map((row) => row.message_id)));
  if (Number(deleted.changes) !== rows.length) {
    throw new Error(`expected to delete ${rows.length} message(s), deleted ${deleted.changes}; nothing in this batch was kept`);
  }
  tally.expired += rows.length;
}

/**
 * Writes one notice per project and sender for every remembered row that still
 * owes one, in the transaction the caller opened, and marks those rows with it.
 * A notice is never changed once written.
 */
function writeOwedNotices(db: MemeshDatabase): { notices: number; unaddressable: number } {
  const written = { notices: 0, unaddressable: 0 };
  const owed = db.prepare(`
    SELECT message_id, project, sender, recipient, created_at, network_json FROM agent_message_expiries
    WHERE ${NOTICE_OWED_SQL} ORDER BY project, sender, created_at, message_id
  `).all() as Array<{ message_id: string; project: string; sender: string; recipient: string; created_at: string; network_json: string | null }>;
  const groups = new Map<string, typeof owed>();
  for (const row of owed) {
    const key = `${row.project}\u0000${row.sender}`;
    const group = groups.get(key);
    if (group) group.push(row); else groups.set(key, [row]);
  }
  const mark = db.prepare('UPDATE agent_message_expiries SET notice_message_id = ? WHERE message_id IN (SELECT value FROM json_each(?))');
  for (const group of groups.values()) {
    const facts = group.map((row) => (row.network_json === null ? null : JSON.parse(row.network_json) as NetworkFact));
    const state: NoticeState = {
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
    if (noticeId === null) written.unaddressable += 1; else written.notices += 1;
    mark.run(noticeId ?? NO_NOTICE, JSON.stringify(group.map((row) => row.message_id)));
  }
  return written;
}

/**
 * What the sender is told. This machine only knows what happened on this machine: for a message to another
 * machine that is whether the network delivered it, never whether anyone there recorded or answered it.
 */
function noticeSummary(state: NoticeState): string {
  const count = state.count;
  const plural = (n: number): string => (n === 1 ? '' : 's');
  const remote = state.facts.filter((fact): fact is NetworkFact => fact !== null);
  if (remote.length === 0) {
    return `${count} message${plural(count)} you sent expired: MeMesh keeps a message for one day, and `
      + `${count === 1 ? 'its recipient' : 'their recipients'} recorded no intake, acknowledgement or disposition and sent no reply. `
      + 'Send it again if it still matters.';
  }
  const parts: string[] = [];
  const local = count - remote.length;
  if (local > 0) parts.push(`For ${local} sent to a recipient on this machine, the recipient recorded no intake, acknowledgement or disposition and sent no reply.`);
  const unique = (values: Array<string | null>): string[] => [...new Set(values.filter((value): value is string => value !== null))];
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

function noticePayload(state: NoticeState) {
  const count = state.count;
  return {
    kind: 'message_expired',
    summary: noticeSummary(state),
    messages: state.listed,
    ...(count > state.listed.length ? { not_listed: count - state.listed.length } : {}),
  };
}

/** Writes the notice to the sender; null when the sender is not an address a message can go to. */
function writeNotice(db: MemeshDatabase, project: string, sender: string, state: NoticeState): string | null {
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
  } catch (error) {
    // A sender that is not a valid address (a path, say) cannot be written to.
    // That is counted in the run; any other failure aborts the notices.
    if (error instanceof AgentMessagingError) return null;
    throw error;
  }
}

/** The run's counts so far, and its archive once it has deleted anything. */
function saveRunProgress(db: MemeshDatabase, runId: number | null, tally: Tally, archiveFile: string | null): void {
  if (runId === null) return;
  db.prepare(`
    UPDATE agent_message_expiry_runs
    SET expired_message_count = ?, unread_message_count = ?, notice_count = ?, backup_path = ?
    WHERE run_id = ?
  `).run(tally.expired, tally.unread, tally.notices, tally.expired > 0 ? archiveFile : null, runId);
}

// ---------------------------------------------------------------------------
// The archive
// ---------------------------------------------------------------------------

/**
 * Where the archive is, in `backups/` beside the database; null for a database with no file.
 * One archive per database file: the default `knowledge-graph.db` keeps the name it always had
 * (so an archive written before still restores and is still cleaned), any other database file
 * `x.db` uses `agent-messages-expired-x.db`, so two databases in one folder never share one.
 */
function archiveLocation(databasePath: string): string | null {
  if (databasePath === '') return null;
  const base = path.basename(databasePath);
  return path.join(path.dirname(databasePath), 'backups', base === DEFAULT_DB_FILE ? AGENT_MESSAGE_ARCHIVE_FILE : `agent-messages-expired-${base}`);
}

/** The archive an earlier MeMesh used for every database of a folder; null when `archive` is that file. */
function sharedArchive(archive: string): string | null {
  return path.basename(archive) === AGENT_MESSAGE_ARCHIVE_FILE ? null : path.join(path.dirname(archive), AGENT_MESSAGE_ARCHIVE_FILE);
}

const SQLITE_HEADER = 'SQLite format 3\u0000';

/**
 * Refuses an archive path that would make a copy no copy: a symlink, wherever it points (it
 * could point at another database, which would then receive the messages), something that is
 * not a plain file, the database itself (a hard link: its check would compare the database
 * with itself), or a file that is not an SQLite database (someone else's file). Each is left
 * exactly as it is.
 */
function refuseUnsafeArchive(db: MemeshDatabase, file: string): void {
  const link = fs.lstatSync(file, { throwIfNoEntry: false });
  if (link === undefined) return; // not there yet: it is created as a plain, owner-only file
  if (link.isSymbolicLink()) {
    throw new Error(`${file} is a symlink; MeMesh never reads or writes its archive through a symlink, wherever it points, and leaves it as it is (move it away)`);
  }
  if (!link.isFile()) throw new Error(`${file} is not a plain file`);
  const main = databaseFile(db);
  const mainStat = main === '' ? undefined : fs.statSync(main, { throwIfNoEntry: false });
  if (mainStat && mainStat.dev === link.dev && mainStat.ino === link.ino) {
    throw new Error(`${file} is the database itself, so it cannot hold a copy of what is deleted from it`);
  }
  if (link.size > 0) {
    const head = Buffer.alloc(SQLITE_HEADER.length);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
    if (head.toString('latin1') !== SQLITE_HEADER) throw new Error(`${file} is not a database (it has no SQLite header), so it is not a MeMesh archive; MeMesh leaves it as it is (move it away)`);
  }
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
 * Rows are always written and compared by column name, so an archive whose
 * columns are in another order (made from another database) is still right.
 */
function attachArchive(db: MemeshDatabase, file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  refuseUnsafeArchive(db, file);
  const fresh = !fs.existsSync(file);
  if (fresh) fs.closeSync(fs.openSync(file, 'a', 0o600));
  // Other users lose access; the owner's own bits are left as the owner set them (#520).
  removeGroupAndOtherAccess(file);
  db.prepare(`ATTACH DATABASE ? AS ${ARCHIVE}`).run(file);
  try {
    // Must come before the first table: the archive gives its pages back when rows are removed.
    if (fresh) db.exec(`PRAGMA ${ARCHIVE}.auto_vacuum = INCREMENTAL`);
    for (const table of ARCHIVED_TABLES) {
      db.exec(`CREATE TABLE IF NOT EXISTS ${ARCHIVE}.${table.name} AS SELECT * FROM main.${table.name} WHERE 0`);
      const live = columnNames(db, 'main', table.name);
      const kept = new Set(columnNames(db, ARCHIVE, table.name));
      for (const column of live.filter((name) => !kept.has(name))) {
        db.exec(`ALTER TABLE ${ARCHIVE}.${table.name} ADD COLUMN ${quoted(column)}`);
      }
      // An archive made before the unique column changed has the old index: replace it.
      const indexed = (db.prepare(`SELECT name FROM pragma_index_info('ux_${table.name}', '${ARCHIVE}')`).all() as Array<{ name: string }>)
        .map((row) => row.name).join(', ');
      if (indexed !== '' && indexed !== table.unique) db.exec(`DROP INDEX ${ARCHIVE}.ux_${table.name}`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${ARCHIVE}.ux_${table.name} ON ${table.name}(${table.unique})`);
      // Each batch's check and the purge find rows by message or delivery; without this they scan the whole archive.
      const lookup = `${table.by}_id`;
      if (lookup !== table.unique) db.exec(`CREATE INDEX IF NOT EXISTS ${ARCHIVE}.by_${table.name} ON ${table.name}(${lookup})`);
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

function quoted(column: string): string {
  return `"${column.replace(/"/g, '""')}"`;
}

/**
 * Copies one batch's rows into the archive by column name, replacing any older
 * copy, starts their extra day again, and commits that. Then checks every table
 * of the archive holds each of the batch's rows with the same content. Throws,
 * and the batch is not deleted, when it does not.
 */
function archiveRows(db: MemeshDatabase, file: string, messageIds: string[], batch: number, options: AgentMessageExpiryOptions): void {
  const ids = JSON.stringify(messageIds);
  attachArchive(db, file);
  try {
    const columns = new Map(ARCHIVED_TABLES.map((table) => [table.name, columnNames(db, 'main', table.name).map(quoted).join(', ')]));
    // A plain (deferred) transaction: only the archive file is written, so the
    // main database's write lock is not taken.
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
      const missing = (db.prepare(`
        SELECT COUNT(*) AS n FROM (
          SELECT ${list} FROM main.${table.name} WHERE ${where('main', table.by)}
          EXCEPT SELECT ${list} FROM ${ARCHIVE}.${table.name} WHERE ${where(ARCHIVE, table.by)}
        )
      `).get(ids, ids) as { n: number }).n;
      if (missing > 0) throw new Error(`${missing} ${table.name} row(s) of this batch are not in the archive as they are in the database`);
    }
  } finally {
    db.exec(`DETACH DATABASE ${ARCHIVE}`);
  }
}

/** Is any archived message past its extra day? False when there is no archive file. */
function archiveHasPurgeableRows(db: MemeshDatabase, file: string, nowMs: number, ownOnly: boolean): boolean {
  try {
    return readArchive(db, file, (archive, hasLog) => {
      if (!hasLog) return false;
      if (ownOnly) archive.prepare('ATTACH DATABASE ? AS live').run(databaseFile(db));
      return (archive.prepare(`SELECT EXISTS (SELECT 1 FROM archive_log WHERE archived_at_ms < ?${ownOnly ? ' AND message_id IN (SELECT message_id FROM live.agent_message_expiries)' : ''}) AS n`)
        .get(nowMs - AGENT_MESSAGE_TTL_MS) as { n: number }).n === 1;
    }) ?? false;
  } catch {
    // Not silent: the purge and every batch attach it too and fail with the reason, naming the
    // file, and doctor opens it and warns before any pass does. Here it only means "no purge now".
    return false;
  }
}

/**
 * Removes what was archived more than one day ago, by the time recorded in the
 * archive (never by file name), BATCH_SIZE messages per transaction (which renews
 * the lease) with an event-loop turn between, so a large archive does not hold the
 * process. `ownOnly`: only what this database deleted, from a file other databases
 * share. The archive is attached only inside each synchronous step.
 */
async function purgeArchive(db: MemeshDatabase, file: string, holder: string, ownOnly: boolean): Promise<number> {
  let purged = 0;
  for (;;) {
    if (fs.lstatSync(file, { throwIfNoEntry: false }) === undefined) return purged;
    attachArchive(db, file);
    let removed: number;
    try {
      removed = db.transaction(() => {
        renewLease(db, holder);
        const batch = (db.prepare(`
          SELECT message_id FROM ${ARCHIVE}.archive_log WHERE archived_at_ms < ?
          ${ownOnly ? 'AND message_id IN (SELECT message_id FROM main.agent_message_expiries)' : ''} LIMIT ?
        `).all(Date.now() - AGENT_MESSAGE_TTL_MS, BATCH_SIZE) as Array<{ message_id: string }>).map((row) => row.message_id);
        const ids = JSON.stringify(batch);
        for (const table of [...ARCHIVED_TABLES].reverse()) {
          db.prepare(`DELETE FROM ${ARCHIVE}.${table.name} WHERE ${where(ARCHIVE, table.by)}`).run(ids);
        }
        db.prepare(`DELETE FROM ${ARCHIVE}.archive_log WHERE message_id IN (SELECT value FROM json_each(?))`).run(ids);
        return batch.length;
      }).immediate();
      // Gives back the pages this batch freed, so the vacuum is as small as the batch.
      if (removed > 0) db.exec(`PRAGMA ${ARCHIVE}.incremental_vacuum`);
    } finally {
      db.exec(`DETACH DATABASE ${ARCHIVE}`);
    }
    if (removed === 0) return purged;
    purged += removed;
    await yieldTurn();
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
    if (row && row.expires_at_ms > now && !abandonedLeases.has(row.holder)) return row.expires_at_ms;
    if (row) abandonedLeases.delete(row.holder);
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
    // Not fatal: the lease runs out by itself, and this process's next pass takes it over at once.
    // Said, so a "skipped_concurrent" in another process has an explanation.
    if (isBusy(error)) abandonedLeases.add(holder);
    reportProblem(`could not release the expiry lease (${errorText(error)}); it runs out on its own`);
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

function hasStalePresence(db: MemeshDatabase, bind: PresenceBindings): boolean {
  return (db.prepare(`
    SELECT EXISTS (SELECT 1 FROM agent_presence_facts WHERE ${STALE_FACTS_SQL}) OR EXISTS (${DEAD_CONNECTIONS_SQL}) AS n
  `).get(bind.facts) as { n: number }).n === 1;
}

function deletePresence(db: MemeshDatabase, bind: PresenceBindings, what: 'facts' | 'connections'): number {
  if (what === 'connections') {
    return Number(db.prepare(`DELETE FROM agent_session_connections WHERE connection_id IN (${DEAD_CONNECTIONS_SQL})`).run(bind.dead).changes);
  }
  return Number(db.prepare(`DELETE FROM agent_presence_facts WHERE ${STALE_FACTS_SQL}`).run(bind.facts).changes);
}

/** Forgets old expired ids, except one whose notice is still owed: forgetting it would mean its sender is never told. */
function trimBookkeeping(db: MemeshDatabase, nowMs: number): void {
  db.prepare(`DELETE FROM agent_message_expiries WHERE expired_at_ms < ? AND (${NOTICE_OWED_SQL}) IS NOT 1`).run(nowMs - AGENT_MESSAGE_EXPIRED_ID_KEEP_MS);
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
    if (isBusy(error)) throw error;
    reportProblem(`could not record that a pass started: ${errorText(error)}`);
    return null;
  }
}

/**
 * Writes the pass's row, after any row of an earlier pass of this process that met a lock. A
 * row that meets a lock now is kept for the next pass instead: waiting would hold the process.
 */
function recordRun(pass: MemeshDatabase | null, file: string, record: PassRecord): number | null {
  const late = unrecorded.get(file) ?? [];
  try {
    if (pass === null) throw new Error('the database could not be opened');
    const runId = pass.transaction(() => {
      for (const missed of late) writeRun(pass, missed, true);
      return writeRun(pass, record, false);
    }).immediate();
    unrecorded.delete(file);
    return runId;
  } catch (error) {
    const { outcome, detail } = record.result;
    const ended = `pass ended ${outcome}${detail ? ` (${detail})` : ''}`;
    if (file !== '' && isBusy(error)) {
      unrecorded.set(file, [...late, record]);
      reportProblem(`${ended} and could not be recorded now (${errorText(error)}); the next pass that can write records it`);
    } else {
      // A read-only database, a missing table: say so where an operator can see it rather than lose it.
      reportProblem(`${ended} and could not be recorded: ${errorText(error)}`);
    }
    return null;
  }
}

/** One try, without waiting, to write the rows still kept for the next pass: the process is about to exit with them. */
function recordLatePasses(db: MemeshDatabase | null): void {
  let pass: MemeshDatabase | null = null;
  try {
    const file = db === null ? '' : databaseFile(db);
    const late = unrecorded.get(file);
    if (file === '' || late === undefined) return;
    const work = pass = openPassConnection(file);
    work.transaction(() => { for (const missed of late) writeRun(work, missed, true); }).immediate();
    unrecorded.delete(file);
  } catch (error) {
    reportProblem(`a pass that met a lock could still not be recorded as the process stopped (${errorText(error)})`);
  } finally {
    if (pass !== null) closeQuietly(pass);
  }
}

/** One run row, in the caller's transaction: the row the pass started with, or a new one. */
function writeRun(db: MemeshDatabase, record: PassRecord, late: boolean): number {
  const { result } = record;
  const detail = late
    ? `recorded late: the database was locked by another process when this pass ended at ${new Date(record.endedAtMs).toISOString()}${result.detail ? `; ${result.detail}` : ''}`
    : result.detail;
  const values = [
    late ? record.endedAtMs : Date.now(), result.outcome, result.expired_message_count, result.unread_message_count,
    result.notice_count, result.presence_fact_count, result.connection_count, result.backup_path, detail,
  ] as const;
  let runId: number | null = null;
  if (record.startedRunId !== null) {
    const updated = db.prepare(`
      UPDATE agent_message_expiry_runs
      SET finished_at_ms = ?, outcome = ?, expired_message_count = ?, unread_message_count = ?,
          notice_count = ?, presence_fact_count = ?, connection_count = ?, backup_path = ?, detail = ?
      WHERE run_id = ?
    `).run(...values, record.startedRunId);
    if (Number(updated.changes) === 1) runId = record.startedRunId;
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

function trimRunLog(db: MemeshDatabase): void {
  db.prepare(`
    DELETE FROM agent_message_expiry_runs
    WHERE run_id <= (SELECT run_id FROM agent_message_expiry_runs ORDER BY run_id DESC LIMIT 1 OFFSET ?)
  `).run(RUN_LOG_KEEP);
}

/**
 * Marks interrupted every run still "started" whose process is gone: no live lease is held, or
 * the live one is this pass's own. A lock ends the pass (database_busy); any other failure is
 * only said, since a database that cannot be written is reported by the pass itself.
 */
function interruptDeadRuns(db: MemeshDatabase, holder: string): void {
  try {
    db.prepare(`
      UPDATE agent_message_expiry_runs
      SET outcome = 'interrupted', detail = 'the process stopped before this pass finished'
      WHERE outcome = 'started'
        AND NOT EXISTS (SELECT 1 FROM agent_message_expiry_lease WHERE expires_at_ms > ? AND holder <> ?)
    `).run(Date.now(), holder);
  } catch (error) {
    if (isBusy(error)) throw error;
    reportProblem(`could not close a pass that never finished: ${errorText(error)}`);
  }
}

/** Lets the event loop run once. */
function yieldTurn(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function reportProblem(message: string): void {
  try { process.stderr.write(`MeMesh message expiry: ${message}\n`); } catch { /* stderr gone */ }
}
