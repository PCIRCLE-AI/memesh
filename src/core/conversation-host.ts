function sessionId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value) ? value : undefined;
}

/** Codex MCP processes serve multiple chats; identity must come from each call. */
export function mcpConversationSession(host: string | undefined, meta: unknown, env: NodeJS.ProcessEnv = process.env): string | undefined {
  host = host?.toLowerCase();
  if (host === 'codex' || host === 'codex-mcp-client') {
    return meta && typeof meta === 'object' ? sessionId((meta as Record<string, unknown>).threadId) : undefined;
  }
  return host === 'claude-code' ? sessionId(env.CLAUDE_CODE_SESSION_ID) : undefined;
}

