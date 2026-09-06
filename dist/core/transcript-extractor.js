const META_USER_PREFIX = /^<(local-command|command-name|command-message|command-args|bash-input|bash-stdout|bash-stderr|user-memory-input|system-reminder)/;
function textFromAssistantBlocks(content) {
    if (!Array.isArray(content))
        return [];
    const out = [];
    for (const block of content) {
        if (!block || typeof block !== 'object')
            continue;
        const b = block;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim())
            out.push(b.text.trim());
    }
    return out;
}
function textFromUserContent(content) {
    if (typeof content === 'string') {
        const trimmed = content.trim();
        if (!trimmed || META_USER_PREFIX.test(trimmed))
            return [];
        return [trimmed];
    }
    if (Array.isArray(content)) {
        const out = [];
        for (const block of content) {
            if (!block || typeof block !== 'object')
                continue;
            const b = block;
            if (b.type === 'text' && typeof b.text === 'string')
                out.push(...textFromUserContent(b.text));
        }
        return out;
    }
    return [];
}
function parseConversationContent(content) {
    const turns = [];
    for (const line of content.split('\n')) {
        if (!line.trim())
            continue;
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (entry.type === 'assistant') {
            for (const text of textFromAssistantBlocks(entry.message?.content)) {
                turns.push({ role: 'assistant', text });
            }
        }
        else if (entry.type === 'user') {
            for (const text of textFromUserContent(entry.message?.content)) {
                turns.push({ role: 'user', text });
            }
        }
    }
    return turns;
}
export function parseVisibleConversation(transcript) {
    return parseConversationContent(transcript.toString('utf8'));
}
//# sourceMappingURL=transcript-extractor.js.map