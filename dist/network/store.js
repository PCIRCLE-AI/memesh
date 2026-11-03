import fs from 'node:fs';
import path from 'node:path';
import { guardDatabaseFiles, removeGroupAndOtherAccess } from '../core/file-mode.js';
import { AGENT_NETWORK_SCHEMA_SQL } from '../storage/agent-network-schema.js';
import { MemeshDatabase } from '../storage/sqlite.js';
export function openNetworkStore(dbPath, options = {}) {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    try {
        process.umask(0o077);
    }
    catch { }
    removeGroupAndOtherAccess(dir);
    guardDatabaseFiles(dbPath);
    const db = new MemeshDatabase(dbPath);
    try {
        if (options.busyTimeoutMs !== undefined)
            db.pragma(`busy_timeout = ${options.busyTimeoutMs}`);
        db.pragma('journal_mode = WAL');
        db.exec(AGENT_NETWORK_SCHEMA_SQL);
    }
    catch (err) {
        db.close();
        throw err;
    }
    return db;
}
export function databaseExists(dbPath) {
    return fs.existsSync(dbPath);
}
export function readConfig(db) {
    const row = db.prepare(`SELECT network_id, owner_id, machine_id, machine_name, person, relay_url, roster_json, roster_signature
       FROM agent_network_config WHERE id = 1`).get();
    return row ?? null;
}
export function insertConfig(db, config, now) {
    db.prepare(`INSERT INTO agent_network_config
       (id, network_id, owner_id, machine_id, machine_name, person, relay_url, roster_json, roster_signature, created_at_ms)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(config.network_id, config.owner_id, config.machine_id, config.machine_name, config.person, config.relay_url, config.roster_json, config.roster_signature, now);
}
export function saveRoster(db, signed) {
    db.prepare('UPDATE agent_network_config SET roster_json = ?, roster_signature = ? WHERE id = 1').run(signed.roster_json, signed.signature);
}
export function signedRosterOf(config) {
    return { roster_json: config.roster_json, signature: config.roster_signature };
}
//# sourceMappingURL=store.js.map