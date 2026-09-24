// ============================================================================
// AUTO-GENERATED from src/core/session-handoff.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
export const SESSION_HANDOFF_TYPE = 'session-handoff';
export const HANDOFF_MAX_CHARS = 800;
export const HANDOFF_MIN_CHARS = 80;
export const HANDOFF_TRANSCRIPT_TAIL_BYTES = 256 * 1024;
export function sessionHandoffName(project) {
    return `${SESSION_HANDOFF_TYPE}:${project}`;
}
const FENCED_BLOCK = /^ {0,3}```[^`\n]*\n[\s\S]*?^ {0,3}```[ \t]*$/gm;
const UNCLOSED_FENCE = /^ {0,3}```[^`\n]*(?:\n[\s\S]*)?$/m;
export function cleanHandoffText(raw) {
    let text = String(raw ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(FENCED_BLOCK, '')
        .replace(UNCLOSED_FENCE, '')
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
