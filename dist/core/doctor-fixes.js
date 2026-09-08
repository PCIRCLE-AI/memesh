import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { findRetiredConfigKeys, getConfigPath, ConfigUnreadableError } from './config.js';
import { PLUGIN_REFRESH_COMMANDS } from './install-channel.js';
export function removeRetiredConfigKeys() {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) {
        return { changed: false, removed: [], backupPath: null, configPath };
    }
    const original = fs.readFileSync(configPath, 'utf8');
    let parsed;
    try {
        const value = JSON.parse(original);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('top-level JSON value is not an object');
        }
        parsed = value;
    }
    catch {
        throw new ConfigUnreadableError(configPath);
    }
    const removed = findRetiredConfigKeys(parsed);
    if (removed.length === 0) {
        return { changed: false, removed: [], backupPath: null, configPath };
    }
    const dir = path.dirname(configPath);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(dir, `config.json.bak-${stamp}-${process.pid}-${randomBytes(3).toString('hex')}`);
    fs.writeFileSync(backupPath, original, { flag: 'wx', mode: 0o600 });
    try {
        fs.chmodSync(backupPath, 0o600);
    }
    catch { }
    if (fs.readFileSync(configPath, 'utf8') !== original) {
        throw new Error(`Refusing to modify ${configPath}: it changed while the backup was being created.`);
    }
    for (const key of removed)
        delete parsed[key];
    const tempPath = `${configPath}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
    try {
        fs.writeFileSync(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        try {
            fs.chmodSync(tempPath, 0o600);
        }
        catch { }
        fs.renameSync(tempPath, configPath);
    }
    catch (error) {
        try {
            fs.unlinkSync(tempPath);
        }
        catch { }
        throw error;
    }
    return { changed: true, removed, backupPath, configPath };
}
function safeOutput(value) {
    return value.replace(/(?:\/Users\/[^\s'"`]+|\/home\/[^\s'"`]+|[A-Za-z]:\\[^\s'"`]+)/g, '<local-path>')
        .replace(/(Bearer\s+|sk-|ghp_)[A-Za-z0-9._-]+/gi, '$1<redacted>')
        .slice(-4000);
}
export function pluginHostFromDoctorCheck(check) {
    if (check.params?.host === 'Codex')
        return 'codex';
    if (check.params?.host === 'Claude Code')
        return 'claude-code';
    throw new Error('The plugin host for this repair is unknown; re-run memesh doctor first.');
}
export function refreshPluginCache(packageRoot, host) {
    if (host === 'claude-code') {
        const script = path.join(packageRoot, 'scripts', 'upgrade-plugin.sh');
        if (!fs.existsSync(script))
            throw new Error(`Plugin refresh script is missing at ${script}.`);
        const run = execFileSync('bash', [script], {
            encoding: 'utf8',
            timeout: 120_000,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: process.env,
        });
        return {
            host,
            command: PLUGIN_REFRESH_COMMANDS[host],
            exitCode: 0,
            output: safeOutput(String(run)),
            restartRequired: true,
        };
    }
    const upgrade = execFileSync('codex', ['plugin', 'marketplace', 'upgrade', 'pcircle-memesh'], {
        encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
    });
    const add = execFileSync('codex', ['plugin', 'add', 'memesh@pcircle-memesh'], {
        encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
    });
    return {
        host,
        command: PLUGIN_REFRESH_COMMANDS[host],
        exitCode: 0,
        output: safeOutput(`${String(upgrade)}\n${String(add)}`),
        restartRequired: true,
    };
}
//# sourceMappingURL=doctor-fixes.js.map