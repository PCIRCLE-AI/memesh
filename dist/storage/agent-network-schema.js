export const NETWORK_METADATA_SCHEMA_SQL = `
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

CREATE TABLE IF NOT EXISTS agent_network_peers (
  machine_id TEXT PRIMARY KEY,
  relay_url TEXT,
  addrs_json TEXT NOT NULL,
  seen_at_ms INTEGER NOT NULL
);
`;
//# sourceMappingURL=agent-network-schema.js.map