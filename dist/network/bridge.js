import { createRequire as __memeshCreateRequire } from 'node:module'; const require = __memeshCreateRequire(import.meta.url);

// dist/network/bridge.js
import path10 from "node:path";

// dist/core/paths.js
import os from "os";
import path from "path";
var AGENT_ROUTER_SOCKET_FILENAME = "agent-router-v2.sock";
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
  return process.env.MEMESH_DIR || path.join(homeDir(), ".memesh");
}
function getDbPath() {
  return process.env.MEMESH_DB_PATH ?? path.join(memeshDir(), "knowledge-graph.db");
}
function getMemeshDirFromDbPath() {
  return process.env.MEMESH_DB_PATH ? path.dirname(process.env.MEMESH_DB_PATH) : memeshDir();
}
function getAgentRouterSocketPath() {
  return path.join(getMemeshDirFromDbPath(), AGENT_ROUTER_SOCKET_FILENAME);
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
  "memesh://join/[A-Za-z0-9_-]{8,}",
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
var EXIT_HOLDER_UNRESPONSIVE = 4;
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
var TEST_BIND_VARIABLE = "MEMESH_TEST_NETWORK_BIND";
function testBindAddress(value) {
  if (value === void 0 || value === "")
    return null;
  const match = /^(?:(\d{1,3}(?:\.\d{1,3}){3})|\[([0-9A-Fa-f:]+)\]):(\d{1,5})$/.exec(value);
  const octetsOk = match?.[1] === void 0 || match[1].split(".").every((octet) => Number(octet) <= 255);
  if (!match || !octetsOk || Number(match[3]) > 65535) {
    throw new Error(`${TEST_BIND_VARIABLE} must be an IP address and port such as 127.0.0.1:0, not ${JSON.stringify(value.slice(0, 80))}; the bridge did not start.`);
  }
  return value;
}
function advertisedAddresses(endpoint, env = process.env) {
  return testBindAddress(env[TEST_BIND_VARIABLE]) === null ? endpoint.addr().directAddresses() : [];
}
async function bindEndpoint(iroh, secret, relay, alpns, env = process.env) {
  const bindAddress = testBindAddress(env[TEST_BIND_VARIABLE]);
  const builder = iroh.Endpoint.builder();
  builder.applyMinimal();
  builder.secretKey(toBytes(secret));
  builder.relayMode(relay === RELAY_OFF ? iroh.RelayMode.disabled() : iroh.RelayMode.customFromUrls([relay]));
  if (alpns.length > 0)
    builder.alpns(alpns.map((alpn) => toBytes(alpn)));
  if (bindAddress !== null)
    builder.bindAddr(bindAddress);
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
function ensureNetworkDir(dataDir2) {
  const dir = networkDir(dataDir2);
  fs2.mkdirSync(dir, { recursive: true, mode: 448 });
  removeGroupAndOtherAccess(dir);
  return dir;
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
var NETWORK_ID = /^[0-9a-f]{32}$/;
var ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
var SIGNED_ROSTER_MAX_BYTES = 128 * 1024;
function canonicalJson(value) {
  if (Array.isArray(value))
    return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value;
    const fields = Object.keys(record).filter((key) => record[key] !== void 0).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value);
}
function isNetworkId(value) {
  return typeof value === "string" && NETWORK_ID.test(value);
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
  if (typeof member.joined_at !== "string" || !ISO_TIMESTAMP.test(member.joined_at) || !Number.isFinite(Date.parse(member.joined_at))) {
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
  if (!isNetworkId(raw.network_id))
    throw invalid("bad network id");
  if (!isMachineId(raw.owner_id))
    throw invalid("bad owner id");
  if (!Number.isSafeInteger(raw.version) || raw.version < 1)
    throw invalid("bad version");
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
    members
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

// dist/storage/agent-network-schema.js
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
  constructor(path11, options = {}) {
    super(path11, options);
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
function openNetworkStore(dbPath, options = {}) {
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
    if (options.busyTimeoutMs !== void 0)
      db.pragma(`busy_timeout = ${options.busyTimeoutMs}`);
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
var OWNER_SIDE_FAULTS = /* @__PURE__ */ new Set(["roster_invalid", "not_owner", "identity_invalid"]);
function encodeJoinRequest(request2) {
  return Buffer.from(JSON.stringify(request2));
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
    const request2 = parseJoinRequest(bytes);
    if (request2.network_id !== config.network_id) {
      throw new NetworkError("wrong_network", "This link is for a different network.");
    }
    const current = signedRosterOf(config);
    const roster = verifyRoster(current, config.owner_id, config.network_id);
    if (findMember(roster, remoteMachineId))
      return current;
    consumeInvite(db, hashToken(request2.token), now);
    const next = signRoster(identity, addMember(roster, {
      machine_id: remoteMachineId,
      name: request2.name,
      person: request2.person,
      joined_at: new Date(now).toISOString()
    }));
    saveRoster(db, next);
    return next;
  });
  try {
    return { ok: true, roster: decide.immediate() };
  } catch (err) {
    if (err instanceof NetworkError && !OWNER_SIDE_FAULTS.has(err.code))
      return { ok: false, error: err.code };
    throw new Error(`Join could not be recorded: ${errorMessage(err)}`, { cause: err });
  }
}

// dist/network/native-loader.js
import fs4 from "node:fs";
import { createRequire as createRequire2 } from "node:module";
import path5 from "node:path";

// dist/network/runtime-platform.js
function currentLibc() {
  if (process.platform !== "linux")
    return null;
  process.report.excludeNetwork = true;
  const header = process.report.getReport();
  return header.header?.glibcVersionRuntime ? "glibc" : "musl";
}
function platformPackages(lockText, platform, arch, libc) {
  const { packages } = JSON.parse(lockText);
  return Object.entries(packages).filter(([, entry]) => entry.os?.includes(platform) && entry.cpu?.includes(arch) && (entry.libc === void 0 || libc === null || entry.libc.includes(libc))).map(([key]) => key.replace(/^node_modules\//, ""));
}
function platformPackage(lockText, platform, arch, libc) {
  const names = platformPackages(lockText, platform, arch, libc);
  return names.find((name) => name.includes("musl") === (libc === "musl")) ?? names[0] ?? null;
}
function nativeFileName(packageName) {
  return `${packageName.split("/").pop().replace(/^iroh-/, "iroh.")}.node`;
}

// dist/network/native-loader.js
function loadNative(runtimeDirectory) {
  const lockText = fs4.readFileSync(path5.join(runtimeDirectory, "package-lock.json"), "utf8");
  const name = platformPackage(lockText, process.platform, process.arch, currentLibc());
  const missing = `the native networking file for ${process.platform}-${process.arch} is missing from the install`;
  if (name === null)
    throw new Error(missing);
  let file;
  try {
    file = fs4.realpathSync(path5.join(runtimeDirectory, "node_modules", name, nativeFileName(name)));
  } catch {
    throw new Error(missing);
  }
  if (!file.startsWith(fs4.realpathSync(runtimeDirectory) + path5.sep)) {
    throw new Error("the native networking file points outside the install, so it was not loaded");
  }
  return createRequire2(path5.join(runtimeDirectory, "package.json"))(file);
}
function explainLoadFailure(err) {
  const message = errorMessage(err).split("\n")[0];
  if (/is missing from the install$|points outside the install/.test(message))
    return message;
  const windowsDamaged = /is not a valid Win32 application|dynamic link library \(DLL\) initialization routine failed/i.test(errorMessage(err));
  if (!windowsDamaged && err.code === "ENOENT")
    return "the networking component is not installed";
  return `the native networking file is damaged or cannot run here (${message.slice(0, 200)})`;
}

// dist/network/bridge-join.js
var RELAY_ONLINE_DEADLINE_MS = 15e3;
var CONNECT_DEADLINE_MS = 35e3;
var SEND_DEADLINE_MS = 1e4;
var REPLY_DEADLINE_MS = 2e4;
var CLOSE_DEADLINE_MS = 5e3;
var JOIN_CHILD_INPUT_MAX_BYTES = 16 * 1024;
async function runJoinClient(dataDir2, input) {
  const identity = loadIdentity(dataDir2);
  let iroh;
  try {
    iroh = loadNative(runtimeDir(dataDir2));
  } catch (err) {
    return { ok: false, code: "runtime_load_failed", detail: explainLoadFailure(err), relay_reached: null };
  }
  const endpoint = await bindEndpoint(iroh, identity.secret, input.own_relay, []);
  let relayReached = null;
  try {
    if (input.own_relay !== RELAY_OFF) {
      relayReached = await deadline(endpoint.online(), RELAY_ONLINE_DEADLINE_MS, "reaching the relay").then(() => true, () => false);
      if (!relayReached && (input.own_relay !== input.owner_relay || !input.owner_addrs?.length)) {
        return { ok: false, code: "relay_unreachable", detail: input.own_relay, relay_reached: false };
      }
    }
    const target = new iroh.EndpointAddr(iroh.EndpointId.fromString(input.owner_id), input.owner_relay, input.owner_addrs);
    let connection;
    try {
      connection = await deadline(endpoint.connect(target, toBytes(JOIN_ALPN)), CONNECT_DEADLINE_MS, "connecting");
    } catch (err) {
      return { ok: false, code: "owner_unreachable", detail: errorMessage(err), relay_reached: relayReached };
    }
    try {
      const stream = await deadline(connection.openBi(), SEND_DEADLINE_MS, "opening a stream");
      await deadline(stream.send.writeAll(toBytes(encodeJoinRequest(input.request))), SEND_DEADLINE_MS, "sending the request");
      await deadline(stream.send.finish(), SEND_DEADLINE_MS, "sending the request");
      const reply2 = Buffer.from(await deadline(stream.recv.readToEnd(JOIN_REPLY_MAX_BYTES), REPLY_DEADLINE_MS, "waiting for the reply"));
      connection.close(0n, toBytes("done"));
      return { ok: true, reply: reply2.toString("utf8"), relay_reached: relayReached };
    } catch (err) {
      return { ok: false, code: "join_interrupted", detail: errorMessage(err), relay_reached: relayReached };
    }
  } finally {
    await deadline(endpoint.close(), CLOSE_DEADLINE_MS, "closing the endpoint").catch(() => void 0);
  }
}

// dist/network/bridge-serve.js
import fs10 from "node:fs";

// dist/network/bridge-state.js
import fs5 from "node:fs";
import path6 from "node:path";
function statusPath(dataDir2) {
  return path6.join(networkDir(dataDir2), "bridge-status.json");
}
function logPath(dataDir2) {
  return path6.join(networkDir(dataDir2), "bridge.log");
}
function writeStatus(dataDir2, status) {
  const file = statusPath(dataDir2);
  const temporary = `${file}.tmp-${process.pid}`;
  fs5.writeFileSync(temporary, `${JSON.stringify(status)}
`, { mode: 384 });
  fs5.renameSync(temporary, file);
}

// dist/network/control-socket.js
import { createHash as createHash2, randomBytes as randomBytes3, timingSafeEqual } from "node:crypto";
import fs6 from "node:fs";
import net from "node:net";
import path7 from "node:path";
var SOCKET_PATH_MAX_BYTES = 103;
var PROBE_DEADLINE_MS = 4e3;
var REQUEST_DEADLINE_MS = 2e3;
var REQUEST_MAX_BYTES = 512;
var REPLY_MAX_BYTES = 8 * 1024;
var STARTUP_LOCK_WAIT_MS = 5e3;
var STARTUP_LOCK_STALE_MS = 3e4;
var STARTUP_LOCK_EMPTY_STALE_MS = 1500;
function controlPath(dataDir2) {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\memesh-bridge-${createHash2("sha256").update(dataDir2).digest("hex").slice(0, 32)}`;
  }
  return path7.join(networkDir(dataDir2), "bridge.sock");
}
function controlPathFits(dataDir2) {
  return Buffer.byteLength(controlPath(dataDir2)) <= SOCKET_PATH_MAX_BYTES;
}
function assertControlPathFits(dataDir2) {
  if (controlPathFits(dataDir2))
    return;
  throw new NetworkError("invalid_option", `The MeMesh data folder's path is too long for this computer's local sockets (${dataDir2}). Use a shorter one with MEMESH_DIR or MEMESH_DB_PATH.`);
}
function dataDirIdentity(dataDir2) {
  try {
    return fs6.realpathSync.native(dataDir2);
  } catch {
    return dataDir2;
  }
}
function tokenPath(dataDir2) {
  return path7.join(networkDir(dataDir2), "control.token");
}
var TOKEN_FORMAT = /^[0-9a-f]{64}$/;
function ensureControlToken(dataDir2) {
  const file = tokenPath(dataDir2);
  const existing = readControlToken(dataDir2);
  if (existing !== null)
    return existing;
  const temporary = `${file}.tmp-${process.pid}`;
  fs6.writeFileSync(temporary, randomBytes3(32).toString("hex"), { mode: 384 });
  try {
    fs6.chmodSync(temporary, 384);
    if (fs6.existsSync(file) && readControlToken(dataDir2) === null)
      fs6.rmSync(file, { force: true });
    fs6.linkSync(temporary, file);
  } catch (err) {
    if (err.code !== "EEXIST")
      throw err;
  } finally {
    fs6.rmSync(temporary, { force: true });
  }
  return readControlToken(dataDir2);
}
function readControlToken(dataDir2) {
  try {
    const token = fs6.readFileSync(tokenPath(dataDir2), "utf8");
    return TOKEN_FORMAT.test(token) ? token : null;
  } catch {
    return null;
  }
}
function tokensMatch(given, expected) {
  if (typeof given !== "string")
    return false;
  const left = createHash2("sha256").update(given).digest();
  return timingSafeEqual(left, createHash2("sha256").update(expected).digest());
}
function parseReply(line2, dataDir2) {
  try {
    const reply2 = JSON.parse(line2);
    const valid = Number.isSafeInteger(reply2?.pid) && reply2?.pid > 0 && typeof reply2?.ready === "boolean";
    return valid && reply2?.data_dir === dataDirIdentity(dataDir2) ? reply2 : null;
  } catch {
    return null;
  }
}
function request(dataDir2, op, deadlineMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection(controlPath(dataDir2));
    let text = "";
    const finish = (result) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), deadlineMs);
    socket.once("connect", () => socket.write(`${JSON.stringify({ op, token: readControlToken(dataDir2) })}
`));
    socket.on("data", (chunk) => {
      text += chunk.toString("utf8");
      if (text.length > REPLY_MAX_BYTES)
        finish(null);
      const newline = text.indexOf("\n");
      if (newline === -1)
        return;
      finish(parseReply(text.slice(0, newline), dataDir2));
    });
    socket.once("error", (err) => {
      finish(["ECONNREFUSED", "ENOENT", "ENOTDIR"].includes(String(err.code)) ? "not-running" : null);
    });
    socket.once("close", () => finish(null));
  });
}
async function probeBridge(dataDir2, deadlineMs = PROBE_DEADLINE_MS) {
  if (!controlPathFits(dataDir2))
    return { kind: "not-running" };
  const reply2 = await request(dataDir2, "hello", deadlineMs);
  if (reply2 === "not-running")
    return { kind: "not-running" };
  return reply2 === null ? { kind: "unresponsive" } : { kind: "running", pid: reply2.pid, ready: reply2.ready };
}
function identityOf(file) {
  try {
    const { dev, ino } = fs6.lstatSync(file);
    return { dev, ino };
  } catch {
    return null;
  }
}
var sameFile = (a, b) => a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
function takeOverStaleLock(lock, judged) {
  const aside = `${lock}.stale-${process.pid}`;
  try {
    fs6.renameSync(lock, aside);
  } catch (err) {
    if (err.code === "ENOENT")
      return;
    throw err;
  }
  try {
    if (sameFile(identityOf(aside), judged))
      return;
    fs6.linkSync(aside, lock);
  } catch (err) {
    if (err.code !== "EEXIST")
      throw err;
  } finally {
    fs6.rmSync(aside, { force: true });
  }
}
async function withStartupLock(dataDir2, use) {
  const lock = path7.join(networkDir(dataDir2), "bridge.sock.startup.lock");
  const giveUpAt = Date.now() + STARTUP_LOCK_WAIT_MS;
  let mine;
  for (; ; ) {
    try {
      const fd = fs6.openSync(lock, "wx", 384);
      const { dev, ino } = fs6.fstatSync(fd);
      mine = { dev, ino };
      fs6.writeSync(fd, `${process.pid}
`);
      fs6.closeSync(fd);
      break;
    } catch (err) {
      if (err.code !== "EEXIST")
        throw err;
      const judged = identityOf(lock);
      if (judged !== null && startupLockIsStale(lock)) {
        takeOverStaleLock(lock, judged);
        continue;
      }
      if (Date.now() >= giveUpAt)
        throw new Error("Another network bridge is starting and did not finish.", { cause: err });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await use(() => sameFile(identityOf(lock), mine));
  } finally {
    if (sameFile(identityOf(lock), mine))
      fs6.rmSync(lock, { force: true });
  }
}
function startupLockIsStale(lock) {
  try {
    const age = Date.now() - fs6.statSync(lock).mtimeMs;
    if (age >= STARTUP_LOCK_STALE_MS)
      return true;
    const raw = fs6.readFileSync(lock, "utf8").trim();
    if (!/^[1-9][0-9]*$/.test(raw))
      return age >= STARTUP_LOCK_EMPTY_STALE_MS;
    process.kill(Number(raw), 0);
    return false;
  } catch (err) {
    return err.code === "ESRCH";
  }
}
function listen(server, target) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      if (err.code === "EADDRINUSE")
        resolve("in-use");
      else
        reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve("listening");
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(target);
  });
}
function removeStaleSocket(target, judged) {
  if (process.platform === "win32")
    return;
  if (!sameFile(identityOf(target), judged))
    return;
  if (!fs6.lstatSync(target).isSocket()) {
    throw new Error(`${target} exists and is not a socket, so the network bridge cannot use it.`);
  }
  fs6.unlinkSync(target);
}
function parseOp(line2, token) {
  try {
    const request2 = JSON.parse(line2);
    if (!tokensMatch(request2.token, token))
      return null;
    return request2.op === "hello" || request2.op === "stop" ? request2.op : null;
  } catch {
    return null;
  }
}
function serveConnection(socket, identity, token, handlers) {
  let text = "";
  socket.setTimeout(REQUEST_DEADLINE_MS, () => socket.destroy());
  socket.on("error", (err) => handlers.onProblem(`Control connection failed: ${err.message}`));
  socket.on("data", (chunk) => {
    text += chunk.toString("utf8");
    if (text.length > REQUEST_MAX_BYTES) {
      socket.destroy();
      return;
    }
    const newline = text.indexOf("\n");
    if (newline === -1)
      return;
    const op = parseOp(text.slice(0, newline), token);
    if (op === null) {
      socket.destroy();
      return;
    }
    const reply2 = { data_dir: identity, pid: process.pid, ready: handlers.isReady() };
    socket.end(`${JSON.stringify(reply2)}
`, () => {
      if (op === "stop")
        handlers.stop();
    });
  });
}
async function holdControlSocket(dataDir2, handlers) {
  assertControlPathFits(dataDir2);
  const identity = dataDirIdentity(dataDir2);
  const target = controlPath(dataDir2);
  for (let attempt = 0; attempt < 5; attempt++) {
    const held = await withStartupLock(dataDir2, async (holdsLock) => {
      const token = ensureControlToken(dataDir2);
      const server = net.createServer((socket) => serveConnection(socket, identity, token, handlers));
      server.on("error", (err) => handlers.onProblem(`Control socket failed: ${err.message}`));
      for (let tries = 0; tries < 3; tries++) {
        if (await listen(server, target) === "listening")
          return heldBy(server, target);
        const judged = identityOf(target);
        const probe = await probeBridge(dataDir2);
        if (probe.kind === "running")
          return { kind: "already-running" };
        if (probe.kind === "unresponsive")
          return { kind: "holder-unresponsive" };
        if (!holdsLock())
          return "lost-the-lock";
        removeStaleSocket(target, judged);
      }
      throw new Error("The network bridge control socket stayed in use.");
    });
    if (held !== "lost-the-lock")
      return held;
  }
  throw new Error("Another network bridge kept taking over the start.");
}
function heldBy(server, target) {
  let bound = identityOf(target);
  const ownership = () => {
    if (process.platform === "win32")
      return "ours";
    let current;
    try {
      const { dev, ino } = fs6.lstatSync(target);
      current = { dev, ino };
    } catch (err) {
      return err.code === "ENOENT" ? "lost" : "unreadable";
    }
    bound ??= current;
    return sameFile(current, bound) ? "ours" : "lost";
  };
  const stillOurs = () => ownership() !== "lost";
  return {
    kind: "held",
    ownership,
    stillOurs,
    close: () => {
      if (stillOurs())
        server.close();
      else
        server.unref();
    }
  };
}

// dist/network/relay-monitor.js
var RELAY_PING_INTERVAL_MS = 15e3;
var RELAY_PING_TIMEOUT_MS = 5e3;
function relayStateOf(signals) {
  if (signals.reachable === false)
    return "unreachable";
  if (signals.online)
    return "online";
  return signals.deadlinePassed ? "unreachable" : "connecting";
}
function relayComplaint(relayUrl) {
  return `The relay ${relayUrl} is not answering.`;
}
function applyRelayState(status, signals, relayUrl) {
  const next = relayStateOf(signals);
  if (next === status.relay_state)
    return false;
  status.relay_state = next;
  if (next === "online" && status.last_error === relayComplaint(relayUrl)) {
    status.last_error = null;
    status.last_error_at = null;
  }
  return true;
}
async function pingRelay(relayUrl, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(new URL("ping", relayUrl), { redirect: "manual", signal: AbortSignal.timeout(RELAY_PING_TIMEOUT_MS) });
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  }
}

// dist/network/test-frame-log.js
import fs7 from "node:fs";
import path8 from "node:path";
function appendTestFrameLog(file, bytes) {
  const folder = path8.dirname(path8.resolve(file));
  let folderStat;
  try {
    folderStat = fs7.lstatSync(folder);
  } catch {
    return `the frame log folder ${folder} does not exist`;
  }
  if (folderStat.isSymbolicLink() || !folderStat.isDirectory())
    return `the frame log folder ${folder} is not a plain folder`;
  if ((folderStat.mode & 63) !== 0)
    return `the frame log folder ${folder} is readable by others`;
  if (typeof process.getuid === "function" && folderStat.uid !== process.getuid())
    return `the frame log folder ${folder} belongs to another user`;
  let fd;
  try {
    fd = fs7.openSync(file, fs7.constants.O_WRONLY | fs7.constants.O_APPEND | fs7.constants.O_CREAT | fs7.constants.O_NOFOLLOW, 384);
  } catch (err) {
    return `the frame log ${file} could not be opened safely (${err.code ?? "error"})`;
  }
  try {
    const stat = fs7.fstatSync(fd);
    if (!stat.isFile())
      return `the frame log ${file} is not a regular file`;
    fs7.fchmodSync(fd, 384);
    fs7.writeSync(fd, `${bytes.toString("utf8")}
`);
    return null;
  } finally {
    fs7.closeSync(fd);
  }
}

// dist/core/agent-router.js
import { randomUUID as randomUUID3 } from "node:crypto";
import fs9 from "node:fs";
import net2 from "node:net";
import path9 from "node:path";

// dist/core/agent-messaging.js
import { createHash as createHash4, randomBytes as randomBytes4, randomUUID as randomUUID2 } from "node:crypto";

// dist/core/agent-message-storage.js
import { createHash as createHash3, randomUUID } from "node:crypto";
import fs8 from "node:fs";

// dist/core/time-utils.js
function parseSqliteUtcMs(sqliteTimestamp) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(sqliteTimestamp ?? "");
  if (!m)
    return null;
  const then = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (!Number.isFinite(then))
    return null;
  const d = new Date(then);
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3] || d.getUTCHours() !== +m[4] || d.getUTCMinutes() !== +m[5] || d.getUTCSeconds() !== +m[6])
    return null;
  return then;
}
function sqliteUtcToIso(sqliteTimestamp) {
  const ms = parseSqliteUtcMs(sqliteTimestamp);
  return ms === null ? sqliteTimestamp : new Date(ms).toISOString().replace(".000Z", "Z");
}

// dist/core/agent-message-storage.js
var TERMINAL_WORKFLOW_STATES = /* @__PURE__ */ new Set(["completed", "cancelled", "rejected"]);
var AgentMessageStorageError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "AgentMessageStorageError";
    this.code = code;
  }
};
var AgentMessageStorageQuotaExceededError = class extends AgentMessageStorageError {
  quotaBytes;
  usedBytes;
  requestedBytes;
  constructor(quotaBytes, usedBytes, requestedBytes) {
    super("storage_quota_exceeded", "Agent message storage quota exceeded. Review stored messages and the owner-configured quota before retrying.");
    this.name = "AgentMessageStorageQuotaExceededError";
    this.quotaBytes = quotaBytes;
    this.usedBytes = usedBytes;
    this.requestedBytes = requestedBytes;
  }
};
function enforceAgentMessageStorageQuota(db, input) {
  const quotaBytes = normalizeNonNegativeInteger("quotaBytes", input.quotaBytes);
  const additionalPayloadBytes = normalizeNonNegativeInteger("additionalPayloadBytes", input.additionalPayloadBytes);
  const row = db.prepare(`
    SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) AS payload_bytes
    FROM agent_messages
  `).get();
  const usedBytes = row.payload_bytes;
  if (usedBytes + additionalPayloadBytes > quotaBytes) {
    throw new AgentMessageStorageQuotaExceededError(quotaBytes, usedBytes, additionalPayloadBytes);
  }
}
function agentMessagePayloadStorageBytes(payloadJson) {
  if (typeof payloadJson !== "string") {
    throw new AgentMessageStorageError("invalid_payload_storage_input", "Agent message payload JSON must be a string.");
  }
  return Buffer.byteLength(payloadJson, "utf8");
}
function normalizeNonNegativeInteger(label, value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AgentMessageStorageError("invalid_storage_quota", `${label} must be a non-negative safe integer.`);
  }
  return value;
}
var AGENT_MESSAGE_TERMINAL_WORKFLOW_STATES = [...TERMINAL_WORKFLOW_STATES];

// dist/core/work-topology.js
var LESSON_TYPES = /* @__PURE__ */ new Set(["lesson_learned", "lesson", "mistake"]);
var LESSON_TYPE_LIST = [...LESSON_TYPES];
var WORK_LAYER_TYPES = /* @__PURE__ */ new Set([
  ...LESSON_TYPES,
  "decision",
  "milestone",
  "pattern",
  "technical_pattern",
  "product_improvement",
  "goal",
  "plan",
  "task-state"
]);
var DECISION_LAYER_TYPES = [...WORK_LAYER_TYPES].filter((type) => !LESSON_TYPES.has(type) && type !== "task-state");
var DEFAULT_TOPOLOGY_BUDGET = {
  maxChars: 4e3,
  maxLineChars: 160
};
var GLOBAL_TOPOLOGY_BUDGET = {
  maxChars: 640,
  maxLineChars: DEFAULT_TOPOLOGY_BUDGET.maxLineChars
};
var SNIPPET_FETCH_CHARS = DEFAULT_TOPOLOGY_BUDGET.maxLineChars * 4;

// dist/core/agent-message-inbox.js
function sessionAliasChain(db, session) {
  const chain = /* @__PURE__ */ new Set([session]);
  try {
    const previous = db.prepare("SELECT previous_session_id AS id FROM agent_session_aliases WHERE lower(session_id) = lower(?)");
    const next = db.prepare("SELECT session_id AS id FROM agent_session_aliases WHERE lower(previous_session_id) = lower(?)");
    for (const step of [previous, next]) {
      let current = session;
      for (; ; ) {
        const row = step.get(current);
        if (typeof row?.id !== "string" || chain.has(row.id))
          break;
        chain.add(row.id);
        current = row.id;
      }
    }
  } catch (err) {
    if (!/no such table: agent_session_aliases\b/.test(errorMessage2(err)))
      throw err;
  }
  return chain;
}
function errorMessage2(err) {
  return err && typeof err === "object" && "message" in err ? String(err.message) : "";
}

// dist/core/agent-scope-id.js
var AGENT_SCOPE_ID_MAX_LENGTH = 200;
var HOST_CONFIG_MAX_BYTES = 64 * 1024;
function canonicalAgentScopeId(value) {
  return value.normalize("NFC").trim();
}
function isFilesystemPathScopeId(value) {
  const v = canonicalAgentScopeId(value);
  if (v.startsWith("/") || v.startsWith("\\"))
    return true;
  return /^[A-Za-z]:[\\/]/.test(v);
}
function lastPathSegment(value) {
  const segments = canonicalAgentScopeId(value).split(/[\\/]+/).filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (last === void 0)
    return null;
  if (/^[A-Za-z]:$/.test(last))
    return null;
  return last;
}
function agentScopeIdRejection(field, value) {
  if (!isFilesystemPathScopeId(value))
    return null;
  const suggestion = lastPathSegment(value);
  const example = suggestion === null ? "reviewer-agent" : suggestion;
  return `${field} must be a stable identifier, not a filesystem path (received ${JSON.stringify(canonicalAgentScopeId(value))}). Use the name on its own, for example ${JSON.stringify(example)}.`;
}
function sessionIdRejection(field, value) {
  const path11 = agentScopeIdRejection(field, value);
  if (path11)
    return path11;
  if (/[\u0080-\uffff]/.test(value)) {
    return `${field} must contain only ASCII characters: a session id is the UUID or thread id its host gives it (received ${JSON.stringify(canonicalAgentScopeId(value))}).`;
  }
  return null;
}
var AGENT_MESSAGE_SCOPE_COLUMNS = [
  { table: "agent_messages", columns: ["project", "recipient"] },
  { table: "agent_message_deliveries", columns: ["project", "recipient"] },
  { table: "agent_message_events", columns: ["project", "recipient"] },
  { table: "agent_message_cursors", columns: ["project", "recipient"] },
  { table: "agent_message_receipts", columns: ["project", "recipient", "actor"] },
  { table: "agent_message_idempotency", columns: ["project"] },
  { table: "agent_ack_facts", columns: ["actor"] },
  { table: "agent_workflow_facts", columns: ["actor"] },
  { table: "agent_retention_facts", columns: ["actor"] }
];
var AGENT_MESSAGE_PROJECT_TABLES = AGENT_MESSAGE_SCOPE_COLUMNS.filter((e) => e.columns.includes("project")).map((e) => e.table);

// dist/core/agent-messaging.js
var MAX_SCOPE_FIELD = AGENT_SCOPE_ID_MAX_LENGTH;
var MAX_IDEMPOTENCY_KEY = 200;
var AGENT_MESSAGE_JSON_MAX_BYTES = 64 * 1024;
var AGENT_NATIVE_MESSAGE_MAX_BYTES = 16 * 1024;
var AgentMessagingError = class extends Error {
};
var AgentIdempotencyConflictError = class extends AgentMessagingError {
};
var AgentConversationLoopError = class extends AgentMessagingError {
  code = "conversation_loop_suspected";
  constructor() {
    super("conversation_loop_suspected: these two agents have exchanged 30 messages within 10 minutes; this may be a loop. Ask your user before continuing. No new message was stored.");
  }
};
var INTENDED_SESSION_ADAPTERS = /* @__PURE__ */ new Set(["claude-channel", "claude-inbox", "codex-cli-queue"]);
function agentHostKind(adapter) {
  if (adapter === "codex-cli-queue" || adapter === "codex-app-server")
    return "codex";
  if (adapter === "claude-channel" || adapter === "claude-inbox")
    return "claude";
  if (adapter === "acp")
    return "gemini";
  return "other";
}
function agentSessionHandle(project, adapter, session) {
  return `${project.split("~")[0]}-${agentHostKind(adapter)}-${session.slice(-4)}`;
}
function resolveAgentSessionHandle(db, project, handle) {
  const rows = db.prepare("SELECT session_instance_id, principal_id, adapter_kind FROM agent_session_instances WHERE project = ?").all(project);
  const matches = rows.filter((row) => agentSessionHandle(project, row.adapter_kind, row.session_instance_id) === handle);
  const available = [...new Set(rows.map((row) => agentSessionHandle(project, row.adapter_kind, row.session_instance_id)))];
  if (matches.length === 0)
    throw new AgentHandleError("handle_not_found", `handle_not_found: No session matches this handle in this project. Discover live agents or use an available handle: ${available.join(", ") || "(none)"}.`);
  if (matches.length > 1)
    throw new AgentHandleError("handle_ambiguous", `handle_ambiguous: This handle matches multiple sessions in this project. Use an exact session id. Available handles: ${available.join(", ")}.`);
  const match = matches[0];
  return INTENDED_SESSION_ADAPTERS.has(match.adapter_kind) ? { recipient: match.principal_id, target_kind: "principal", intended_session: match.session_instance_id } : { recipient: match.session_instance_id, target_kind: "session", intended_session: void 0 };
}
var AgentHandleError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
var AgentIntendedSessionUnsupportedError = class extends AgentMessagingError {
  constructor(session, adapterKind) {
    super(`intended_session ${JSON.stringify(session)} is registered by the ${JSON.stringify(adapterKind)} host, which cannot say which session it is when it records intake. Only Claude Code sessions and Codex CLI threads (claude-channel, claude-inbox, codex-cli-queue, or an id the router never registered) can be named as intended_session.`);
  }
};
function enforceConversationLoopLimit(db, input) {
  const sessions = /* @__PURE__ */ new Map();
  const endpoint = (name, session) => {
    if (typeof session !== "string" || session.length === 0)
      return { principal: name, session: null };
    let canonical = sessions.get(session);
    if (canonical === void 0) {
      const aliases = [...sessionAliasChain(db, session)];
      canonical = aliases.sort()[0];
      for (const alias of aliases)
        sessions.set(alias, canonical);
    }
    return { principal: name, session: canonical };
  };
  const same = (left, right) => left.session !== null && right.session !== null ? left.session === right.session : left.principal === right.principal;
  const from = endpoint(input.sender, input.provenance?.sender_session);
  const to = endpoint(input.recipient, input.intended_session ?? (input.target_kind === "session" ? input.recipient : void 0));
  const cutoff = new Date(Date.now() - 10 * 6e4).toISOString().slice(0, 19).replace("T", " ");
  const recent = db.prepare(`
    SELECT m.sender, m.recipient, m.provenance_json, d.target_kind, d.intended_session
    FROM agent_messages m
    JOIN agent_message_deliveries d ON d.message_id = m.message_id
    WHERE m.project = ? AND m.created_at >= ?
  `).all(input.project, cutoff);
  let count = 0;
  for (const row of recent) {
    const provenance = parseJsonObject(row.provenance_json, "provenance_json");
    if (typeof provenance.fallback_of_message_id === "string")
      continue;
    const rowFrom = endpoint(row.sender, provenance.sender_session);
    const rowTo = endpoint(row.recipient, row.intended_session ?? (row.target_kind === "session" ? row.recipient : void 0));
    if (same(rowFrom, from) && same(rowTo, to) || same(rowFrom, to) && same(rowTo, from)) {
      count += 1;
      if (count >= 30)
        throw new AgentConversationLoopError();
    }
  }
}
function canonicalIntendedSession(db, project, session) {
  const ids = [...sessionAliasChain(db, session)];
  const exact = db.prepare(`SELECT 1 AS present FROM agent_session_instances WHERE project = ? AND session_instance_id IN (${ids.map(() => "?").join(", ")}) LIMIT 1`).get(project, ...ids);
  if (exact !== void 0)
    return session;
  const folded = db.prepare("SELECT session_instance_id FROM agent_session_instances WHERE project = ? AND lower(session_instance_id) = ?").all(project, session.toLowerCase());
  return folded.length === 1 ? folded[0].session_instance_id : session.toLowerCase();
}
function sendAgentMessage(db, input, options = {}) {
  const normalized = normalizeSendInput(options.fallback_of_message_id === void 0 ? input : {
    ...input,
    provenance: { ...input.provenance, fallback_of_message_id: options.fallback_of_message_id }
  });
  const requestedIntendedSession = normalized.intended_session;
  if (normalized.intended_session !== null) {
    normalized.intended_session = canonicalIntendedSession(db, normalized.project, normalized.intended_session);
    const ids = [...sessionAliasChain(db, normalized.intended_session)];
    const registered = db.prepare(`
      SELECT adapter_kind FROM agent_session_instances
      WHERE project = ? AND session_instance_id IN (${ids.map(() => "?").join(", ")})
    `).all(normalized.project, ...ids);
    const unsupported = registered.find((row) => !INTENDED_SESSION_ADAPTERS.has(row.adapter_kind));
    if (unsupported) {
      throw new AgentIntendedSessionUnsupportedError(normalized.intended_session, unsupported.adapter_kind);
    }
  }
  const requestProvenance = { ...normalized.provenance };
  delete requestProvenance.sender_session;
  delete requestProvenance.fallback_of_message_id;
  const requestHash = hashCanonical({
    project: normalized.project,
    sender: normalized.sender,
    recipient: normalized.recipient,
    target_kind: normalized.target_kind,
    ...requestedIntendedSession === null ? {} : { intended_session: requestedIntendedSession },
    idempotency_key: normalized.idempotency_key,
    content_type: normalized.content_type,
    sender_host: normalized.sender_host,
    correlation_id: normalized.correlation_id,
    reply_to: normalized.reply_to,
    privacy: normalized.privacy,
    payload: normalized.payload,
    provenance: requestProvenance
  });
  const messageId = randomUUID2();
  const deliveryId = randomUUID2();
  const eventId = randomUUID2();
  const payloadJson = stableStringify(normalized.payload);
  let reused = false;
  const tx = db.transaction(() => {
    const existing = lookupExistingMessage(db, normalized.project, normalized.sender, normalized.idempotency_key);
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new AgentIdempotencyConflictError(`Agent message idempotency conflict for sender ${normalized.sender} in project ${normalized.project}.`);
      }
      reused = true;
      return existing;
    }
    if (options.fallback_of_message_id === void 0)
      enforceConversationLoopLimit(db, normalized);
    if (options.storage_quota_bytes !== void 0) {
      enforceAgentMessageStorageQuota(db, {
        quotaBytes: options.storage_quota_bytes,
        additionalPayloadBytes: agentMessagePayloadStorageBytes(payloadJson)
      });
    }
    db.prepare(`
      INSERT INTO agent_messages (
        message_id, project, sender, sender_host, recipient, content_type,
        correlation_id, reply_to_message_id, privacy, payload_json, provenance_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(messageId, normalized.project, normalized.sender, normalized.sender_host, normalized.recipient, normalized.content_type, normalized.correlation_id, normalized.reply_to, normalized.privacy, payloadJson, stableStringify(normalized.provenance));
    db.prepare(`
      INSERT INTO agent_message_deliveries (delivery_id, message_id, project, recipient, target_kind, intended_session)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(deliveryId, messageId, normalized.project, normalized.recipient, normalized.target_kind, normalized.intended_session);
    db.prepare(`
      INSERT INTO agent_message_events (event_id, message_id, delivery_id, project, recipient, event_kind)
      VALUES (?, ?, ?, ?, ?, 'message_available')
    `).run(eventId, messageId, deliveryId, normalized.project, normalized.recipient);
    db.prepare(`
      INSERT INTO agent_message_idempotency (project, sender, idempotency_key, request_hash, message_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(normalized.project, normalized.sender, normalized.idempotency_key, requestHash, messageId);
    const stored = loadSentMessage(db, normalized.project, normalized.recipient, messageId);
    if (!stored)
      throw new AgentMessagingError(`Sent agent message ${messageId} could not be read back.`);
    return stored;
  });
  try {
    const sent = finishSentMessage(tx.immediate(), options);
    return reused ? { ...sent, reused: true } : sent;
  } catch (error) {
    if (!isUniqueConstraint(error))
      throw error;
    const raced = lookupExistingMessage(db, normalized.project, normalized.sender, normalized.idempotency_key);
    if (raced && raced.request_hash === requestHash)
      return { ...finishSentMessage(raced, options), reused: true };
    if (raced) {
      throw new AgentIdempotencyConflictError(`Agent message idempotency conflict for sender ${normalized.sender} in project ${normalized.project}.`);
    }
    throw error;
  }
}
function normalizeSendInput(input) {
  const project = requireScopeId("project", input.project);
  const sender = requireText("sender", input.sender, MAX_SCOPE_FIELD);
  const recipient = requireScopeId("recipient", input.recipient);
  const target_kind = parseTargetKind(input.target_kind ?? "principal");
  const intended_session = input.intended_session === void 0 || input.intended_session === null ? null : requireScopeId("intended_session", input.intended_session);
  const sessionRejection = (intended_session !== null ? sessionIdRejection("intended_session", intended_session) : null) ?? (target_kind === "session" ? sessionIdRejection("recipient", recipient) : null);
  if (sessionRejection)
    throw new AgentMessagingError(sessionRejection);
  if (intended_session !== null && target_kind !== "principal") {
    throw new AgentMessagingError('intended_session is only valid with target_kind "principal".');
  }
  const idempotency_key = requireText("idempotency_key", input.idempotency_key, MAX_IDEMPOTENCY_KEY);
  const content_type = parseContentType(input.content_type);
  const sender_host = optionalText("sender_host", input.sender_host ?? null, MAX_SCOPE_FIELD);
  const correlation_id = optionalText("correlation_id", input.correlation_id ?? null, MAX_SCOPE_FIELD);
  const reply_to = optionalText("reply_to", input.reply_to ?? null, MAX_SCOPE_FIELD);
  const privacy = parsePrivacy(input.privacy ?? "private");
  if (content_type === "text/plain" && typeof input.payload !== "string") {
    throw new AgentMessagingError("text/plain agent messages require a string payload.");
  }
  assertJsonValue(input.payload, "payload");
  const payloadBytes = Buffer.byteLength(stableStringify(input.payload), "utf8");
  if (payloadBytes > AGENT_MESSAGE_JSON_MAX_BYTES) {
    throw new AgentMessagingError(`Agent message payload exceeds ${AGENT_MESSAGE_JSON_MAX_BYTES} bytes.`);
  }
  const provenance = input.provenance === void 0 ? {} : normalizeObject(input.provenance);
  const provenanceBytes = Buffer.byteLength(stableStringify(provenance), "utf8");
  if (provenanceBytes > AGENT_MESSAGE_JSON_MAX_BYTES) {
    throw new AgentMessagingError(`Agent message provenance exceeds ${AGENT_MESSAGE_JSON_MAX_BYTES} bytes.`);
  }
  return {
    project,
    sender,
    recipient,
    target_kind,
    intended_session,
    idempotency_key,
    content_type,
    payload: input.payload,
    sender_host,
    correlation_id,
    reply_to,
    privacy,
    provenance
  };
}
function lookupExistingMessage(db, project, sender, idempotencyKey) {
  return db.prepare(`
    SELECT
      i.request_hash,
      m.message_id,
      d.delivery_id,
      e.event_id,
      m.project,
      m.sender,
      m.sender_host,
      d.recipient,
      d.target_kind,
      d.intended_session,
      m.content_type,
      m.correlation_id,
      m.reply_to_message_id,
      m.privacy,
      m.provenance_json,
      m.created_at
    FROM agent_message_idempotency i
    JOIN agent_messages m ON m.message_id = i.message_id
    JOIN agent_message_deliveries d ON d.message_id = m.message_id
    JOIN agent_message_events e ON e.message_id = m.message_id
    WHERE i.project = ? AND i.sender = ? AND i.idempotency_key = ?
    ORDER BY e.event_sequence ASC
    LIMIT 1
  `).get(project, sender, idempotencyKey);
}
function loadSentMessage(db, project, recipient, messageId) {
  return db.prepare(`
    SELECT
      m.message_id,
      d.delivery_id,
      e.event_id,
      m.project,
      m.sender,
      m.sender_host,
      d.recipient,
      d.target_kind,
      d.intended_session,
      m.content_type,
      m.correlation_id,
      m.reply_to_message_id,
      m.privacy,
      m.provenance_json,
      m.created_at
    FROM agent_messages m
    JOIN agent_message_deliveries d ON d.message_id = m.message_id
    JOIN agent_message_events e ON e.message_id = m.message_id
    WHERE m.project = ? AND d.project = ? AND d.recipient = ? AND m.message_id = ?
    ORDER BY e.event_sequence ASC
    LIMIT 1
  `).get(project, project, recipient, messageId);
}
function finishSentMessage(row, options) {
  const sent = rowToSentAgentMessage(row);
  if (!options.notifier)
    return sent;
  try {
    const result = options.notifier.notify({
      delivery_id: sent.delivery_id,
      event_id: sent.event_id,
      project: sent.project,
      target_kind: sent.target_kind,
      target_id: sent.recipient
    });
    if (result && typeof result.then === "function")
      void result.catch(() => void 0);
  } catch {
  }
  return sent;
}
function rowToSentAgentMessage(row) {
  return {
    message_id: row.message_id,
    delivery_id: row.delivery_id,
    event_id: row.event_id,
    project: row.project,
    sender: row.sender,
    sender_host: row.sender_host,
    recipient: row.recipient,
    target_kind: parseTargetKind(row.target_kind),
    intended_session: row.intended_session,
    content_type: parseContentType(row.content_type),
    correlation_id: row.correlation_id,
    reply_to: row.reply_to_message_id,
    privacy: parsePrivacy(row.privacy),
    created_at: sqliteUtcToIso(row.created_at),
    provenance: parseJsonObject(row.provenance_json, "provenance_json")
  };
}
function parsePrivacy(value) {
  if (value === "private" || value === "team")
    return value;
  throw new AgentMessagingError(`Unsupported agent message privacy ${value}.`);
}
function parseContentType(value) {
  if (value === "text/plain" || value === "application/json")
    return value;
  throw new AgentMessagingError(`Unsupported agent message content_type ${value}.`);
}
function parseTargetKind(value) {
  if (value === "principal" || value === "session")
    return value;
  throw new AgentMessagingError(`Unsupported agent message target_kind ${value}.`);
}
function parseJsonObject(json, label) {
  const parsed = parseJsonObjectOrValue(json);
  if (!isPlainObject(parsed))
    throw new AgentMessagingError(`${label} must contain a JSON object.`);
  return parsed;
}
function parseJsonObjectOrValue(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new AgentMessagingError(`Stored agent message JSON is invalid: ${error instanceof Error ? error.message : String(error)}.`);
  }
  assertJsonValue(parsed, "stored_json");
  return parsed;
}
function hashCanonical(value) {
  return createHash4("sha256").update(stableStringify(value)).digest("hex");
}
function stableStringify(value) {
  if (value === null)
    return "null";
  if (typeof value === "boolean")
    return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new AgentMessagingError("Only finite numbers are allowed in agent message JSON.");
    return JSON.stringify(value);
  }
  if (typeof value === "string")
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${entries.join(",")}}`;
}
function assertJsonValue(value, label) {
  if (value === null)
    return;
  if (typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new AgentMessagingError(`${label} must contain only finite numbers.`);
    return;
  }
  if (typeof value === "string")
    return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${label}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      assertJsonValue(entry, `${label}.${key}`);
    }
    return;
  }
  throw new AgentMessagingError(`${label} must be JSON-serializable.`);
}
function normalizeObject(value) {
  assertJsonValue(value, "object");
  return value;
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireText(label, value, maxLength) {
  if (typeof value !== "string")
    throw new AgentMessagingError(`${label} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length === 0)
    throw new AgentMessagingError(`${label} must not be blank.`);
  if (trimmed.length > maxLength) {
    throw new AgentMessagingError(`${label} must be at most ${maxLength} characters.`);
  }
  return trimmed;
}
function requireScopeId(label, value) {
  const text = requireText(label, value, MAX_SCOPE_FIELD);
  const rejection = agentScopeIdRejection(label, text);
  if (rejection)
    throw new AgentMessagingError(rejection);
  return canonicalAgentScopeId(text);
}
function optionalText(label, value, maxLength) {
  if (value === null)
    return null;
  return requireText(label, value, maxLength);
}
function isUniqueConstraint(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed|PRIMARY KEY/i.test(message);
}

// dist/core/agent-router.js
var AGENT_ROUTER_PROTOCOL_VERSION = 2;
var AGENT_ROUTER_MAX_FRAME_BYTES = 64 * 1024;
var AGENT_ROUTER_SOCKET_PATH_MAX_BYTES = 103;
var MAX_LEASE_MS = 5 * 6e4;
var DEFAULT_CLIENT_TIMEOUT_MS = 2e3;
var MAX_FIELD_LENGTH = 200;
var MAX_ADAPTER_RECEIPT_BYTES = 16 * 1024;
var SUPERSEDED_HOLD_MS = 10 * 6e4;
function isLegacyAgentRouterVersionMismatchResponse(value) {
  if (!isPlainObject2(value) || value.version !== 1 || value.request_id !== "" || value.ok !== false)
    return false;
  if (!isPlainObject2(value.error))
    return false;
  return value.error.code === "unsupported_type" || value.error.code === "unsupported_version";
}
var AgentRouterError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
var AgentRouterProtocolError = class extends AgentRouterError {
};
function createAgentRouterNotifier(socketPath) {
  const validatedPath = validateSocketPath(socketPath);
  return {
    async notify(hint) {
      await sendAgentRouterRequest(validatedPath, {
        version: AGENT_ROUTER_PROTOCOL_VERSION,
        type: "notify",
        request_id: randomUUID3(),
        project: hint.project,
        delivery_id: hint.delivery_id,
        hops: 0
      });
    }
  };
}
async function sendAgentRouterRequest(socketPath, request2, timeoutMs = DEFAULT_CLIENT_TIMEOUT_MS) {
  const frame = Buffer.from(`${JSON.stringify(request2)}
`, "utf8");
  if (frame.length > AGENT_ROUTER_MAX_FRAME_BYTES) {
    throw new AgentRouterProtocolError("frame_too_large", "Router request exceeds the byte limit.");
  }
  return new Promise((resolve, reject) => {
    const socket = net2.createConnection(validateSocketPath(socketPath));
    let pending = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => finish(new AgentRouterProtocolError("timeout", "Router request timed out.")), timeoutMs);
    const finish = (error, value) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) {
        reject(error);
      } else if (value === void 0) {
        reject(new AgentRouterProtocolError("invalid_response", "Router response omitted its result object."));
      } else {
        resolve(value);
      }
    };
    socket.on("connect", () => socket.write(frame));
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > AGENT_ROUTER_MAX_FRAME_BYTES) {
        finish(new AgentRouterProtocolError("frame_too_large", "Router response exceeds the byte limit."));
        return;
      }
      const newline = pending.indexOf(10);
      if (newline < 0)
        return;
      try {
        const response = JSON.parse(pending.subarray(0, newline).toString("utf8"));
        if (isLegacyAgentRouterVersionMismatchResponse(response)) {
          throw new AgentRouterProtocolError("router_version_mismatch", "router_version_mismatch: the configured router endpoint uses a stale protocol; restart that router with the current MeMesh version.");
        }
        const uncorrelatedError = response.request_id === "" && response.ok === false && isPlainObject2(response.error) && typeof response.error.code === "string" && typeof response.error.message === "string";
        if (response.version !== AGENT_ROUTER_PROTOCOL_VERSION || response.request_id !== request2.request_id && !uncorrelatedError) {
          throw new AgentRouterProtocolError("invalid_response", "Router response identity does not match.");
        }
        if (!response.ok)
          throw new AgentRouterProtocolError(response.error.code, response.error.message);
        finish(void 0, validateRouterSuccessResult(request2, response.result));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", () => {
      if (!settled)
        finish(new AgentRouterProtocolError("connection_closed", "Router closed without a response."));
    });
  });
}
function validateRouterSuccessResult(request2, value) {
  if (!isPlainObject2(value)) {
    throw new AgentRouterProtocolError("invalid_response", "Router response result must be an object.");
  }
  const requireResultString = (field) => {
    const candidate = value[field];
    if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > MAX_FIELD_LENGTH) {
      throw new AgentRouterProtocolError("invalid_response", `Router response omitted a valid ${field}.`);
    }
    return candidate;
  };
  const requireResultInteger = (field, minimum = 1) => {
    const candidate = value[field];
    if (!Number.isSafeInteger(candidate) || candidate < minimum) {
      throw new AgentRouterProtocolError("invalid_response", `Router response omitted a valid ${field}.`);
    }
    return candidate;
  };
  const requireResultBoolean = (field) => {
    const candidate = value[field];
    if (typeof candidate !== "boolean") {
      throw new AgentRouterProtocolError("invalid_response", `Router response omitted a valid ${field}.`);
    }
    return candidate;
  };
  switch (request2.type) {
    case "register":
      requireResultString("connection_id");
      requireResultInteger("generation");
      requireResultInteger("lease_ms");
      requireResultBoolean("drain_scheduled");
      break;
    case "notify":
      requireResultBoolean("delivered");
      break;
    case "discover":
      if (!Array.isArray(value.cards) || value.cards.length > request2.limit || value.cards.some((card) => !isSelectionCard(card, request2.project))) {
        throw new AgentRouterProtocolError("invalid_response", "Router response contained invalid discovery cards.");
      }
      for (const card of value.cards)
        card.model = null;
      break;
    case "heartbeat":
      requireResultInteger("generation");
      requireResultInteger("lease_ms");
      break;
    case "disconnect":
      if (value.disconnected !== true) {
        throw new AgentRouterProtocolError("invalid_response", "Router response did not confirm disconnect.");
      }
      break;
    case "host_accept":
    case "host_reject":
      if (value.correlated !== true && typeof value.duplicate !== "boolean") {
        throw new AgentRouterProtocolError("invalid_response", "Router response omitted its host-outcome correlation.");
      }
      break;
  }
  return value;
}
function isSelectionCard(value, project) {
  if (!isPlainObject2(value))
    return false;
  return typeof value.session_id === "string" && (value.handle === void 0 || typeof value.handle === "string") && typeof value.principal_id === "string" && ["codex", "claude", "gemini", "other"].includes(String(value.host_kind)) && value.project === project && (value.model === null || typeof value.model === "string") && (value.work_summary === null || typeof value.work_summary === "string") && value.active === true && Number.isSafeInteger(value.generation) && value.generation >= 1 && Number.isSafeInteger(value.lease_expires_at_ms) && value.lease_expires_at_ms >= 0;
}
function validateSocketPath(socketPath) {
  if (typeof socketPath !== "string" || !path9.isAbsolute(socketPath) || Buffer.byteLength(socketPath) > AGENT_ROUTER_SOCKET_PATH_MAX_BYTES) {
    throw new AgentRouterProtocolError("invalid_socket_path", `Router socket path must be absolute and at most ${AGENT_ROUTER_SOCKET_PATH_MAX_BYTES} bytes.`);
  }
  return socketPath;
}
function isPlainObject2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// dist/network/courier.js
import { createHash as createHash6 } from "node:crypto";

// dist/network/address.js
import { createHash as createHash5 } from "node:crypto";
var TARGET = /^[^/@\s]{1,200}$/;
function parseNetworkAddress(value) {
  const at = value.lastIndexOf("@");
  if (at <= 0)
    return null;
  const machine = value.slice(at + 1);
  const left = value.slice(0, at);
  const slash = left.indexOf("/");
  if (slash <= 0)
    return null;
  const person = left.slice(0, slash);
  const target = left.slice(slash + 1);
  if (!NAME.test(person) || !NAME.test(machine) || !TARGET.test(target))
    return null;
  return { person, target, machine };
}
function formatNetworkAddress(person, target, machine) {
  return `${person}/${target}@${machine}`;
}
function projectHash(networkId, project) {
  return createHash5("sha256").update(`${networkId}:${project}`).digest("hex");
}
function isLocalSenderName(value) {
  return TARGET.test(value);
}

// dist/network/frames.js
var FRAME_VERSION = 1;
var FRAME_MAX_BYTES = AGENT_MESSAGE_JSON_MAX_BYTES + 8 * 1024;
var ACK_MAX_BYTES = 1024;
var PRESENCE_MAX_ENTRIES = 256;
var FIELD_MAX = 200;
var MESSAGE_FRAME_KEYS = [
  "version",
  "kind",
  "project_hash",
  "sender",
  "target",
  "target_kind",
  "idempotency_key",
  "content_type",
  "payload",
  "correlation_id",
  "reply_to_origin",
  "origin_message_id",
  "created_at"
];
var PRESENCE_FRAME_KEYS = ["version", "kind", "relay", "addrs", "entries"];
var PRESENCE_ENTRY_KEYS = ["project_hash", "principal", "handle", "host_kind", "connected"];
var FrameError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
var HASH = /^[0-9a-f]{64}$/;
var isText = (value, max = FIELD_MAX) => typeof value === "string" && value.length > 0 && value.length <= max;
var isOptionalText = (value) => value === null || isText(value);
function exactKeys(value, keys) {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function parseFrame(bytes) {
  if (bytes.length > FRAME_MAX_BYTES)
    throw new FrameError("frame_too_large", "The frame is too large.");
  let raw;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new FrameError("frame_invalid", "The frame is not JSON.");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || raw.version !== FRAME_VERSION) {
    throw new FrameError("frame_invalid", "The frame has no supported version.");
  }
  if (raw.kind === "message") {
    if (!exactKeys(raw, MESSAGE_FRAME_KEYS))
      throw new FrameError("frame_invalid", "The message frame has other keys than allowed.");
    const ok = isText(raw.project_hash) && HASH.test(raw.project_hash) && isText(raw.sender) && !/[/@\s]/.test(raw.sender) && isText(raw.target) && raw.target_kind === "principal" && isText(raw.idempotency_key, 300) && (raw.content_type === "text/plain" || raw.content_type === "application/json") && isOptionalText(raw.correlation_id) && isOptionalText(raw.reply_to_origin) && isText(raw.origin_message_id) && isText(raw.created_at, 40) && Buffer.byteLength(JSON.stringify(raw.payload ?? null)) <= AGENT_MESSAGE_JSON_MAX_BYTES;
    if (!ok)
      throw new FrameError("frame_invalid", "The message frame has a field of the wrong shape.");
    return raw;
  }
  if (raw.kind === "presence") {
    if (!exactKeys(raw, PRESENCE_FRAME_KEYS))
      throw new FrameError("frame_invalid", "The presence frame has other keys than allowed.");
    const entries = raw.entries;
    const addrs = raw.addrs;
    const ok = isOptionalText(raw.relay) && Array.isArray(addrs) && addrs.length <= 64 && addrs.every((addr) => isText(addr, 64)) && Array.isArray(entries) && entries.length <= PRESENCE_MAX_ENTRIES && entries.every((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry) && exactKeys(entry, PRESENCE_ENTRY_KEYS) && HASH.test(String(entry.project_hash)) && isText(entry.principal) && isText(entry.handle) && isText(entry.host_kind, 20) && typeof entry.connected === "boolean");
    if (!ok)
      throw new FrameError("frame_invalid", "The presence frame has a field of the wrong shape.");
    return raw;
  }
  throw new FrameError("frame_invalid", "The frame kind is unknown.");
}
function encodeFrame(frame) {
  return Buffer.from(JSON.stringify(frame));
}
function parseAck(bytes) {
  try {
    const raw = JSON.parse(bytes.toString("utf8"));
    if (["accepted", "duplicate", "rejected", "retry"].includes(String(raw.result))) {
      return { result: raw.result, ...typeof raw.code === "string" ? { code: raw.code.slice(0, 64) } : {} };
    }
  } catch {
  }
  return { result: "retry", code: "ack_invalid" };
}

// dist/network/outbound.js
var PRESENCE_TTL_MS = 3 * 6e4;

// dist/network/courier.js
var DELIVERY_WINDOW_MS = 24 * 60 * 6e4;
var BACKOFF_FIRST_MS = 5e3;
var BACKOFF_MAX_MS = 5 * 6e4;
var NOTICE_SENDER = "memesh-network";
function hasTable(db, name) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== void 0;
}
function messagingAvailable(db) {
  return hasTable(db, "agent_messages") && hasTable(db, "agent_message_deliveries");
}
function enqueueOutgoing(db, joined, now) {
  const rows = db.prepare(`
    SELECT d.delivery_id, d.message_id, d.recipient, m.created_at
    FROM agent_message_deliveries d
    JOIN agent_messages m ON m.message_id = d.message_id
    LEFT JOIN agent_network_outbox o ON o.delivery_id = d.delivery_id
    WHERE o.delivery_id IS NULL AND d.target_kind = 'principal' AND d.recipient LIKE '%/%@%'
  `).all();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO agent_network_outbox (delivery_id, message_id, machine_id, state, next_attempt_at_ms, expires_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  let taken = 0;
  for (const row of rows) {
    const address = parseNetworkAddress(row.recipient);
    const member = address && joined.roster.members.find((candidate) => candidate.name === address.machine);
    const createdAt = parseSqliteUtcMs(row.created_at) ?? now;
    const self = joined.roster.members.find((candidate) => candidate.machine_id === joined.config.machine_id);
    const since = Math.max(Date.parse(self?.joined_at ?? ""), Date.parse(member?.joined_at ?? "")) || 0;
    const olderThanMembership = createdAt + 1e3 <= since;
    if (!member || member.machine_id === joined.config.machine_id || member.person !== address?.person || olderThanMembership) {
      insert.run(row.delivery_id, row.message_id, null, "local", 0, createdAt + DELIVERY_WINDOW_MS);
      continue;
    }
    insert.run(row.delivery_id, row.message_id, member.machine_id, "pending", now, createdAt + DELIVERY_WINDOW_MS);
    taken++;
  }
  return taken;
}
function dueMachines(db, now) {
  return db.prepare(`
    SELECT DISTINCT machine_id FROM agent_network_outbox
    WHERE state = 'pending' AND next_attempt_at_ms <= ? AND expires_at_ms > ? AND machine_id IS NOT NULL
  `).all(now, now).map((row) => row.machine_id);
}
function dueOutgoingFor(db, machineId, now, limit = 20) {
  return db.prepare(`
    SELECT delivery_id, message_id, machine_id, attempts, expires_at_ms FROM agent_network_outbox
    WHERE state = 'pending' AND machine_id = ? AND next_attempt_at_ms <= ? AND expires_at_ms > ?
    ORDER BY next_attempt_at_ms, rowid LIMIT ?
  `).all(machineId, now, now, limit);
}
function retryNowFor(db, machineId, now) {
  db.prepare(`UPDATE agent_network_outbox SET next_attempt_at_ms = ? WHERE state = 'pending' AND machine_id = ?`).run(now, machineId);
}
function buildMessageFrame(db, joined, entry) {
  const row = db.prepare(`
    SELECT m.message_id, m.project, m.sender, d.recipient, m.content_type, m.correlation_id, m.reply_to_message_id,
           m.payload_json, m.payload_tombstoned_at, m.created_at,
           (SELECT i.idempotency_key FROM agent_message_idempotency i WHERE i.message_id = m.message_id LIMIT 1) AS idempotency_key
    FROM agent_message_deliveries d JOIN agent_messages m ON m.message_id = d.message_id
    WHERE d.delivery_id = ?
  `).get(entry.delivery_id);
  if (!row)
    return "message_gone";
  if (row.payload_tombstoned_at !== null)
    return "payload_removed";
  if (!isLocalSenderName(row.sender))
    return "sender_not_local";
  const address = parseNetworkAddress(row.recipient);
  if (!address || row.idempotency_key === null)
    return "message_invalid";
  return {
    version: FRAME_VERSION,
    kind: "message",
    project_hash: projectHash(joined.config.network_id, row.project),
    sender: row.sender,
    target: address.target,
    target_kind: "principal",
    idempotency_key: row.idempotency_key,
    content_type: row.content_type,
    payload: JSON.parse(row.payload_json),
    correlation_id: row.correlation_id,
    reply_to_origin: replyToOrigin(db, row.reply_to_message_id),
    origin_message_id: row.message_id,
    created_at: sqliteUtcToIso(row.created_at)
  };
}
function replyToOrigin(db, replyTo) {
  if (replyTo === null)
    return null;
  const row = db.prepare("SELECT provenance_json FROM agent_messages WHERE message_id = ?").get(replyTo);
  if (!row)
    return null;
  try {
    const provenance = JSON.parse(row.provenance_json);
    return provenance.via === "network" && typeof provenance.origin_message_id === "string" ? provenance.origin_message_id : null;
  } catch {
    return null;
  }
}
function backoffMs(attempts) {
  return Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
}
function recordAttempt(db, entry, result, now, notifier) {
  const attempts = entry.attempts + 1;
  const ack = result.ack;
  if (ack && (ack.result === "accepted" || ack.result === "duplicate")) {
    db.prepare(`
      UPDATE agent_network_outbox SET state = 'delivered', attempts = ?, delivered_at_ms = ?, path = ?, last_error_code = NULL
      WHERE delivery_id = ?
    `).run(attempts, now, result.path ?? null, entry.delivery_id);
    return "delivered";
  }
  if (ack?.result === "rejected") {
    db.prepare(`UPDATE agent_network_outbox SET state = 'rejected', attempts = ?, last_error_code = ? WHERE delivery_id = ?`).run(attempts, ack.code ?? "rejected", entry.delivery_id);
    notifySender(db, entry.delivery_id, "rejected", ack.code ?? "rejected", notifier);
    return "rejected";
  }
  const code = ack?.code ?? result.failure ?? "unreachable";
  if (now + backoffMs(attempts) >= entry.expires_at_ms) {
    db.prepare(`UPDATE agent_network_outbox SET state = 'expired', attempts = ?, last_error_code = ? WHERE delivery_id = ?`).run(attempts, code, entry.delivery_id);
    notifySender(db, entry.delivery_id, "expired", code, notifier);
    return "expired";
  }
  db.prepare(`UPDATE agent_network_outbox SET attempts = ?, last_error_code = ?, next_attempt_at_ms = ? WHERE delivery_id = ?`).run(attempts, code, now + backoffMs(attempts), entry.delivery_id);
  return "pending";
}
function recordUnsendable(db, entry, code, notifier) {
  db.prepare(`UPDATE agent_network_outbox SET state = 'rejected', last_error_code = ? WHERE delivery_id = ?`).run(code, entry.delivery_id);
  notifySender(db, entry.delivery_id, "rejected", code, notifier);
}
function expireOverdue(db, now, notifier) {
  const overdue = db.prepare(`SELECT delivery_id, last_error_code FROM agent_network_outbox WHERE state = 'pending' AND expires_at_ms <= ?`).all(now);
  for (const row of overdue) {
    db.prepare(`UPDATE agent_network_outbox SET state = 'expired' WHERE delivery_id = ?`).run(row.delivery_id);
    notifySender(db, row.delivery_id, "expired", row.last_error_code ?? "unreachable", notifier);
  }
  return overdue.length;
}
function notifySender(db, deliveryId, state, code, notifier) {
  const row = db.prepare(`
    SELECT m.message_id, m.project, m.sender, d.recipient FROM agent_message_deliveries d
    JOIN agent_messages m ON m.message_id = d.message_id WHERE d.delivery_id = ?
  `).get(deliveryId);
  if (!row)
    return;
  const what = state === "expired" ? `was not delivered: ${row.recipient.split("@").pop()} did not take it within one day` : `was refused by ${row.recipient.split("@").pop()}`;
  sendAgentMessage(db, {
    project: row.project,
    sender: NOTICE_SENDER,
    recipient: row.sender,
    target_kind: "principal",
    idempotency_key: `memesh-network:${state}:${deliveryId}`,
    content_type: "text/plain",
    payload: `Your message ${row.message_id} to ${row.recipient} ${what}. Codes: state=${state}, code=${code}.`,
    reply_to: row.message_id,
    provenance: { via: "network-notice", delivery_id: deliveryId, state, code }
  }, { ...notifier ? { notifier } : {} });
}
function localProjects(db) {
  const projects = /* @__PURE__ */ new Set();
  const add = (rows) => {
    for (const row of rows)
      projects.add(row.project);
  };
  if (hasTable(db, "agent_session_instances"))
    add(db.prepare("SELECT DISTINCT project FROM agent_session_instances").all());
  if (hasTable(db, "agent_session_connections"))
    add(db.prepare("SELECT DISTINCT project FROM agent_session_connections").all());
  if (hasTable(db, "agent_principals"))
    add(db.prepare("SELECT DISTINCT project FROM agent_principals").all());
  if (hasTable(db, "agent_messages"))
    add(db.prepare("SELECT DISTINCT project FROM agent_messages").all());
  return [...projects];
}
function receiveMessage(db, joined, member, frame, notifier) {
  if (!messagingAvailable(db))
    return { result: "retry", code: "messaging_unavailable" };
  const project = localProjects(db).find((candidate) => projectHash(joined.config.network_id, candidate) === frame.project_hash);
  if (project === void 0)
    return { result: "rejected", code: "project_unknown" };
  let target;
  try {
    target = resolveAgentSessionHandle(db, project, frame.target);
  } catch {
    target = { recipient: frame.target, target_kind: "principal" };
  }
  const replyTo = frame.reply_to_origin !== null && db.prepare("SELECT 1 FROM agent_messages WHERE message_id = ?").get(frame.reply_to_origin) !== void 0 ? frame.reply_to_origin : null;
  try {
    const sent = sendAgentMessage(db, {
      project,
      sender: formatNetworkAddress(member.person, frame.sender, member.name),
      ...target,
      idempotency_key: frame.idempotency_key,
      payload: frame.payload,
      content_type: frame.content_type,
      correlation_id: frame.correlation_id,
      reply_to: replyTo,
      provenance: { via: "network", from_machine: member.name, origin_message_id: frame.origin_message_id }
    }, { ...notifier ? { notifier } : {} });
    return { result: sent.reused ? "duplicate" : "accepted" };
  } catch (err) {
    if (err instanceof AgentIdempotencyConflictError)
      return { result: "rejected", code: "idempotency_conflict" };
    if (err instanceof AgentConversationLoopError)
      return { result: "rejected", code: "loop_limit" };
    if (err instanceof AgentMessagingError)
      return { result: "rejected", code: "message_invalid" };
    throw err;
  }
}
function localPresence(db, joined, now) {
  if (!hasTable(db, "agent_session_connections"))
    return [];
  const rows = db.prepare(`
    SELECT project, principal_id, session_instance_id, adapter_kind FROM agent_session_connections
    WHERE disconnected_at IS NULL AND lease_expires_at_ms > ?
  `).all(now);
  const entries = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const handle = agentSessionHandle(row.project, row.adapter_kind, row.session_instance_id);
    const entry = {
      project_hash: projectHash(joined.config.network_id, row.project),
      principal: row.principal_id,
      handle,
      host_kind: agentHostKind(row.adapter_kind),
      connected: true
    };
    entries.set(`${entry.project_hash}:${handle}`, entry);
  }
  return [...entries.values()].slice(0, 256);
}
function receivePresence(db, member, frame, now) {
  db.transaction(() => {
    db.prepare("DELETE FROM agent_network_presence WHERE machine_id = ?").run(member.machine_id);
    const insert = db.prepare(`
      INSERT OR REPLACE INTO agent_network_presence (machine_id, project_hash, principal, handle, host_kind, connected, expires_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const entry of frame.entries) {
      insert.run(member.machine_id, entry.project_hash, entry.principal, entry.handle, entry.host_kind, entry.connected ? 1 : 0, now + PRESENCE_TTL_MS);
    }
    rememberPeer(db, member.machine_id, frame.relay, frame.addrs, now);
  }).immediate();
}
function rememberPeer(db, machineId, relay, addrs, now) {
  db.prepare(`
    INSERT INTO agent_network_peers (machine_id, relay_url, addrs_json, seen_at_ms) VALUES (?, ?, ?, ?)
    ON CONFLICT(machine_id) DO UPDATE SET relay_url = excluded.relay_url, addrs_json = excluded.addrs_json, seen_at_ms = excluded.seen_at_ms
  `).run(machineId, relay, JSON.stringify(addrs), now);
}
function peerRoute(db, machineId) {
  const row = db.prepare("SELECT relay_url, addrs_json FROM agent_network_peers WHERE machine_id = ?").get(machineId);
  if (!row)
    return null;
  try {
    return { relay: row.relay_url, addrs: JSON.parse(row.addrs_json) };
  } catch {
    return { relay: row.relay_url, addrs: [] };
  }
}
function frameLabel(frame) {
  return frame.kind === "message" ? `message ${createHash6("sha256").update(String(frame.origin_message_id)).digest("hex").slice(0, 12)}` : frame.kind;
}

// dist/network/bridge-serve.js
var RELAY_ONLINE_DEADLINE_MS2 = 2e4;
var HANDSHAKE_DEADLINE_MS = 2e4;
var STREAM_DEADLINE_MS = 15e3;
var CLOSE_DEADLINE_MS2 = 5e3;
var BRIDGE_BUSY_TIMEOUT_MS = 3e3;
var HEARTBEAT_MS = 1e3;
var STATUS_REFRESH_MS = 3e4;
var SOCKET_UNREADABLE_LIMIT_MS = 3e4;
var LOG_MAX_BYTES = 1024 * 1024;
var MAX_CONCURRENT_CONNECTIONS = 32;
var COURIER_INTERVAL_MS = 1e3;
var PRESENCE_INTERVAL_MS = 6e4;
var SEND_CONNECT_DEADLINE_MS = 2e4;
function appendLog(dataDir2, event, detail = {}) {
  try {
    const file = logPath(dataDir2);
    if (fs10.existsSync(file) && fs10.statSync(file).size > LOG_MAX_BYTES)
      fs10.renameSync(file, `${file}.1`);
    fs10.appendFileSync(file, line(event, detail), { mode: 384 });
  } catch {
    try {
      process.stderr.write(line(event, detail));
    } catch {
    }
  }
}
function line(event, detail) {
  return `${JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), pid: process.pid, event, ...detail })}
`;
}
async function serve(dataDir2, dbPath) {
  try {
    process.umask(63);
  } catch {
  }
  ensureNetworkDir(dataDir2);
  let requestStop = () => {
    appendLog(dataDir2, "stopped", { reason: "asked during startup" });
    process.exit(0);
  };
  let ready = false;
  const control = await holdControlSocket(dataDir2, {
    isReady: () => ready,
    stop: () => requestStop(),
    onProblem: (message) => appendLog(dataDir2, "control_problem", { error: message })
  });
  if (control.kind === "already-running") {
    appendLog(dataDir2, "exit_already_running");
    return EXIT_ALREADY_RUNNING;
  }
  if (control.kind === "holder-unresponsive") {
    appendLog(dataDir2, "exit_holder_unresponsive");
    return EXIT_HOLDER_UNRESPONSIVE;
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
    frames_received: 0
  };
  const publish = () => {
    if (control.ownership() === "lost")
      return;
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
    control.close();
    return 1;
  };
  publish();
  let db;
  let config;
  try {
    db = openNetworkStore(dbPath, { busyTimeoutMs: BRIDGE_BUSY_TIMEOUT_MS });
    config = readConfig(db);
  } catch (err) {
    return fail("exit_database", `Cannot open the database: ${errorMessage(err)}`);
  }
  if (!config) {
    db.close();
    return fail("exit_not_joined", "This machine has not joined a network.");
  }
  const { machine_id: machineId, owner_id: ownerId, relay_url: relayUrl } = config;
  const isOwner = ownerId === machineId;
  let identity;
  try {
    identity = loadIdentity(dataDir2);
  } catch (err) {
    db.close();
    return fail("exit_identity", errorMessage(err));
  }
  if (identity.machineId !== machineId) {
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
    endpoint = await bindEndpoint(iroh, identity.secret, relayUrl, isOwner ? [JOIN_ALPN, NET_ALPN] : [NET_ALPN]);
  } catch (err) {
    db.close();
    return fail("exit_bind", `Cannot open a network connection: ${errorMessage(err)}`);
  }
  status.state = "running";
  ready = true;
  status.relay_state = relayUrl === RELAY_OFF ? "off" : "connecting";
  publish();
  appendLog(dataDir2, "running", { relay_state: status.relay_state, owner: isOwner });
  const relaySignals = { online: false, deadlinePassed: false, reachable: null };
  const refreshRelayState = () => {
    if (!applyRelayState(status, relaySignals, relayUrl))
      return;
    appendLog(dataDir2, "relay_state", { relay_state: status.relay_state });
    if (status.relay_state === "unreachable")
      recordError("relay_unreachable", relayComplaint(relayUrl));
    else
      publish();
  };
  const relayTimers = [];
  if (status.relay_state === "connecting") {
    endpoint.online().then(() => {
      relaySignals.online = true;
      refreshRelayState();
    }, (err) => {
      recordError("relay_failed", `The relay failed: ${errorMessage(err)}`);
    });
    relayTimers.push(setTimeout(() => {
      relaySignals.deadlinePassed = true;
      refreshRelayState();
    }, RELAY_ONLINE_DEADLINE_MS2));
    let pingInFlight = false;
    const ping = () => {
      if (pingInFlight)
        return;
      pingInFlight = true;
      void pingRelay(relayUrl).then((reachable) => {
        pingInFlight = false;
        relaySignals.reachable = reachable;
        refreshRelayState();
      });
    };
    ping();
    relayTimers.push(setInterval(ping, RELAY_PING_INTERVAL_MS));
  }
  let lastPublished = Date.now();
  let unreadableSince = null;
  const heartbeat = setInterval(() => {
    const ownership = control.ownership();
    if (ownership === "lost") {
      void abandon();
      return;
    }
    if (ownership === "unreadable") {
      if (unreadableSince === null) {
        unreadableSince = Date.now();
        appendLog(dataDir2, "control_socket_unreadable_retrying");
      } else if (Date.now() - unreadableSince >= SOCKET_UNREADABLE_LIMIT_MS) {
        clearInterval(heartbeat);
        recordError("control_socket_unreadable", `The control socket could not be read for ${SOCKET_UNREADABLE_LIMIT_MS / 1e3} s, so this bridge stopped.`);
        void stop("control_socket_unreadable", 1);
      }
      return;
    }
    if (unreadableSince !== null) {
      unreadableSince = null;
      appendLog(dataDir2, "control_socket_readable_again");
    }
    let addresses = null;
    try {
      addresses = advertisedAddresses(endpoint);
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
    relayTimers.forEach(clearTimeout);
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
    control.close();
    process.exit(exitCode);
  };
  const abandon = async () => {
    if (stopping)
      return;
    stopping = true;
    clearInterval(heartbeat);
    relayTimers.forEach(clearTimeout);
    appendLog(dataDir2, "control_socket_lost", { detail: "The control socket path is gone or replaced, so this bridge is exiting." });
    await deadline(endpoint.close(), CLOSE_DEADLINE_MS2, "closing the endpoint").catch(() => void 0);
    try {
      db.close();
    } catch {
    }
    process.exit(1);
  };
  requestStop = () => {
    void stop("asked over the control socket", 0);
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
    const request2 = Buffer.from(await deadline(stream.recv.readToEnd(JOIN_REQUEST_MAX_BYTES), STREAM_DEADLINE_MS, "reading the join request"));
    let reply2;
    try {
      reply2 = handleJoinRequest(db, identity, remoteId, request2, Date.now());
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
  const joinedNow = () => {
    const current = readConfig(db);
    if (!current)
      throw new Error("The network settings are gone from the database.");
    return { config: current, roster: verifyRoster(signedRosterOf(current), ownerId, current.network_id) };
  };
  let notifier;
  try {
    notifier = createAgentRouterNotifier(getAgentRouterSocketPath());
  } catch {
    notifier = void 0;
  }
  let lastPresenceAt = 0;
  const answer = (frame, joined, remoteId) => {
    const member = findMember(joined.roster, remoteId);
    if (!member)
      return { result: "rejected", code: "not_a_member" };
    if (frame.kind === "presence") {
      const firstContact = !peerRoute(db, remoteId);
      receivePresence(db, member, frame, Date.now());
      retryNowFor(db, remoteId, Date.now());
      if (firstContact)
        lastPresenceAt = 0;
      return { result: "accepted" };
    }
    if (!messagingAvailable(db)) {
      recordError("messaging_unavailable", "A message arrived, but the message tables do not exist here yet; it will be retried.");
      return { result: "retry", code: "messaging_unavailable" };
    }
    return receiveMessage(db, joined, member, frame, notifier);
  };
  const answerMember = async (connection, remoteId) => {
    const joined = joinedNow();
    if (!findMember(joined.roster, remoteId)) {
      connection.close(1n, toBytes("not_a_member"));
      status.non_member_refused++;
      appendLog(dataDir2, "non_member_refused", { machine_id: remoteId });
      publish();
      return;
    }
    const stream = await deadline(connection.acceptBi(), STREAM_DEADLINE_MS, "waiting for a member stream");
    const bytes = Buffer.from(await deadline(stream.recv.readToEnd(FRAME_MAX_BYTES), STREAM_DEADLINE_MS, "reading a member stream"));
    const frameLog = process.env.MEMESH_TEST_NETWORK_FRAME_LOG;
    if (frameLog) {
      const refused = appendTestFrameLog(frameLog, bytes);
      if (refused)
        recordError("test_frame_log_refused", refused);
    }
    let ack;
    try {
      const frame = parseFrame(bytes);
      ack = answer(frame, joined, remoteId);
      appendLog(dataDir2, "frame_received", { machine_id: remoteId, frame: frameLabel(frame), result: ack.result, code: ack.code ?? null });
    } catch (err) {
      if (err instanceof FrameError)
        ack = { result: "rejected", code: err.code };
      else {
        recordError("frame_failed", errorMessage(err));
        ack = { result: "retry", code: "internal" };
      }
    }
    await deadline(stream.send.writeAll(toBytes(JSON.stringify(ack))), STREAM_DEADLINE_MS, "answering a member");
    await stream.send.finish();
    status.frames_received++;
    publish();
    await finishConnection(connection);
  };
  const sendFrame = async (target, frame) => {
    const route = peerRoute(db, target);
    const relay = route?.relay ?? (relayUrl === RELAY_OFF ? null : relayUrl);
    const address = new iroh.EndpointAddr(iroh.EndpointId.fromString(target), relay, route?.addrs ?? []);
    const connection = await deadline(endpoint.connect(address, toBytes(NET_ALPN)), SEND_CONNECT_DEADLINE_MS, "connecting to a member");
    try {
      const stream = await deadline(connection.openBi(), STREAM_DEADLINE_MS, "opening a stream");
      await deadline(stream.send.writeAll(toBytes(encodeFrame(frame))), STREAM_DEADLINE_MS, "sending a frame");
      await deadline(stream.send.finish(), STREAM_DEADLINE_MS, "sending a frame");
      const ack = parseAck(Buffer.from(await deadline(stream.recv.readToEnd(ACK_MAX_BYTES), STREAM_DEADLINE_MS, "waiting for the answer")));
      let path11 = null;
      try {
        const selected = connection.paths().find((candidate) => candidate.isSelected);
        path11 = selected ? selected.isRelay ? "relay" : "direct" : null;
      } catch {
      }
      return { ack, path: path11 };
    } finally {
      connection.close(0n, toBytes("done"));
    }
  };
  let courierBusy = false;
  const deliver = async (joined, entry) => {
    const frame = buildMessageFrame(db, joined, entry);
    if (typeof frame === "string") {
      recordUnsendable(db, entry, frame, notifier);
      appendLog(dataDir2, "message_unsendable", { delivery_id: entry.delivery_id, code: frame });
      return true;
    }
    try {
      const { ack, path: path11 } = await sendFrame(entry.machine_id, frame);
      const outcome = recordAttempt(db, entry, { ack, path: path11 }, Date.now(), notifier);
      appendLog(dataDir2, "message_attempt", { delivery_id: entry.delivery_id, outcome, code: ack.code ?? null, path: path11 });
      return true;
    } catch (err) {
      if (stopping)
        return false;
      const outcome = recordAttempt(db, entry, { failure: "unreachable" }, Date.now(), notifier);
      appendLog(dataDir2, "message_attempt", { delivery_id: entry.delivery_id, outcome, code: "unreachable", error: errorMessage(err) });
      return false;
    }
  };
  const sendingTo = /* @__PURE__ */ new Set();
  const announcingTo = /* @__PURE__ */ new Set();
  const deliverTo = async (joined, target) => {
    sendingTo.add(target);
    try {
      for (const entry of dueOutgoingFor(db, target, Date.now())) {
        if (stopping)
          return;
        if (!await deliver(joined, entry))
          return;
      }
    } catch (err) {
      if (!stopping)
        recordError("courier_failed", errorMessage(err));
    } finally {
      sendingTo.delete(target);
    }
  };
  const sentTo = /* @__PURE__ */ new Map();
  const announce = (joined, heartbeat2) => {
    const frame = {
      version: FRAME_VERSION,
      kind: "presence",
      relay: relayUrl === RELAY_OFF ? null : relayUrl,
      addrs: advertisedAddresses(endpoint),
      entries: localPresence(db, joined, Date.now())
    };
    const content = JSON.stringify(frame);
    for (const member of joined.roster.members) {
      const target = member.machine_id;
      if (target === machineId || announcingTo.has(target))
        continue;
      if (!heartbeat2 && sentTo.get(target) === content)
        continue;
      if (!peerRoute(db, target) && relayUrl === RELAY_OFF)
        continue;
      sentTo.set(target, content);
      announcingTo.add(target);
      void sendFrame(target, frame).catch((err) => {
        if (!stopping)
          appendLog(dataDir2, "presence_unreachable", { machine_id: target, error: errorMessage(err) });
      }).finally(() => {
        announcingTo.delete(target);
      });
    }
  };
  const courier = async () => {
    if (courierBusy || stopping)
      return;
    courierBusy = true;
    try {
      if (!messagingAvailable(db))
        return;
      const joined = joinedNow();
      const now = Date.now();
      enqueueOutgoing(db, joined, now);
      expireOverdue(db, now, notifier);
      for (const target of dueMachines(db, now)) {
        if (!sendingTo.has(target))
          void deliverTo(joined, target);
      }
      const heartbeat2 = now - lastPresenceAt >= PRESENCE_INTERVAL_MS;
      if (heartbeat2)
        lastPresenceAt = now;
      announce(joined, heartbeat2);
    } catch (err) {
      recordError("courier_failed", errorMessage(err));
    } finally {
      courierBusy = false;
    }
  };
  relayTimers.push(setInterval(() => {
    void courier();
  }, COURIER_INTERVAL_MS));
  void courier();
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
var dataDir = path10.resolve(getMemeshDirFromDbPath());
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
    await reply({ ok: false, code: "internal", detail: errorMessage(err), relay_reached: null });
    process.exit(1);
  }
} else if (mode === "serve") {
  try {
    process.exit(await serve(dataDir, getDbPath()));
  } catch (err) {
    process.stderr.write(`The network bridge failed before it could start: ${errorMessage(err)}
`);
    process.exit(1);
  }
} else {
  process.stderr.write("Usage: bridge.js check | join | serve\n");
  process.exit(2);
}
//# sourceMappingURL=bridge.js.map
