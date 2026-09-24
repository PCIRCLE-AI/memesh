// ============================================================================
// AUTO-GENERATED from src/core/session-handoff.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
import { parseSqliteUtcMs } from './time-utils.js';
export const SESSION_HANDOFF_TYPE = 'session-handoff';
export const HANDOFF_STALE_HOURS = 72;
export const HANDOFF_MAX_AGE_DAYS = 14;
export const HANDOFF_FUTURE_SKEW_MINUTES = 5;
export const HANDOFF_MAX_CHARS = 800;
export const HANDOFF_MIN_CHARS = 80;
export const HANDOFF_TRANSCRIPT_TAIL_BYTES = 256 * 1024;
export function sessionHandoffName(project) {
    return `${SESSION_HANDOFF_TYPE}:${project}`;
}
const FENCE_LINE = /^\s*(`{3,}|~{3,})(.*)$/;
function stripFences(text) {
    const kept = [];
    let open = null;
    for (const line of text.split('\n')) {
        const m = FENCE_LINE.exec(line);
        if (open) {
            if (m && m[1][0] === open.char && m[1].length >= open.len)
                open = null;
            continue;
        }
        if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
            open = { char: m[1][0], len: m[1].length };
            continue;
        }
        kept.push(line);
    }
    return kept.join('\n');
}
export function cleanHandoffText(raw) {
    let text = stripFences(String(raw ?? '').replace(/\r\n?/g, '\n'))
        .split('\n')
        .map((line) => line.trimEnd())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (text.length <= HANDOFF_MAX_CHARS)
        return text;
    text = text.slice(-(HANDOFF_MAX_CHARS - 1));
    const first = text.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff)
        text = text.slice(1);
    const newline = text.indexOf('\n');
    if (newline >= 0 && newline < HANDOFF_MAX_CHARS / 3)
        text = text.slice(newline + 1);
    return `…${text.trim()}`;
}
export function lastAssistantText(jsonl) {
    const lines = String(jsonl ?? '').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line)
            continue;
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (entry?.type !== 'assistant' || entry.isSidechain === true)
            continue;
        if (entry.isApiErrorMessage === true || entry.message?.model === '<synthetic>')
            continue;
        const content = entry.message?.content;
        const text = typeof content === 'string'
            ? content
            : Array.isArray(content)
                ? content
                    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
                    .map((b) => b.text)
                    .join('\n')
                : '';
        if (text.trim())
            return text;
    }
    return null;
}
function ageText(hours) {
    if (hours < 1)
        return 'less than an hour ago';
    if (hours < 24) {
        const h = Math.floor(hours);
        return `${h} hour${h === 1 ? '' : 's'} ago`;
    }
    const d = Math.floor(hours / 24);
    return `${d} day${d === 1 ? '' : 's'} ago`;
}
export function handoffView(record, now = new Date()) {
    const text = record ? cleanHandoffText(record.text ?? '') : '';
    if (!record || !text)
        return { lines: [], status: 'empty' };
    const then = typeof record.observedAt === 'string' ? parseSqliteUtcMs(record.observedAt) : null;
    if (then === null)
        return { lines: [], status: 'undatable' };
    const hours = (now.getTime() - then) / 3_600_000;
    if (hours < -HANDOFF_FUTURE_SKEW_MINUTES / 60)
        return { lines: [], status: 'future' };
    const age = Math.max(0, hours);
    if (age > HANDOFF_MAX_AGE_DAYS * 24)
        return { lines: [], status: 'expired' };
    const stale = age > HANDOFF_STALE_HOURS;
    const when = stale
        ? `${ageText(age)} — may be out of date; check it against the repository`
        : ageText(age);
    return {
        lines: [`Where the last session left off (${when}): [mem:${record.id}]`, ...text.split('\n')],
        status: stale ? 'stale' : 'shown',
    };
}
export function handoffLines(record, now = new Date()) {
    return handoffView(record, now).lines;
}
