// =============================================================================
// Unread inbox — the one fact about messages that belongs in a briefing
// =============================================================================
//
// Why this exists. On 2026-08-29 an agent working in this repository spent a
// whole session next to two other local agents and never once used `message`
// to reach them — it used the host's own push tool every time, because that
// tool named itself in the output the agent was reading, and nothing the agent
// read ever said "there is a durable inbox, and something in it is for you".
// The rules were all written down; none of them were in front of the agent at
// the moment it chose a tool.
//
// So this module puts the fact where the agent is already looking: the same
// block that carries the user's stated goal / next / blocked. One line, only
// when a briefing caller supplies an exact recipient and the count is non-zero:
//
//   2 messages waiting for "claude-implementer" in project "memesh" — poll
//   with that exact project and recipient, then fetch each message_id
//
// What "unread" means, precisely: a delivery row exists for this project and
// no intake receipt (`fetched` or `ingested`) has been recorded for it. That
// is the durable inbox's own definition — polling and fetching are separate
// facts, and this counts only what nobody has fetched yet. It does NOT count
// acknowledgement; a fetched-but-unacknowledged message is the agent's
// business, not a wakeup.
//
// Read-only, one query, and it tolerates a database from before the message
// tables existed (returns 0, says nothing). A caller with no exact recipient
// also returns 0 before querying, so generic briefing and SessionStart share
// one fail-closed rule instead of implementing separate omission paths.
//
// This file is mirrored into scripts/hooks/_generated/ by
// scripts/generate-hook-core.mjs, exactly like task-state.ts, so SessionStart
// and the MCP/CLI briefing surface cannot disagree on this trust boundary.

/** Minimal database shape shared by node:sqlite and the hook's wrapper. */
interface InboxDb {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

/** Same, for the one query that returns several rows. */
interface InboxListDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

/**
 * Deliveries addressed to recipients in `project` that have no intake receipt.
 * 0 when the message tables are absent (pre-4.8.0 graph) or on any query
 * error — a briefing must never fail because the inbox could not be counted.
 */
export function unreadDeliveryCount(db: InboxDb, project: string, recipient?: string): number {
  if (!recipient) return 0;
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS n
       FROM agent_message_deliveries d
       WHERE d.project = ?
         AND d.recipient = ?
         AND NOT EXISTS (
           SELECT 1 FROM agent_message_receipts r
           WHERE r.project = d.project
             AND r.recipient = d.recipient
             AND r.message_id = d.message_id
             AND r.receipt_kind = 'intake'
         )`,
    ).get(project, recipient) as { n?: number } | undefined;
    const n = row?.n;
    return typeof n === 'number' && n > 0 ? n : 0;
  } catch {
    // Table missing (older schema) or unreadable: not a wakeup, not an error.
    return 0;
  }
}

/**
 * D8: has `recipient` ever been addressed in `project` at all — as a live
 * host-native connection, or as a delivery target (durable inbox, whether
 * or not it was ever fetched)? `unreadDeliveryCount` answers "how many are
 * unread", which is 0 for both a quiet inbox and a typo'd recipient id —
 * so `briefing --recipient <typo>` used to read identically to `briefing
 * --recipient <real-but-quiet>`. This is the one signal the data can
 * actually tell them apart with.
 *
 * Two tables, not three: `agent_session_connections` also carries
 * `principal_id`, but every row there is reached through
 * `agent_session_instances`, which `registerConnection` (agent-router.ts)
 * only ever creates AFTER upserting `agent_principals` for that same
 * principal — so a connection can never exist without the principal row.
 * That does NOT make `agent_session_instances` itself redundant to check,
 * though: `target_kind: 'session'` messages key on a session instance's OWN
 * id (`agent_message_deliveries.recipient` stores it verbatim), and a
 * session that connected but has not yet received a delivery has a row
 * ONLY in `agent_session_instances` — neither of the other two tables has
 * heard of it yet, so omitting this EXISTS misreported an actually-live,
 * registered session as "never seen" (D8 review finding, reproduced by
 * seeding exactly that state before this fix).
 *
 * Returns `undefined` — not `false` — when the question cannot be answered
 * at all (a database from before the message tables existed, or any query
 * error). Asserting "no such recipient" from a table this process could not
 * read would be a new way to lie; staying silent, as the quiet-inbox case
 * already does, is the honest answer here too.
 *
 * {@link recipientEverSeen} (project-scoped) and {@link recipientEverSeenAnywhere}
 * (any project) both answer through this one query, so their WHERE clauses
 * cannot drift apart the way two hand-written copies did. A database that
 * predates the message tables is the ONE expected shape of "cannot answer"
 * (every fresh install passes through it); `onError`, if given, fires only
 * for anything else, so a caller can tell an empty history apart from a
 * broken one without this function ever throwing.
 */
function recipientSeenQuery(
  db: InboxDb,
  recipient: string,
  project?: string,
  onError?: (err: unknown) => void,
): boolean | undefined {
  try {
    const scope = project !== undefined ? 'project = ? AND ' : '';
    const params: unknown[] = project !== undefined
      ? [project, recipient, project, recipient, project, recipient]
      : [recipient, recipient, recipient];
    const row = db.prepare(
      `SELECT (
         EXISTS(SELECT 1 FROM agent_principals WHERE ${scope}principal_id = ?)
         OR EXISTS(SELECT 1 FROM agent_message_deliveries WHERE ${scope}recipient = ?)
         OR EXISTS(SELECT 1 FROM agent_session_instances WHERE ${scope}session_instance_id = ?)
       ) AS seen`,
    ).get(...params) as { seen?: number } | undefined;
    return row?.seen === undefined ? undefined : Boolean(row.seen);
  } catch (err) {
    if (!isMissingMessageTableError(err)) onError?.(err);
    return undefined;
  }
}

/** Is this the one expected shape of "cannot answer" — a database from before the message tables existed? */
function isMissingMessageTableError(err: unknown): boolean {
  return /no such table: agent_(principals|message_deliveries|session_instances)\b/.test(errorMessage(err));
}

/**
 * The unread queries' own "never messaged" shape: no deliveries table at all
 * (SQLite names the outer FROM table first). A deliveries table WITHOUT the
 * session tables {@link DELIVERY_MATCHES_RECIPIENT_OR_LIVE_SESSION} joins is a
 * half-migrated database, not an empty inbox, so it is raised and the hook
 * records an error instead of "nothing waiting".
 */
function isMissingDeliveriesTableError(err: unknown): boolean {
  return /no such table: agent_message_deliveries\b/.test(errorMessage(err));
}

function errorMessage(err: unknown): string {
  return err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : '';
}

export function recipientEverSeen(db: InboxDb, project: string, recipient: string): boolean | undefined {
  return recipientSeenQuery(db, recipient, project);
}

/**
 * Same question as {@link recipientEverSeen}, with no `project` filter: has
 * `recipient` ever been addressed in ANY project? A hint question, not a
 * certainty — a genuinely new recipient id also returns `false`. Same
 * fail-silent contract: `undefined`, not `false`, when the tables cannot be
 * read. `onError`, given, is called only when the read failed for a reason
 * other than the tables not existing yet.
 */
export function recipientEverSeenAnywhere(
  db: InboxDb,
  recipient: string,
  onError?: (err: unknown) => void,
): boolean | undefined {
  return recipientSeenQuery(db, recipient, undefined, onError);
}

/**
 * The one-line hint for a declared recipient {@link recipientEverSeenAnywhere}
 * answered `false` for. Worded as a hint ("check for a typo"), never a fact.
 */
export function unknownRecipientHint(recipient: string): string {
  return `MEMESH_RECIPIENT ${JSON.stringify(recipient)} has never been seen in any project — check it for a typo (or ignore this if it is a genuinely new recipient id).`;
}

/** Most waiting refs {@link unreadMessageRefsFor} returns in one call. */
export const UNREAD_MESSAGE_REFS_LIMIT = 500;

/** One waiting delivery's identity: which inbox it sits in, and its message. */
export interface UnreadMessageRef {
  readonly project: string;
  readonly message_id: string;
}

/**
 * WHERE-clause fragment shared by {@link unreadMessageRefsFor} and
 * {@link unreadInboxLinesFor} (#490): a delivery `d` (aliased
 * `agent_message_deliveries`) matches `recipient` either the ordinary way —
 * addressed to it directly, the only case before #490 — OR when its
 * `target_kind` is `'session'` and that session id (`d.recipient`, a
 * `session_instance_id`) is registered, in the delivery's OWN project, under
 * `recipient` as ITS principal, AND that session is LIVE right now: a row in
 * `agent_session_connections` with no disconnect and an unexpired lease.
 * `d.recipient` is compared to `si.session_instance_id` as a column
 * (not a bound parameter) — the join is entirely within the delivery's own
 * project, which is why `si.project = d.project` is required rather than a
 * bare `session_instance_id` match: two different projects can reuse the
 * same session id string.
 *
 * A session-targeted delivery whose session has since disconnected or let
 * its lease expire is deliberately NOT matched — surfacing a message for a
 * session that is no longer there would be nagging about a dead session, not
 * a wakeup, and #490 asks for exactly the opposite. Callers of this fragment
 * pass `recipient` twice and the current time in ms once, in that order,
 * before any further `?` their own query adds.
 */
const DELIVERY_MATCHES_RECIPIENT_OR_LIVE_SESSION = `(
  d.recipient = ?
  OR (
    d.target_kind = 'session'
    AND EXISTS (
      SELECT 1
      FROM agent_session_instances si
      JOIN agent_session_connections c
        ON c.project = si.project AND c.session_instance_id = si.session_instance_id
      WHERE si.project = d.project
        AND si.session_instance_id = d.recipient
        AND si.principal_id = ?
        AND c.disconnected_at IS NULL
        AND c.lease_expires_at_ms > ?
    )
  )
)`;

/**
 * The waiting message ids behind {@link unreadInboxLinesFor}'s counts (#468) — same
 * "no intake receipt yet" definition, across every project, with no
 * `host_accept` dependency: a delivery row exists whether or not native push
 * ever ran, so this counts a message a stopped or disconnected exact session
 * never received just as readily as one that did. Unlike
 * {@link unreadInboxLinesFor}, this is not capped to the 5 busiest projects —
 * the caller uses these ids to decide whether a specific message has already
 * been accounted for, and a project outside that top-5 must still be able to
 * trigger that decision. Also matches a delivery targeted at a LIVE session
 * registered under `recipient` as its principal — see
 * {@link DELIVERY_MATCHES_RECIPIENT_OR_LIVE_SESSION} (#490).
 */
export function unreadMessageRefsFor(
  db: InboxListDb,
  recipient?: string,
  limit: number = UNREAD_MESSAGE_REFS_LIMIT,
): UnreadMessageRef[] {
  if (!recipient) return [];
  try {
    const rows = db.prepare(
      `SELECT d.project AS project, d.message_id AS message_id
       FROM agent_message_deliveries d
       WHERE ${DELIVERY_MATCHES_RECIPIENT_OR_LIVE_SESSION}
         AND NOT EXISTS (
           SELECT 1 FROM agent_message_receipts r
           WHERE r.project = d.project
             AND r.recipient = d.recipient
             AND r.message_id = d.message_id
             AND r.receipt_kind = 'intake'
         )
       ORDER BY d.project, d.message_id
       LIMIT ?`,
    ).all(recipient, recipient, Date.now(), limit) as Array<{ project?: string; message_id?: string }>;
    return rows.filter(
      (row): row is UnreadMessageRef => typeof row.project === 'string' && typeof row.message_id === 'string',
    );
  } catch (err) {
    // A database from before the message tables existed has nothing to report.
    // Any other failure is not "no messages": raise it so the caller can say so.
    if (isMissingDeliveriesTableError(err)) return [];
    throw err;
  }
}

/**
 * The line(s) to place beside the task-state lines. Empty when nothing is
 * waiting AND the recipient is known (or unknowable) — a quiet, real inbox
 * adds no noise. `everSeen === false` is the one case worth a line even at
 * zero unread: see {@link recipientEverSeen}. `targetKind: 'session'` (#490)
 * is the delivery's own `target_kind`, not the declared recipient's: it
 * changes the instructions, because polling/fetching/intake for a
 * session-targeted message must use that session's own id, not the
 * principal — `recipient` here is already that session id when this is
 * `'session'` (see {@link unreadInboxLinesFor}, the only caller that passes
 * it as anything other than the default).
 */
export function unreadInboxLines(
  count: number,
  project: string,
  recipient?: string,
  everSeen?: boolean,
  targetKind: 'principal' | 'session' = 'principal',
): string[] {
  if (!recipient) return [];
  // CLI callers bypass Zod and project/recipient values become model-facing
  // text. JSON quoting keeps quotes, control characters, and newlines from
  // forging a second briefing line while the SQL query still uses originals.
  const displayProject = JSON.stringify(project);
  const displayRecipient = JSON.stringify(recipient);
  if (count > 0) {
    const noun = count === 1 ? 'message' : 'messages';
    if (targetKind === 'session') {
      return [`${count} ${noun} waiting for the live session ${displayRecipient} in project ${displayProject} — that session is registered under your principal and connected right now. Poll the message tool with project ${displayProject} and recipient ${displayRecipient}, then fetch each message_id with target_kind "session" (fetch or intake using your own principal id instead of ${displayRecipient} will not match this session-targeted message), and record intake for each with recipient ${displayRecipient} (intake_state "ingested", with an idempotency_key such as "intake-<message_id>"): fetching alone does not acknowledge, and only intake ends this line.`];
    }
    return [`${count} ${noun} waiting for ${displayRecipient} in project ${displayProject} — poll the message tool with project ${displayProject} and recipient ${displayRecipient}, then fetch each message_id and record intake for each (intake_state "ingested", with an idempotency_key such as "intake-<message_id>"): fetching alone does not acknowledge, and only intake ends this line.`];
  }
  if (everSeen === false) {
    return [`No messages waiting for ${displayRecipient} in project ${displayProject} — and this recipient id has never been seen in this project (check for a typo).`];
  }
  return [];
}

/**
 * The reminder lines for a session that has declared who it is
 * (`MEMESH_RECIPIENT`): every project in which deliveries addressed to that
 * exact recipient — OR to a session LIVE right now that is registered under
 * it as its principal (#490) — have no intake receipt yet, one line per
 * (project, actual delivery recipient) pair, at most five, most-waiting
 * first. Senders pick the project string themselves, so this does not assume
 * the session's own project name; the line names the project AND the exact
 * recipient (the declared one, or the live session's own id) to poll with.
 * The recipient must match exactly, so an agent still never learns that a
 * message exists for anyone else. No recipient, nothing waiting, or a
 * database from before the message tables existed all return no lines; any
 * other failure is raised, because it is not "no messages".
 */
export function unreadInboxLinesFor(db: InboxListDb, recipient?: string): string[] {
  if (!recipient) return [];
  try {
    const rows = db.prepare(
      `SELECT d.project AS project, d.recipient AS recipient, d.target_kind AS target_kind, COUNT(*) AS n
       FROM agent_message_deliveries d
       WHERE ${DELIVERY_MATCHES_RECIPIENT_OR_LIVE_SESSION}
         AND NOT EXISTS (
           SELECT 1 FROM agent_message_receipts r
           WHERE r.project = d.project
             AND r.recipient = d.recipient
             AND r.message_id = d.message_id
             AND r.receipt_kind = 'intake'
         )
       GROUP BY d.project, d.recipient, d.target_kind
       ORDER BY n DESC, d.project, d.recipient
       LIMIT 5`,
    ).all(recipient, recipient, Date.now()) as Array<{ project?: string; recipient?: string; target_kind?: string; n?: number }>;
    return rows.flatMap((row) =>
      typeof row.project === 'string' && typeof row.recipient === 'string' && typeof row.n === 'number' && row.n > 0
        ? unreadInboxLines(row.n, row.project, row.recipient, undefined, row.target_kind === 'session' ? 'session' : 'principal')
        : [],
    );
  } catch (err) {
    // A database from before the message tables existed has nothing to report.
    // Any other failure is not "no messages": raise it so the caller can say so.
    if (isMissingDeliveriesTableError(err)) return [];
    throw err;
  }
}
