// ============================================================================
// AUTO-GENERATED from src/core/agent-message-ttl.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
export const AGENT_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
export function agentMessageExpiryCutoff(nowMs = Date.now()) {
    return new Date(nowMs - AGENT_MESSAGE_TTL_MS).toISOString().slice(0, 19).replace('T', ' ');
}
