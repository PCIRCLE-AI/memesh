// ============================================================================
// AUTO-GENERATED from src/core/agent-message-inbox.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
export function unreadDeliveryCount(db, project, recipient) {
    if (!recipient)
        return 0;
    try {
        const row = db.prepare(`SELECT COUNT(*) AS n
       FROM agent_message_deliveries d
       WHERE d.project = ?
         AND d.recipient = ?
         AND NOT EXISTS (
           SELECT 1 FROM agent_message_receipts r
           WHERE r.project = d.project
             AND r.recipient = d.recipient
             AND r.message_id = d.message_id
             AND r.receipt_kind = 'intake'
         )`).get(project, recipient);
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
    const message = err && typeof err === 'object' && 'message' in err ? String(err.message) : '';
    return /no such table: agent_(principals|message_deliveries|session_instances)\b/.test(message);
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
export function unreadInboxLines(count, project, recipient, everSeen) {
    if (!recipient)
        return [];
    const displayProject = JSON.stringify(project);
    const displayRecipient = JSON.stringify(recipient);
    if (count > 0) {
        const noun = count === 1 ? 'message' : 'messages';
        return [`${count} ${noun} waiting for ${displayRecipient} in project ${displayProject} — poll the message tool with project ${displayProject} and recipient ${displayRecipient}, then fetch each message_id and record the intake action for it: fetching alone does not acknowledge, and only intake ends this line.`];
    }
    if (everSeen === false) {
        return [`No messages waiting for ${displayRecipient} in project ${displayProject} — and this recipient id has never been seen in this project (check for a typo).`];
    }
    return [];
}
export function unreadInboxLinesFor(db, recipient) {
    if (!recipient)
        return [];
    try {
        const rows = db.prepare(`SELECT d.project AS project, COUNT(*) AS n
       FROM agent_message_deliveries d
       WHERE d.recipient = ?
         AND NOT EXISTS (
           SELECT 1 FROM agent_message_receipts r
           WHERE r.project = d.project
             AND r.recipient = d.recipient
             AND r.message_id = d.message_id
             AND r.receipt_kind = 'intake'
         )
       GROUP BY d.project
       ORDER BY n DESC, d.project
       LIMIT 5`).all(recipient);
        return rows.flatMap((row) => typeof row.project === 'string' && typeof row.n === 'number' && row.n > 0
            ? unreadInboxLines(row.n, row.project, recipient)
            : []);
    }
    catch (err) {
        if (/no such table: agent_message_deliveries/.test(String(err?.message)))
            return [];
        throw err;
    }
}
