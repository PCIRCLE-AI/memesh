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
`;
//# sourceMappingURL=agent-network-schema.js.map