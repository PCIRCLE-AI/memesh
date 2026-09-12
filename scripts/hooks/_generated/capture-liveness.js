// ============================================================================
// AUTO-GENERATED from src/core/capture-liveness.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
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
function readHookOutcomeLines(raw) {
    const entries = [];
    for (const line of raw.split('\n')) {
        const record = parseHookOutcomeLine(line);
        if (record)
            entries.push({ hook: record.hook, triggered: isTriggeredRecord(record), record, line });
    }
    return entries;
}
export const HOOK_OUTCOMES_ROTATE_BYTES = 64 * 1024;
export function serializeHookOutcome(record) {
    return `${JSON.stringify(record)}\n`;
}
export function trimHookOutcomeLines(raw, max = HOOK_OUTCOMES_PER_HOOK, maxBytes = HOOK_OUTCOMES_ROTATE_BYTES) {
    const records = readHookOutcomeLines(raw);
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
    'note-ingest',
    'remember-nudge',
];
export const FAIL_ELIGIBLE_HOOKS = ['session-summary'];
export const SILENT_ELIGIBLE_HOOKS = ['post-commit', 'session-summary', 'pre-compact'];
export const SKIP_REASONS = {
    notBash: 'not a Bash tool call',
    notGitCommit: 'not a git commit command',
    commitLineMissing: 'a git commit ran but printed no commit line',
    alreadyCaptured: 'this session was already captured',
    payloadTooLarge: 'payload exceeded the stdin byte cap',
    toolNameAbsent: 'tool_name absent in payload',
    notDecisionTool: 'not a decision-shaped tool call',
    noSessionId: 'no usable session_id in the payload',
    alreadyNudged: 'already nudged for this tool in this session',
    noBashCommand: 'no Bash command in the payload',
    noDatabaseForGuards: 'no database yet — nothing to guard against',
    noGuardMatched: 'no active guard matched this command',
    autoCaptureOff: 'auto-capture is turned off',
    commitCwdAbsent: 'data.cwd absent — cannot resolve project or repo',
    hashNotACommit: 'the hash is not a commit in this repository',
    noSessionOrTranscript: 'neither session_id nor transcript_path in the payload',
    emptyStdin: 'empty stdin',
    cwdAbsent: 'cwd absent in payload — cannot resolve project',
    notAgenticLoop: 'not an agentic loop',
    transcriptPathAbsent: 'transcript_path absent',
    transcriptGone: 'the transcript file named by the payload is gone',
    tooLittleActivity: 'too little activity in the session to be worth saving',
    noRuleMatched: 'no rule matched (no edited file and fewer than 20 tool calls)',
    allMatchedEntitiesArchived: 'every rule that matched targeted an entity the user forget-archived',
    toolInputAbsent: 'tool_input absent in payload',
    noFilePath: 'no file_path in the tool input',
    noDatabaseForRecall: 'no database yet — nothing to recall',
    nothingToRecall: 'no guard matched and nothing to recall for this file',
    noPromptIntent: 'the prompt carried no remember intent and no update decision',
    noMemoryDir: 'no Claude Code memory directory for this project',
    noNoteChanged: 'no note file changed since the last ingestion',
    noteIngesterNotBuilt: 'the note ingester is not built (dist/core/note-ingest.js is missing)',
    noteNothingNew: 'note files were read and nothing new needed storing',
    noteFilesRefused: 'note files were refused and nothing was stored',
    noTranscript: 'no transcript to read',
    trivialTurn: 'trivial turn — too few tool calls since the last Stop',
    noDecisionMove: 'no decision-shaped move since the last Stop',
    memoryWritten: 'a memory was written since the last Stop',
    noteFileChanged: 'a note file changed since the last Stop',
};
const KNOWN_SKIP_REASONS = new Set(Object.values(SKIP_REASONS));
export const UNRECOGNISED_REASON = 'unrecognised reason';
export function renderableSkipReason(reason) {
    if (reason === undefined)
        return 'unspecified';
    return KNOWN_SKIP_REASONS.has(reason) ? reason : UNRECOGNISED_REASON;
}
export function isGitCommitCommand(command) {
    const start = /(?:^|[\s;&|(`/])git(?=\s)/g;
    let m;
    while ((m = start.exec(command)) !== null) {
        const walk = commitFollowsGit(command, m.index + m[0].length);
        if (walk.commit)
            return true;
        if (walk.end > start.lastIndex)
            start.lastIndex = walk.end;
    }
    return false;
}
const VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const COMMIT_END = /[\s;&|)`]/;
function commitFollowsGit(s, i) {
    for (;;) {
        const afterSpace = skipSpace(s, i);
        if (afterSpace === i)
            return { commit: false, end: i };
        i = afterSpace;
        if (s.startsWith('commit', i)) {
            const next = s[i + 6];
            return { commit: next === undefined || COMMIT_END.test(next), end: i + 6 };
        }
        if (s[i] !== '-')
            return { commit: false, end: i };
        const optionEnd = tokenEnd(s, i);
        const option = s.slice(i, optionEnd);
        i = optionEnd;
        if (VALUE_OPTIONS.has(option)) {
            const valueStart = skipSpace(s, i);
            if (valueStart === i || valueStart >= s.length)
                return { commit: false, end: valueStart };
            i = valueEnd(s, valueStart);
        }
    }
}
function skipSpace(s, i) {
    while (i < s.length && /\s/.test(s[i]))
        i++;
    return i;
}
function tokenEnd(s, i) {
    while (i < s.length && !/\s/.test(s[i]))
        i++;
    return i;
}
function valueEnd(s, i) {
    const quote = s[i];
    if (quote === '"' || quote === "'") {
        const close = s.indexOf(quote, i + 1);
        return close === -1 ? s.length : close + 1;
    }
    return tokenEnd(s, i);
}
export const NOT_TRIGGERED_SKIP_REASONS = {
    'post-commit': [SKIP_REASONS.notBash, SKIP_REASONS.notGitCommit],
    'session-summary': [SKIP_REASONS.alreadyCaptured],
    'note-ingest': [SKIP_REASONS.noNoteChanged],
    'remember-nudge': [SKIP_REASONS.trivialTurn, SKIP_REASONS.noDecisionMove],
};
export const UNCLASSIFIED_SKIP_HOOKS = [
    'pre-compact',
    'pre-edit-recall',
    'user-prompt-intent',
    'decision-nudge',
    'guard-check',
    'session-start',
];
export const NEVER_RAN_GRACE_HOURS = 72;
export function parseHookOutcomes(raw, limit = HOOK_OUTCOMES_PER_HOOK) {
    if (!raw)
        return { hooks: {} };
    const entries = readHookOutcomeLines(raw);
    const keep = windowKeep(entries, limit, HOOK_OUTCOMES_NOT_TRIGGERED_PER_HOOK);
    const hooks = {};
    entries.forEach(({ hook, record }, i) => {
        if (!keep[i])
            return;
        (hooks[hook] ?? (hooks[hook] = [])).push(record);
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
    if (rec.outcome !== 'wrote' && rec.outcome !== 'skipped'
        && rec.outcome !== 'notified' && rec.outcome !== 'error')
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
    let notifies = 0;
    let lastNotifiedAt = null;
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
        else if (r.outcome === 'notified') {
            notifies++;
            if (lastNotifiedAt === null || r.at >= lastNotifiedAt)
                lastNotifiedAt = r.at;
        }
        else if (r.outcome === 'skipped') {
            skips++;
            lastSkipReason = r.reason === undefined ? null : renderableSkipReason(r.reason);
            if (triggered) {
                const key = renderableSkipReason(r.reason);
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
        notifies,
        lastNotifiedAt,
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
