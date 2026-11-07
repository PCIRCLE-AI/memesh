import { createRequire as __memeshCreateRequire } from 'node:module'; const require = __memeshCreateRequire(import.meta.url);

// dist/network/bridge.js
import path8 from "node:path";

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
  constructor(path9, options = {}) {
    super(path9, options);
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
  if (err.code === "ENOENT")
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
import fs7 from "node:fs";

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
    return fs6.realpathSync(dataDir2);
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
    if (Date.now() - fs6.statSync(lock).mtimeMs >= STARTUP_LOCK_STALE_MS)
      return true;
    process.kill(Number(fs6.readFileSync(lock, "utf8").trim()), 0);
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
    const response = await fetchImpl(new URL("ping", relayUrl), { signal: AbortSignal.timeout(RELAY_PING_TIMEOUT_MS) });
    return response.status === 200;
  } catch {
    return false;
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
var MEMBER_STUB_MAX_BYTES = 1024;
var MEMBER_STUB_REPLY = JSON.stringify({ ok: false, error: "not_implemented" });
function appendLog(dataDir2, event, detail = {}) {
  try {
    const file = logPath(dataDir2);
    if (fs7.existsSync(file) && fs7.statSync(file).size > LOG_MAX_BYTES)
      fs7.renameSync(file, `${file}.1`);
    fs7.appendFileSync(file, line(event, detail), { mode: 384 });
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
    member_stub_served: 0
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
  const answerMember = async (connection, remoteId) => {
    const current = readConfig(db);
    if (!current)
      throw new Error("The network settings are gone from the database.");
    const roster = verifyRoster(signedRosterOf(current), ownerId, current.network_id);
    if (!findMember(roster, remoteId)) {
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
var dataDir = path8.resolve(getMemeshDirFromDbPath());
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
