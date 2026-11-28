import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { memeshDir } from './paths.js';
import { removeGroupAndOtherAccess } from './file-mode.js';
const SCHEMA_VERSION = 1;
function installFilePath() {
    return path.join(memeshDir(), 'install.json');
}
export function readInstallRecordState() {
    let raw;
    try {
        raw = fs.readFileSync(installFilePath(), 'utf8');
    }
    catch (err) {
        const code = err?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR')
            return { status: 'missing' };
        return { status: 'unreadable', reason: typeof code === 'string' ? code : 'read error' };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return { status: 'unreadable', reason: 'not valid JSON' };
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.install_id !== 'string' || parsed.install_id.length === 0) {
        return { status: 'unreadable', reason: 'no install_id in it' };
    }
    const createdAt = typeof parsed.created_at === 'string' && Number.isFinite(new Date(parsed.created_at).getTime())
        ? parsed.created_at
        : null;
    return { status: 'ok', install_id: parsed.install_id, created_at: createdAt };
}
export function getInstallRecord() {
    const filePath = installFilePath();
    const state = readInstallRecordState();
    if (state.status === 'ok') {
        return {
            install_id: state.install_id,
            created_at: state.created_at ?? new Date().toISOString(),
            schema_version: SCHEMA_VERSION,
        };
    }
    const record = {
        install_id: randomUUID(),
        created_at: new Date().toISOString(),
        schema_version: SCHEMA_VERSION,
    };
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        removeGroupAndOtherAccess(path.dirname(filePath));
        fs.writeFileSync(filePath, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
        removeGroupAndOtherAccess(filePath);
    }
    catch {
    }
    return record;
}
export function getInstallId() {
    return getInstallRecord().install_id;
}
//# sourceMappingURL=install-id.js.map