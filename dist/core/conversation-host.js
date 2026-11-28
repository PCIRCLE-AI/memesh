function sessionId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value) ? value : undefined;
}
export function mcpConversationSession(host, meta, env = process.env) {
    host = host?.toLowerCase();
    if (host === 'codex' || host === 'codex-mcp-client') {
        return meta && typeof meta === 'object' ? sessionId(meta.threadId) : undefined;
    }
    return host === 'claude-code' ? sessionId(env.CLAUDE_CODE_SESSION_ID) : undefined;
}
//# sourceMappingURL=conversation-host.js.map