import { createRequire as __memeshCreateRequire } from 'node:module'; const require = __memeshCreateRequire(import.meta.url);

// dist/network/bridge.js
import path7 from "node:path";

// dist/core/paths.js
import os from "os";
import path from "path";
function homeDir() {
  const home = process.env.HOME;
  if (home && home.length > 0)
    return home;
  const fromOs = os.homedir();
  if (fromOs && fromOs.length > 0)
    return fromOs;
  return os.userInfo().homedir;
}
function memeshDir() {
  return process.env.MEMESH_DIR ?? path.join(homeDir(), ".memesh");
}
function getDbPath() {
  return process.env.MEMESH_DB_PATH ?? path.join(memeshDir(), "knowledge-graph.db");
}
function getMemeshDirFromDbPath() {
  return process.env.MEMESH_DB_PATH ? path.dirname(process.env.MEMESH_DB_PATH) : memeshDir();
}
var PROJECT_HASH_HEX_LENGTH = 32;
var PROJECT_ID_MAX_LENGTH = 200;
var PROJECT_LABEL_MAX_LENGTH = PROJECT_ID_MAX_LENGTH - PROJECT_HASH_HEX_LENGTH - 1;
var SK_KEY = 'sk[-_][^\\s"\\\\]{4,}[A-Za-z0-9]';
var NAMED_VALUE = `(?:api[-_]?key|access[-_]?token|auth[-_]?token|refresh[-_]?token|session[-_]?token|token|secret|password|passwd|pwd|signature)=[^&\\s"'<>]{8,}`;
var JWT_TOKEN = "eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}";
var SENDGRID_KEY = "SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}";
var SECRET_PATTERN_SOURCES = [
  "-----BEGIN[A-Z ]*PRIVATE KEY-----(?:[\\s\\S]*?-----END[A-Z ]*PRIVATE KEY-----|[\\s\\S]*)",
  "(?:postgres|postgresql|mysql|mariadb|mongodb(?:\\+srv)?|redis|rediss|amqp|amqps)://[^\\s:@/]*:[^\\s:@/]+@",
  JWT_TOKEN,
  SENDGRID_KEY,
  "[srp]k_(?:live|test)_[A-Za-z0-9]{16,}",
  "npm_[A-Za-z0-9]{36}",
  `\\b${SK_KEY}`,
  "Bearer(?:\\s|\\\\[nrt])+[A-Za-z0-9_.\\-]{16,}",
  `(?<![A-Za-z0-9])${NAMED_VALUE}`,
  "ghp_[A-Za-z0-9]{30,}",
  "gho_[A-Za-z0-9]{30,}",
  "gh[sur]_[A-Za-z0-9]{30,}",
  "github_pat_[A-Za-z0-9_]{20,}",
  "A(?:KIA|SIA)[A-Z0-9]{16}",
  "AIza[A-Za-z0-9_-]{30,}",
  "xox[baprs]-[A-Za-z0-9-]{10,}"
];
var SECRET_PATTERNS = SECRET_PATTERN_SOURCES.map((s) => new RegExp(s, "gi"));
var SEGMENTED = new Set([SENDGRID_KEY].map((s) => SECRET_PATTERNS[SECRET_PATTERN_SOURCES.indexOf(s)]));
var JWT_PATTERN = SECRET_PATTERNS[SECRET_PATTERN_SOURCES.indexOf(JWT_TOKEN)];
var GLUED = [SK_KEY, NAMED_VALUE].map((s) => new RegExp(s, "iy"));

// dist/network/types.js
import path2 from "node:path";
var JOIN_ALPN = "memesh/join/1";
var NET_ALPN = "memesh/net/1";
var RELAY_OFF = "off";
var EXIT_ALREADY_RUNNING = 3;
var NetworkError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "NetworkError";
    this.code = code;
  }
};
function networkDir(dataDir2) {
  return path2.join(dataDir2, "network");
}
function runtimeDir(dataDir2) {
  return path2.join(networkDir(dataDir2), "runtime");
}
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

// dist/network/endpoint.js
function toBytes(value) {
  return Array.from(typeof value === "string" ? Buffer.from(value) : value);
}
function deadline(promise, ms, label) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}
async function bindEndpoint(iroh, secret, relay, alpns) {
  const builder = iroh.Endpoint.builder();
  builder.applyMinimal();
  builder.secretKey(toBytes(secret));
  builder.relayMode(relay === RELAY_OFF ? iroh.RelayMode.disabled() : iroh.RelayMode.customFromUrls([relay]));
  if (alpns.length > 0)
    builder.alpns(alpns.map((alpn) => toBytes(alpn)));
  return builder.bind();
}

// dist/network/identity.js
import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";
import fs2 from "node:fs";
import path3 from "node:path";

// dist/core/file-mode.js
import fs from "fs";
function shellQuote(value) {
  const word = value.startsWith("-") ? `./${value}` : value;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}
var warned = /* @__PURE__ */ new Set();
function removeGroupAndOtherAccess(target) {
  let stat;
  try {
    stat = fs.statSync(target);
    const mode2 = stat.mode & 4095;
    if ((mode2 & 63) !== 0)
      fs.chmodSync(target, mode2 & ~63);
  } catch (err) {
    const code = err.code;
    if (code === "ENOENT")
      return;
    if (warned.has(target))
      return;
    warned.add(target);
    const notYours = stat !== void 0 && belongsToAnotherUser(stat);
    try {
      process.stderr.write(notYours ? `MeMesh: ${target} belongs to another user, so MeMesh cannot remove other users' access to it (${code}). Point MEMESH_DB_PATH at a database you own, in a folder you own.
` : `MeMesh: could not remove other users' access to ${target} (${code ?? String(err)}); they may be able to read your memories. Fix it with: chmod go-rwx ${shellQuote(target)}
`);
    } catch {
    }
  }
}
function belongsToAnotherUser(stat) {
  return typeof process.getuid === "function" && process.getuid() !== 0 && stat.uid !== process.getuid();
}
function databaseFiles(dbPath) {
  let real = dbPath;
  try {
    if (fs.lstatSync(dbPath).isSymbolicLink())
      real = fs.realpathSync(dbPath);
  } catch {
  }
  return [real, `${real}-wal`, `${real}-shm`];
}
function guardDatabaseFiles(dbPath) {
  for (const target of databaseFiles(dbPath))
    removeGroupAndOtherAccess(target);
  refuseMismatchedSidecars(dbPath);
}
var SIDECAR_PERMISSIONS_CODE = "MEMESH_SIDECAR_PERMISSIONS";
var OWNER_LETTERS = [[256, "r"], [128, "w"], [64, "x"]];
var quoted = (files) => files.map(shellQuote).join(" ");
var letters = (bits) => OWNER_LETTERS.filter(([bit]) => bits & bit).map(([, letter]) => letter).join("");
function refuseMismatchedSidecars(dbPath) {
  if (process.platform === "win32")
    return;
  const [real, wal, shm] = databaseFiles(dbPath);
  const database = fs.statSync(real, { throwIfNoEntry: false });
  if (!database)
    return;
  const fewer = [];
  const extra = [];
  const notYours = [];
  let fewerBits = 0;
  let extraBits = 0;
  for (const sidecar of [wal, shm]) {
    const stat = fs.statSync(sidecar, { throwIfNoEntry: false });
    if (!stat)
      continue;
    const missing = database.mode & ~stat.mode & (stat.size === 0 ? 448 : 384);
    const added = stat.mode & ~database.mode & 448;
    if (missing !== 0) {
      fewer.push(sidecar);
      fewerBits |= missing;
    } else if (added !== 0 && stat.size === 0) {
      extra.push(sidecar);
      extraBits |= added;
    } else
      continue;
    if (belongsToAnotherUser(stat))
      notYours.push(sidecar);
  }
  if (notYours.length === 0 && fewer.length + extra.length > 0 && belongsToAnotherUser(database))
    notYours.push(real);
  if (notYours.length > 0) {
    const fix = "Point MEMESH_DB_PATH at a database you own, in a folder you own.";
    throw Object.assign(new Error(`MeMesh: the owner permissions of ${real} and its ${[...fewer, ...extra].join(" and ")} do not match, and ${notYours.join(" and ")} ${notYours.length > 1 ? "belong" : "belongs"} to another user, so you cannot change them. ${fix}`), { fix, code: SIDECAR_PERMISSIONS_CODE });
  }
  if (fewer.length > 0) {
    const fix = `chmod u+${letters(fewerBits)} ${quoted(fewer)}`;
    const keepReadOnly = fewerBits === 128 ? ` To keep the database read-only instead, run: chmod u-w ${shellQuote(real)}` : "";
    throw Object.assign(new Error(`MeMesh: ${fewer.join(" and ")} ${fewer.length > 1 ? "have" : "has"} fewer owner permissions than ${real}, so opening it would either widen them or leave the database silently read-only. To use the database normally, run: ${fix}.${keepReadOnly}`), { fix, code: SIDECAR_PERMISSIONS_CODE });
  }
  if (extra.length > 0) {
    const fix = `chmod u-${letters(extraBits)} ${quoted(extra)}`;
    throw Object.assign(new Error(`MeMesh: ${extra.join(" and ")} ${extra.length > 1 ? "are" : "is"} empty and ${extra.length > 1 ? "have" : "has"} more owner permissions than ${real}, which SQLite would reset while opening. To read the database as it is, run: ${fix}. To use it normally, run: chmod u+${letters(extraBits)} ${shellQuote(real)}`), { fix, code: SIDECAR_PERMISSIONS_CODE });
  }
}

// dist/network/identity.js
var SEED_BYTES = 32;
var PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
var SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
var MACHINE_ID = /^[0-9a-f]{64}$/;
function isMachineId(value) {
  return typeof value === "string" && MACHINE_ID.test(value);
}
function identityPath(dataDir2) {
  return path3.join(networkDir(dataDir2), "identity.key");
}
function identityFromSeed(secret) {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, secret]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return {
    secret,
    machineId: spki.subarray(-SEED_BYTES).toString("hex"),
    sign: (message) => sign(null, message, privateKey).toString("base64url")
  };
}
function loadIdentity(dataDir2) {
  const file = identityPath(dataDir2);
  let secret;
  try {
    secret = fs2.readFileSync(file);
  } catch (err) {
    const code = err.code;
    throw new NetworkError(code === "ENOENT" ? "not_joined" : "identity_invalid", code === "ENOENT" ? "This machine has not joined a network." : `Cannot read ${file} (${code}).`);
  }
  if (secret.length !== SEED_BYTES) {
    throw new NetworkError("identity_invalid", `${file} is not a valid machine key (${secret.length} bytes, expected ${SEED_BYTES}).`);
  }
  removeGroupAndOtherAccess(file);
  return identityFromSeed(secret);
}
function verifySignature(machineId, message, signature) {
  if (!isMachineId(machineId) || typeof signature !== "string")
    return false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(machineId, "hex")]),
      format: "der",
      type: "spki"
    });
    return verify(null, message, publicKey, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

// dist/network/invites.js
import { createHash, randomBytes as randomBytes2 } from "node:crypto";

// dist/network/roster.js
var SIGNATURE_DOMAIN = "memesh-roster-v1\n";
var MAX_MEMBERS = 256;
var NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var SIGNED_ROSTER_MAX_BYTES = 128 * 1024;
function canonicalJson(value) {
  if (Array.isArray(value))
    return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value;
    const fields = Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value);
}
function assertValidName(kind, value) {
  if (typeof value !== "string" || !NAME.test(value)) {
    throw new NetworkError("invalid_name", `The ${kind} must start with a letter or digit and use only letters, digits, ".", "_" and "-" (at most 64 characters).`);
  }
}
function invalid(detail) {
  return new NetworkError("roster_invalid", `The team list is not valid: ${detail}.`);
}
function parseMember(raw) {
  const member = raw;
  if (member === null || typeof member !== "object")
    throw invalid("a member is not an object");
  if (!isMachineId(member.machine_id))
    throw invalid("a member has a bad machine id");
  try {
    assertValidName("machine name", member.name);
    assertValidName("person", member.person);
  } catch {
    throw invalid("a member has a bad name or person");
  }
  if (typeof member.joined_at !== "string" || !Number.isFinite(Date.parse(member.joined_at))) {
    throw invalid("a member has a bad joined_at");
  }
  return { machine_id: member.machine_id, name: member.name, person: member.person, joined_at: member.joined_at };
}
function parseRoster(rosterJson) {
  let raw;
  try {
    raw = JSON.parse(rosterJson);
  } catch {
    throw invalid("it is not JSON");
  }
  if (raw === null || typeof raw !== "object")
    throw invalid("it is not an object");
  if (typeof raw.network_id !== "string" || raw.network_id.length === 0)
    throw invalid("no network id");
  if (!isMachineId(raw.owner_id))
    throw invalid("bad owner id");
  if (!Number.isSafeInteger(raw.version) || raw.version < 1)
    throw invalid("bad version");
  if (!Number.isSafeInteger(raw.invite_epoch) || raw.invite_epoch < 0)
    throw invalid("bad invite epoch");
  if (!Array.isArray(raw.members) || raw.members.length > MAX_MEMBERS)
    throw invalid("bad member list");
  const members = raw.members.map(parseMember);
  const names = new Set(members.map((member) => member.name.toLowerCase()));
  const ids = new Set(members.map((member) => member.machine_id));
  if (names.size !== members.length)
    throw invalid("two machines share a name");
  if (ids.size !== members.length)
    throw invalid("a machine is listed twice");
  if (!ids.has(raw.owner_id))
    throw invalid("the owner is not a member");
  return {
    network_id: raw.network_id,
    owner_id: raw.owner_id,
    version: raw.version,
    members,
    invite_epoch: raw.invite_epoch
  };
}
function signRoster(identity, roster) {
  const rosterJson = canonicalJson(roster);
  return { roster_json: rosterJson, signature: identity.sign(Buffer.from(SIGNATURE_DOMAIN + rosterJson)) };
}
function verifyRoster(signed, expectedOwnerId, expectedNetworkId) {
  if (typeof signed?.roster_json !== "string" || !verifySignature(expectedOwnerId, Buffer.from(SIGNATURE_DOMAIN + signed.roster_json), signed.signature)) {
    throw new NetworkError("roster_invalid", "The team list is not signed by the network owner.");
  }
  const roster = parseRoster(signed.roster_json);
  if (roster.owner_id !== expectedOwnerId)
    throw invalid("it names a different owner");
  if (roster.network_id !== expectedNetworkId)
    throw invalid("it belongs to a different network");
  return roster;
}
function findMember(roster, machineId) {
  return roster.members.find((member) => member.machine_id === machineId);
}
function addMember(roster, member) {
  const wanted = member.name.toLowerCase();
  if (roster.members.some((existing) => existing.name.toLowerCase() === wanted)) {
    throw new NetworkError("name_taken", `A machine named "${member.name}" is already in this network. Pick another name.`);
  }
  if (roster.members.length >= MAX_MEMBERS) {
    throw new NetworkError("roster_full", `This network already has ${MAX_MEMBERS} machines.`);
  }
  return { ...roster, version: roster.version + 1, members: [...roster.members, member] };
}

// dist/network/invites.js
var MAX_INVITE_TTL_HOURS = 24 * 30;
function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}
function consumeInvite(db, tokenHash, now) {
  const { changes } = db.prepare("UPDATE agent_network_invites SET used_at = ? WHERE hash = ? AND used_at IS NULL AND expires_at_ms > ?").run(now, tokenHash, now);
  if (Number(changes) === 1)
    return;
  const row = db.prepare("SELECT used_at FROM agent_network_invites WHERE hash = ?").get(tokenHash);
  if (!row)
    throw new NetworkError("invite_unknown", "This invite link is not one this network created.");
  if (row.used_at !== null)
    throw new NetworkError("invite_used", "This invite link has already been used. Ask for a new one.");
  throw new NetworkError("invite_expired", "This invite link has expired. Ask for a new one.");
}

// dist/network/store.js
import fs3 from "node:fs";
import path4 from "node:path";

// dist/storage/fts-index.js
var UNSPACED_SCRIPT_RANGES = [
  [3585, 3675],
  [3713, 3807],
  [6016, 6143],
  [13312, 19903],
  [19968, 40959],
  [63744, 64255],
  [12352, 12543],
  [44032, 55215],
  [65382, 65437],
  [131072, 262143]
];
var UNSPACED_SCRIPT_CLASS = UNSPACED_SCRIPT_RANGES.map(([lo, hi]) => `${String.fromCodePoint(lo)}-${String.fromCodePoint(hi)}`).join("");
var UNSPACED_SCRIPT_GLOB_RUN3 = `*[${UNSPACED_SCRIPT_CLASS}][${UNSPACED_SCRIPT_CLASS}][${UNSPACED_SCRIPT_CLASS}]*`;
var UNSPACED_SCRIPT = new RegExp(`[${UNSPACED_SCRIPT_CLASS}]+`, "gu");
var LONE_UNSPACED_CHAR = new RegExp(`[${UNSPACED_SCRIPT_CLASS}]`, "u");

// dist/storage/schema.js
var AGENT_NETWORK_SCHEMA_SQL = `
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
var SCHEMA_SQL = `
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
-- The tags dedup DELETE + idx_tags_entity_tag_unique creation live in
-- ensureTagsUniqueIndex(), AFTER this exec \u2014 the DELETE is a one-time
-- migration, and a DML statement in this string made every open start a
-- write transaction even when it deleted nothing (same reader-breaking
-- pattern as the hook_runs_since note below).
CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity_id);
CREATE INDEX IF NOT EXISTS idx_entities_type_created ON entities(type, created_at);

-- Migration markers and small bits of persistent state.
--
-- This used to be created ad hoc by each helper that needed it \u2014 four inline
-- CREATE TABLE IF NOT EXISTS copies in src/db.ts, none of them visible to
-- schema checks. A column added to one copy would not have been caught. It
-- also meant the hook-side schema had no metadata table at all, so hooks
-- could not participate in migrations even in principle.
CREATE TABLE IF NOT EXISTS memesh_metadata (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Local agent messaging core. Messages are immutable, deliveries identify the
-- authorized recipient, events are the wakeup/catch-up surface, cursors keep
-- the internal sequence opaque, and receipts are append-only facts that remain
-- separate from delivery existence.
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
  -- A tombstone replaces only a terminal payload. The original JSON bytes
  -- are never reconstructed from these fields; they retain enough identity to
  -- audit the erasure while the routing and lifecycle tables remain intact.
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
  -- #497: the one session a principal delivery is meant for (NULL: every
  -- session of that principal). Added by migrateEntitiesSchema on older files.
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

-- Host-native push identity and lifecycle. A principal is stable, a session
-- instance is ephemeral, and every connection to that session gets a strictly
-- increasing generation. The activation checkpoint is intentionally created
-- at first principal registration: principal-targeted history at or before it
-- is durable inbox history, but is never replayed as a first-time host push.
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

-- Dispatch is at-least-once across a crash boundary. delivery_id is the stable
-- adapter dispatch key; attempt_id identifies one invocation. A host_accept is
-- a separate fact and never implies an agent acknowledgement or workflow
-- outcome.
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
CREATE INDEX IF NOT EXISTS idx_agent_dispatch_attempts_delivery
  ON agent_dispatch_attempts(delivery_id, attempt_number);
CREATE INDEX IF NOT EXISTS idx_agent_workflow_facts_delivery_created
  ON agent_workflow_facts(delivery_id, created_at, workflow_fact_id);

-- Proof that a capture hook actually RAN. Nothing else in this schema can
-- give it: every other signal is "a row was written", and "the hook ran and
-- found nothing worth saving" is the healthy case that produces no row at
-- all. So a quiet day and a dead capture loop were byte-identical in the
-- database, and the one doctor message that had to cover both cried wolf on
-- the first and stayed silent on the second.
--
-- Written by the three hooks that hold a read-write handle (Stop, PreCompact,
-- PostToolUse), each calling recordHookRun() at its own SUCCESSFUL exit \u2014
-- after capture, not at open. Stamping at open certified the wrong thing: a
-- hook that opened the database and then died mid-capture looked alive for a
-- day. "Successful" is precise: a completed capture, or a well-formed
-- payload the hook correctly decided not to capture (dedup, low-signal
-- session). A malformed payload (schema-flip shapes) and a write that did
-- not land both leave no stamp \u2014 either would make the heartbeat mask the
-- exact dropout it exists to expose. The recall-side hooks open read-only
-- and deliberately do not appear here: their liveness answers a different
-- question, and giving them a write handle would put a lock acquisition on
-- the SessionStart hot path.
--
-- One row per hook, upserted. It does not grow.
CREATE TABLE IF NOT EXISTS hook_runs (
  hook        TEXT PRIMARY KEY,
  last_run_at TIMESTAMP NOT NULL,
  run_count   INTEGER NOT NULL DEFAULT 0
);

-- The 'hook_runs_since' metadata key (when this database first became able
-- to record hook runs) is stamped by ensureHookRunsSince() AFTER this exec,
-- NOT here. It used to be an INSERT OR IGNORE in this string, and that made
-- every open \u2014 including opens that only ever read \u2014 start a write
-- transaction: an INSERT statement takes the WAL writer lock even when
-- OR IGNORE ends up changing nothing. Two states regressed from "reads work"
-- to "open throws": a peer holding the writer lock past busy_timeout, and a
-- read-only database FILE (measured: "attempt to write a readonly database"
-- killed recall along with capture). The helper SELECTs first and writes
-- only when the key is genuinely absent \u2014 once per database lifetime.
${AGENT_NETWORK_SCHEMA_SQL}`;
var MIGRATION_RETRY_BACKOFF_MS = 24 * 60 * 60 * 1e3;

// dist/storage/sqlite.js
import { createRequire } from "node:module";
function loadNodeSqlite() {
  const require2 = createRequire(import.meta.url);
  const original = process.emitWarning;
  process.emitWarning = function(warning, ...rest) {
    const text = typeof warning === "string" ? warning : String(warning?.message ?? warning);
    if (text.includes("SQLite is an experimental feature"))
      return;
    return original.call(process, warning, ...rest);
  };
  try {
    return require2("node:sqlite");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`memesh needs Node's built-in SQLite, which this runtime (${process.version}) does not provide. It became usable without a flag in Node 22.13.0 \u2014 upgrade Node to 22.13 or newer and run memesh again. (${detail})`, { cause: err });
  } finally {
    process.emitWarning = original;
  }
}
var { DatabaseSync } = loadNodeSqlite();
var BUSY_TIMEOUT_MS = 3e4;
var MemeshDatabase = class extends DatabaseSync {
  #depth = 0;
  constructor(path8, options = {}) {
    super(path8, options);
    this.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  }
  pragma(statement) {
    this.exec(`PRAGMA ${statement}`);
  }
  transaction(fn) {
    const run = (mode2, ...args) => {
      const nested = this.#depth > 0;
      const savepoint = `memesh_sp_${this.#depth}`;
      this.exec(nested ? `SAVEPOINT ${savepoint}` : `BEGIN${mode2}`);
      this.#depth++;
      try {
        const result = fn(...args);
        this.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
        return result;
      } catch (err) {
        try {
          this.exec(nested ? `ROLLBACK TO ${savepoint}` : "ROLLBACK");
          if (nested)
            this.exec(`RELEASE ${savepoint}`);
        } catch {
        }
        throw err;
      } finally {
        this.#depth--;
      }
    };
    const callable = ((...args) => run("", ...args));
    callable.immediate = (...args) => run(" IMMEDIATE", ...args);
    return callable;
  }
};

// dist/network/store.js
function openNetworkStore(dbPath) {
  const dir = path4.dirname(dbPath);
  fs3.mkdirSync(dir, { recursive: true });
  try {
    process.umask(63);
  } catch {
  }
  removeGroupAndOtherAccess(dir);
  guardDatabaseFiles(dbPath);
  const db = new MemeshDatabase(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.exec(AGENT_NETWORK_SCHEMA_SQL);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
function readConfig(db) {
  const row = db.prepare(`SELECT network_id, owner_id, machine_id, machine_name, person, relay_url, roster_json, roster_signature
       FROM agent_network_config WHERE id = 1`).get();
  return row ?? null;
}
function saveRoster(db, signed) {
  db.prepare("UPDATE agent_network_config SET roster_json = ?, roster_signature = ? WHERE id = 1").run(signed.roster_json, signed.signature);
}
function signedRosterOf(config) {
  return { roster_json: config.roster_json, signature: config.roster_signature };
}

// dist/network/join-protocol.js
var JOIN_REQUEST_MAX_BYTES = 4 * 1024;
var JOIN_REPLY_MAX_BYTES = SIGNED_ROSTER_MAX_BYTES + 1024;
function encodeJoinRequest(request) {
  return Buffer.from(JSON.stringify(request));
}
function parseJoinRequest(bytes) {
  let raw;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new NetworkError("bad_request", "The join request is not JSON.");
  }
  if (raw === null || typeof raw !== "object" || typeof raw.network_id !== "string" || typeof raw.token !== "string") {
    throw new NetworkError("bad_request", "The join request is missing fields.");
  }
  assertValidName("machine name", raw.name);
  assertValidName("person", raw.person);
  return { network_id: raw.network_id, token: raw.token, name: raw.name, person: raw.person };
}
function handleJoinRequest(db, identity, remoteMachineId, bytes, now) {
  const decide = db.transaction(() => {
    const config = readConfig(db);
    if (!config || config.owner_id !== identity.machineId) {
      throw new NetworkError("not_owner", "This machine does not own a network.");
    }
    const request = parseJoinRequest(bytes);
    if (request.network_id !== config.network_id) {
      throw new NetworkError("wrong_network", "This link is for a different network.");
    }
    const current = signedRosterOf(config);
    const roster = verifyRoster(current, config.owner_id, config.network_id);
    if (findMember(roster, remoteMachineId))
      return current;
    consumeInvite(db, hashToken(request.token), now);
    const next = signRoster(identity, addMember(roster, {
      machine_id: remoteMachineId,
      name: request.name,
      person: request.person,
      joined_at: new Date(now).toISOString()
    }));
    saveRoster(db, next);
    return next;
  });
  try {
    return { ok: true, roster: decide.immediate() };
  } catch (err) {
    if (err instanceof NetworkError)
      return { ok: false, error: err.code };
    throw new Error(`Join could not be recorded: ${errorMessage(err)}`, { cause: err });
  }
}

// dist/network/native-loader.js
import { createRequire as createRequire2 } from "node:module";
import path5 from "node:path";
function loadNative(runtimeDirectory) {
  const requireFromRuntime = createRequire2(path5.join(runtimeDirectory, "package.json"));
  return requireFromRuntime("@number0/iroh");
}
function explainLoadFailure(err) {
  const messages = [];
  for (let at = err; at instanceof Error && messages.length < 16; at = at.cause) {
    messages.push(at.message);
  }
  const specific = messages.find((message) => /^Unsupported /.test(message));
  if (specific)
    return `this computer is not supported (${specific})`;
  if (messages.length === 1 && err.code === "MODULE_NOT_FOUND") {
    return "the networking component is not installed";
  }
  const mismatch = messages.find((message) => /version mismatch/.test(message));
  if (mismatch)
    return `the installed networking files do not match each other (${mismatch})`;
  const damaged = messages.find((message) => /dlopen|slice is not valid|too short|file too|not a mach-o|invalid ELF|wrong ELF|code signature/i.test(message));
  if (damaged)
    return `the native networking file is damaged or cannot run here (${damaged.split("\n")[0].slice(0, 200)})`;
  if (messages.some((message) => /npm has a bug|Cannot find native binding/.test(message))) {
    return `the native networking file for ${process.platform}-${process.arch} is missing from the install`;
  }
  return errorMessage(err).split("\n")[0];
}

// dist/network/bridge-join.js
var RELAY_ONLINE_DEADLINE_MS = 15e3;
var CONNECT_DEADLINE_MS = 35e3;
var REPLY_DEADLINE_MS = 3e4;
var CLOSE_DEADLINE_MS = 5e3;
var JOIN_CHILD_INPUT_MAX_BYTES = 16 * 1024;
async function runJoinClient(dataDir2, input) {
  const identity = loadIdentity(dataDir2);
  let iroh;
  try {
    iroh = loadNative(runtimeDir(dataDir2));
  } catch (err) {
    return { ok: false, code: "runtime_load_failed", detail: explainLoadFailure(err) };
  }
  const endpoint = await bindEndpoint(iroh, identity.secret, input.own_relay, []);
  try {
    if (input.own_relay !== RELAY_OFF) {
      await deadline(endpoint.online(), RELAY_ONLINE_DEADLINE_MS, "reaching the relay").catch(() => void 0);
    }
    const target = new iroh.EndpointAddr(iroh.EndpointId.fromString(input.owner_id), input.owner_relay, input.owner_addrs);
    let connection;
    try {
      connection = await deadline(endpoint.connect(target, toBytes(JOIN_ALPN)), CONNECT_DEADLINE_MS, "connecting");
    } catch (err) {
      return { ok: false, code: "owner_unreachable", detail: errorMessage(err) };
    }
    const stream = await connection.openBi();
    await stream.send.writeAll(toBytes(encodeJoinRequest(input.request)));
    await stream.send.finish();
    const reply2 = Buffer.from(await deadline(stream.recv.readToEnd(JOIN_REPLY_MAX_BYTES), REPLY_DEADLINE_MS, "waiting for the reply"));
    connection.close(0n, toBytes("done"));
    return { ok: true, reply: reply2.toString("utf8") };
  } catch (err) {
    return { ok: false, code: "owner_unreachable", detail: errorMessage(err) };
  } finally {
    await deadline(endpoint.close(), CLOSE_DEADLINE_MS, "closing the endpoint").catch(() => void 0);
  }
}

// dist/network/bridge-serve.js
import fs5 from "node:fs";

// dist/network/bridge-state.js
import { execFileSync } from "node:child_process";
import fs4 from "node:fs";
import path6 from "node:path";
function statusPath(dataDir2) {
  return path6.join(networkDir(dataDir2), "bridge-status.json");
}
function lockPath(dataDir2) {
  return path6.join(networkDir(dataDir2), "bridge.pid");
}
function logPath(dataDir2) {
  return path6.join(networkDir(dataDir2), "bridge.log");
}
function writeStatus(dataDir2, status) {
  const file = statusPath(dataDir2);
  const temporary = `${file}.tmp-${process.pid}`;
  fs4.writeFileSync(temporary, `${JSON.stringify(status)}
`, { mode: 384 });
  fs4.renameSync(temporary, file);
}
function isBridgeProcess(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "win32")
    return true;
  try {
    const command = execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 5e3 });
    return /bridge\.js serve/.test(command);
  } catch (err) {
    return err.status === void 0;
  }
}
function readLockPid(dataDir2) {
  try {
    const pid = Number(fs4.readFileSync(lockPath(dataDir2), "utf8").trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
function runningBridgePid(dataDir2) {
  const pid = readLockPid(dataDir2);
  return pid !== null && isBridgeProcess(pid) ? pid : null;
}
async function acquireLock(dataDir2) {
  const file = lockPath(dataDir2);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs4.writeFileSync(file, `${process.pid}
`, { flag: "wx", mode: 384 });
    } catch (err) {
      if (err.code !== "EEXIST")
        throw err;
      if (runningBridgePid(dataDir2) !== null)
        return false;
      fs4.rmSync(file, { force: true });
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    return readLockPid(dataDir2) === process.pid;
  }
  return false;
}
function releaseLock(dataDir2) {
  if (readLockPid(dataDir2) === process.pid)
    fs4.rmSync(lockPath(dataDir2), { force: true });
}

// dist/network/bridge-serve.js
var RELAY_ONLINE_DEADLINE_MS2 = 2e4;
var HANDSHAKE_DEADLINE_MS = 2e4;
var STREAM_DEADLINE_MS = 15e3;
var CLOSE_DEADLINE_MS2 = 5e3;
var HEARTBEAT_MS = 1e3;
var STATUS_REFRESH_MS = 3e4;
var LOG_MAX_BYTES = 1024 * 1024;
var MAX_CONCURRENT_CONNECTIONS = 32;
var MEMBER_STUB_MAX_BYTES = 1024;
var MEMBER_STUB_REPLY = JSON.stringify({ ok: false, error: "not_implemented" });
function appendLog(dataDir2, event, detail = {}) {
  try {
    const file = logPath(dataDir2);
    if (fs5.existsSync(file) && fs5.statSync(file).size > LOG_MAX_BYTES)
      fs5.renameSync(file, `${file}.1`);
    fs5.appendFileSync(file, `${JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), pid: process.pid, event, ...detail })}
`, { mode: 384 });
  } catch {
  }
}
async function serve(dataDir2, dbPath) {
  try {
    process.umask(63);
  } catch {
  }
  if (!await acquireLock(dataDir2)) {
    appendLog(dataDir2, "exit_already_running");
    return EXIT_ALREADY_RUNNING;
  }
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  const status = {
    pid: process.pid,
    started_at: startedAt,
    updated_at: startedAt,
    state: "starting",
    relay_state: "off",
    last_error: null,
    last_error_at: null,
    direct_addresses: [],
    joins_accepted: 0,
    joins_refused: 0,
    non_member_refused: 0,
    member_stub_served: 0
  };
  const publish = () => {
    status.updated_at = (/* @__PURE__ */ new Date()).toISOString();
    try {
      writeStatus(dataDir2, status);
    } catch (err) {
      appendLog(dataDir2, "status_write_failed", { error: errorMessage(err) });
    }
  };
  const recordError = (event, message) => {
    status.last_error = message;
    status.last_error_at = (/* @__PURE__ */ new Date()).toISOString();
    appendLog(dataDir2, event, { error: message });
    publish();
  };
  const fail = (event, message) => {
    status.state = "failed";
    recordError(event, message);
    releaseLock(dataDir2);
    return 1;
  };
  publish();
  let db;
  try {
    db = openNetworkStore(dbPath);
  } catch (err) {
    return fail("exit_database", `Cannot open the database: ${errorMessage(err)}`);
  }
  const config = readConfig(db);
  if (!config) {
    db.close();
    return fail("exit_not_joined", "This machine has not joined a network.");
  }
  const isOwner = config.owner_id === config.machine_id;
  let identity;
  try {
    identity = loadIdentity(dataDir2);
  } catch (err) {
    db.close();
    return fail("exit_identity", errorMessage(err));
  }
  if (identity.machineId !== config.machine_id) {
    db.close();
    return fail("exit_identity", "The machine key does not match the one this network was joined with.");
  }
  let iroh;
  try {
    iroh = loadNative(runtimeDir(dataDir2));
  } catch (err) {
    db.close();
    return fail("exit_native", `Cannot load the networking component: ${explainLoadFailure(err)}`);
  }
  let endpoint;
  try {
    endpoint = await bindEndpoint(iroh, identity.secret, config.relay_url, isOwner ? [JOIN_ALPN, NET_ALPN] : [NET_ALPN]);
  } catch (err) {
    db.close();
    return fail("exit_bind", `Cannot open a network connection: ${errorMessage(err)}`);
  }
  status.state = "running";
  status.relay_state = config.relay_url === RELAY_OFF ? "off" : "connecting";
  publish();
  appendLog(dataDir2, "running", { relay_state: status.relay_state, owner: isOwner });
  if (status.relay_state === "connecting") {
    const online = endpoint.online();
    online.then(() => {
      status.relay_state = "online";
      appendLog(dataDir2, "relay_online");
      publish();
    }, (err) => {
      status.relay_state = "unreachable";
      recordError("relay_failed", `The relay failed: ${errorMessage(err)}`);
    });
    setTimeout(() => {
      if (status.relay_state !== "connecting")
        return;
      status.relay_state = "unreachable";
      recordError("relay_unreachable", `The relay ${config.relay_url} did not answer within ${RELAY_ONLINE_DEADLINE_MS2 / 1e3} s.`);
    }, RELAY_ONLINE_DEADLINE_MS2);
  }
  let lastPublished = Date.now();
  const heartbeat = setInterval(() => {
    let addresses = null;
    try {
      addresses = endpoint.addr().directAddresses();
    } catch (err) {
      appendLog(dataDir2, "addresses_failed", { error: errorMessage(err) });
    }
    const changed = addresses !== null && addresses.join() !== status.direct_addresses.join();
    if (changed)
      status.direct_addresses = addresses;
    if (changed || Date.now() - lastPublished >= STATUS_REFRESH_MS) {
      lastPublished = Date.now();
      publish();
    }
  }, HEARTBEAT_MS);
  let stopping = false;
  const stop = async (reason, exitCode) => {
    if (stopping)
      await new Promise(() => {
      });
    stopping = true;
    clearInterval(heartbeat);
    try {
      await deadline(endpoint.close(), CLOSE_DEADLINE_MS2, "closing the endpoint");
    } catch (err) {
      appendLog(dataDir2, "close_failed", { error: errorMessage(err) });
    }
    status.state = exitCode === 0 ? "stopped" : "failed";
    appendLog(dataDir2, "stopped", { reason });
    publish();
    try {
      db.close();
    } catch {
    }
    releaseLock(dataDir2);
    process.exit(exitCode);
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => {
      void stop(signal, 0);
    });
  }
  process.on("uncaughtException", (err) => {
    recordError("uncaught_exception", errorMessage(err));
    void stop("uncaught_exception", 1);
  });
  process.on("unhandledRejection", (err) => {
    recordError("unhandled_rejection", errorMessage(err));
    void stop("unhandled_rejection", 1);
  });
  const finishConnection = async (connection) => {
    await deadline(connection.closed(), CLOSE_DEADLINE_MS2, "waiting for the peer to close").catch(() => void 0);
    connection.close(0n, toBytes("done"));
  };
  const answerJoin = async (connection, remoteId) => {
    const stream = await deadline(connection.acceptBi(), STREAM_DEADLINE_MS, "waiting for the join request");
    const request = Buffer.from(await deadline(stream.recv.readToEnd(JOIN_REQUEST_MAX_BYTES), STREAM_DEADLINE_MS, "reading the join request"));
    let reply2;
    try {
      reply2 = handleJoinRequest(db, identity, remoteId, request, Date.now());
    } catch (err) {
      recordError("join_failed", errorMessage(err));
      reply2 = { ok: false, error: "internal" };
    }
    if (reply2.ok) {
      status.joins_accepted++;
      appendLog(dataDir2, "join_accepted", { machine_id: remoteId });
    } else {
      status.joins_refused++;
      appendLog(dataDir2, "join_refused", { machine_id: remoteId, reason: reply2.error });
    }
    publish();
    await deadline(stream.send.writeAll(toBytes(JSON.stringify(reply2))), STREAM_DEADLINE_MS, "sending the join reply");
    await stream.send.finish();
    await finishConnection(connection);
  };
  const answerMember = async (connection, remoteId) => {
    const current = readConfig(db);
    const roster = current ? parseRoster(current.roster_json) : null;
    if (!roster || !findMember(roster, remoteId)) {
      connection.close(1n, toBytes("not_a_member"));
      status.non_member_refused++;
      appendLog(dataDir2, "non_member_refused", { machine_id: remoteId });
      publish();
      return;
    }
    const stream = await deadline(connection.acceptBi(), STREAM_DEADLINE_MS, "waiting for a member stream");
    await deadline(stream.recv.readToEnd(MEMBER_STUB_MAX_BYTES), STREAM_DEADLINE_MS, "reading a member stream");
    await deadline(stream.send.writeAll(toBytes(MEMBER_STUB_REPLY)), STREAM_DEADLINE_MS, "answering a member");
    await stream.send.finish();
    status.member_stub_served++;
    appendLog(dataDir2, "member_stub_served", { machine_id: remoteId });
    publish();
    await finishConnection(connection);
  };
  const handleIncoming = async (incoming) => {
    let connection;
    try {
      const accepting = await deadline(incoming.accept(), HANDSHAKE_DEADLINE_MS, "accepting a connection");
      connection = await deadline(accepting.connect(), HANDSHAKE_DEADLINE_MS, "the connection handshake");
      const remoteId = connection.remoteId().toString();
      const alpn = Buffer.from(connection.alpn()).toString();
      if (alpn === JOIN_ALPN && isOwner)
        await answerJoin(connection, remoteId);
      else if (alpn === NET_ALPN)
        await answerMember(connection, remoteId);
      else {
        connection.close(2n, toBytes("unknown_protocol"));
        appendLog(dataDir2, "unknown_protocol_refused", { machine_id: remoteId });
      }
    } catch (err) {
      recordError("connection_failed", errorMessage(err));
      try {
        connection?.close(3n, toBytes("error"));
      } catch {
      }
    }
  };
  let inFlight = 0;
  for (; ; ) {
    let incoming;
    try {
      incoming = await endpoint.acceptNext();
    } catch (err) {
      recordError("accept_failed", errorMessage(err));
      return stop("accept_failed", 1);
    }
    if (incoming === null)
      return stop("endpoint_closed", stopping ? 0 : 1);
    if (inFlight >= MAX_CONCURRENT_CONNECTIONS) {
      appendLog(dataDir2, "too_many_connections_refused");
      void incoming.refuse().catch((err) => appendLog(dataDir2, "refuse_failed", { error: errorMessage(err) }));
      continue;
    }
    inFlight++;
    void handleIncoming(incoming).finally(() => {
      inFlight--;
    });
  }
}

// dist/network/bridge.js
function reply(result) {
  return new Promise((resolve) => {
    process.stdout.write(`${JSON.stringify(result)}
`, () => resolve());
  });
}
function check(dataDir2) {
  try {
    loadNative(runtimeDir(dataDir2)).Endpoint.builder();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: explainLoadFailure(err) };
  }
}
async function readBoundedStdin(limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = chunk;
    size += buffer.length;
    if (size > limit)
      throw new Error("input too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
var mode = process.argv[2];
var dataDir = path7.resolve(getMemeshDirFromDbPath());
if (mode === "check") {
  const result = check(dataDir);
  await reply(result);
  process.exit(result.ok ? 0 : 1);
} else if (mode === "join") {
  try {
    const input = JSON.parse(await readBoundedStdin(JOIN_CHILD_INPUT_MAX_BYTES));
    await reply(await runJoinClient(dataDir, input));
    process.exit(0);
  } catch (err) {
    await reply({ ok: false, code: "internal", detail: errorMessage(err) });
    process.exit(1);
  }
} else if (mode === "serve") {
  process.exit(await serve(dataDir, getDbPath()));
} else {
  process.stderr.write("Usage: bridge.js check|join|serve\n");
  process.exit(2);
}
//# sourceMappingURL=bridge.js.map
