export const HOOK_OUTCOMES_FILENAME = 'hook-outcomes.jsonl';
export const HOOK_OUTCOMES_PER_HOOK = 20;
export const HOOK_OUTCOMES_NOT_TRIGGERED_PER_HOOK = 5;
function windowKeep(entries, maxTriggered, maxNotTriggered) {
    const keep = new Array(entries.length).fill(false);
    const seen = new Map();
    for (let i = entries.length - 1; i >= 0; i--) {
        const { hook, triggered } = entries[i];
        const counts = seen.get(hook) ?? { t: 0, n: 0 };
        seen.set(hook, counts);
        if (triggered) {
            if (++counts.t <= maxTriggered)
                keep[i] = true;
        }
        else if (++counts.n <= maxNotTriggered) {
            keep[i] = true;
        }
    }
    return keep;
}
export function isTriggeredRecord(record) {
    if (record.outcome !== 'skipped' || record.reason === undefined)
        return true;
    return !(NOT_TRIGGERED_SKIP_REASONS[record.hook] ?? []).includes(record.reason);
}
export const HOOK_OUTCOMES_ROTATE_BYTES = 64 * 1024;
export function serializeHookOutcome(record) {
    return `${JSON.stringify(record)}\n`;
}
export function trimHookOutcomeLines(raw, max = HOOK_OUTCOMES_PER_HOOK, maxBytes = HOOK_OUTCOMES_ROTATE_BYTES) {
    const records = [];
    for (const line of raw.split('\n')) {
        const record = parseHookOutcomeLine(line);
        if (record)
            records.push({ hook: record.hook, triggered: isTriggeredRecord(record), line });
    }
    const keep = windowKeep(records, max, HOOK_OUTCOMES_NOT_TRIGGERED_PER_HOOK);
    let kept = records.filter((_, i) => keep[i]).map((r) => r.line);
    let bytes = kept.reduce((n, line) => n + utf8Length(line) + 1, 0);
    if (bytes > maxBytes) {
        const budget = maxBytes / 2;
        const fit = [];
        bytes = 0;
        for (let i = kept.length - 1; i >= 0; i--) {
            const size = utf8Length(kept[i]) + 1;
            if (size > budget)
                continue;
            if (bytes + size > budget)
                break;
            fit.push(kept[i]);
            bytes += size;
        }
        kept = fit.reverse();
    }
    return kept.length ? `${kept.join('\n')}\n` : '';
}
function utf8Length(text) {
    let n = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c < 0x80)
            n += 1;
        else if (c < 0x800)
            n += 2;
        else if (c >= 0xd800 && c <= 0xdbff) {
            n += 4;
            i++;
        }
        else
            n += 3;
    }
    return n;
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
export const FAIL_ELIGIBLE_HOOKS = ['session-summary'];
export const SILENT_ELIGIBLE_HOOKS = ['post-commit', 'session-summary', 'pre-compact'];
export const SKIP_REASONS = {
    notBash: 'not a Bash tool call',
    notGitCommit: 'not a git commit command',
    commitLineMissing: 'a git commit ran but printed no commit line',
    alreadyCaptured: 'this session was already captured',
};
export const NOT_TRIGGERED_SKIP_REASONS = {
    'post-commit': [SKIP_REASONS.notBash, SKIP_REASONS.notGitCommit],
    'session-summary': [SKIP_REASONS.alreadyCaptured],
};
export const NEVER_RAN_GRACE_HOURS = 72;
export function parseHookOutcomes(raw, limit = HOOK_OUTCOMES_PER_HOOK) {
    if (!raw)
        return { hooks: {} };
    const records = [];
    for (const line of raw.split('\n')) {
        const record = parseHookOutcomeLine(line);
        if (record)
            records.push(record);
    }
    const keep = windowKeep(records.map((r) => ({ hook: r.hook, triggered: isTriggeredRecord(r) })), limit, HOOK_OUTCOMES_NOT_TRIGGERED_PER_HOOK);
    const hooks = {};
    records.forEach((record, i) => {
        if (!keep[i])
            return;
        (hooks[record.hook] ?? (hooks[record.hook] = [])).push(record);
    });
    return { hooks };
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
    if (typeof rec.hook !== 'string' || !CAPTURE_HOOKS.includes(rec.hook))
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
    const reason = typeof rec.reason === 'string' ? sanitizeRecordText(rec.reason) : '';
    if (reason)
        record.reason = reason;
    const entity = typeof rec.entity === 'string' ? sanitizeRecordText(rec.entity) : '';
    if (entity)
        record.entity = entity;
    return record;
}
export const RECORD_TEXT_MAX = 200;
export function sanitizeRecordText(text) {
    return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, RECORD_TEXT_MAX);
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
    let firstTriggeredAt = null;
    let triggeredRuns = 0;
    let lastWriteAt = null;
    let lastEntity = null;
    let lastSkipReason = null;
    const skipCounts = new Map();
    const hosts = new Set();
    for (const r of records) {
        hosts.add(r.host);
        if (lastRunAt === null || r.at >= lastRunAt)
            lastRunAt = r.at;
        const triggered = isTriggeredRecord(r);
        if (triggered) {
            triggeredRuns++;
            if (firstTriggeredAt === null || r.at < firstTriggeredAt)
                firstTriggeredAt = r.at;
        }
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
            if (triggered) {
                const key = r.reason ?? 'unspecified';
                skipCounts.set(key, (skipCounts.get(key) ?? 0) + 1);
            }
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
        triggeredRuns,
        writes,
        skips,
        errors,
        lastRunAt,
        firstTriggeredAt,
        lastWriteAt,
        lastEntity,
        lastSkipReason,
        dominantSkipReason,
        dominantSkipCount,
        hosts: [...hosts].sort(),
        silent: SILENT_ELIGIBLE_HOOKS.includes(hook)
            && triggeredRuns >= SILENT_HOOK_MIN_RUNS
            && writes === 0,
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
    const silent = input.hooks.filter((h) => h.silent).sort((a, b) => b.triggeredRuns - a.triggeredRuns);
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
        const since = (hook.firstTriggeredAt ?? '').slice(0, 10) || 'install';
        return `memesh: ${hook.hook} ran ${hook.triggeredRuns} times since ${since} and wrote nothing — \`memesh doctor\` for the reason`;
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
//# sourceMappingURL=capture-liveness.js.map