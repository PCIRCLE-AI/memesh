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
export function recipientEverSeen(db, project, recipient) {
    try {
        const row = db.prepare(`SELECT (
         EXISTS(SELECT 1 FROM agent_principals WHERE project = ? AND principal_id = ?)
         OR EXISTS(SELECT 1 FROM agent_message_deliveries WHERE project = ? AND recipient = ?)
         OR EXISTS(SELECT 1 FROM agent_session_instances WHERE project = ? AND session_instance_id = ?)
       ) AS seen`).get(project, recipient, project, recipient, project, recipient);
        return row?.seen === undefined ? undefined : Boolean(row.seen);
    }
    catch {
        return undefined;
    }
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
//# sourceMappingURL=agent-message-inbox.js.map