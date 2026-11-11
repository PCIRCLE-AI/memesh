// The network's rows in the MeMesh database, through a connection that runs only
// the agent_network_* schema. It deliberately does not go through db.ts: the
// bridge has no reason to load, migrate or touch the memory tables.

import fs from 'node:fs';
import path from 'node:path';
import { guardDatabaseFiles, removeGroupAndOtherAccess } from '../core/file-mode.js';
import { AGENT_NETWORK_SCHEMA_SQL } from '../storage/agent-network-schema.js';
import { MemeshDatabase } from '../storage/sqlite.js';
import type { SignedRoster } from './types.js';

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
    db.exec(AGENT_NETWORK_SCHEMA_SQL);
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
