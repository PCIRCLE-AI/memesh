import { jsonStringLiteral } from './work-topology.js';
function hostAcceptedFilter(db, excludeHostAccepted, session) {
    if (!excludeHostAccepted)
        return { sql: '', params: [] };
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_host_accepts'").get() !== undefined;
    if (!hasTable)
        return { sql: '', params: [] };
    const carriedBody = "COALESCE(json_extract(h.receipt_json, '$.content'), '') <> 'notice'";
    if (session === undefined) {
        return {
            sql: `AND NOT EXISTS (SELECT 1 FROM agent_host_accepts h WHERE h.delivery_id = d.delivery_id AND ${carriedBody})`,
            params: [],
        };
    }
    const ids = [...sessionAliasChain(db, session)];
    return {
        sql: `AND NOT EXISTS (
      SELECT 1 FROM agent_host_accepts h
      WHERE h.delivery_id = d.delivery_id
        AND ${carriedBody}
        AND (json_extract(h.receipt_json, '$.thread_id') IS NULL
          OR json_extract(h.receipt_json, '$.thread_id') IN (${ids.map(() => '?').join(', ')}))
    )`,
        params: ids,
    };
}
function intendedSessionFilter(db, session) {
    const hasColumn = db.prepare("SELECT 1 AS present FROM pragma_table_info('agent_message_deliveries') WHERE name = 'intended_session'").get() !== undefined;
    if (!hasColumn)
        return { sql: '', params: [] };
    if (session === undefined)
        return { sql: 'AND d.intended_session IS NULL', params: [] };
    const ids = [...sessionAliasChain(db, session)];
    return {
        sql: `AND (d.intended_session IS NULL OR d.intended_session IN (${ids.map(() => '?').join(', ')}))`,
        params: ids,
    };
}
export function sessionAliasChain(db, session) {
    const chain = new Set([session]);
    try {
        const previous = db.prepare('SELECT previous_session_id AS id FROM agent_session_aliases WHERE session_id = ?');
        const next = db.prepare('SELECT session_id AS id FROM agent_session_aliases WHERE previous_session_id = ?');
        for (const step of [previous, next]) {
            let current = session;
            for (;;) {
                const row = step.get(current);
                if (typeof row?.id !== 'string' || chain.has(row.id))
                    break;
                chain.add(row.id);
                current = row.id;
            }
        }
    }
    catch (err) {
        if (!/no such table: agent_session_aliases\b/.test(errorMessage(err)))
            throw err;
    }
    return chain;
}
export function unreadDeliveryCount(db, project, recipient, session) {
    if (!recipient)
        return 0;
    try {
        const intended = intendedSessionFilter(db, session);
        const row = db.prepare(`SELECT COUNT(*) AS n
       FROM agent_message_deliveries d
       WHERE d.project = ?
         AND d.recipient = ?
         ${intended.sql}
         AND NOT EXISTS (
           SELECT 1 FROM agent_message_receipts r
           WHERE r.project = d.project
             AND r.recipient = d.recipient
             AND r.message_id = d.message_id
             AND r.receipt_kind = 'intake'
         )`).get(project, recipient, ...intended.params);
        const n = row?.n;
        return typeof n === 'number' && n > 0 ? n : 0;
    }
    catch {
        return 0;
    }
}
function recipientSeenQuery(db, recipient, project, onError) {
    try {
        const scope = project !== undefined ? 'project = ? AND ' : '';
        const params = project !== undefined
            ? [project, recipient, project, recipient, project, recipient]
            : [recipient, recipient, recipient];
        const row = db.prepare(`SELECT (
         EXISTS(SELECT 1 FROM agent_principals WHERE ${scope}principal_id = ?)
         OR EXISTS(SELECT 1 FROM agent_message_deliveries WHERE ${scope}recipient = ?)
         OR EXISTS(SELECT 1 FROM agent_session_instances WHERE ${scope}session_instance_id = ?)
       ) AS seen`).get(...params);
        return row?.seen === undefined ? undefined : Boolean(row.seen);
    }
    catch (err) {
        if (!isMissingMessageTableError(err))
            onError?.(err);
        return undefined;
    }
}
function isMissingMessageTableError(err) {
    return /no such table: agent_(principals|message_deliveries|session_instances)\b/.test(errorMessage(err));
}
function isMissingDeliveriesTableError(err) {
    return /no such table: agent_message_deliveries\b/.test(errorMessage(err));
}
function errorMessage(err) {
    return err && typeof err === 'object' && 'message' in err ? String(err.message) : '';
}
export function recipientEverSeen(db, project, recipient) {
    return recipientSeenQuery(db, recipient, project);
}
export function recipientEverSeenAnywhere(db, recipient, onError) {
    return recipientSeenQuery(db, recipient, undefined, onError);
}
export function unknownRecipientHint(recipient) {
    return `MEMESH_RECIPIENT ${JSON.stringify(recipient)} has never been seen in any project — check it for a typo (or ignore this if it is a genuinely new recipient id).`;
}
export const UNREAD_MESSAGE_REFS_LIMIT = 500;
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
export function unreadMessageRefsFor(db, recipient, session, limit = UNREAD_MESSAGE_REFS_LIMIT, excludeHostAccepted = false) {
    if (!recipient)
        return [];
    try {
        const intended = intendedSessionFilter(db, session);
        const accepted = hostAcceptedFilter(db, excludeHostAccepted, session);
        const rows = db.prepare(`SELECT d.project AS project, d.message_id AS message_id
       FROM agent_message_deliveries d
       WHERE ${DELIVERY_MATCHES_RECIPIENT_OR_LIVE_SESSION}
         ${intended.sql}
         ${accepted.sql}
         AND NOT EXISTS (
           SELECT 1 FROM agent_message_receipts r
           WHERE r.project = d.project
             AND r.recipient = d.recipient
             AND r.message_id = d.message_id
             AND r.receipt_kind = 'intake'
         )
       ORDER BY d.project, d.message_id
       LIMIT ?`).all(recipient, recipient, Date.now(), ...intended.params, ...accepted.params, limit);
        return rows.filter((row) => typeof row.project === 'string' && typeof row.message_id === 'string');
    }
    catch (err) {
        if (isMissingDeliveriesTableError(err))
            return [];
        throw err;
    }
}
export function unreadInboxLines(count, project, recipient, everSeen, targetKind = 'principal') {
    if (!recipient)
        return [];
    const displayProject = jsonStringLiteral(project);
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
export function unreadInboxLinesFor(db, recipient, session, excludeHostAccepted = false) {
    if (!recipient)
        return [];
    try {
        const intended = intendedSessionFilter(db, session);
        const accepted = hostAcceptedFilter(db, excludeHostAccepted, session);
        const rows = db.prepare(`SELECT d.project AS project, d.recipient AS recipient, d.target_kind AS target_kind, COUNT(*) AS n
       FROM agent_message_deliveries d
       WHERE ${DELIVERY_MATCHES_RECIPIENT_OR_LIVE_SESSION}
         ${intended.sql}
         ${accepted.sql}
         AND NOT EXISTS (
           SELECT 1 FROM agent_message_receipts r
           WHERE r.project = d.project
             AND r.recipient = d.recipient
             AND r.message_id = d.message_id
             AND r.receipt_kind = 'intake'
         )
       GROUP BY d.project, d.recipient, d.target_kind
       ORDER BY n DESC, d.project, d.recipient
       LIMIT 5`).all(recipient, recipient, Date.now(), ...intended.params, ...accepted.params);
        return rows.flatMap((row) => typeof row.project === 'string' && typeof row.recipient === 'string' && typeof row.n === 'number' && row.n > 0
            ? unreadInboxLines(row.n, row.project, row.recipient, undefined, row.target_kind === 'session' ? 'session' : 'principal')
            : []);
    }
    catch (err) {
        if (isMissingDeliveriesTableError(err))
            return [];
        throw err;
    }
}
//# sourceMappingURL=agent-message-inbox.js.map