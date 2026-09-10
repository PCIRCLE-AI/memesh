// ============================================================================
// AUTO-GENERATED from src/core/capture-liveness.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
export const HOOK_OUTCOMES_FILENAME = 'hook-outcomes.json';
export const HOOK_OUTCOMES_VERSION = 1;
export const HOOK_OUTCOMES_PER_HOOK = 20;
export const SILENT_HOOK_MIN_RUNS = 5;
export const CAPTURE_HOOKS = [
    'post-commit',
    'session-summary',
    'pre-compact',
    'pre-edit-recall',
    'user-prompt-intent',
    'decision-nudge',
    'guard-check',
    'session-start',
];
export const HEARTBEAT_HOOKS = ['post-commit', 'session-summary', 'pre-compact'];
export const NEVER_RAN_GRACE_HOURS = 72;
export function emptyOutcomeFile() {
    return { version: HOOK_OUTCOMES_VERSION, hooks: {} };
}
export function parseHookOutcomes(raw) {
    if (!raw)
        return emptyOutcomeFile();
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return emptyOutcomeFile();
    }
    if (!parsed || typeof parsed !== 'object')
        return emptyOutcomeFile();
    const hooksRaw = parsed.hooks;
    if (!hooksRaw || typeof hooksRaw !== 'object')
        return emptyOutcomeFile();
    const hooks = {};
    for (const [hook, entries] of Object.entries(hooksRaw)) {
        if (!Array.isArray(entries))
            continue;
        const kept = [];
        for (const entry of entries) {
            if (!entry || typeof entry !== 'object')
                continue;
            const rec = entry;
            if (typeof rec.at !== 'string')
                continue;
            if (rec.outcome !== 'wrote' && rec.outcome !== 'skipped' && rec.outcome !== 'error')
                continue;
            const record = {
                hook,
                at: rec.at,
                host: rec.host === 'claude-code' || rec.host === 'codex' ? rec.host : 'unknown',
                outcome: rec.outcome,
            };
            if (typeof rec.reason === 'string')
                record.reason = rec.reason;
            if (typeof rec.entity === 'string')
                record.entity = rec.entity;
            if (typeof rec.session_id === 'string')
                record.session_id = rec.session_id;
            kept.push(record);
        }
        if (kept.length)
            hooks[hook] = kept;
    }
    return { version: HOOK_OUTCOMES_VERSION, hooks };
}
export function appendHookOutcome(file, record, limit = HOOK_OUTCOMES_PER_HOOK) {
    const hooks = { ...file.hooks };
    const existing = hooks[record.hook] ?? [];
    const next = [...existing, record];
    hooks[record.hook] = next.length > limit ? next.slice(next.length - limit) : next;
    return { version: HOOK_OUTCOMES_VERSION, hooks };
}
export function summarizeHookOutcomes(file) {
    const order = [...CAPTURE_HOOKS];
    const names = Object.keys(file.hooks).sort((a, b) => {
        const ai = order.indexOf(a);
        const bi = order.indexOf(b);
        if (ai !== bi)
            return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi);
        return a.localeCompare(b);
    });
    return names.map((hook) => summarizeOne(hook, file.hooks[hook] ?? []));
}
function summarizeOne(hook, records) {
    let writes = 0;
    let skips = 0;
    let errors = 0;
    let lastRunAt = null;
    let lastWriteAt = null;
    let lastEntity = null;
    let lastSkipReason = null;
    const skipCounts = new Map();
    const hosts = new Set();
    for (const r of records) {
        hosts.add(r.host);
        if (lastRunAt === null || r.at >= lastRunAt)
            lastRunAt = r.at;
        if (r.outcome === 'wrote') {
            writes++;
            if (lastWriteAt === null || r.at >= lastWriteAt) {
                lastWriteAt = r.at;
                lastEntity = r.entity ?? null;
            }
        }
        else if (r.outcome === 'skipped') {
            skips++;
            lastSkipReason = r.reason ?? null;
            const key = r.reason ?? 'unspecified';
            skipCounts.set(key, (skipCounts.get(key) ?? 0) + 1);
        }
        else {
            errors++;
        }
    }
    let dominantSkipReason = null;
    let dominantSkipCount = 0;
    for (const [reason, count] of skipCounts) {
        if (count > dominantSkipCount) {
            dominantSkipCount = count;
            dominantSkipReason = reason;
        }
    }
    const runs = records.length;
    return {
        hook,
        runs,
        writes,
        skips,
        errors,
        lastRunAt,
        lastWriteAt,
        lastEntity,
        lastSkipReason,
        dominantSkipReason,
        dominantSkipCount,
        hosts: [...hosts].sort(),
        silent: runs >= SILENT_HOOK_MIN_RUNS && writes === 0,
    };
}
export function summarizeTypeTrends(rows) {
    return rows
        .map((r) => ({ ...r, stopped: r.prev7 > 0 && r.last7 === 0 }))
        .sort((a, b) => a.type.localeCompare(b.type));
}
export function captureLivenessVerdict(input) {
    const withRecords = new Set(input.hooks.filter((h) => h.runs > 0).map((h) => h.hook));
    const graceOver = input.measuringHours !== null &&
        input.measuringHours !== undefined &&
        input.measuringHours > NEVER_RAN_GRACE_HOURS;
    const deadHooks = graceOver
        ? (input.neverRanHooks ?? []).filter((h) => HEARTBEAT_HOOKS.includes(h) && !withRecords.has(h)).sort()
        : [];
    const silent = input.hooks.filter((h) => h.silent).sort((a, b) => b.runs - a.runs);
    const stoppedTypes = input.types.filter((t) => t.stopped);
    let status = 'PASS';
    if (deadHooks.length > 0)
        status = 'FAIL';
    else if (silent.length > 0 || stoppedTypes.length > 0)
        status = 'PASS_WITH_CONCERNS';
    return { status, silentHook: silent[0] ?? null, stoppedTypes, deadHooks };
}
export function captureLivenessNotice(verdict) {
    if (verdict.status === 'PASS')
        return null;
    if (verdict.deadHooks.length > 0) {
        const hook = verdict.deadHooks[0];
        return `memesh: the ${hook} hook has never run — \`memesh doctor\` for the reason`;
    }
    const hook = verdict.silentHook;
    if (hook) {
        const since = (hook.lastRunAt ?? '').slice(0, 10) || 'install';
        return `memesh: ${hook.hook} ran ${hook.runs} times since ${since} and wrote nothing — \`memesh doctor\` for the reason`;
    }
    const stopped = verdict.stoppedTypes[0];
    if (stopped) {
        return `memesh: nothing of type ${stopped.type} was captured this week (${stopped.prev7} last week) — \`memesh doctor\` for the reason`;
    }
    return null;
}
export function detectHookHost(payload, env = {}) {
    if (env.MEMESH_HOOK_HOST === 'claude-code' || env.MEMESH_HOOK_HOST === 'codex') {
        return env.MEMESH_HOOK_HOST;
    }
    if (env.CODEX_HOME || env.CODEX_SANDBOX || env.CODEX_PLUGIN_ROOT)
        return 'codex';
    if (env.CLAUDE_PLUGIN_ROOT || env.CLAUDE_PROJECT_DIR || env.CLAUDECODE)
        return 'claude-code';
    if (payload && typeof payload === 'object') {
        if (typeof payload.transcript_path === 'string' || typeof payload.hook_event_name === 'string') {
            return 'claude-code';
        }
    }
    return 'unknown';
}
