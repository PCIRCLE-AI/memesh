// ============================================================================
// AUTO-GENERATED from src/core/agent-scope-id.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
export const AGENT_SCOPE_ID_MAX_LENGTH = 200;
export function canonicalAgentScopeId(value) {
    return value.normalize('NFC').trim();
}
export function isFilesystemPathScopeId(value) {
    const v = canonicalAgentScopeId(value);
    if (v.startsWith('/') || v.startsWith('\\'))
        return true;
    return /^[A-Za-z]:[\\/]/.test(v);
}
export function lastPathSegment(value) {
    const segments = canonicalAgentScopeId(value).split(/[\\/]+/).filter((s) => s.length > 0);
    const last = segments[segments.length - 1];
    if (last === undefined)
        return null;
    if (/^[A-Za-z]:$/.test(last))
        return null;
    return last;
}
export function agentScopeIdRejection(field, value) {
    if (!isFilesystemPathScopeId(value))
        return null;
    const suggestion = lastPathSegment(value);
    const example = suggestion === null ? 'reviewer-agent' : suggestion;
    return `${field} must be a stable identifier, not a filesystem path (received ${JSON.stringify(canonicalAgentScopeId(value))}). `
        + `Use the name on its own, for example ${JSON.stringify(example)}.`;
}
export const AGENT_MESSAGE_SCOPE_COLUMNS = [
    { table: 'agent_messages', columns: ['project', 'recipient'] },
    { table: 'agent_message_deliveries', columns: ['project', 'recipient'] },
    { table: 'agent_message_events', columns: ['project', 'recipient'] },
    { table: 'agent_message_cursors', columns: ['project', 'recipient'] },
    { table: 'agent_message_receipts', columns: ['project', 'recipient', 'actor'] },
    { table: 'agent_message_idempotency', columns: ['project'] },
    { table: 'agent_ack_facts', columns: ['actor'] },
    { table: 'agent_workflow_facts', columns: ['actor'] },
    { table: 'agent_retention_facts', columns: ['actor'] },
];
export const AGENT_MESSAGE_PROJECT_TABLES = AGENT_MESSAGE_SCOPE_COLUMNS.filter((e) => e.columns.includes('project')).map((e) => e.table);
