// ============================================================================
// AUTO-GENERATED from src/core/capture-liveness.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
export const HOOK_OUTCOMES_FILENAME = 'hook-outcomes.jsonl';
export const HOOK_OUTCOMES_VERSION = 1;
export const HOOK_OUTCOMES_PER_HOOK = 20;
export const HOOK_OUTCOMES_MAX_LINES = 200;
export const HOOK_OUTCOMES_ROTATE_BYTES = 32 * 1024;
export function serializeHookOutcome(record) {
    return `${JSON.stringify(record)}\n`;
}
export function trimHookOutcomeLines(raw, max = HOOK_OUTCOMES_MAX_LINES) {
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const kept = lines.length > max ? lines.slice(lines.length - max) : lines;
    return kept.length ? `${kept.join('\n')}\n` : '';
}
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
export const FAIL_ELIGIBLE_HOOKS = ['session-summary'];
export const NEVER_RAN_GRACE_HOURS = 72;
export function emptyOutcomeFile() {
    return { version: HOOK_OUTCOMES_VERSION, hooks: {} };
}
export function parseHookOutcomes(raw, limit = HOOK_OUTCOMES_PER_HOOK) {
    if (!raw)
        return emptyOutcomeFile();
    const hooks = {};
    for (const line of raw.split('\n')) {
        const record = parseHookOutcomeLine(line);
        if (!record)
            continue;
        const bucket = hooks[record.hook] ?? (hooks[record.hook] = []);
        bucket.push(record);
        if (bucket.length > limit)
            bucket.shift();
    }
    return { version: HOOK_OUTCOMES_VERSION, hooks };
}
export function parseHookOutcomeLine(line) {
    const trimmed = line.trim();
    if (!trimmed)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object')
        return null;
    const rec = parsed;
    if (typeof rec.hook !== 'string' || !rec.hook)
        return null;
    if (typeof rec.at !== 'string')
        return null;
    if (rec.outcome !== 'wrote' && rec.outcome !== 'skipped' && rec.outcome !== 'error')
        return null;
    const record = {
        hook: rec.hook,
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
    return record;
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
        ? (input.neverRanHooks ?? []).filter((h) => FAIL_ELIGIBLE_HOOKS.includes(h) && !withRecords.has(h)).sort()
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
export const GRACE_SESSIONS = 3;
export const GRACE_HOURS = 24;
export function parseGraceState(raw) {
    if (!raw)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object')
        return null;
    const rec = parsed;
    if (typeof rec.version !== 'string' || typeof rec.firstSeenAt !== 'string')
        return null;
    const sessions = typeof rec.sessions === 'number' && Number.isFinite(rec.sessions) ? rec.sessions : 0;
    return { version: rec.version, firstSeenAt: rec.firstSeenAt, sessions };
}
export function advanceGraceState(previous, version, nowMs) {
    if (!previous || previous.version !== version) {
        return { version, firstSeenAt: new Date(nowMs).toISOString(), sessions: 1 };
    }
    return { ...previous, sessions: previous.sessions + 1 };
}
export function graceInEffect(state, nowMs) {
    if (state.sessions <= GRACE_SESSIONS)
        return true;
    const startedMs = Date.parse(state.firstSeenAt);
    if (!Number.isFinite(startedMs))
        return false;
    return nowMs - startedMs < GRACE_HOURS * 60 * 60 * 1000;
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
