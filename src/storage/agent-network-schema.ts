// Cross-machine network tables. Empty for anyone who never ran `memesh network
// create` or `join`. A leaf with no imports and no other table's text: the network
// bridge reaches the database through this file alone, so its bundle carries no
// memory table SQL. schema.ts composes it into SCHEMA_SQL. Invites keep only a
// token's sha256; the token itself is never stored.
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
