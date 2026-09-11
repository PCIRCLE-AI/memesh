import { createHash } from 'crypto';
import { redactSecrets } from './paths.js';
import { truncateTitle, TITLE_MAX_LENGTH } from './title.js';
export const NOTE_OBSERVATION_MAX_CHARS = 10_000;
export const NOTE_MAX_OBSERVATIONS = 100;
export const NOTE_MAX_CHARS = 20_000;
export const NOTE_DEFAULT_TYPE = 'note';
export function sanitizeNoteText(raw) {
    const normalized = raw.replace(/\r\n?/g, '\n');
    const stripped = normalized.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    return redactSecrets(stripped).trim();
}
function stripLineMarker(line) {
    return line.replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, '').trim();
}
export function splitObservations(body) {
    const out = [];
    for (const block of body.split(/\n\s*\n/)) {
        const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
        if (lines.length === 0)
            continue;
        const isList = lines.every((l) => /^(?:[-*+]\s+|\d+[.)]\s+)/.test(l));
        const parts = isList ? lines.map(stripLineMarker) : [lines.join(' ')];
        for (const part of parts) {
            const text = part.replace(/\s+/g, ' ').trim();
            if (!text)
                continue;
            out.push(text.length > NOTE_OBSERVATION_MAX_CHARS
                ? `${text.slice(0, NOTE_OBSERVATION_MAX_CHARS - 1).trimEnd()}…`
                : text);
        }
    }
    return out;
}
function slugify(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
        .replace(/-+$/g, '');
}
export function deriveNote(raw) {
    const text = sanitizeNoteText(raw);
    if (!text)
        return null;
    const lines = text.split('\n');
    const firstIndex = lines.findIndex((l) => l.trim().length > 0);
    const firstLine = stripLineMarker(lines[firstIndex]).replace(/\s+/g, ' ');
    const rest = lines.slice(firstIndex + 1).join('\n');
    let titleSource = firstLine;
    if (firstLine.length > TITLE_MAX_LENGTH) {
        const sentence = /^(.+?[.!?。！？])(?:\s|$)/.exec(firstLine);
        if (sentence)
            titleSource = sentence[1];
    }
    const title = truncateTitle(titleSource) || 'note';
    const body = splitObservations(rest);
    const observations = title === firstLine && body.length > 0
        ? body
        : [...splitObservations(firstLine), ...body];
    const digest = createHash('sha256').update(text).digest('hex').slice(0, 8);
    const name = `${slugify(title) || NOTE_DEFAULT_TYPE}-${digest}`;
    return { text, title, observations, name };
}
//# sourceMappingURL=note-derive.js.map