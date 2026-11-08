// ============================================================================
// AUTO-GENERATED from src/storage/agent-network-schema.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
export const AGENT_NETWORK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_network_config (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  network_id       TEXT NOT NULL,
  owner_id         TEXT NOT NULL,
  machine_id       TEXT NOT NULL,
  machine_name     TEXT NOT NULL,
  person           TEXT NOT NULL,
  relay_url        TEXT NOT NULL,
  roster_json      TEXT NOT NULL,
  roster_signature TEXT NOT NULL,
  created_at_ms    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_network_invites (
  hash          TEXT PRIMARY KEY,
  expires_at_ms INTEGER NOT NULL,
  used_at       INTEGER
);

-- One row per delivery addressed to another machine. state: pending, delivered,
-- rejected, expired; or local when the address names no member and the delivery
-- stays an ordinary local one.
CREATE TABLE IF NOT EXISTS agent_network_outbox (
  delivery_id        TEXT PRIMARY KEY REFERENCES agent_message_deliveries(delivery_id) ON DELETE CASCADE,
  message_id         TEXT NOT NULL,
  machine_id         TEXT,
  state              TEXT NOT NULL,
  attempts           INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
  expires_at_ms      INTEGER NOT NULL,
  last_error_code    TEXT,
  delivered_at_ms    INTEGER,
  path               TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_network_outbox_due ON agent_network_outbox(state, next_attempt_at_ms);

-- Who is live on other machines, by project hash only. Expires on its own.
CREATE TABLE IF NOT EXISTS agent_network_presence (
  machine_id    TEXT NOT NULL,
  project_hash  TEXT NOT NULL,
  principal     TEXT NOT NULL,
  handle        TEXT NOT NULL,
  host_kind     TEXT NOT NULL,
  connected     INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (machine_id, project_hash, handle)
);

-- How to reach another member: learned from the invite link and from its presence.
CREATE TABLE IF NOT EXISTS agent_network_peers (
  machine_id  TEXT PRIMARY KEY,
  relay_url   TEXT,
  addrs_json  TEXT NOT NULL,
  seen_at_ms  INTEGER NOT NULL
);
`;
