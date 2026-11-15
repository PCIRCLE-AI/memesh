import { createRequire as __memeshCreateRequire } from 'node:module'; const require = __memeshCreateRequire(import.meta.url);

// dist/network/bridge.js
import path14 from "node:path";

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
  return process.env.MEMESH_DIR || path.join(homeDir(), ".memesh");
}
var DEFAULT_DB_FILE = "knowledge-graph.db";
function getDbPath() {
  return process.env.MEMESH_DB_PATH ?? path.join(memeshDir(), DEFAULT_DB_FILE);
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
var NET_ALPN = "memesh/net/2";
var MEMBERSHIP_ALPN = "memesh/membership/1";
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
function networkMetadataPath(dataDir2) {
  return path2.join(networkDir(dataDir2), "metadata.db");
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
import { pathToFileURL } from "url";
function shellQuote(value) {
  const word = value.startsWith("-") ? `./${value}` : value;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}
var warned = /* @__PURE__ */ new Set();
function removeGroupAndOtherAccess(target) {
  let stat2;
  try {
    stat2 = fs.statSync(target);
    const mode2 = stat2.mode & 4095;
    if ((mode2 & 63) !== 0)
      fs.chmodSync(target, mode2 & ~63);
  } catch (err) {
    const code = err.code;
    if (code === "ENOENT")
      return;
    if (warned.has(target))
      return;
    warned.add(target);
    const notYours = stat2 !== void 0 && belongsToAnotherUser(stat2);
    try {
      process.stderr.write(notYours ? `MeMesh: ${target} belongs to another user, so MeMesh cannot remove other users' access to it (${code}). Point MEMESH_DB_PATH at a database you own, in a folder you own.
` : `MeMesh: could not remove other users' access to ${target} (${code ?? String(err)}); they may be able to read your memories. Fix it with: chmod go-rwx ${shellQuote(target)}
`);
    } catch {
    }
  }
}
function belongsToAnotherUser(stat2) {
  return typeof process.getuid === "function" && process.getuid() !== 0 && stat2.uid !== process.getuid();
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
function holdsBytes(file) {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}
function hasPagesWaiting(dbPath) {
  const [real, wal] = databaseFiles(dbPath);
  return holdsBytes(wal) || holdsBytes(`${real}-journal`);
}
function immutableAddress(file) {
  return `${pathToFileURL(file).href}?immutable=1`;
}
function guardDatabaseFiles(dbPath) {
  for (const target of databaseFiles(dbPath))
    removeGroupAndOtherAccess(target);
  refuseMismatchedSidecars(dbPath);
}
function requirePrivateWritableDirectory(dir, purpose) {
  removeGroupAndOtherAccess(dir);
  const mode2 = fs.statSync(dir).mode & 511;
  if ((mode2 & 63) !== 0) {
    throw new Error(`${dir} is still open to other users (${mode2.toString(8)}), and ${purpose}. Run: chmod go-rwx ${shellQuote(dir)}`);
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    throw new Error(`${dir} is read-only, and ${purpose}. MeMesh does not make it writable; if you want it to run, run: chmod u+w ${shellQuote(dir)}`);
  }
}
var SIDECAR_PERMISSIONS_CODE = "MEMESH_SIDECAR_PERMISSIONS";
var OWNER_LETTERS = [[256, "r"], [128, "w"], [64, "x"]];
var quoted = (files) => files.map(shellQuote).join(" ");
var letters = (bits) => OWNER_LETTERS.filter(([bit]) => bits & bit).map(([, letter]) => letter).join("");
function refuseMismatchedSidecars(dbPath, options = {}) {
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
    const stat2 = fs.statSync(sidecar, { throwIfNoEntry: false });
    if (!stat2)
      continue;
    if (options.readOnly && stat2.size > 0)
      continue;
    const missing = database.mode & ~stat2.mode & (stat2.size === 0 ? 448 : 384);
    const added = stat2.mode & ~database.mode & 448;
    if (missing !== 0) {
      fewer.push(sidecar);
      fewerBits |= missing;
    } else if (added !== 0 && stat2.size === 0) {
      extra.push(sidecar);
      extraBits |= added;
    } else
      continue;
    if (belongsToAnotherUser(stat2))
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
function acceptRoster(current, incoming, ownerId, networkId) {
  const roster = verifyRoster(incoming, ownerId, networkId);
  if (current) {
    const held = verifyRoster(current, ownerId, networkId);
    if (roster.version < held.version) {
      throw new NetworkError("roster_downgrade", `Refused an older team list (version ${roster.version}, this machine has ${held.version}).`);
    }
    if (roster.version === held.version && incoming.roster_json !== current.roster_json) {
      throw new NetworkError("roster_downgrade", `Refused a team list that differs from the one this machine has at version ${held.version}.`);
    }
  }
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
var NETWORK_METADATA_SCHEMA_SQL = `
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
var AGENT_NETWORK_SCHEMA_SQL = NETWORK_METADATA_SCHEMA_SQL + `

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

`;

// dist/storage/sqlite.js
import { createRequire } from "node:module";
function loadNodeSqlite() {
  const require2 = createRequire(import.meta.url);
  const original = process.emitWarning;
  process.emitWarning = function(warning, ...rest) {
    const text2 = typeof warning === "string" ? warning : String(warning?.message ?? warning);
    if (text2.includes("SQLite is an experimental feature"))
      return;
    return original.call(process, warning, ...rest);
  };
  try {
    return require2("node:sqlite");
  } catch {
    return null;
  } finally {
    process.emitWarning = original;
  }
}
var loadedSqlite = loadNodeSqlite();
var MissingDatabaseSync = class {
  constructor() {
    assertNodeSupported();
    throw new Error("node:sqlite did not load");
  }
};
var DatabaseSync = loadedSqlite?.DatabaseSync ?? MissingDatabaseSync;
var MIN_NODE_VERSION = "22.16.0";
var MIN_NODE_SERIES = MIN_NODE_VERSION.split(".").slice(0, 2).join(".");
var UnsupportedNodeError = class extends Error {
  code = "NODE_TOO_OLD";
  fix;
  constructor(problem) {
    super(problem.message);
    this.name = "UnsupportedNodeError";
    this.fix = problem.fix;
  }
};
var SqliteSelfCheckError = class extends Error {
  code = "SQLITE_SELF_CHECK_FAILED";
  advice = "Your database is not the problem. Run the command again; if it keeps failing, free some memory or restart, then run `memesh doctor`.";
  constructor(cause) {
    super(`MeMesh could not check this Node's SQLite (${cause instanceof Error ? cause.message : String(cause)}).`, { cause });
    this.name = "SqliteSelfCheckError";
  }
};
function atLeastMinimumNode(version) {
  const want = MIN_NODE_VERSION.split(".").map(Number);
  const have = version.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < 3; i++) {
    const h = have[i];
    if (!Number.isFinite(h))
      return false;
    if (h !== want[i])
      return h > want[i];
  }
  return true;
}
function fts5ProbeResult(createFtsTable) {
  try {
    createFtsTable();
    return true;
  } catch (err) {
    if (/no such module/i.test(err instanceof Error ? err.message : String(err)))
      return false;
    throw err;
  }
}
var ftsProbe;
function hasFts5() {
  if (ftsProbe === void 0) {
    let probe;
    try {
      probe = new DatabaseSync(":memory:");
      const throwaway = probe;
      ftsProbe = fts5ProbeResult(() => throwaway.exec("CREATE VIRTUAL TABLE memesh_fts5_probe USING fts5(a)"));
    } catch (err) {
      throw new SqliteSelfCheckError(err);
    } finally {
      try {
        probe?.close();
      } catch {
      }
    }
  }
  return ftsProbe;
}
function nodeProblem(version = process.versions.node, fts5Available = hasFts5, sqliteLoaded = loadedSqlite !== null) {
  const shown = version.replace(/^v/, "");
  const official = `the official Node ${MIN_NODE_SERIES} or newer from nodejs.org`;
  if (!atLeastMinimumNode(version)) {
    return {
      kind: "too-old",
      message: `This Node (v${shown}) lacks the full-text search MeMesh needs; upgrade to Node ${MIN_NODE_SERIES} or newer and run memesh again.`,
      fix: `Upgrade Node to ${MIN_NODE_SERIES} or newer, then run \`memesh doctor\` again.`
    };
  }
  if (!sqliteLoaded) {
    return {
      kind: "sqlite-switched-off",
      message: `This Node (v${shown}) is new enough, but its built-in SQLite (node:sqlite) is switched off; remove the --no-experimental-sqlite option (from the command line, the NODE_OPTIONS environment variable or a Node config file), or install ${official}, and run memesh again.`,
      fix: `Remove the --no-experimental-sqlite option (from the command line, NODE_OPTIONS or a Node config file), or install ${official}, then run \`memesh doctor\` again.`
    };
  }
  if (!fts5Available()) {
    return {
      kind: "no-fts5",
      message: `This Node build (v${shown}) lacks the full-text search (FTS5) MeMesh needs; install ${official} and run memesh again.`,
      fix: `Install ${official}, then run \`memesh doctor\` again.`
    };
  }
  return null;
}
function assertNodeSupported() {
  const problem = nodeProblem();
  if (problem)
    throw new UnsupportedNodeError(problem);
}
var BUSY_TIMEOUT_MS = 3e4;
var MemeshDatabase = class extends DatabaseSync {
  #depth = 0;
  constructor(path15, options = {}) {
    assertNodeSupported();
    super(path15, options);
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
    db.exec(options.metadataOnly ? NETWORK_METADATA_SCHEMA_SQL : AGENT_NETWORK_SCHEMA_SQL);
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
function exchangeRoster(db, incoming) {
  return db.transaction(() => {
    const config = readConfig(db);
    if (!config)
      throw new Error("Network configuration missing.");
    const current = signedRosterOf(config);
    const held = verifyRoster(current, config.owner_id, config.network_id);
    const offered = verifyRoster(incoming, config.owner_id, config.network_id);
    if (offered.version < held.version)
      return current;
    acceptRoster(current, incoming, config.owner_id, config.network_id);
    if (offered.version > held.version)
      saveRoster(db, incoming);
    return incoming;
  })();
}
function authorizeNetworkPeer(db, remoteId) {
  const config = readConfig(db);
  if (!config)
    throw new Error("Network configuration missing.");
  const roster = verifyRoster(signedRosterOf(config), config.owner_id, config.network_id);
  if (!findMember(roster, config.machine_id) || !findMember(roster, remoteId))
    throw new Error("not_a_member");
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
import fs13 from "node:fs";
import path13 from "node:path";

// dist/core/conversation-messages.js
import fs7 from "node:fs";
import path8 from "node:path";
import os2 from "node:os";
import { randomUUID } from "node:crypto";

// dist/core/public-network-context.js
import fs5 from "node:fs";
import path6 from "node:path";
function stat(file) {
  try {
    return fs5.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT")
      return void 0;
    throw error;
  }
}
function openPublicNetworkDatabase(file, consistentSnapshot = false) {
  const parent = stat(path6.dirname(file));
  if (!parent)
    return void 0;
  let expectedParent = path6.resolve(path6.dirname(file));
  if (process.platform === "darwin") {
    for (const alias of ["/var", "/tmp"]) {
      if ((expectedParent === alias || expectedParent.startsWith(`${alias}/`)) && fs5.realpathSync(alias) === `/private${alias}`) {
        expectedParent = `/private${expectedParent}`;
      }
    }
  }
  if (!parent.isDirectory() || parent.isSymbolicLink() || fs5.realpathSync(path6.dirname(file)) !== expectedParent || process.platform !== "win32" && (parent.uid !== process.getuid?.() || (parent.mode & 63) !== 0))
    throw new Error("Unsafe network metadata directory");
  const main = stat(file);
  if (!main)
    return void 0;
  for (const target of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    const value = stat(target);
    if (value && (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1 || process.platform !== "win32" && (value.uid !== process.getuid?.() || (value.mode & 63) !== 0)))
      throw new Error("Unsafe network metadata file");
  }
  const pending = hasPagesWaiting(file);
  if (pending) {
    if (!stat(`${file}-shm`))
      throw new Error("Network metadata WAL requires existing SHM for readonly access");
  }
  if (pending || consistentSnapshot) {
    refuseMismatchedSidecars(file, { readOnly: true });
  }
  const db = new MemeshDatabase(pending || consistentSnapshot ? file : immutableAddress(file), { readOnly: true });
  db.pragma("busy_timeout = 100");
  return db;
}
function readPublicNetworkContext(dataDir2) {
  const db = openPublicNetworkDatabase(path6.join(dataDir2, "network", "metadata.db"));
  if (!db)
    return void 0;
  try {
    const row = db.prepare("SELECT network_id,owner_id,machine_id,roster_json,roster_signature FROM agent_network_config WHERE id=1").get();
    if (!row)
      return void 0;
    const roster = verifyRoster({ roster_json: row.roster_json, signature: row.roster_signature }, row.owner_id, row.network_id);
    const self = roster.members.find((member) => member.machine_id === row.machine_id);
    if (!self)
      throw new Error("This machine is no longer a network member");
    return {
      network_id: row.network_id,
      self: { id: self.machine_id, name: self.name },
      members: roster.members.map((member) => ({ id: member.machine_id, name: member.name }))
    };
  } finally {
    db.close();
  }
}

// dist/core/conversation-message-migration.js
import { createHash as createHash2 } from "node:crypto";
import fs6 from "node:fs";
import path7 from "node:path";

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

// dist/core/conversation-message-migration.js
function legacyConversationArchiveFiles(graph, target) {
  const directory = path7.dirname(path7.resolve(graph));
  if (directory !== path7.dirname(path7.resolve(target)))
    throw new Error("Legacy archive and message store must share a data directory");
  const backups = path7.join(directory, "backups");
  const names = /* @__PURE__ */ new Set([path7.basename(graph) === "knowledge-graph.db" ? "agent-messages-expired.db" : `agent-messages-expired-${path7.basename(graph)}`, "agent-messages-expired.db"]);
  const privateEntry = (file, directoryEntry) => {
    const stat2 = fs6.lstatSync(file);
    if (stat2.isSymbolicLink() || !(directoryEntry ? stat2.isDirectory() : stat2.isFile()) || process.platform !== "win32" && ((stat2.mode & 63) !== 0 || typeof process.getuid === "function" && stat2.uid !== process.getuid())) {
      throw new Error(`Unsafe legacy archive path: ${file}`);
    }
  };
  const candidates = [...names].map((name) => path7.join(backups, name)).filter((file) => {
    try {
      return fs6.lstatSync(file) !== void 0;
    } catch (error) {
      const code = error.code;
      if (code === "ENOENT" || code === "ENOTDIR")
        return false;
      throw error;
    }
  });
  if (candidates.length === 0)
    return [];
  privateEntry(directory, true);
  privateEntry(backups, true);
  const files = [];
  for (const file of candidates) {
    privateEntry(file, false);
    assertLegacyPathsAreDifferent(file, graph);
    assertLegacyPathsAreDifferent(file, target);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      if (fs6.lstatSync(file + suffix, { throwIfNoEntry: false }))
        privateEntry(file + suffix, false);
    }
    refuseMismatchedSidecars(file, { readOnly: true });
    files.push(file);
  }
  return files;
}
function assertLegacyConversationArchiveSchema(source) {
  const tables = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  for (const name of [
    "agent_messages",
    "agent_message_deliveries",
    "agent_network_outbox",
    "agent_message_events",
    "agent_message_idempotency",
    "agent_message_receipts",
    "agent_retention_facts",
    "agent_dispatch_attempts",
    "agent_host_accepts",
    "agent_ack_facts",
    "agent_workflow_facts",
    "archive_log"
  ]) {
    if (!tables.has(name))
      throw new Error(`Invalid legacy archive: missing ${name}`);
  }
}
var LEGACY_CONVERSATION_PREFIX = "legacy:";
function historicalHostMatches(adapter, host, origin) {
  const family = adapter === "codex-cli-queue" ? "codex" : adapter === "claude-channel" || adapter === "claude-inbox" ? "claude" : void 0;
  if (family === void 0)
    return false;
  const matches = (value) => value === "cli" ? origin.transport === "cli" : family === "codex" ? value === "codex" || value === "codex-mcp-client" : value === "claude-code";
  return matches(host) && (origin.source_host === void 0 || matches(origin.source_host));
}
function provenance(message) {
  const value = JSON.parse(text(message.provenance_json, "provenance_json"));
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function text(value, field) {
  if (typeof value !== "string")
    throw new Error(`Legacy message has invalid ${field}`);
  return value;
}
function utc(value) {
  const raw = text(value, "timestamp");
  const iso = sqliteUtcToIso(raw);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(iso) || !Number.isFinite(Date.parse(iso))) {
    throw new Error("Legacy message has invalid timestamp");
  }
  const result = new Date(iso).toISOString();
  if (result !== (iso.includes(".") ? iso : iso.replace("Z", ".000Z")))
    throw new Error("Legacy timestamp is not a calendar instant");
  return result;
}
function session(value) {
  if (typeof value !== "string" || !value || value.length > 200 || value.startsWith(LEGACY_CONVERSATION_PREFIX) || /[\s/@\\]/u.test(value) || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || value !== value.normalize("NFC"))
    return void 0;
  return value;
}
function legacyIdentity(project, name) {
  return LEGACY_CONVERSATION_PREFIX + createHash2("sha256").update(JSON.stringify([project, name])).digest("hex");
}
function canonical(value) {
  if (Array.isArray(value))
    return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === void 0)
    throw new Error("Legacy row contains an unsupported value");
  return encoded;
}
var databaseFile = (db) => db.prepare("SELECT file FROM pragma_database_list WHERE name = 'main'").get()?.file;
function assertLegacyDestinationIsDifferent(source, targetFile) {
  const sourceFile = databaseFile(source);
  if (!sourceFile || !targetFile)
    return;
  assertLegacyPathsAreDifferent(sourceFile, targetFile);
}
function assertLegacyPathsAreDifferent(sourceFile, targetFile) {
  if (path7.resolve(sourceFile) === path7.resolve(targetFile))
    throw new Error("Legacy source and target must be different files");
  let a, b;
  try {
    a = fs6.statSync(sourceFile);
    b = fs6.statSync(targetFile);
  } catch (error) {
    if (error.code === "ENOENT")
      return;
    throw error;
  }
  if (a.dev === b.dev && a.ino === b.ino)
    throw new Error("Legacy source and target must be different files");
}
function importLegacyConversationMessages(source, target, options) {
  if (source === target)
    throw new Error("Legacy source and target must be different databases");
  const targetFile = databaseFile(target);
  if (targetFile)
    assertLegacyDestinationIsDifferent(source, targetFile);
  const at = new Date(options.nowMs).toISOString();
  const snapshots = source.transaction(() => {
    const tables = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    if (!tables.has("agent_messages"))
      return [];
    const rows = (table, column, values) => tables.has(table) ? source.prepare(`SELECT * FROM ${table} WHERE ${column} IN (SELECT value FROM json_each(?))`).all(JSON.stringify(values)).sort((a, b) => canonical(a).localeCompare(canonical(b))) : [];
    const messages = options.messageIds === void 0 ? source.prepare("SELECT * FROM agent_messages ORDER BY message_id").all() : source.prepare("SELECT * FROM agent_messages WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY message_id").all(JSON.stringify(options.messageIds));
    return messages.flatMap((message) => {
      const sentAt = utc(message.created_at);
      if (Date.parse(sentAt) <= options.nowMs - 14 * 864e5)
        return [];
      const id = text(message.message_id, "message_id");
      const facts = {};
      for (const table of [
        "agent_message_deliveries",
        "agent_message_events",
        "agent_message_receipts",
        "agent_message_idempotency",
        "agent_retention_facts",
        "agent_network_outbox",
        "agent_message_expiries"
      ]) {
        facts[table] = rows(table, "message_id", [id]);
      }
      const deliveries = facts.agent_message_deliveries.map((row) => row.delivery_id);
      for (const table of ["agent_dispatch_attempts", "agent_host_accepts", "agent_ack_facts", "agent_workflow_facts"]) {
        facts[table] = rows(table, "delivery_id", deliveries);
      }
      const connections = facts.agent_dispatch_attempts.map((row) => row.connection_id);
      facts.agent_session_connections = rows("agent_session_connections", "connection_id", connections);
      facts.agent_presence_facts = rows("agent_presence_facts", "connection_id", connections);
      const project = text(message.project, "project");
      const identities = /* @__PURE__ */ new Set([
        message.sender,
        message.recipient,
        provenance(message).sender_session,
        ...facts.agent_message_deliveries.flatMap((row) => [row.recipient, row.intended_session]),
        ...facts.agent_session_connections.map((row) => row.session_instance_id)
      ]);
      facts.agent_session_instances = tables.has("agent_session_instances") ? source.prepare("SELECT * FROM agent_session_instances WHERE project = ?").all(project).filter((row) => identities.has(row.session_instance_id) || identities.has(row.principal_id)).sort((a, b) => canonical(a).localeCompare(canonical(b))) : [];
      facts.agent_principals = rows("agent_principals", "project", [project]).filter((row) => identities.has(row.principal_id));
      return [{ message, facts }];
    });
  })();
  return target.transaction(() => {
    let imported = 0, alreadyImported = 0;
    for (const snapshot of snapshots) {
      const { message: original, facts } = snapshot;
      const project = text(original.project, "project");
      const id = text(original.message_id, "message_id");
      const senderName = text(original.sender, "sender");
      const recipientName = text(original.recipient, "recipient");
      const explicitTargets = [...new Set(facts.agent_message_deliveries.map((row) => row.target_kind === "session" ? session(row.recipient) : session(row.intended_session)).filter((value) => value !== void 0))];
      if (explicitTargets.length > 1)
        throw new Error("Legacy message has multiple conversation targets");
      const recipient = explicitTargets[0] ?? legacyIdentity(project, recipientName);
      const origin = provenance(original);
      const senderSession = session(origin.sender_session);
      const matchingSenders = facts.agent_session_instances.filter((row) => row.session_instance_id === senderSession && row.project === project && (row.principal_id === senderName || row.session_instance_id === senderName) && historicalHostMatches(row.adapter_kind, original.sender_host, origin));
      const localSender = senderSession !== void 0 && matchingSenders.length === 1 && origin.via !== "network" && origin.from_machine === void 0 && origin.origin_message_id === void 0;
      const sender = localSender ? senderSession : legacyIdentity(project, senderName);
      const payload = text(original.payload_json, "payload_json");
      const decoded = JSON.parse(payload);
      const body = original.content_type === "text/plain" && original.payload_tombstoned_at == null ? text(decoded, "text payload") : payload;
      const mapped = {
        id,
        sender,
        sender_host: typeof original.sender_host === "string" && original.sender_host ? original.sender_host : "unknown",
        sender_machine: localSender ? options.localMachine : "unknown",
        recipient,
        recipient_host: null,
        recipient_machine: explicitTargets.length === 1 ? options.localMachine : "unknown",
        kind: "legacy",
        body,
        body_bytes: Buffer.byteLength(body, "utf8"),
        reply_to: original.reply_to_message_id == null ? null : text(original.reply_to_message_id, "reply_to"),
        sent_at: utc(original.created_at)
      };
      const detail = canonical({ version: 1, source: snapshot, mapped });
      const existing = target.prepare("SELECT id,sender,sender_host,sender_machine,recipient,recipient_host,recipient_machine,kind,body,body_bytes,reply_to,sent_at FROM messages WHERE id = ?").get(id);
      if (existing) {
        const receipts = target.prepare("SELECT detail FROM events WHERE message_id = ? AND event = 'legacy_imported'").all(id);
        const initial = receipts.length === 1 ? JSON.parse(receipts[0].detail) : void 0;
        const routing = (deliveries) => deliveries.map((row) => canonical({
          delivery_id: row.delivery_id ?? null,
          message_id: row.message_id ?? null,
          project: row.project ?? null,
          recipient: row.recipient ?? null,
          target_kind: row.target_kind ?? "principal",
          intended_session: row.intended_session ?? null
        })).sort();
        if (!initial?.source?.message || !initial.mapped || !initial.source.facts?.agent_message_deliveries || canonical(existing) !== canonical(initial.mapped) || canonical(initial.source.message) !== canonical(original) || canonical(routing(initial.source.facts.agent_message_deliveries)) !== canonical(routing(facts.agent_message_deliveries))) {
          throw new Error(`Legacy migration conflict for message ${id}`);
        }
        alreadyImported++;
      } else {
        target.prepare("INSERT INTO messages (id,sender,sender_host,sender_machine,recipient,recipient_host,recipient_machine,kind,body,body_bytes,reply_to,sent_at,sender_local,recipient_local) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(mapped.id, mapped.sender, mapped.sender_host, mapped.sender_machine, mapped.recipient, mapped.recipient_host, mapped.recipient_machine, mapped.kind, mapped.body, mapped.body_bytes, mapped.reply_to, mapped.sent_at, localSender ? 1 : 0, explicitTargets.length === 1 ? 1 : 0);
        target.prepare("INSERT INTO events (message_id,at,event,detail) VALUES (?,?,?,?)").run(id, at, "legacy_imported", detail);
        imported++;
      }
      const priorRows = target.prepare("SELECT event,detail FROM events WHERE message_id = ? AND event IN ('legacy_fact','legacy_handled')").all(id);
      const prior = new Set(priorRows.map((row) => `${row.event}:${row.detail}`));
      for (const [table, records] of Object.entries(facts))
        for (const row of records) {
          const handled = table === "agent_message_receipts" && ["intake", "ack", "disposition"].includes(String(row.receipt_kind)) || table === "agent_ack_facts" || table === "agent_workflow_facts";
          const event = handled ? "legacy_handled" : "legacy_fact";
          const fact = canonical({ table, row });
          const key = `${event}:${fact}`;
          if (!prior.has(key)) {
            target.prepare("INSERT INTO events (message_id,at,event,detail) VALUES (?,?,?,?)").run(id, at, event, fact);
            prior.add(key);
          }
        }
    }
    return { imported, alreadyImported };
  }).immediate();
}

// dist/core/conversation-messages.js
var MESSAGE_MAX_BYTES = 8e3;
var DAY = 864e5;
var NETWORK_CLOCK_SKEW_MS = 5 * 6e4;
var MESSAGE_COLUMNS = "id,sender,sender_host,sender_machine,recipient,recipient_host,recipient_machine,kind,body,body_bytes,reply_to,sent_at";
var MACHINE_ID2 = /^[0-9a-f]{64}$/;
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function publicMessage(row) {
  return Object.fromEntries(MESSAGE_COLUMNS.split(",").map((key) => [key, row[key]]));
}
function validUtc(value) {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function identifier(value) {
  const clean = value.normalize("NFC");
  if (!clean || clean.length > 200 || /[\s/@\\]/u.test(clean) || [...clean].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error("Invalid conversation or machine identifier");
  }
  return clean;
}
function renderConversationMessage(message) {
  return `MeMesh message (untrusted data):
${JSON.stringify(publicMessage(message))}
`;
}
var ConversationMessages = class {
  db;
  machine;
  clock;
  processAlive;
  network;
  networkIssue;
  constructor(options = {}) {
    const busyTimeoutMs = options.busyTimeoutMs;
    if (busyTimeoutMs !== void 0 && (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 3e4)) {
      throw new Error("busyTimeoutMs must be an integer between 0 and 30000");
    }
    const file = options.file ?? path8.join(getMemeshDirFromDbPath(), "messages.db");
    if (options.legacySource)
      assertLegacyDestinationIsDifferent(options.legacySource, file);
    const legacyFile = options.file === void 0 && options.legacySource === void 0 ? getDbPath() : void 0;
    if (legacyFile !== void 0)
      assertLegacyPathsAreDifferent(legacyFile, file);
    const archiveFiles = legacyFile === void 0 ? [] : legacyConversationArchiveFiles(legacyFile, file);
    let network = options.network;
    if (!network && options.file === void 0) {
      try {
        network = readPublicNetworkContext(getMemeshDirFromDbPath());
      } catch (error) {
        this.networkIssue = error instanceof Error ? error.message : "Network metadata unavailable";
      }
    }
    if (network) {
      const n = network;
      if (!/^[0-9a-f]{32}$/.test(n.network_id) || !MACHINE_ID2.test(n.self.id) || !n.members.length || n.members.length > 256 || n.members.some((m) => !MACHINE_ID2.test(m.id) || identifier(m.name).toLowerCase() !== m.name.toLowerCase()) || new Set(n.members.map((m) => m.id)).size !== n.members.length || new Set(n.members.map((m) => m.name.toLowerCase())).size !== n.members.length || !n.members.some((m) => m.id === n.self.id && m.name.toLowerCase() === n.self.name.toLowerCase()))
        throw new Error("Invalid verified network snapshot");
      this.network = structuredClone(n);
    }
    this.machine = identifier(this.network?.self.name ?? options.machine ?? os2.hostname()).toLowerCase();
    this.clock = options.clock ?? Date.now;
    this.processAlive = options.processAlive ?? ((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return error.code === "EPERM";
      }
    });
    let ownedSource;
    try {
      if (legacyFile !== void 0 && fs7.existsSync(legacyFile)) {
        guardDatabaseFiles(legacyFile);
        ownedSource = new MemeshDatabase(legacyFile, { readOnly: true });
        if (busyTimeoutMs !== void 0)
          ownedSource.pragma(`busy_timeout = ${busyTimeoutMs}`);
        assertLegacyDestinationIsDifferent(ownedSource, file);
      }
      fs7.mkdirSync(path8.dirname(file), { recursive: true, mode: 448 });
      requirePrivateWritableDirectory(path8.dirname(file), "messages must remain owner-private");
      guardDatabaseFiles(file);
      const fd = fs7.openSync(file, "a", 384);
      fs7.closeSync(fd);
      this.db = new MemeshDatabase(file);
      try {
        if (busyTimeoutMs !== void 0)
          this.db.pragma(`busy_timeout = ${busyTimeoutMs}`);
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
          CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY, host TEXT NOT NULL, machine TEXT NOT NULL,
            pid INTEGER NOT NULL, wake TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY, sender TEXT NOT NULL, sender_host TEXT NOT NULL,
            sender_machine TEXT NOT NULL, recipient TEXT NOT NULL, recipient_host TEXT,
            recipient_machine TEXT NOT NULL, kind TEXT NOT NULL, body TEXT,
            body_bytes INTEGER NOT NULL, reply_to TEXT, sent_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS events (
            message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            at TEXT NOT NULL, event TEXT NOT NULL, detail TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS message_recipient ON messages(recipient, sent_at);
          CREATE INDEX IF NOT EXISTS message_expiry ON messages(sent_at);
          CREATE INDEX IF NOT EXISTS message_events ON events(message_id);
        `);
        this.upgradeRoutingSchema();
        for (const target of databaseFiles(file))
          removeGroupAndOtherAccess(target);
        const legacySource = options.legacySource ?? ownedSource;
        if (legacySource)
          importLegacyConversationMessages(legacySource, this.db, { nowMs: this.clock(), localMachine: this.machine, messageIds: options.legacyMessageIds });
        for (const archiveFile of archiveFiles) {
          const archive = new MemeshDatabase(archiveFile, { readOnly: true });
          try {
            if (busyTimeoutMs !== void 0)
              archive.pragma(`busy_timeout = ${busyTimeoutMs}`);
            assertLegacyConversationArchiveSchema(archive);
            importLegacyConversationMessages(archive, this.db, { nowMs: this.clock(), localMachine: this.machine });
          } finally {
            archive.close();
          }
        }
        this.db.transaction(() => this.maintain()).immediate();
      } catch (error) {
        this.db.close();
        throw error;
      }
    } finally {
      ownedSource?.close();
    }
  }
  close() {
    this.db.close();
  }
  upgradeRoutingSchema() {
    this.db.transaction(() => {
      const columns = this.db.prepare("PRAGMA table_info(messages)").all();
      if (columns.some((c) => c.name === "sender_local"))
        return;
      this.db.exec(`ALTER TABLE messages ADD COLUMN sender_local INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE messages ADD COLUMN recipient_local INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE messages ADD COLUMN network_id TEXT;
        ALTER TABLE messages ADD COLUMN sender_machine_id TEXT;
        ALTER TABLE messages ADD COLUMN recipient_machine_id TEXT;
        UPDATE messages SET sender_local=1 WHERE kind != 'legacy';
        UPDATE messages SET recipient_local=1 WHERE kind != 'legacy' AND recipient_host IS NOT NULL;
        UPDATE messages SET sender_local=1 WHERE kind='legacy' AND sender_machine!='unknown' AND sender NOT LIKE 'legacy:%';
        UPDATE messages SET recipient_local=1 WHERE kind='legacy' AND recipient_machine!='unknown' AND recipient NOT LIKE 'legacy:%';
        ALTER TABLE conversations RENAME TO conversations_before_routing;
        CREATE TABLE conversations (
          id TEXT NOT NULL, host TEXT NOT NULL, machine TEXT NOT NULL, pid INTEGER NOT NULL, wake TEXT NOT NULL,
          is_local INTEGER NOT NULL, machine_id TEXT NOT NULL, network_id TEXT NOT NULL, online INTEGER NOT NULL,
          PRIMARY KEY(id,is_local,machine_id,network_id));
        INSERT INTO conversations SELECT id,host,machine,pid,wake,1,'','',0 FROM conversations_before_routing;
        DROP TABLE conversations_before_routing;`);
    }).immediate();
  }
  maintainMessages() {
    this.db.transaction(() => this.maintain()).immediate();
  }
  registerChannel(caller, hostPid) {
    if (!Number.isSafeInteger(hostPid) || hostPid <= 1 || !this.processAlive(hostPid))
      throw new Error("Channel host identity unavailable");
    const existing = this.findRegistration(caller);
    if (!existing)
      this.register({ id: caller, host: "claude-code", machine: this.machine, pid: hostPid, wake: {} });
    this.channelRegistration(caller, hostPid);
  }
  channelBatch(caller, hostPid) {
    this.channelRegistration(caller, hostPid);
    return this.messageBatch(caller, [], true);
  }
  recordChannelPush(caller, hostPid, ids) {
    this.db.transaction(() => {
      this.channelRegistration(caller, hostPid);
      for (const id of ids) {
        const message = this.get(id);
        if (message.recipient !== caller || message.recipient_host !== "claude-code" || !message.recipient_local || this.rejected(id))
          throw new Error("Wrong recipient");
        this.eventOnce(id, "pushed", { actor: caller, route: "claude-channel" });
      }
    }).immediate();
  }
  channelRegistration(caller, hostPid) {
    const registered = this.registration(caller);
    if (registered.host !== "claude-code" || registered.pid !== hostPid || hostPid <= 1 || !this.processAlive(hostPid))
      throw new Error("Channel host identity unavailable");
  }
  wakeTarget(messageId) {
    const message = this.get(messageId);
    if (!message.recipient_local || this.rejected(messageId))
      return void 0;
    const target = this.findRegistration(message.recipient);
    if (!target || target.host !== message.recipient_host || !this.processAlive(target.pid))
      return void 0;
    return target;
  }
  recordPush(sender, messageId, route) {
    const message = this.get(messageId);
    if (message.sender !== identifier(sender) || !message.sender_local || this.rejected(messageId)) {
      throw new Error("Wrong push actor");
    }
    this.eventOnce(messageId, "pushed", { actor: sender, route });
  }
  register(input) {
    const id = identifier(input.id);
    if (id.startsWith(LEGACY_CONVERSATION_PREFIX))
      throw new Error("Legacy audit identities cannot register as conversations");
    if (!["claude-code", "codex", "hermes"].includes(input.host))
      throw new Error("Unknown host");
    if (identifier(input.machine).toLowerCase() !== this.machine)
      throw new Error("Local registration requires this machine");
    if (!Number.isSafeInteger(input.pid) || input.pid <= 0)
      throw new Error("Invalid process id");
    this.db.prepare(`INSERT INTO conversations (id,host,machine,pid,wake,is_local,machine_id,network_id,online) VALUES (?, ?, ?, ?, ?,1,'','',0)
      ON CONFLICT(id,is_local,machine_id,network_id) DO UPDATE SET host=excluded.host, machine=excluded.machine,
      pid=excluded.pid, wake=excluded.wake`).run(id, input.host, this.machine, input.pid, JSON.stringify(input.wake));
  }
  discover() {
    const rows = this.db.prepare("SELECT * FROM conversations ORDER BY id").all();
    return rows.filter((row) => row.is_local || row.network_id === this.network?.network_id && this.member(row.machine_id)).map((row) => ({
      id: row.id,
      host: row.host,
      machine: row.is_local ? this.machine : this.member(row.machine_id).name.toLowerCase(),
      pid: row.is_local ? row.pid : 0,
      wake: row.is_local ? JSON.parse(row.wake) : {},
      online: row.is_local ? this.processAlive(row.pid) : Boolean(row.online)
    }));
  }
  send(sender, input) {
    const from = this.registration(sender);
    if (!["task", "question", "review_request", "result"].includes(input.kind))
      throw new Error("Unknown message kind");
    if (typeof input.body !== "string")
      throw new Error("Message body must be text");
    const pieces = input.recipient.split("@");
    if (pieces.length > 2 || pieces.length === 2 && !pieces[1])
      throw new Error("Invalid recipient address");
    if (input.reply_to !== void 0 && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.reply_to)) {
      throw new Error("Invalid reply_to message id");
    }
    const recipient = identifier(pieces[0]);
    let machine = pieces[1] ? identifier(pieces[1]).toLowerCase() : this.machine;
    let remoteId = pieces[1] && machine !== this.machine ? this.network?.members.find((m) => m.name.toLowerCase() === machine)?.id : void 0;
    let local = !pieces[1] || machine === this.machine;
    const original = input.reply_to ? this.get(input.reply_to) : void 0;
    if (original) {
      if (!original.recipient_local || original.recipient !== from.id || original.sender !== recipient || this.rejected(original.id)) {
        throw new Error("Reply must address the sender of a message received by this conversation");
      }
      if (original.sender_local) {
        if (pieces[1] && machine !== original.sender_machine && machine !== this.machine)
          throw new Error("Wrong reply machine");
        local = true;
        remoteId = void 0;
        machine = this.machine;
      } else {
        const member = original.network_id === this.network?.network_id ? this.member(original.sender_machine_id) : void 0;
        if (!pieces[1] || machine !== original.sender_machine && machine !== member?.name.toLowerCase())
          throw new Error("Wrong reply machine");
        local = false;
        remoteId = member?.id;
        machine = member?.name.toLowerCase() ?? machine;
      }
    }
    const to = local ? this.findRegistration(recipient) : remoteId ? this.remoteRegistration(remoteId, recipient) : void 0;
    return this.db.transaction(() => {
      const message = {
        id: randomUUID(),
        sender: from.id,
        sender_host: from.host,
        sender_machine: this.machine,
        recipient,
        recipient_host: to?.host ?? null,
        recipient_machine: machine,
        kind: input.kind,
        body: input.body,
        body_bytes: Buffer.byteLength(input.body, "utf8"),
        reply_to: input.reply_to ?? null,
        sent_at: this.now()
      };
      const tooLarge = Buffer.byteLength(renderConversationMessage(message), "utf8") > MESSAGE_MAX_BYTES;
      const reason = tooLarge ? "message_too_large" : !to ? "unknown_recipient" : void 0;
      if (tooLarge)
        message.body = null;
      this.insert(message, {
        sender_local: 1,
        recipient_local: local && Boolean(to) ? 1 : 0,
        network_id: !local ? this.network?.network_id ?? null : null,
        sender_machine_id: !local ? this.network?.self.id ?? null : null,
        recipient_machine_id: remoteId ?? null
      });
      this.event(message.id, reason ? "rejected" : "queued", { actor: from.id, ...reason ? { reason } : {} });
      if (reason)
        return {
          message,
          accepted: false,
          reason,
          recipients: this.discover().map((row) => row.machine === this.machine ? row.id : `${row.id}@${row.machine}`)
        };
      if (message.reply_to) {
        this.eventOnce(message.reply_to, "delivered", { actor: from.id, via: "reply" });
        this.eventOnce(message.reply_to, "replied", { actor: from.id, reply: message.id });
      }
      const pending = local ? this.pending(recipient).length : this.db.prepare(`SELECT COUNT(*) AS count FROM messages m
        WHERE recipient=? AND recipient_local=0 AND network_id=? AND recipient_machine_id=?
        AND NOT EXISTS (SELECT 1 FROM events e WHERE e.message_id=m.id
          AND e.event IN ('rejected','delivered','read','replied','legacy_handled'))`).get(recipient, this.network.network_id, remoteId).count;
      return { message, accepted: true, ...pending > 30 ? { warning: `${pending} messages await delivery` } : {} };
    }).immediate();
  }
  read(caller, id) {
    caller = identifier(caller);
    this.registration(caller);
    return this.db.transaction(() => {
      const message = this.get(id);
      if (message.recipient !== caller || !message.recipient_local || this.rejected(id)) {
        throw new Error("Message is not addressed to this conversation");
      }
      this.eventOnce(id, "delivered", { actor: caller, via: "read" });
      this.eventOnce(id, "read", { actor: caller });
      return publicMessage(message);
    }).immediate();
  }
  status(caller, id) {
    if (caller !== void 0)
      caller = identifier(caller);
    if (caller)
      this.registration(caller);
    const rows = this.db.prepare(`SELECT * FROM messages ${id ? "WHERE id = ?" : ""} ORDER BY sent_at, rowid`).all(...id ? [id] : []);
    return rows.filter((row) => !caller || row.sender === caller && row.sender_local || row.recipient === caller && row.recipient_local).map((row) => {
      const events = this.db.prepare("SELECT * FROM events WHERE message_id = ? ORDER BY rowid").all(row.id);
      const priority = ["queued", "pushed", "delivered", "read", "replied"];
      const state = this.rejected(row.id) ? "rejected" : [...priority].reverse().find((value) => events.some((event) => event.event === value)) ?? (events.some((event) => event.event === "legacy_handled") ? "legacy_handled" : events.some((event) => event.event === "legacy_imported") ? "legacy_imported" : "queued");
      return { ...publicMessage(row), state, events };
    });
  }
  hookBatch(caller, excludedIds = []) {
    caller = identifier(caller);
    this.registration(caller);
    return this.messageBatch(caller, excludedIds, false);
  }
  messageBatch(caller, excludedIds, excludePushed) {
    let text2 = "";
    const ids = [];
    const excluded = new Set(excludedIds);
    for (const message of this.pending(caller, excludePushed)) {
      if (excluded.has(message.id))
        continue;
      const next = renderConversationMessage(message);
      if (Buffer.byteLength(next, "utf8") > MESSAGE_MAX_BYTES)
        continue;
      if (Buffer.byteLength(text2 + next, "utf8") > MESSAGE_MAX_BYTES)
        break;
      text2 += next;
      ids.push(message.id);
    }
    return { text: text2, ids };
  }
  recordHookDelivery(caller, ids, hook) {
    caller = identifier(caller);
    this.registration(caller);
    this.db.transaction(() => {
      for (const id of ids) {
        const message = this.get(id);
        if (message.recipient !== caller || !message.recipient_local || this.rejected(id))
          throw new Error("Wrong recipient");
        this.eventOnce(id, "delivered", { actor: caller, via: "hook", hook });
      }
    }).immediate();
  }
  exportRegistrations() {
    const rows = this.db.prepare("SELECT id,host,pid FROM conversations WHERE is_local=1 ORDER BY id").all();
    return rows.map((row) => ({ id: row.id, host: row.host, online: this.processAlive(row.pid) }));
  }
  replaceRemoteRegistrations(peerId, registrations) {
    this.writeRemoteRegistrations(peerId, registrations, true);
  }
  upsertRemoteRegistrations(peerId, registrations) {
    this.writeRemoteRegistrations(peerId, registrations, false);
  }
  writeRemoteRegistrations(peerId, registrations, replace) {
    const peer = this.requirePeer(peerId);
    const ids = /* @__PURE__ */ new Set();
    for (const row of registrations) {
      if (Object.keys(row).sort().join(",") !== "host,id,online" || identifier(row.id).startsWith(LEGACY_CONVERSATION_PREFIX) || !["claude-code", "codex", "hermes"].includes(row.host) || typeof row.online !== "boolean" || ids.has(row.id))
        throw new Error("Invalid remote registration snapshot");
      ids.add(row.id);
    }
    this.db.transaction(() => {
      if (replace)
        this.db.prepare("DELETE FROM conversations WHERE is_local=0 AND network_id=? AND machine_id=?").run(this.network.network_id, peerId);
      const insert = this.db.prepare(`INSERT INTO conversations (id,host,machine,pid,wake,is_local,machine_id,network_id,online) VALUES (?,?,?,0,'{}',0,?,?,?)
        ON CONFLICT(id,is_local,machine_id,network_id) DO UPDATE SET host=excluded.host,machine=excluded.machine,online=excluded.online`);
      for (const row of registrations)
        insert.run(row.id, row.host, peer.name.toLowerCase(), peerId, this.network.network_id, row.online ? 1 : 0);
    }).immediate();
  }
  outgoingFor(peerId) {
    this.requirePeer(peerId);
    const rows = this.db.prepare(`SELECT m.* FROM messages m WHERE sender_local=1 AND recipient_local=0
      AND network_id=? AND sender_machine_id=? AND recipient_machine_id=? AND sent_at>?
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.message_id=m.id AND e.event IN ('rejected','network_accepted'))
      ORDER BY sent_at,rowid`).all(this.network.network_id, this.network.self.id, peerId, new Date(this.clock() - 14 * DAY).toISOString());
    return rows.map((row) => ({ network_id: row.network_id, sender_machine_id: row.sender_machine_id, recipient_machine_id: row.recipient_machine_id, message: publicMessage(row) }));
  }
  receiveFrom(peerId, wire) {
    const peer = this.requirePeer(peerId);
    if (wire.network_id !== this.network.network_id || wire.sender_machine_id !== peerId || wire.recipient_machine_id !== this.network.self.id)
      throw new Error("Wrong network message binding");
    const m = wire.message;
    if (!m || Object.keys(m).sort().join(",") !== MESSAGE_COLUMNS.split(",").sort().join(",") || !UUID.test(m.id) || identifier(m.sender).startsWith(LEGACY_CONVERSATION_PREFIX) || identifier(m.recipient).startsWith(LEGACY_CONVERSATION_PREFIX) || !["claude-code", "codex", "hermes"].includes(m.sender_host) || !["task", "question", "review_request", "result"].includes(m.kind) || typeof m.body !== "string" || m.body_bytes !== Buffer.byteLength(m.body, "utf8") || !validUtc(m.sent_at) || Date.parse(m.sent_at) <= this.clock() - 14 * DAY || Date.parse(m.sent_at) > this.clock() + NETWORK_CLOCK_SKEW_MS || m.reply_to !== null && !UUID.test(m.reply_to))
      throw new Error("Invalid or expired network message");
    const message = { ...publicMessage(m), sender_machine: peer.name.toLowerCase(), recipient_machine: this.machine };
    if (Buffer.byteLength(renderConversationMessage(message), "utf8") > MESSAGE_MAX_BYTES)
      throw new Error("Network message too large");
    return this.db.transaction(() => {
      const prior = this.db.prepare("SELECT * FROM messages WHERE id=?").get(m.id);
      if (prior) {
        const content = (row) => JSON.stringify(MESSAGE_COLUMNS.split(",").filter((k) => k !== "sender_machine" && k !== "recipient_machine").map((k) => row[k]));
        if (prior.sender_local || !prior.recipient_local || prior.network_id !== wire.network_id || prior.sender_machine_id !== peerId || prior.recipient_machine_id !== wire.recipient_machine_id || this.rejected(prior.id) || content(prior) !== content(message))
          throw new Error("Network message id collision");
        return "duplicate";
      }
      const from = this.remoteRegistration(peerId, m.sender), to = this.findRegistration(m.recipient);
      if (!from || from.host !== m.sender_host || !to || to.host !== m.recipient_host)
        throw new Error("Unregistered network conversation");
      if (m.reply_to) {
        const original = this.get(m.reply_to);
        if (!original.sender_local || original.recipient_local || original.network_id !== wire.network_id || original.sender_machine_id !== this.network.self.id || original.recipient_machine_id !== peerId || original.sender !== m.recipient || original.recipient !== m.sender || this.rejected(original.id))
          throw new Error("Wrong network reply binding");
        this.eventOnce(original.id, "delivered", { actor: m.sender, peer: peerId, via: "reply" });
        this.eventOnce(original.id, "replied", { actor: m.sender, peer: peerId, reply: m.id });
      }
      this.insert(message, { sender_local: 0, recipient_local: 1, network_id: wire.network_id, sender_machine_id: peerId, recipient_machine_id: wire.recipient_machine_id });
      this.event(message.id, "queued", { actor: m.sender, peer: peerId, via: "network" });
      return "accepted";
    }).immediate();
  }
  recordCopyAccepted(peerId, messageId) {
    this.outboundMessage(peerId, messageId);
    this.eventOnce(messageId, "network_accepted", { peer: peerId, network_id: this.network.network_id });
  }
  recordNetworkPush(peerId, messageId, route) {
    this.requirePeer(peerId);
    const message = this.get(messageId);
    if (!message.recipient_local || message.sender_local || message.network_id !== this.network.network_id || message.sender_machine_id !== peerId || message.recipient_machine_id !== this.network.self.id || this.rejected(messageId))
      throw new Error("Wrong network push binding");
    this.eventOnce(messageId, "pushed", { actor: message.recipient, peer: peerId, route });
  }
  receiptsFor(peerId) {
    this.requirePeer(peerId);
    const rows = this.db.prepare(`SELECT e.message_id,e.event,e.at,e.detail FROM events e JOIN messages m ON m.id=e.message_id
      WHERE m.sender_local=0 AND m.recipient_local=1 AND m.network_id=? AND m.sender_machine_id=? AND m.recipient_machine_id=?
      AND m.sent_at>? AND e.event IN ('delivered','read') ORDER BY e.rowid`).all(this.network.network_id, peerId, this.network.self.id, new Date(this.clock() - 14 * DAY).toISOString());
    return rows.map((row) => ({ message_id: row.message_id, event: row.event, at: row.at, actor: JSON.parse(row.detail).actor })).filter((receipt) => !this.receiptAcknowledged(receipt));
  }
  recordReceiptAccepted(peerId, receipt) {
    this.requirePeer(peerId);
    const message = this.get(receipt.message_id);
    if (message.sender_local || !message.recipient_local || message.network_id !== this.network.network_id || message.sender_machine_id !== peerId || message.recipient_machine_id !== this.network.self.id || receipt.actor !== message.recipient)
      throw new Error("Wrong receipt acknowledgement binding");
    const actual = this.db.prepare("SELECT at,detail FROM events WHERE message_id=? AND event=?").get(receipt.message_id, receipt.event);
    if (!["delivered", "read"].includes(receipt.event) || !actual || actual.at !== receipt.at || JSON.parse(actual.detail).actor !== receipt.actor)
      throw new Error("Unknown receipt acknowledgement");
    if (this.receiptAcknowledged(receipt))
      return;
    if (!this.receiptsFor(peerId).some((r) => this.receiptKey(r) === this.receiptKey(receipt)))
      throw new Error("Unknown receipt acknowledgement");
    this.event(receipt.message_id, "network_receipt_acked", { receipt: this.receiptKey(receipt), peer: peerId });
  }
  receiveReceipt(peerId, receipt) {
    const message = this.outboundMessage(peerId, receipt.message_id);
    if (Object.keys(receipt).sort().join(",") !== "actor,at,event,message_id" || !["delivered", "read"].includes(receipt.event) || receipt.actor !== message.recipient || !validUtc(receipt.at) || Date.parse(receipt.at) < Date.parse(message.sent_at) - NETWORK_CLOCK_SKEW_MS || Date.parse(receipt.at) > this.clock() + NETWORK_CLOCK_SKEW_MS)
      throw new Error("Invalid network receipt");
    return this.db.transaction(() => {
      const previous = this.db.prepare("SELECT at,detail FROM events WHERE message_id=? AND event=?").get(message.id, receipt.event);
      if (previous) {
        const detail = JSON.parse(previous.detail);
        if (detail.via === "network_receipt" && previous.at !== receipt.at)
          throw new Error("Network receipt conflict");
        return "duplicate";
      }
      this.db.prepare("INSERT INTO events (message_id,at,event,detail) VALUES (?,?,?,?)").run(message.id, receipt.at, receipt.event, JSON.stringify({ actor: receipt.actor, peer: peerId, via: "network_receipt" }));
      return "accepted";
    }).immediate();
  }
  member(id) {
    return this.network?.members.find((m) => m.id === id && id !== this.network?.self.id);
  }
  requirePeer(id) {
    const peer = this.member(id);
    if (!peer)
      throw new Error("Peer is not a current network member");
    return peer;
  }
  remoteRegistration(peerId, id) {
    this.requirePeer(peerId);
    return this.db.prepare("SELECT id,host FROM conversations WHERE is_local=0 AND network_id=? AND machine_id=? AND id=?").get(this.network.network_id, peerId, identifier(id));
  }
  outboundMessage(peerId, id) {
    this.requirePeer(peerId);
    const message = this.get(id);
    if (!message.sender_local || message.recipient_local || message.network_id !== this.network.network_id || message.sender_machine_id !== this.network.self.id || message.recipient_machine_id !== peerId || Date.parse(message.sent_at) <= this.clock() - 14 * DAY || this.rejected(id))
      throw new Error("Wrong outbound message binding");
    return message;
  }
  receiptKey(receipt) {
    return JSON.stringify([receipt.message_id, receipt.event, receipt.at, receipt.actor]);
  }
  receiptAcknowledged(receipt) {
    return Boolean(this.db.prepare("SELECT 1 FROM events WHERE message_id=? AND event='network_receipt_acked' AND json_extract(detail,'$.receipt')=?").get(receipt.message_id, this.receiptKey(receipt)));
  }
  now() {
    return new Date(this.clock()).toISOString();
  }
  findRegistration(id) {
    const row = this.db.prepare("SELECT id,host,machine,pid,wake FROM conversations WHERE id = ? AND is_local=1").get(identifier(id));
    return row ? { ...row, machine: this.machine, wake: JSON.parse(row.wake) } : void 0;
  }
  registration(id) {
    const found = this.findRegistration(id);
    if (!found)
      throw new Error("Caller conversation is not registered");
    return found;
  }
  get(id) {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    if (!row)
      throw new Error("Message not found");
    return row;
  }
  rejected(id) {
    return Boolean(this.db.prepare("SELECT 1 FROM events WHERE message_id = ? AND event = 'rejected'").get(id));
  }
  pending(caller, excludePushed = false) {
    return this.db.prepare(`SELECT m.* FROM messages m WHERE recipient = ? AND recipient_local=1
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.message_id = m.id AND e.event IN ('rejected','delivered','read','replied','legacy_handled'))
      AND (? = 0 OR (m.recipient_host = 'claude-code'
        AND NOT EXISTS (SELECT 1 FROM events e WHERE e.message_id = m.id AND e.event = 'pushed')))
      ORDER BY sent_at, rowid`).all(caller, excludePushed ? 1 : 0);
  }
  insert(message, route = {
    sender_local: 1,
    recipient_local: 1,
    network_id: null,
    sender_machine_id: null,
    recipient_machine_id: null
  }) {
    this.db.prepare(`INSERT INTO messages (${MESSAGE_COLUMNS},sender_local,recipient_local,network_id,sender_machine_id,recipient_machine_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,?,?,?,?,?)`).run(message.id, message.sender, message.sender_host, message.sender_machine, message.recipient, message.recipient_host, message.recipient_machine, message.kind, message.body, message.body_bytes, message.reply_to, message.sent_at, route.sender_local, route.recipient_local, route.network_id, route.sender_machine_id, route.recipient_machine_id);
  }
  event(id, event, detail) {
    this.db.prepare("INSERT INTO events VALUES (?, ?, ?, ?)").run(id, this.now(), event, JSON.stringify(detail));
  }
  eventOnce(id, event, detail) {
    if (!this.db.prepare("SELECT 1 FROM events WHERE message_id = ? AND event = ?").get(id, event))
      this.event(id, event, detail);
  }
  maintain() {
    const now = this.clock();
    this.db.prepare("DELETE FROM messages WHERE sent_at <= ?").run(new Date(now - 14 * DAY).toISOString());
    const overdue = this.db.prepare(`SELECT m.* FROM messages m WHERE sent_at <= ? AND sender_host != 'system' AND sender_local=1
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.message_id=m.id
        AND e.event IN ('rejected','delivered','read','replied','legacy_handled','undelivered_notified'))`).all(new Date(now - DAY).toISOString());
    for (const original of overdue) {
      const notice = {
        id: randomUUID(),
        sender: "memesh",
        sender_host: "system",
        sender_machine: this.machine,
        recipient: original.sender,
        recipient_host: original.sender_host,
        recipient_machine: original.sender_machine,
        kind: "result",
        body: `Message ${original.id} has not been delivered after one day.`,
        body_bytes: 0,
        reply_to: original.id,
        sent_at: this.now()
      };
      notice.body_bytes = Buffer.byteLength(notice.body, "utf8");
      this.insert(notice);
      this.event(notice.id, "queued", { actor: "memesh", reason: "undelivered" });
      this.event(original.id, "undelivered_notified", { actor: "memesh", notification: notice.id });
    }
  }
};

// dist/host-adapters/conversation-wake.js
import fs8 from "node:fs";
import net from "node:net";
import os3 from "node:os";
import path9 from "node:path";
import { execFile } from "node:child_process";
var TIMEOUT_MS = 2e3;
var MAX_OUTPUT_BYTES = 16 * 1024;
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1)
    return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function privateSocket(socketPath) {
  if (!path9.isAbsolute(socketPath) || process.platform === "win32")
    throw new Error("Socket unavailable");
  const stat2 = fs8.lstatSync(socketPath);
  if (!stat2.isSocket() || (stat2.mode & 63) !== 0 || typeof process.getuid !== "function" || stat2.uid !== process.getuid())
    throw new Error("Socket unavailable");
  return stat2;
}
async function wakeConversationMessage(message, target, localMachine = os3.hostname().toLowerCase()) {
  if (!target || target.id !== message.recipient || target.host !== message.recipient_host || target.machine !== message.recipient_machine || target.machine !== localMachine || !alive(target.pid) || message.body === null)
    return { pushed: false, reason: "unavailable" };
  const content = renderConversationMessage(message);
  if (Buffer.byteLength(content, "utf8") > MESSAGE_MAX_BYTES)
    return { pushed: false, reason: "unavailable" };
  try {
    if (target.host === "claude-code" && typeof target.wake.socket === "string") {
      const socketPath = target.wake.socket;
      const before = privateSocket(socketPath);
      await new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        let settled = false;
        const finish = (error) => {
          if (settled)
            return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          if (error)
            reject(error);
          else
            resolve();
        };
        const timer = setTimeout(() => finish(new Error("Socket timeout")), TIMEOUT_MS);
        socket.once("error", () => finish(new Error("Socket failed")));
        socket.once("close", () => finish(new Error("Socket closed before write")));
        socket.once("connect", () => {
          try {
            const after = privateSocket(socketPath);
            if (before.dev !== after.dev || before.ino !== after.ino || !alive(target.pid))
              throw new Error("Host changed");
            socket.end(`${JSON.stringify({ type: "user", message: { role: "user", content } })}
`, () => finish());
          } catch {
            finish(new Error("Socket identity changed"));
          }
        });
      });
      return { pushed: true, route: "claude-socket" };
    }
    if (target.host === "codex" && target.wake.thread === target.id) {
      await new Promise((resolve, reject) => {
        execFile("codex", ["queue", "--thread", target.id, "--message", content], {
          shell: false,
          windowsHide: true,
          timeout: TIMEOUT_MS,
          killSignal: "SIGKILL",
          maxBuffer: MAX_OUTPUT_BYTES,
          encoding: "utf8"
        }, (error) => {
          if (error)
            reject(new Error("Queue failed"));
          else
            resolve();
        });
      });
      return { pushed: true, route: "codex-queue" };
    }
    return { pushed: false, reason: "unavailable" };
  } catch {
    return { pushed: false, reason: "failed" };
  }
}

// dist/network/bridge-state.js
import fs9 from "node:fs";
import path10 from "node:path";
function statusPath(dataDir2) {
  return path10.join(networkDir(dataDir2), "bridge-status.json");
}
function logPath(dataDir2) {
  return path10.join(networkDir(dataDir2), "bridge.log");
}
function writeStatus(dataDir2, status) {
  const file = statusPath(dataDir2);
  const temporary = `${file}.tmp-${process.pid}`;
  fs9.writeFileSync(temporary, `${JSON.stringify(status)}
`, { mode: 384 });
  fs9.renameSync(temporary, file);
}

// dist/network/control-socket.js
import { createHash as createHash4, randomBytes as randomBytes4, timingSafeEqual } from "node:crypto";
import fs11 from "node:fs";
import net2 from "node:net";
import path11 from "node:path";

// dist/core/agent-messaging.js
import { createHash as createHash3, randomBytes as randomBytes3, randomUUID as randomUUID2 } from "node:crypto";

// dist/core/agent-message-storage.js
import fs10 from "node:fs";

// dist/core/agent-message-ttl.js
var AGENT_MESSAGE_TTL_MS = 24 * 60 * 60 * 1e3;

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
var DECISION_TYPES = /* @__PURE__ */ new Set(["decision", "architecture_decision", "design_decision"]);
var PREFERENCE_TYPES = ["preference", "user_preference"];
var SHARED_EXPERIENCE_TYPES = /* @__PURE__ */ new Set([
  ...LESSON_TYPES,
  ...DECISION_TYPES,
  ...PREFERENCE_TYPES
]);
var SHARED_EXPERIENCE_TYPE_LIST = [...SHARED_EXPERIENCE_TYPES];
var DECISION_LAYER_TYPES = [...WORK_LAYER_TYPES].filter((type) => !LESSON_TYPES.has(type) && type !== "task-state");
var DEFAULT_TOPOLOGY_BUDGET = {
  maxChars: 4e3,
  maxLineChars: 160
};
var SHARED_TOPOLOGY_BUDGET = {
  maxChars: 640,
  maxLineChars: DEFAULT_TOPOLOGY_BUDGET.maxLineChars
};
var GLOBAL_TOPOLOGY_BUDGET = {
  maxChars: 640,
  maxLineChars: DEFAULT_TOPOLOGY_BUDGET.maxLineChars
};
var SNIPPET_FETCH_CHARS = DEFAULT_TOPOLOGY_BUDGET.maxLineChars * 4;

// dist/core/agent-scope-id.js
var HOST_CONFIG_MAX_BYTES = 64 * 1024;
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
var AGENT_MESSAGE_JSON_MAX_BYTES = 64 * 1024;
var AGENT_NATIVE_MESSAGE_MAX_BYTES = 16 * 1024;

// dist/network/frames.js
function parseConversationFrame(bytes) {
  if (bytes.length > FRAME_MAX_BYTES)
    throw new FrameError("frame_too_large", "Frame too large");
  let raw;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new FrameError("frame_invalid", "Invalid conversation JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.version !== 2)
    throw new FrameError("frame_invalid", "Unsupported conversation frame");
  if (raw.kind === "conversations" && exactKeys(raw, ["version", "kind", "relay", "addrs", "entries"]) && isOptionalText(raw.relay) && Array.isArray(raw.addrs) && raw.addrs.length <= 64 && raw.addrs.every((a) => isText(a, 64)) && Array.isArray(raw.entries) && raw.entries.every((r) => r && typeof r === "object" && !Array.isArray(r) && exactKeys(r, ["id", "host", "online"]) && isText(r.id) && ["claude-code", "codex", "hermes"].includes(String(r.host)) && typeof r.online === "boolean"))
    return raw;
  if (raw.kind === "conversation-message" && exactKeys(raw, ["version", "kind", "row"]) && raw.row && typeof raw.row === "object" && !Array.isArray(raw.row) && exactKeys(raw.row, ["network_id", "sender_machine_id", "recipient_machine_id", "message"]))
    return raw;
  if (raw.kind === "conversation-receipt" && exactKeys(raw, ["version", "kind", "receipt"]) && raw.receipt && typeof raw.receipt === "object" && !Array.isArray(raw.receipt) && exactKeys(raw.receipt, ["message_id", "event", "actor", "at"]))
    return raw;
  throw new FrameError("frame_invalid", "Invalid conversation frame");
}
function conversationPresenceFrames(relay, addrs, entries) {
  const frames = [];
  let frame = { version: 2, kind: "conversations", relay, addrs, entries: [] };
  for (const entry of entries) {
    const next = { ...frame, entries: [...frame.entries, entry] };
    if (Buffer.byteLength(JSON.stringify(next)) > FRAME_MAX_BYTES) {
      if (!frame.entries.length)
        throw new FrameError("frame_too_large", "Presence entry too large");
      frames.push(frame);
      frame = { ...frame, entries: [entry] };
      parseConversationFrame(Buffer.from(JSON.stringify(frame)));
    } else
      frame = next;
  }
  frames.push(frame);
  return frames;
}
var ROSTER_EXCHANGE_MAX_BYTES = SIGNED_ROSTER_MAX_BYTES + 1024;
function parseRosterExchange(bytes) {
  if (bytes.length > ROSTER_EXCHANGE_MAX_BYTES)
    throw new FrameError("roster_invalid", "Roster exchange too large.");
  const raw = JSON.parse(bytes.toString("utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).sort().join(",") !== "roster_json,signature" || typeof raw.roster_json !== "string" || Buffer.byteLength(raw.roster_json) > SIGNED_ROSTER_MAX_BYTES || typeof raw.signature !== "string" || raw.signature.length > 256) {
    throw new FrameError("roster_invalid", "Invalid roster exchange.");
  }
  return raw;
}
async function exchangeRosterStream(stream, local, accept, timeoutMs) {
  const write = async (signed) => {
    const bytes = Buffer.from(JSON.stringify(signed));
    parseRosterExchange(bytes);
    await deadline(stream.send.writeAll(toBytes(bytes)), timeoutMs, "sending roster");
    await deadline(stream.send.finish(), timeoutMs, "finishing roster");
  };
  if (local)
    await write(local);
  const received = Buffer.from(await deadline(stream.recv.readToEnd(ROSTER_EXCHANGE_MAX_BYTES), timeoutMs, "receiving roster"));
  const selected = accept(parseRosterExchange(received));
  if (!local)
    await write(selected);
}
var FRAME_MAX_BYTES = AGENT_MESSAGE_JSON_MAX_BYTES + 8 * 1024;
var ACK_MAX_BYTES = 1024;
var FIELD_MAX = 200;
var FrameError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
var isText = (value, max = FIELD_MAX) => typeof value === "string" && value.length > 0 && value.length <= max;
var isOptionalText = (value) => value === null || isText(value);
function exactKeys(value, keys2) {
  const own = Object.keys(value);
  return own.length === keys2.length && keys2.every((key) => Object.hasOwn(value, key));
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

// dist/network/membership.js
var MEMBERSHIP_MAX_BYTES = ROSTER_EXCHANGE_MAX_BYTES + 256;
var MEMBERSHIP_ACK_MAX_BYTES = 512;
var MEMBERSHIP_DEADLINE_MS = 5e3;
var NETWORK = /^[0-9a-f]{32}$/;
var MACHINE = /^[0-9a-f]{64}$/;
function keys(value, expected) {
  return Object.keys(value).sort().join(",") === expected.sort().join(",");
}
function invalid2() {
  throw new NetworkError("bad_request", "Invalid membership request.");
}
function parseMembershipFrame(bytes) {
  if (bytes.length > MEMBERSHIP_MAX_BYTES)
    invalid2();
  const raw = JSON.parse(bytes.toString("utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.version !== 1 || typeof raw.network_id !== "string" || !NETWORK.test(raw.network_id))
    invalid2();
  if ((raw.op === "leave-self" || raw.op === "self-status") && keys(raw, ["version", "op", "network_id"]))
    return raw;
  if (raw.op === "roster" && keys(raw, ["version", "op", "network_id", "roster"])) {
    return { ...raw, roster: parseRosterExchange(Buffer.from(JSON.stringify(raw.roster))) };
  }
  invalid2();
}
function parseMembershipAck(bytes, networkId) {
  if (bytes.length > MEMBERSHIP_ACK_MAX_BYTES)
    invalid2();
  const raw = JSON.parse(bytes.toString("utf8"));
  if (!raw || typeof raw !== "object" || !keys(raw, ["version", "network_id", "roster_version", "member"]) || raw.version !== 1 || raw.network_id !== networkId || !Number.isSafeInteger(raw.roster_version) || raw.roster_version < 1 || typeof raw.member !== "boolean")
    invalid2();
  return raw;
}
function parseMembershipAction(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    invalid2();
  const value = raw;
  if (typeof value.network_id !== "string" || typeof value.machine_id !== "string" || !NETWORK.test(value.network_id) || !MACHINE.test(value.machine_id))
    invalid2();
  if (value.action === "leave" && keys(value, ["action", "network_id", "machine_id"]))
    return value;
  if (value.action === "remove" && keys(value, ["action", "network_id", "machine_id", "target"]) && typeof value.target === "string" && value.target.length > 0 && value.target.length <= 64)
    return value;
  invalid2();
}
function membershipConfig(db, expected) {
  const current = readConfig(db);
  if (!current || current.network_id !== expected.network_id || current.machine_id !== expected.machine_id || current.owner_id !== expected.owner_id) {
    throw new NetworkError("wrong_network", "Network changed during the membership operation.");
  }
  verifyRoster(signedRosterOf(current), current.owner_id, current.network_id);
  return current;
}
function removeMember(db, identity, expected, target) {
  return db.transaction(() => {
    const current = membershipConfig(db, expected);
    if (current.owner_id !== identity.machineId || current.machine_id !== identity.machineId)
      throw new NetworkError("not_owner", "Only the network owner can remove a member.");
    const held = verifyRoster(signedRosterOf(current), current.owner_id, current.network_id);
    const member = held.members.find((m) => m.machine_id === target || m.name.toLowerCase() === target.toLowerCase());
    const removed = member?.machine_id ?? (MACHINE.test(target) ? target : invalid2());
    if (removed === current.owner_id)
      throw new NetworkError("invalid_option", "Owner departure is not supported; no membership was changed.");
    const signed = member ? signRoster(identity, { ...held, version: held.version + 1, members: held.members.filter((m) => m.machine_id !== removed) }) : signedRosterOf(current);
    if (member)
      saveRoster(db, signed);
    return { signed, removed, alreadyRemoved: !member, priorMembers: held.members.map((m) => m.machine_id) };
  }).immediate();
}
function clearMembership(db, expected, confirmedVersion) {
  db.transaction(() => {
    const current = membershipConfig(db, expected);
    if (confirmedVersion !== void 0 && verifyRoster(signedRosterOf(current), current.owner_id, current.network_id).version > confirmedVersion) {
      throw new Error("Membership changed after the owner confirmation");
    }
    db.exec("DELETE FROM agent_network_invites; DELETE FROM agent_network_peers; DELETE FROM agent_network_config;");
  }).immediate();
}
function receiveMembershipRoster(db, expected, incoming) {
  return db.transaction(() => {
    const current = membershipConfig(db, expected);
    const roster = acceptRoster(signedRosterOf(current), incoming, current.owner_id, current.network_id);
    const member = Boolean(findMember(roster, current.machine_id));
    if (member)
      saveRoster(db, incoming);
    else
      clearMembership(db, current);
    return { version: roster.version, member };
  }).immediate();
}

// dist/network/control-socket.js
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
    return `\\\\.\\pipe\\memesh-bridge-${createHash4("sha256").update(dataDir2).digest("hex").slice(0, 32)}`;
  }
  return path11.join(networkDir(dataDir2), "bridge.sock");
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
    return fs11.realpathSync.native(dataDir2);
  } catch {
    return dataDir2;
  }
}
function tokenPath(dataDir2) {
  return path11.join(networkDir(dataDir2), "control.token");
}
var TOKEN_FORMAT = /^[0-9a-f]{64}$/;
function ensureControlToken(dataDir2) {
  const file = tokenPath(dataDir2);
  const existing = readControlToken(dataDir2);
  if (existing !== null)
    return existing;
  const temporary = `${file}.tmp-${process.pid}`;
  fs11.writeFileSync(temporary, randomBytes4(32).toString("hex"), { mode: 384 });
  try {
    fs11.chmodSync(temporary, 384);
    if (fs11.existsSync(file) && readControlToken(dataDir2) === null)
      fs11.rmSync(file, { force: true });
    fs11.linkSync(temporary, file);
  } catch (err) {
    if (err.code !== "EEXIST")
      throw err;
  } finally {
    fs11.rmSync(temporary, { force: true });
  }
  return readControlToken(dataDir2);
}
function readControlToken(dataDir2) {
  try {
    const token = fs11.readFileSync(tokenPath(dataDir2), "utf8");
    return TOKEN_FORMAT.test(token) ? token : null;
  } catch {
    return null;
  }
}
function tokensMatch(given, expected) {
  if (typeof given !== "string")
    return false;
  const left = createHash4("sha256").update(given).digest();
  return timingSafeEqual(left, createHash4("sha256").update(expected).digest());
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
function request(dataDir2, op, deadlineMs, expectedPid) {
  return new Promise((resolve) => {
    const socket = net2.createConnection(controlPath(dataDir2));
    let text2 = "";
    const finish = (result) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), deadlineMs);
    socket.once("connect", () => socket.write(`${JSON.stringify({ op: typeof op === "string" ? op : "membership", ...typeof op === "string" ? {} : { action: op }, ...expectedPid === void 0 ? {} : { expected_pid: expectedPid }, token: readControlToken(dataDir2) })}
`));
    socket.on("data", (chunk) => {
      text2 += chunk.toString("utf8");
      if (text2.length > (typeof op === "string" ? REPLY_MAX_BYTES : 32 * 1024)) {
        finish(null);
        return;
      }
      const newline = text2.indexOf("\n");
      if (newline === -1)
        return;
      finish(parseReply(text2.slice(0, newline), dataDir2));
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
    const { dev, ino } = fs11.lstatSync(file);
    return { dev, ino };
  } catch {
    return null;
  }
}
var sameFile = (a, b) => a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
function takeOverStaleLock(lock, judged) {
  const aside = `${lock}.stale-${process.pid}`;
  try {
    fs11.renameSync(lock, aside);
  } catch (err) {
    if (err.code === "ENOENT")
      return;
    throw err;
  }
  try {
    if (sameFile(identityOf(aside), judged))
      return;
    fs11.linkSync(aside, lock);
  } catch (err) {
    if (err.code !== "EEXIST")
      throw err;
  } finally {
    fs11.rmSync(aside, { force: true });
  }
}
async function withStartupLock(dataDir2, use) {
  const lock = path11.join(networkDir(dataDir2), "bridge.sock.startup.lock");
  const giveUpAt = Date.now() + STARTUP_LOCK_WAIT_MS;
  let mine;
  for (; ; ) {
    try {
      const fd = fs11.openSync(lock, "wx", 384);
      const { dev, ino } = fs11.fstatSync(fd);
      mine = { dev, ino };
      fs11.writeSync(fd, `${process.pid}
`);
      fs11.closeSync(fd);
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
      fs11.rmSync(lock, { force: true });
  }
}
function startupLockIsStale(lock) {
  try {
    const age = Date.now() - fs11.statSync(lock).mtimeMs;
    if (age >= STARTUP_LOCK_STALE_MS)
      return true;
    const raw = fs11.readFileSync(lock, "utf8").trim();
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
  if (!fs11.lstatSync(target).isSocket()) {
    throw new Error(`${target} exists and is not a socket, so the network bridge cannot use it.`);
  }
  fs11.unlinkSync(target);
}
function parseOp(line2, token) {
  try {
    const request2 = JSON.parse(line2);
    if (!tokensMatch(request2.token, token))
      return null;
    if (request2.expected_pid !== void 0 && request2.expected_pid !== process.pid)
      return null;
    if (request2.op === "membership" && Object.keys(request2).sort().join(",") === "action,op,token")
      return parseMembershipAction(request2.action);
    return request2.op === "hello" || request2.op === "stop" ? request2.op : null;
  } catch {
    return null;
  }
}
function serveConnection(socket, identity, token, handlers) {
  let text2 = "";
  let handled = false;
  socket.setTimeout(REQUEST_DEADLINE_MS, () => socket.destroy());
  socket.on("error", (err) => handlers.onProblem(`Control connection failed: ${err.message}`));
  socket.on("data", (chunk) => {
    if (handled)
      return;
    text2 += chunk.toString("utf8");
    if (text2.length > REQUEST_MAX_BYTES) {
      socket.destroy();
      return;
    }
    const newline = text2.indexOf("\n");
    if (newline === -1)
      return;
    handled = true;
    const op = parseOp(text2.slice(0, newline), token);
    if (op === null) {
      socket.destroy();
      return;
    }
    const reply2 = { data_dir: identity, pid: process.pid, ready: handlers.isReady() };
    if (typeof op === "object") {
      socket.setTimeout(25e3);
      if (!handlers.membership || !handlers.isReady()) {
        socket.destroy();
        return;
      }
      void handlers.membership(op).then(({ result, afterReply }) => {
        socket.end(`${JSON.stringify({ ...reply2, membership: result })}
`, () => afterReply?.());
        if (socket.destroyed)
          afterReply?.();
      }).catch((error) => {
        socket.end(`${JSON.stringify({ ...reply2, error: error instanceof Error ? error.message : "Membership failed" })}
`);
      });
      return;
    }
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
      const server = net2.createServer((socket) => serveConnection(socket, identity, token, handlers));
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
      const { dev, ino } = fs11.lstatSync(target);
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
import fs12 from "node:fs";
import path12 from "node:path";
function appendTestFrameLog(file, bytes) {
  const folder = path12.dirname(path12.resolve(file));
  let folderStat;
  try {
    folderStat = fs12.lstatSync(folder);
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
    fd = fs12.openSync(file, fs12.constants.O_WRONLY | fs12.constants.O_APPEND | fs12.constants.O_CREAT | fs12.constants.O_NOFOLLOW, 384);
  } catch (err) {
    return `the frame log ${file} could not be opened safely (${err.code ?? "error"})`;
  }
  try {
    const stat2 = fs12.fstatSync(fd);
    if (!stat2.isFile())
      return `the frame log ${file} is not a regular file`;
    fs12.fchmodSync(fd, 384);
    fs12.writeSync(fd, `${bytes.toString("utf8")}
`);
    return null;
  } finally {
    fs12.closeSync(fd);
  }
}

// dist/network/courier.js
import { createHash as createHash6 } from "node:crypto";

// dist/network/address.js
import { createHash as createHash5 } from "node:crypto";

// dist/network/outbound.js
var PRESENCE_TTL_MS = 3 * 6e4;

// dist/network/courier.js
var BACKOFF_MAX_MS = 5 * 6e4;
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
    if (fs13.existsSync(file) && fs13.statSync(file).size > LOG_MAX_BYTES)
      fs13.renameSync(file, `${file}.1`);
    fs13.appendFileSync(file, line(event, detail), { mode: 384 });
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
  assertLegacyPathsAreDifferent(getDbPath(), path13.join(dataDir2, "messages.db"));
  assertLegacyPathsAreDifferent(getDbPath(), dbPath);
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
    membership: (action) => membershipAction(action),
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
    db = openNetworkStore(dbPath, { busyTimeoutMs: BRIDGE_BUSY_TIMEOUT_MS, metadataOnly: true });
    config = readConfig(db);
  } catch (err) {
    return fail("exit_database", `Cannot open the database: ${errorMessage(err)}`);
  }
  if (!config) {
    db.close();
    return fail("exit_not_joined", "This machine has not joined a network.");
  }
  const { machine_id: machineId, owner_id: ownerId, relay_url: relayUrl, network_id: networkId } = config;
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
    endpoint = await bindEndpoint(iroh, identity.secret, relayUrl, isOwner ? [JOIN_ALPN, NET_ALPN, MEMBERSHIP_ALPN] : [NET_ALPN, MEMBERSHIP_ALPN]);
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
    if (current.network_id !== networkId || current.owner_id !== ownerId || current.machine_id !== machineId)
      throw new Error("Bridge network identity changed");
    return { config: current, roster: verifyRoster(signedRosterOf(current), ownerId, current.network_id) };
  };
  const memberConnections = /* @__PURE__ */ new Map();
  const authorize = (remoteId) => {
    authorizeNetworkPeer(db, remoteId);
    return joinedNow();
  };
  const revokeConnections = () => {
    for (const [connection, remoteId] of memberConnections) {
      try {
        authorize(remoteId);
      } catch {
        connection.close(1n, toBytes("not_a_member"));
        memberConnections.delete(connection);
      }
    }
  };
  const requestMembership = async (target, frame, expected) => {
    const until = Date.now() + MEMBERSHIP_DEADLINE_MS;
    const remaining = () => Math.max(1, until - Date.now());
    parseMembershipFrame(Buffer.from(JSON.stringify(frame)));
    membershipConfig(db, expected);
    const route = peerRoute(db, target);
    const address = new iroh.EndpointAddr(iroh.EndpointId.fromString(target), route?.relay ?? (relayUrl === RELAY_OFF ? null : relayUrl), route?.addrs ?? []);
    let expired = false;
    let connection;
    const pending = endpoint.connect(address, toBytes(MEMBERSHIP_ALPN));
    void pending.then((c) => {
      if (expired)
        c.close(1n, toBytes("management_timeout"));
    }, () => void 0);
    try {
      connection = await deadline(pending, remaining(), "connecting for membership");
      if (connection.remoteId().toString() !== target)
        throw new Error("Wrong membership peer");
      membershipConfig(db, expected);
      const stream = await deadline(connection.openBi(), remaining(), "opening membership request");
      await deadline(stream.send.writeAll(toBytes(JSON.stringify(frame))), remaining(), "sending membership request");
      await deadline(stream.send.finish(), remaining(), "finishing membership request");
      return parseMembershipAck(Buffer.from(await deadline(stream.recv.readToEnd(MEMBERSHIP_ACK_MAX_BYTES), remaining(), "receiving membership confirmation")), expected.network_id);
    } finally {
      expired = true;
      connection?.close(0n, toBytes("membership_done"));
    }
  };
  const finishDeparture = () => {
    if (!stopping && control.stillOurs() && readConfig(db) === null) {
      status.membership_departure = { network_id: networkId, owner_id: ownerId, machine_id: machineId };
      void stop("membership revoked", 0);
    }
  };
  const broadcastRoster = async (expected, signed, targets, skip) => {
    const todo = [...new Set(targets)].filter((id) => id !== machineId && id !== skip);
    const unsynchronized = [];
    const until = Date.now() + 15e3;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, todo.length) }, async () => {
      for (; ; ) {
        const target = todo[next++];
        if (!target)
          return;
        if (Date.now() >= until || stopping) {
          unsynchronized.push(target);
          continue;
        }
        try {
          const ack = await requestMembership(target, { version: 1, op: "roster", network_id: expected.network_id, roster: signed }, expected);
          if (ack.roster_version < verifyRoster(signed, expected.owner_id, expected.network_id).version)
            throw new Error("Roster not acknowledged");
        } catch {
          unsynchronized.push(target);
        }
      }
    }));
    return unsynchronized.sort();
  };
  let membershipBusy = false;
  const membershipAction = async (action) => {
    if (membershipBusy || stopping || !control.stillOurs())
      throw new Error("Membership action unavailable");
    membershipBusy = true;
    try {
      const expected = joinedNow().config;
      if (action.network_id !== expected.network_id || action.machine_id !== expected.machine_id)
        throw new Error("Membership control binding changed");
      if (action.action === "remove") {
        const changed = removeMember(db, identity, expected, action.target);
        revokeConnections();
        const unsynchronized = await broadcastRoster(expected, changed.signed, [...changed.priorMembers, changed.removed]);
        return { result: {
          action: "remove",
          network_id: expected.network_id,
          roster_version: verifyRoster(changed.signed, ownerId, expected.network_id).version,
          removed: changed.removed,
          already_removed: changed.alreadyRemoved,
          unsynchronized
        } };
      }
      if (isOwner)
        throw new Error("Owner departure is not supported; no membership was changed.");
      const ack = await requestMembership(ownerId, { version: 1, op: "leave-self", network_id: expected.network_id }, expected);
      if (ack.member || ack.roster_version < verifyRoster(signedRosterOf(expected), ownerId, expected.network_id).version)
        throw new Error("Owner has not confirmed departure");
      if (stopping || !control.stillOurs())
        throw new Error("Bridge changed before departure confirmation");
      clearMembership(db, expected, ack.roster_version);
      revokeConnections();
      return { result: {
        action: "leave",
        network_id: expected.network_id,
        roster_version: ack.roster_version,
        removed: machineId,
        already_removed: false,
        unsynchronized: null
      }, afterReply: finishDeparture };
    } finally {
      membershipBusy = false;
    }
  };
  const answerMembership = async (connection, remoteId) => {
    const stream = await deadline(connection.acceptBi(), MEMBERSHIP_DEADLINE_MS, "waiting for membership request");
    const frame = parseMembershipFrame(Buffer.from(await deadline(stream.recv.readToEnd(MEMBERSHIP_MAX_BYTES), MEMBERSHIP_DEADLINE_MS, "reading membership request")));
    const expected = joinedNow().config;
    if (frame.network_id !== expected.network_id)
      throw new Error("Wrong membership network");
    let ack;
    let departed = false;
    if (frame.op === "roster") {
      if (remoteId !== expected.owner_id)
        throw new Error("Only the owner may push membership");
      const accepted = receiveMembershipRoster(db, expected, frame.roster);
      revokeConnections();
      departed = !accepted.member;
      ack = { version: 1, network_id: expected.network_id, roster_version: accepted.version, member: accepted.member };
    } else {
      if (!isOwner || identity.machineId !== expected.owner_id)
        throw new Error("Membership request requires the owner");
      if (frame.op === "leave-self") {
        const changed = removeMember(db, identity, expected, remoteId);
        revokeConnections();
        void broadcastRoster(expected, changed.signed, changed.priorMembers, remoteId).then((unsynchronized) => {
          appendLog(dataDir2, "membership_propagation", { version: verifyRoster(changed.signed, ownerId, expected.network_id).version, unsynchronized });
        }).catch((error) => recordError("membership_propagation_failed", errorMessage(error)));
      }
      const current = joinedNow();
      ack = { version: 1, network_id: expected.network_id, roster_version: current.roster.version, member: Boolean(findMember(current.roster, remoteId)) };
    }
    try {
      await deadline(stream.send.writeAll(toBytes(JSON.stringify(ack))), MEMBERSHIP_DEADLINE_MS, "answering membership");
      await deadline(stream.send.finish(), MEMBERSHIP_DEADLINE_MS, "finishing membership answer");
      await finishConnection(connection);
    } finally {
      if (departed)
        finishDeparture();
    }
  };
  let selfStatusBusy = false;
  const checkSelfMembership = async () => {
    if (isOwner || selfStatusBusy || stopping)
      return;
    selfStatusBusy = true;
    try {
      const expected = joinedNow().config;
      const ack = await requestMembership(ownerId, { version: 1, op: "self-status", network_id: expected.network_id }, expected);
      if (!ack.member && ack.roster_version >= verifyRoster(signedRosterOf(expected), ownerId, expected.network_id).version) {
        if (stopping || !control.stillOurs())
          return;
        clearMembership(db, expected, ack.roster_version);
        revokeConnections();
        finishDeparture();
      }
    } catch (error) {
      if (!stopping)
        appendLog(dataDir2, "membership_status_unconfirmed", { error: errorMessage(error) });
    } finally {
      selfStatusBusy = false;
    }
  };
  relayTimers.push(setInterval(() => {
    void checkSelfMembership();
  }, STATUS_REFRESH_MS));
  void checkSelfMembership();
  const messages = (joined) => {
    const self = findMember(joined.roster, machineId);
    if (!self)
      throw new Error("This machine is no longer a network member");
    return new ConversationMessages({
      file: path13.join(dataDir2, "messages.db"),
      busyTimeoutMs: BRIDGE_BUSY_TIMEOUT_MS,
      network: {
        network_id: joined.config.network_id,
        self: { id: machineId, name: self.name },
        members: joined.roster.members.map((m) => ({ id: m.machine_id, name: m.name }))
      }
    });
  };
  let lastPresenceAt = 0;
  const answer = async (frame, joined, remoteId) => {
    const member = findMember(joined.roster, remoteId);
    if (!member)
      return { result: "rejected", code: "not_a_member" };
    const store = messages(joined);
    try {
      if (frame.kind === "conversations") {
        const firstContact = !peerRoute(db, remoteId);
        store.upsertRemoteRegistrations(remoteId, frame.entries);
        rememberPeer(db, remoteId, frame.relay, frame.addrs, Date.now());
        if (firstContact)
          lastPresenceAt = 0;
        return { result: "accepted" };
      }
      if (frame.kind === "conversation-receipt")
        return { result: store.receiveReceipt(remoteId, frame.receipt) };
      const result = store.receiveFrom(remoteId, frame.row);
      if (result === "accepted") {
        const message = store.status(frame.row.message.recipient, frame.row.message.id)[0];
        const wake = await wakeConversationMessage(message, store.wakeTarget(message.id), store.machine);
        if (wake.pushed) {
          authorize(remoteId);
          store.recordNetworkPush(remoteId, message.id, wake.route);
        }
      }
      return { result };
    } finally {
      store.close();
    }
  };
  const answerMember = async (connection, remoteId) => {
    const handshake = await deadline(connection.acceptBi(), STREAM_DEADLINE_MS, "waiting for roster");
    await exchangeRosterStream(handshake, null, (offered) => {
      const selected = exchangeRoster(db, offered);
      revokeConnections();
      authorize(remoteId);
      return selected;
    }, STREAM_DEADLINE_MS);
    authorize(remoteId);
    memberConnections.set(connection, remoteId);
    try {
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
        const frame = parseConversationFrame(bytes);
        ack = await answer(frame, authorize(remoteId), remoteId);
        authorize(remoteId);
        appendLog(dataDir2, "frame_received", { machine_id: remoteId, frame: frame.kind, result: ack.result, code: ack.code ?? null });
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
    } finally {
      memberConnections.delete(connection);
    }
  };
  const sendFrame = async (target, frame) => {
    parseConversationFrame(Buffer.from(JSON.stringify(frame)));
    const route = peerRoute(db, target);
    const relay = route?.relay ?? (relayUrl === RELAY_OFF ? null : relayUrl);
    const address = new iroh.EndpointAddr(iroh.EndpointId.fromString(target), relay, route?.addrs ?? []);
    const connection = await deadline(endpoint.connect(address, toBytes(NET_ALPN)), SEND_CONNECT_DEADLINE_MS, "connecting to a member");
    try {
      const handshake = await deadline(connection.openBi(), STREAM_DEADLINE_MS, "opening roster exchange");
      await exchangeRosterStream(handshake, signedRosterOf(joinedNow().config), (offered) => {
        const selected = exchangeRoster(db, offered);
        revokeConnections();
        authorize(target);
        return selected;
      }, STREAM_DEADLINE_MS);
      authorize(target);
      memberConnections.set(connection, target);
      const stream = await deadline(connection.openBi(), STREAM_DEADLINE_MS, "opening a stream");
      const fresh = messages(authorize(target));
      try {
        if (frame.kind === "conversation-message" && !fresh.outgoingFor(target).some((row) => JSON.stringify(row) === JSON.stringify(frame.row)))
          throw new Error("Outgoing network binding changed");
        if (frame.kind === "conversation-receipt" && !fresh.receiptsFor(target).some((receipt) => JSON.stringify(receipt) === JSON.stringify(frame.receipt)))
          throw new Error("Receipt network binding changed");
      } finally {
        fresh.close();
      }
      await deadline(stream.send.writeAll(toBytes(JSON.stringify(frame))), STREAM_DEADLINE_MS, "sending a frame");
      await deadline(stream.send.finish(), STREAM_DEADLINE_MS, "sending a frame");
      const ack = parseAck(Buffer.from(await deadline(stream.recv.readToEnd(ACK_MAX_BYTES), STREAM_DEADLINE_MS, "waiting for the answer")));
      authorize(target);
      let path15 = null;
      try {
        const selected = connection.paths().find((candidate) => candidate.isSelected);
        path15 = selected ? selected.isRelay ? "relay" : "direct" : null;
      } catch {
      }
      return { ack, path: path15 };
    } finally {
      memberConnections.delete(connection);
      connection.close(0n, toBytes("done"));
    }
  };
  let courierBusy = false;
  const sendingTo = /* @__PURE__ */ new Set();
  const announcingTo = /* @__PURE__ */ new Set();
  const deliverTo = async (target) => {
    sendingTo.add(target);
    try {
      const before = messages(authorize(target));
      let outgoing;
      let receipts;
      try {
        outgoing = before.outgoingFor(target);
        receipts = before.receiptsFor(target);
      } finally {
        before.close();
      }
      for (const row of outgoing) {
        if (stopping)
          return;
        const { ack } = await sendFrame(target, { version: 2, kind: "conversation-message", row });
        if (ack.result !== "accepted" && ack.result !== "duplicate") {
          appendLog(dataDir2, "message_not_accepted", { message_id: row.message.id, result: ack.result, code: ack.code ?? null });
          return;
        }
        const current = messages(authorize(target));
        try {
          current.recordCopyAccepted(target, row.message.id);
        } finally {
          current.close();
        }
      }
      for (const receipt of receipts) {
        if (stopping)
          return;
        const { ack } = await sendFrame(target, { version: 2, kind: "conversation-receipt", receipt });
        if (ack.result !== "accepted" && ack.result !== "duplicate")
          return;
        const current = messages(authorize(target));
        try {
          current.recordReceiptAccepted(target, receipt);
        } finally {
          current.close();
        }
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
    const store = messages(joined);
    let frames;
    try {
      frames = conversationPresenceFrames(relayUrl === RELAY_OFF ? null : relayUrl, advertisedAddresses(endpoint), store.exportRegistrations());
    } finally {
      store.close();
    }
    const content = JSON.stringify(frames);
    for (const member of joined.roster.members) {
      const target = member.machine_id;
      if (target === machineId || announcingTo.has(target))
        continue;
      if (!heartbeat2 && sentTo.get(target) === content)
        continue;
      if (!peerRoute(db, target) && relayUrl === RELAY_OFF)
        continue;
      announcingTo.add(target);
      void (async () => {
        for (const frame of frames) {
          if (stopping)
            return;
          const { ack } = await sendFrame(target, frame);
          if (ack.result !== "accepted")
            throw new Error("Presence not accepted");
        }
        sentTo.set(target, content);
      })().catch((err) => {
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
      revokeConnections();
      const joined = joinedNow();
      if (!findMember(joined.roster, machineId)) {
        clearMembership(db, joined.config, joined.roster.version);
        revokeConnections();
        finishDeparture();
        return;
      }
      const now = Date.now();
      const store = messages(joined);
      try {
        store.maintainMessages();
      } finally {
        store.close();
      }
      for (const member of joined.roster.members) {
        const target = member.machine_id;
        if (target !== machineId && !sendingTo.has(target))
          void deliverTo(target);
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
      else if (alpn === MEMBERSHIP_ALPN)
        await answerMembership(connection, remoteId);
      else {
        connection.close(2n, toBytes("unknown_protocol"));
        appendLog(dataDir2, "unknown_protocol_refused", { machine_id: remoteId });
      }
    } catch (err) {
      recordError("connection_failed", errorMessage(err));
      const notMember = errorMessage(err) === "not_a_member";
      if (notMember) {
        status.non_member_refused++;
        publish();
      }
      try {
        connection?.close(3n, toBytes(notMember ? "not_a_member" : "error"));
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
var dataDir = path14.resolve(getMemeshDirFromDbPath());
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
    process.exit(await serve(dataDir, networkMetadataPath(dataDir)));
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
