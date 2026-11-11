// =============================================================================
// How long an agent message lives
// =============================================================================
//
// The one definition of the retention rule: a message, read or unread, is kept
// at most one day from the moment it was created, then deleted. Everything that
// has to agree on "is this message still alive" imports it from here — the
// expiry pass that deletes (agent-message-expiry.ts), the readers that must not
// show a message the pass has not reached yet (poll, fetch, the inbox count the
// hooks print, the router's drain).
//
// Leaf module: node builtins only, because the hooks' unread count is a
// mirrored copy (scripts/hooks/_generated/) and has to run without `dist/`.

/** A message is kept at most this long after it was created. */
export const AGENT_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The oldest `created_at` that is still alive at `nowMs`, in SQLite's own
 * `CURRENT_TIMESTAMP` form (`2026-11-03 09:15:00`, UTC), which is how
 * `agent_messages.created_at` and `agent_message_deliveries.created_at` are
 * stored. A row with `created_at < cutoff` has expired. Strings of that form
 * compare in time order, so the comparison can use an index.
 */
export function agentMessageExpiryCutoff(nowMs: number = Date.now()): string {
  return new Date(nowMs - AGENT_MESSAGE_TTL_MS).toISOString().slice(0, 19).replace('T', ' ');
}
