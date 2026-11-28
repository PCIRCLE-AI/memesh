-- Historical message schema for migration and repair fixtures.
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  metadata JSON
);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_entity_id INTEGER NOT NULL,
  to_entity_id INTEGER NOT NULL,
  relation_type TEXT NOT NULL,
  metadata JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (from_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
  FOREIGN KEY (to_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
  UNIQUE(from_entity_id, to_entity_id, relation_type)
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tags_entity ON tags(entity_id);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity_id);
CREATE INDEX IF NOT EXISTS idx_entities_type_created ON entities(type, created_at);

CREATE TABLE IF NOT EXISTS memesh_metadata (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_messages (
  message_id         TEXT PRIMARY KEY,
  project            TEXT NOT NULL,
  sender             TEXT NOT NULL,
  sender_host        TEXT,
  recipient          TEXT NOT NULL,
  content_type       TEXT NOT NULL,
  correlation_id     TEXT,
  reply_to_message_id TEXT,
  privacy            TEXT NOT NULL,
  payload_json       TEXT NOT NULL,
  payload_sha256     TEXT,
  payload_original_bytes INTEGER,
  payload_tombstoned_at TIMESTAMP,
  provenance_json    TEXT NOT NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_message_deliveries (
  delivery_id        TEXT PRIMARY KEY,
  message_id         TEXT NOT NULL,
  project            TEXT NOT NULL,
  recipient          TEXT NOT NULL,
  target_kind        TEXT NOT NULL DEFAULT 'principal' CHECK (target_kind IN ('principal', 'session')),
  intended_session   TEXT,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (message_id) REFERENCES agent_messages(message_id) ON DELETE CASCADE,
  UNIQUE(message_id, project, recipient)
);

CREATE TABLE IF NOT EXISTS agent_message_events (
  event_sequence     INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id           TEXT NOT NULL UNIQUE,
  message_id         TEXT NOT NULL,
  delivery_id        TEXT NOT NULL,
  project            TEXT NOT NULL,
  recipient          TEXT NOT NULL,
  event_kind         TEXT NOT NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (message_id) REFERENCES agent_messages(message_id) ON DELETE CASCADE,
  FOREIGN KEY (delivery_id) REFERENCES agent_message_deliveries(delivery_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_message_idempotency (
  project            TEXT NOT NULL,
  sender             TEXT NOT NULL,
  idempotency_key    TEXT NOT NULL,
  request_hash       TEXT NOT NULL,
  message_id         TEXT NOT NULL UNIQUE,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (message_id) REFERENCES agent_messages(message_id) ON DELETE CASCADE,
  PRIMARY KEY(project, sender, idempotency_key)
);

CREATE TABLE IF NOT EXISTS agent_message_cursors (
  cursor_token       TEXT PRIMARY KEY,
  project            TEXT NOT NULL,
  recipient          TEXT NOT NULL,
  event_sequence     INTEGER NOT NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_message_receipts (
  receipt_id         TEXT PRIMARY KEY,
  message_id         TEXT NOT NULL,
  project            TEXT NOT NULL,
  recipient          TEXT NOT NULL,
  receipt_kind       TEXT NOT NULL,
  actor              TEXT NOT NULL,
  idempotency_key    TEXT NOT NULL,
  request_hash       TEXT NOT NULL,
  detail_json        TEXT NOT NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (message_id) REFERENCES agent_messages(message_id) ON DELETE CASCADE,
  UNIQUE(project, recipient, message_id, receipt_kind, idempotency_key)
);

CREATE TABLE IF NOT EXISTS agent_principals (
  project                     TEXT NOT NULL,
  principal_id                TEXT NOT NULL,
  activation_event_sequence   INTEGER NOT NULL,
  created_at                  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(project, principal_id)
);

CREATE TABLE IF NOT EXISTS agent_session_instances (
  project                  TEXT NOT NULL,
  session_instance_id      TEXT NOT NULL,
  principal_id             TEXT NOT NULL,
  adapter_kind             TEXT NOT NULL,
  last_generation          INTEGER NOT NULL DEFAULT 0,
  created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(project, session_instance_id),
  FOREIGN KEY (project, principal_id) REFERENCES agent_principals(project, principal_id)
);

CREATE TABLE IF NOT EXISTS agent_session_connections (
  connection_id            TEXT PRIMARY KEY,
  project                  TEXT NOT NULL,
  principal_id             TEXT NOT NULL,
  session_instance_id      TEXT NOT NULL,
  generation               INTEGER NOT NULL,
  adapter_kind             TEXT NOT NULL,
  router_instance_id       TEXT NOT NULL,
  lease_expires_at_ms      INTEGER NOT NULL,
  connected_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  disconnected_at          TIMESTAMP,
  disconnect_reason        TEXT,
  UNIQUE(project, session_instance_id, generation),
  FOREIGN KEY (project, session_instance_id)
    REFERENCES agent_session_instances(project, session_instance_id)
);

CREATE TABLE IF NOT EXISTS agent_presence_facts (
  presence_fact_id          TEXT PRIMARY KEY,
  project                  TEXT NOT NULL,
  principal_id             TEXT NOT NULL,
  session_instance_id      TEXT NOT NULL,
  connection_id            TEXT NOT NULL,
  generation               INTEGER NOT NULL,
  presence_kind            TEXT NOT NULL CHECK (presence_kind IN ('connected', 'heartbeat', 'disconnected', 'superseded')),
  detail_json              TEXT NOT NULL,
  created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (connection_id) REFERENCES agent_session_connections(connection_id)
);

CREATE TABLE IF NOT EXISTS agent_dispatch_attempts (
  attempt_id               TEXT PRIMARY KEY,
  delivery_id              TEXT NOT NULL,
  project                  TEXT NOT NULL,
  principal_id             TEXT NOT NULL,
  session_instance_id      TEXT NOT NULL,
  connection_id            TEXT NOT NULL,
  generation               INTEGER NOT NULL,
  router_instance_id       TEXT NOT NULL,
  attempt_number           INTEGER NOT NULL,
  result                   TEXT NOT NULL DEFAULT 'started' CHECK (result IN ('started', 'adapter_returned', 'adapter_rejected', 'adapter_failed', 'stale_generation')),
  failure_code             TEXT,
  created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at             TIMESTAMP,
  UNIQUE(delivery_id, attempt_number),
  FOREIGN KEY (delivery_id) REFERENCES agent_message_deliveries(delivery_id) ON DELETE CASCADE,
  FOREIGN KEY (connection_id) REFERENCES agent_session_connections(connection_id)
);

CREATE TABLE IF NOT EXISTS agent_host_accepts (
  host_accept_id           TEXT PRIMARY KEY,
  attempt_id               TEXT NOT NULL UNIQUE,
  delivery_id              TEXT NOT NULL UNIQUE,
  adapter_kind             TEXT NOT NULL,
  receipt_json             TEXT NOT NULL,
  created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (attempt_id) REFERENCES agent_dispatch_attempts(attempt_id),
  FOREIGN KEY (delivery_id) REFERENCES agent_message_deliveries(delivery_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_ack_facts (
  ack_fact_id              TEXT PRIMARY KEY,
  delivery_id              TEXT NOT NULL,
  host_accept_id           TEXT NOT NULL,
  actor                    TEXT NOT NULL,
  idempotency_key          TEXT NOT NULL,
  request_hash             TEXT NOT NULL,
  detail_json              TEXT NOT NULL,
  created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(delivery_id, actor, idempotency_key),
  FOREIGN KEY (delivery_id) REFERENCES agent_message_deliveries(delivery_id) ON DELETE CASCADE,
  FOREIGN KEY (host_accept_id) REFERENCES agent_host_accepts(host_accept_id)
);

CREATE TABLE IF NOT EXISTS agent_workflow_facts (
  workflow_fact_id         TEXT PRIMARY KEY,
  delivery_id              TEXT NOT NULL,
  actor                    TEXT NOT NULL,
  workflow_state           TEXT NOT NULL,
  idempotency_key          TEXT NOT NULL,
  request_hash             TEXT NOT NULL,
  detail_json              TEXT NOT NULL,
  created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(delivery_id, actor, idempotency_key),
  FOREIGN KEY (delivery_id) REFERENCES agent_message_deliveries(delivery_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_retention_facts (
  retention_fact_id        TEXT PRIMARY KEY,
  message_id               TEXT NOT NULL,
  actor                    TEXT NOT NULL,
  retention_state          TEXT NOT NULL,
  idempotency_key          TEXT NOT NULL,
  request_hash             TEXT NOT NULL,
  detail_json              TEXT NOT NULL,
  created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(message_id, actor, idempotency_key),
  FOREIGN KEY (message_id) REFERENCES agent_messages(message_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_message_expiry_runs (
  run_id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at_ms           INTEGER NOT NULL,
  finished_at_ms          INTEGER NOT NULL,
  trigger_source          TEXT NOT NULL,
  outcome                 TEXT NOT NULL,
  expired_message_count   INTEGER NOT NULL DEFAULT 0,
  unread_message_count    INTEGER NOT NULL DEFAULT 0,
  notice_count            INTEGER NOT NULL DEFAULT 0,
  presence_fact_count     INTEGER NOT NULL DEFAULT 0,
  connection_count        INTEGER NOT NULL DEFAULT 0,
  backup_path             TEXT,
  detail                  TEXT
);

CREATE TABLE IF NOT EXISTS agent_message_expiry_lease (
  lease_id                INTEGER PRIMARY KEY CHECK (lease_id = 1),
  holder                  TEXT NOT NULL,
  expires_at_ms           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_message_expiries (
  message_id              TEXT PRIMARY KEY,
  project                 TEXT NOT NULL,
  created_at              TIMESTAMP NOT NULL,
  expired_at_ms           INTEGER NOT NULL,
  was_read                INTEGER NOT NULL,
  notice_message_id       TEXT,
  sender                  TEXT,
  recipient               TEXT,
  network_json            TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_message_events_recipient_sequence
  ON agent_message_events(project, recipient, event_sequence);
CREATE INDEX IF NOT EXISTS idx_agent_message_deliveries_scope
  ON agent_message_deliveries(project, recipient, message_id);
CREATE INDEX IF NOT EXISTS idx_agent_message_receipts_scope
  ON agent_message_receipts(project, recipient, message_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_message_cursors_unique_scope_sequence
  ON agent_message_cursors(project, recipient, event_sequence);
CREATE INDEX IF NOT EXISTS idx_agent_principals_activation
  ON agent_principals(project, activation_event_sequence);
CREATE INDEX IF NOT EXISTS idx_agent_session_connections_active
  ON agent_session_connections(project, principal_id, session_instance_id, lease_expires_at_ms)
  WHERE disconnected_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_agent_message_receipts_message
  ON agent_message_receipts(message_id);
CREATE INDEX IF NOT EXISTS idx_agent_message_events_message
  ON agent_message_events(message_id);
CREATE INDEX IF NOT EXISTS idx_agent_message_events_delivery
  ON agent_message_events(delivery_id);
CREATE INDEX IF NOT EXISTS idx_agent_messages_reply_to
  ON agent_messages(reply_to_message_id) WHERE reply_to_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_messages_created
  ON agent_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_agent_message_expiry_runs_started
  ON agent_message_expiry_runs(started_at_ms);
CREATE INDEX IF NOT EXISTS idx_agent_dispatch_attempts_delivery
  ON agent_dispatch_attempts(delivery_id, attempt_number);
CREATE INDEX IF NOT EXISTS idx_agent_workflow_facts_delivery_created
  ON agent_workflow_facts(delivery_id, created_at, workflow_fact_id);

CREATE TABLE IF NOT EXISTS hook_runs (
  hook        TEXT PRIMARY KEY,
  last_run_at TIMESTAMP NOT NULL,
  run_count   INTEGER NOT NULL DEFAULT 0
);


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


CREATE TABLE IF NOT EXISTS agent_session_aliases (
       session_id          TEXT PRIMARY KEY,
       previous_session_id TEXT NOT NULL UNIQUE,
       created_at_ms       INTEGER NOT NULL
     );
     CREATE TABLE IF NOT EXISTS agent_session_launchers (
       launcher_pid    INTEGER PRIMARY KEY,
       launcher_start  TEXT NOT NULL,
       session_id      TEXT NOT NULL,
       updated_at_ms   INTEGER NOT NULL
     );
