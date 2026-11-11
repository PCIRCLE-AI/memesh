export const AGENT_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
export function agentMessageExpiryCutoff(nowMs = Date.now()) {
    return new Date(nowMs - AGENT_MESSAGE_TTL_MS).toISOString().slice(0, 19).replace('T', ' ');
}
//# sourceMappingURL=agent-message-ttl.js.map