import { redactSecrets, redactUserPaths } from './paths.js';
import { EVIDENCE_LAYER_TYPES, isAutoInjectable, topologyLine } from './work-topology.js';
export const INDEX_MAX_LINES = 40;
export const INDEX_MAX_BYTES = 3072;
export const INDEX_STALE_DAYS = 180;
export const INDEX_LINE_MAX_CHARS = 120;
export const INDEX_SNIPPET_FETCH_CHARS = 4000;
export const INDEX_CANDIDATE_CAP = 2000;
export const INDEX_EXCLUDED_TYPES = [...EVIDENCE_LAYER_TYPES, 'task-state'];
export function isIndexableType(type) {
    return !INDEX_EXCLUDED_TYPES.includes(type || 'memory');
}
const DAY_MS = 24 * 60 * 60 * 1000;
function byteLength(text) {
    return new TextEncoder().encode(text).length;
}
function sectionBytes(lines) {
    return lines.reduce((sum, line) => sum + byteLength(line) + 1, 0);
}
function parseActivity(value) {
    if (!value)
        return Number.NaN;
    const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
    return Date.parse(iso);
}
function compareIndexCandidates(a, b) {
    const at = parseActivity(a.lastActivity);
    const bt = parseActivity(b.lastActivity);
    const av = Number.isNaN(at) ? -Infinity : at;
    const bv = Number.isNaN(bt) ? -Infinity : bt;
    if (av !== bv)
        return bv - av;
    return b.id - a.id;
}
function candidateIsAutoInjectable(metadata) {
    if (metadata == null)
        return true;
    if (typeof metadata === 'string') {
        let parsed;
        try {
            parsed = JSON.parse(metadata);
        }
        catch {
            return false;
        }
        return parsed !== null && typeof parsed === 'object' && isAutoInjectable(parsed);
    }
    return isAutoInjectable(metadata);
}
function redact(text) {
    if (!text)
        return '';
    return redactUserPaths(redactSecrets(String(text))).replace(/\s+/g, ' ').trim();
}
function indexLine(candidate) {
    const title = redact(candidate.title);
    const snippet = redact(candidate.snippet);
    const repeats = title && snippet && snippet.toLowerCase().startsWith(title.replace(/…$/, '').toLowerCase());
    const text = title && snippet && !repeats ? `${title} — ${snippet}` : (title || snippet);
    return topologyLine({ name: String(candidate.id), id: candidate.id, type: candidate.type || 'memory', title: text || null }, INDEX_LINE_MAX_CHARS);
}
function indexHeading(projectName) {
    return `Index of durable memories for "${projectName}" (newest first):`;
}
function indexEmptyLine(projectName) {
    return `- No durable memories (decisions, lessons, patterns, references) for "${projectName}" yet.`;
}
function moreLine(n, truncated) {
    return `- ${n}${truncated ? '+' : ''} more — memesh recall --tag "project:…"`;
}
function olderLine(n, truncated) {
    return `- ${n}${truncated ? '+' : ''} older memor${n === 1 ? 'y' : 'ies'} (no change in ${INDEX_STALE_DAYS} days) — recall to see`;
}
function footerLine(shown, bytes, tokens) {
    return `(index cost: ${shown} line${shown === 1 ? '' : 's'}, ${bytes} bytes ≈ ${tokens} tokens; cap ${INDEX_MAX_LINES} lines / ${INDEX_MAX_BYTES} bytes)`;
}
function closeWithFooter(lines, shown) {
    const above = sectionBytes(lines);
    let footer = footerLine(shown, above, Math.ceil(above / 4));
    for (let step = 0; step < 8; step++) {
        const bytes = above + byteLength(footer) + 1;
        const tokens = Math.ceil(bytes / 4);
        const next = footerLine(shown, bytes, tokens);
        if (next === footer)
            return { lines: [...lines, footer], bytes, tokens };
        footer = next;
    }
    throw new Error('briefing index: the footer cost did not converge');
}
export function buildBriefingIndex(candidates, projectName, now, options = {}) {
    const truncated = options.truncated === true;
    const cutoff = now - INDEX_STALE_DAYS * DAY_MS;
    const eligible = candidates
        .filter((c) => isIndexableType(c.type) && candidateIsAutoInjectable(c.metadata))
        .slice()
        .sort(compareIndexCandidates);
    const current = [];
    let older = 0;
    for (const c of eligible) {
        const at = parseActivity(c.lastActivity);
        if (!Number.isNaN(at) && at < cutoff)
            older++;
        else
            current.push(c);
    }
    const heading = indexHeading(projectName);
    if (current.length === 0 && older === 0) {
        const closed = closeWithFooter([heading, indexEmptyLine(projectName)], 0);
        return { ...closed, shown: 0, more: 0, older: 0, truncated, ids: [] };
    }
    const reserve = sectionBytes([
        moreLine(current.length, truncated),
        olderLine(older, truncated),
        footerLine(INDEX_MAX_LINES, INDEX_MAX_BYTES, INDEX_MAX_BYTES),
    ]);
    const budget = INDEX_MAX_BYTES - reserve - sectionBytes([heading]);
    const rendered = [];
    const ids = [];
    let used = 0;
    for (const c of current) {
        if (rendered.length >= INDEX_MAX_LINES)
            break;
        const line = indexLine(c);
        const cost = byteLength(line) + 1;
        if (used + cost > budget)
            break;
        rendered.push(line);
        ids.push(c.id);
        used += cost;
    }
    const more = current.length - rendered.length;
    const above = [heading, ...rendered];
    if (more > 0)
        above.push(moreLine(more, truncated));
    if (older > 0)
        above.push(olderLine(older, truncated));
    const closed = closeWithFooter(above, rendered.length);
    return { ...closed, shown: rendered.length, more, older, truncated, ids };
}
//# sourceMappingURL=briefing-index.js.map