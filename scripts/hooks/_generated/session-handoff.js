// ============================================================================
// AUTO-GENERATED from src/core/session-handoff.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
import { parseSqliteUtcMs } from './time-utils.js';
import { redactMemoryText } from './core-paths.js';
import { codexAssistantText } from './host-transcript.js';
export const SESSION_HANDOFF_TYPE = 'session-handoff';
export const HANDOFF_SESSION_LIMIT = 3;
export const HANDOFF_MAX_BYTES = 600;
export const HANDOFF_TRANSCRIPT_TAIL_BYTES = 256 * 1024;
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
        const codex = codexAssistantText(entry);
        if (codex !== null) {
            if (codex.trim())
                return codex;
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
export const AGENT_TEXT_OMITTED = '[text from an agent message omitted]';
export const AGENT_QUOTE_MIN_CHARS = 24;
const CHANNEL_OPEN = '<channel source="memesh-channel"';
const CHANNEL_TAG_MAX_CHARS = 512;
export const CHANNEL_SCAN_MAX_CHARS = 17 * 1024;
function jsonValueEnd(s, i) {
    while (s[i] === ' ' || s[i] === '\n' || s[i] === '\r' || s[i] === '\t')
        i++;
    if (s[i] !== '{' && s[i] !== '[')
        return -1;
    let depth = 0;
    let inString = false;
    for (let j = i, stop = Math.min(s.length, i + CHANNEL_SCAN_MAX_CHARS); j < stop; j++) {
        const c = s[j];
        if (inString) {
            if (c === '\\')
                j++;
            else if (c === '"')
                inString = false;
            continue;
        }
        if (c === '"')
            inString = true;
        else if (c === '{' || c === '[')
            depth++;
        else if ((c === '}' || c === ']') && --depth === 0)
            return j + 1;
        else if (c === '<')
            return -1;
    }
    return -1;
}
function isEnvelope(o) {
    return typeof o.message_id === 'string' && typeof o.sender === 'string' && o.payload !== undefined && o.payload !== null;
}
function payloadTexts(payload, out, depth = 0) {
    if (depth > 12 || payload === null || payload === undefined)
        return;
    if (typeof payload === 'string') {
        out.add(payload);
        return;
    }
    if (depth === 0)
        out.add(JSON.stringify(payload));
    if (Array.isArray(payload)) {
        for (const v of payload)
            payloadTexts(v, out, depth + 1);
        return;
    }
    if (typeof payload === 'object')
        for (const v of Object.values(payload))
            payloadTexts(v, out, depth + 1);
}
export function agentMessageTexts(jsonl) {
    const found = new Set();
    let unreadTags = 0;
    const walk = (value, depth) => {
        if (depth > 12 || value === null || value === undefined)
            return;
        if (typeof value === 'string') {
            for (let from = value.indexOf(CHANNEL_OPEN); from >= 0; from = value.indexOf(CHANNEL_OPEN, from + 1)) {
                const gt = value.slice(from, from + CHANNEL_TAG_MAX_CHARS).indexOf('>');
                const end = gt < 0 ? -1 : jsonValueEnd(value, from + gt + 1);
                let body;
                try {
                    body = end < 0 ? undefined : JSON.parse(value.slice(from + gt + 1, end));
                }
                catch {
                    body = undefined;
                }
                if (body === undefined) {
                    unreadTags++;
                    continue;
                }
                walk(body, depth + 1);
                from = end - 1;
            }
            const t = value.trim();
            if ((t.startsWith('{') || t.startsWith('[')) && t.includes('"payload"')) {
                try {
                    walk(JSON.parse(t), depth + 1);
                }
                catch { }
            }
            return;
        }
        if (Array.isArray(value)) {
            for (const v of value)
                walk(v, depth + 1);
            return;
        }
        if (typeof value === 'object') {
            const o = value;
            if (isEnvelope(o))
                payloadTexts(o.payload, found);
            for (const v of Object.values(o))
                walk(v, depth + 1);
        }
    };
    for (const raw of String(jsonl ?? '').split('\n')) {
        const line = raw.trim();
        if (!line || (!line.includes('payload') && !line.includes('memesh-channel')))
            continue;
        try {
            walk(JSON.parse(line), 0);
        }
        catch { }
    }
    return { texts: [...found], unreadTags };
}
const isHighSurrogate = (c) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c) => c >= 0xdc00 && c <= 0xdfff;
const PROSE = /[\s\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/;
export function omitAgentMessageText(text, payloads) {
    const src = String(text ?? '');
    const n = AGENT_QUOTE_MIN_CHARS;
    const windows = new Set();
    for (const p of payloads) {
        const s = String(p);
        for (let i = 0; i + n <= s.length; i++)
            windows.add(s.slice(i, i + n));
    }
    if (windows.size === 0 || src.length < n)
        return { text: src, omitted: 0 };
    const covered = new Uint8Array(src.length);
    for (let i = 0; i + n <= src.length; i++)
        if (windows.has(src.slice(i, i + n)))
            covered.fill(1, i, i + n);
    let out = '';
    let omitted = 0;
    for (let i = 0; i < src.length;) {
        if (!covered[i]) {
            out += src[i];
            i++;
            continue;
        }
        const runStart = i;
        while (i < src.length && covered[i])
            i++;
        let start = runStart;
        let end = i;
        if (start > 0 && isLowSurrogate(src.charCodeAt(start)) && isHighSurrogate(src.charCodeAt(start - 1)))
            start++;
        if (end < src.length && isLowSurrogate(src.charCodeAt(end)) && isHighSurrogate(src.charCodeAt(end - 1)))
            end--;
        const run = src.slice(start, end);
        if (run.length >= n && PROSE.test(run.trim())) {
            out += src.slice(runStart, start) + AGENT_TEXT_OMITTED + src.slice(end, i);
            omitted++;
        }
        else {
            out += src.slice(runStart, i);
        }
    }
    return { text: out, omitted };
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
    if (!record)
        return { lines: [], status: 'empty' };
    const text = redactMemoryText(record.text ?? '').replace(/[\s\u0085\u001c-\u001e]+/g, ' ').replace(/</g, '&lt;').trim();
    if (!text)
        return { lines: [], status: 'empty' };
    const then = typeof record.observedAt === 'string' ? parseSqliteUtcMs(record.observedAt) : null;
    const hours = then === null ? null : (now.getTime() - then) / 3_600_000;
    const when = hours === null || !Number.isFinite(hours) || hours < -5 / 60
        ? 'age unknown'
        : ageText(Math.max(0, hours));
    let source = '';
    try {
        const host = JSON.parse(record.metadata ?? 'null')?.provenance?.source_host;
        if (host === 'codex' || host === 'claude-code' || host === 'hermes')
            source = `; source: ${host}`;
    }
    catch { }
    const header = `Last reply from a recent session (${when}${source}): [mem:${record.id}]`;
    const budget = HANDOFF_MAX_BYTES - Buffer.byteLength(header + '\n', 'utf8');
    let tail = text;
    if (Buffer.byteLength(tail, 'utf8') > budget) {
        tail = tail.slice(-budget);
        if (/^[\uDC00-\uDFFF]/u.test(tail))
            tail = tail.slice(1);
        const points = Array.from(tail);
        let bytes = Buffer.byteLength(tail, 'utf8') + 3;
        while (bytes > budget && points.length > 0)
            bytes -= Buffer.byteLength(points.shift(), 'utf8');
        tail = '…' + points.join('');
    }
    return { lines: [header, tail], status: 'shown' };
}
export function handoffLines(record, now = new Date()) {
    return handoffView(record, now).lines;
}
