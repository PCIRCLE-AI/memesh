// The network's rows in the MeMesh database, through a connection that runs only
// the agent_network_* schema. It deliberately does not go through db.ts: the
// bridge has no reason to load, migrate or touch the memory tables.

import fs from 'node:fs';
import path from 'node:path';
import { guardDatabaseFiles, removeGroupAndOtherAccess } from '../core/file-mode.js';
import { NETWORK_METADATA_SCHEMA_SQL } from '../storage/agent-network-schema.js';
import { MemeshDatabase } from '../storage/sqlite.js';
import type { SignedRoster } from './types.js';
import { acceptRoster, findMember, verifyRoster } from './roster.js';

export interface NetworkConfig {
  network_id: string;
  owner_id: string;
  machine_id: string;
  machine_name: string;
  person: string;
  /** A relay URL, or "off". */
  relay_url: string;
  roster_json: string;
  roster_signature: string;
}

export function openNetworkStore(dbPath: string, options: { busyTimeoutMs?: number } = {}): MemeshDatabase {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  try { process.umask(0o077); } catch { /* non-POSIX */ }
  removeGroupAndOtherAccess(dir);
  guardDatabaseFiles(dbPath);
  const db = new MemeshDatabase(dbPath);
  try {
    if (options.busyTimeoutMs !== undefined) db.pragma(`busy_timeout = ${options.busyTimeoutMs}`);
    db.pragma('journal_mode = WAL');
    db.exec(NETWORK_METADATA_SCHEMA_SQL);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/** The saved network settings, without creating a database for someone who has none. */
export function databaseExists(dbPath: string): boolean {
  return fs.existsSync(dbPath);
}

export function readConfig(db: MemeshDatabase): NetworkConfig | null {
  const row = db.prepare(
    `SELECT network_id, owner_id, machine_id, machine_name, person, relay_url, roster_json, roster_signature
       FROM agent_network_config WHERE id = 1`,
  ).get() as unknown as NetworkConfig | undefined;
  return row ?? null;
}

export function insertConfig(db: MemeshDatabase, config: NetworkConfig, now: number): void {
  db.prepare(
    `INSERT INTO agent_network_config
       (id, network_id, owner_id, machine_id, machine_name, person, relay_url, roster_json, roster_signature, created_at_ms)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    config.network_id, config.owner_id, config.machine_id, config.machine_name, config.person,
    config.relay_url, config.roster_json, config.roster_signature, now,
  );
}

export function saveRoster(db: MemeshDatabase, signed: SignedRoster): void {
  db.prepare('UPDATE agent_network_config SET roster_json = ?, roster_signature = ? WHERE id = 1').run(signed.roster_json, signed.signature);
}

export function signedRosterOf(config: NetworkConfig): SignedRoster {
  return { roster_json: config.roster_json, signature: config.roster_signature };
}

/** An older authenticated advertisement requests our current roster, never a rollback. */
export function exchangeRoster(db: MemeshDatabase, incoming: SignedRoster): SignedRoster {
  return db.transaction(() => {
    const config = readConfig(db);
    if (!config) throw new Error('Network configuration missing.');
    const current = signedRosterOf(config);
    const held = verifyRoster(current, config.owner_id, config.network_id);
    const offered = verifyRoster(incoming, config.owner_id, config.network_id);
    if (offered.version < held.version) return current;
    acceptRoster(current, incoming, config.owner_id, config.network_id);
    if (offered.version > held.version) saveRoster(db, incoming);
    return incoming;
  })();
}

/** Re-read at every application boundary, including already-open connections. */
export function authorizeNetworkPeer(db: MemeshDatabase, remoteId: string): void {
  const config = readConfig(db);
  if (!config) throw new Error('Network configuration missing.');
  const roster = verifyRoster(signedRosterOf(config), config.owner_id, config.network_id);
  if (!findMember(roster, config.machine_id) || !findMember(roster, remoteId)) throw new Error('not_a_member');
}
