// ============================================================================
// AUTO-GENERATED from src/core/host-transcript.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
export function isCodexRollout(transcriptPath) {
    return typeof transcriptPath === 'string' && /(?:^|[\\/])rollout-[^\\/]*\.jsonl(?:\.zst)?$/.test(transcriptPath);
}
export function isCodexToolRequest(entry) {
    const row = record(entry);
    const payload = record(row?.payload);
    return row?.type === 'response_item' && (payload?.type === 'function_call' || payload?.type === 'custom_tool_call');
}
export function codexAssistantText(entry) {
    const row = record(entry);
    const payload = record(row?.payload);
    if (row?.type !== 'response_item' || payload?.type !== 'message' || payload.role !== 'assistant')
        return null;
    const content = payload.content;
    if (!Array.isArray(content))
        return '';
    return content
        .map((block) => { const b = record(block); return b?.type === 'output_text' && typeof b.text === 'string' ? b.text : ''; })
        .filter((text) => text !== '')
        .join('\n');
}
