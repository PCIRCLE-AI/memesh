function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
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
//# sourceMappingURL=host-transcript.js.map