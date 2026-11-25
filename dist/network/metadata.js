import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemeshDatabase } from '../storage/sqlite.js';
import { NETWORK_METADATA_SCHEMA_SQL } from '../storage/agent-network-schema.js';
import { openPublicNetworkDatabase } from '../core/public-network-context.js';
import { assertLegacyPathsAreDifferent } from '../core/conversation-message-migration.js';
import { stopBridge } from './bridge-control.js';
import { probeBridge } from './control-socket.js';
import { canonicalJson, verifyRoster } from './roster.js';
import { readConfig, signedRosterOf } from './store.js';
import { networkMetadataPath } from './types.js';
const TABLES = {
    agent_network_config: ['id', 'network_id', 'owner_id', 'machine_id', 'machine_name', 'person', 'relay_url', 'roster_json', 'roster_signature', 'created_at_ms'],
    agent_network_invites: ['hash', 'expires_at_ms', 'used_at'],
    agent_network_peers: ['machine_id', 'relay_url', 'addrs_json', 'seen_at_ms'],
};
function verifiedIdentity(db) {
    const config = readConfig(db);
    if (!config)
        return undefined;
    verifyRoster(signedRosterOf(config), config.owner_id, config.network_id);
    return { network: config.network_id, machine: config.machine_id };
}
export async function migrateNetworkMetadata(ctx) {
    const target = networkMetadataPath(ctx.dataDir);
    assertLegacyPathsAreDifferent(ctx.dbPath, target);
    const existing = openPublicNetworkDatabase(target);
    if (existing) {
        try {
            return Boolean(verifiedIdentity(existing));
        }
        finally {
            existing.close();
        }
    }
    const running = await probeBridge(ctx.dataDir);
    if (running.kind === 'unresponsive')
        throw new Error('Old network bridge is unresponsive; metadata preserved');
    if (running.kind === 'running')
        await stopBridge(ctx);
    const source = openPublicNetworkDatabase(ctx.dbPath, true);
    if (!source)
        return false;
    let temporary;
    try {
        const hasConfig = source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_network_config'").get();
        if (!hasConfig)
            return false;
        source.exec('BEGIN');
        const identity = verifiedIdentity(source);
        if (!identity)
            return false;
        const rows = Object.entries(TABLES).map(([table, columns]) => ({ table, columns,
            rows: source.prepare(`SELECT ${columns.join(',')} FROM ${table}`).all() }));
        const directory = path.dirname(target);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const check = openPublicNetworkDatabase(target);
        check?.close();
        temporary = path.join(directory, `.metadata-${randomUUID()}.db`);
        fs.closeSync(fs.openSync(temporary, 'wx', 0o600));
        const destination = new MemeshDatabase(temporary);
        try {
            destination.exec(NETWORK_METADATA_SCHEMA_SQL);
            destination.transaction(() => {
                for (const table of rows) {
                    const insert = destination.prepare(`INSERT INTO ${table.table} (${table.columns.join(',')}) VALUES (${table.columns.map(() => '?').join(',')})`);
                    for (const row of table.rows)
                        insert.run(...table.columns.map(column => row[column]));
                    const actual = destination.prepare(`SELECT ${table.columns.join(',')} FROM ${table.table}`).all();
                    if (canonicalJson(actual.map(canonicalJson).sort()) !== canonicalJson(table.rows.map(canonicalJson).sort()))
                        throw new Error('Network metadata copy mismatch');
                }
                if (canonicalJson(verifiedIdentity(destination)) !== canonicalJson(identity))
                    throw new Error('Network identity changed during copy');
            }).immediate();
            destination.pragma('wal_checkpoint(TRUNCATE)');
        }
        finally {
            destination.close();
        }
        source.exec('COMMIT');
        const fd = fs.openSync(temporary, 'r+');
        try {
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        try {
            fs.linkSync(temporary, target);
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
        }
        fs.unlinkSync(temporary);
        temporary = undefined;
        const published = openPublicNetworkDatabase(target);
        if (!published)
            throw new Error('Network metadata publication missing');
        try {
            if (canonicalJson(verifiedIdentity(published)) !== canonicalJson(identity))
                throw new Error('Concurrent network metadata has another identity');
        }
        finally {
            published.close();
        }
        return true;
    }
    finally {
        source.close();
        if (temporary)
            fs.unlinkSync(temporary);
    }
}
//# sourceMappingURL=metadata.js.map