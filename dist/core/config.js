import fs from 'fs';
import path from 'path';
import { memeshDir } from './paths.js';
const CONFIG_KEYS = ['autoCapture', 'sessionLimit', 'autoUpdate', 'setupCompleted'];
export const RETIRED_CONFIG_KEYS = [
    'llm',
    'llmFallbacks',
    'embedder',
    'language',
    'transcriptMining',
];
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
function configDir() {
    return memeshDir();
}
function configFilePath() {
    return path.join(configDir(), 'config.json');
}
let lastConfigReadWarning = null;
function warnUnreadable(p, detail) {
    const key = `${p}::${detail}`;
    if (key === lastConfigReadWarning)
        return;
    lastConfigReadWarning = key;
    try {
        process.stderr.write(`[memesh config] ${p} exists but could not be read as a settings object (${detail}). ` +
            'Existing settings are ignored and will not be overwritten until the file is fixed.\n');
    }
    catch {
    }
}
function readRawConfigResult() {
    const p = configFilePath();
    if (!fs.existsSync(p))
        return { raw: {}, state: 'absent' };
    try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('top-level JSON value is not an object');
        }
        return { raw: parsed, state: 'ok' };
    }
    catch (error) {
        warnUnreadable(p, error instanceof Error ? error.message : String(error));
        return { raw: {}, state: 'unreadable' };
    }
}
function selectConfig(raw) {
    const config = {};
    if (typeof raw.autoCapture === 'boolean')
        config.autoCapture = raw.autoCapture;
    if (typeof raw.sessionLimit === 'number' && Number.isFinite(raw.sessionLimit)) {
        config.sessionLimit = raw.sessionLimit;
    }
    if (raw.autoUpdate === 'off' ||
        raw.autoUpdate === 'patch' ||
        raw.autoUpdate === 'minor' ||
        raw.autoUpdate === 'major') {
        config.autoUpdate = raw.autoUpdate;
    }
    if (typeof raw.setupCompleted === 'boolean')
        config.setupCompleted = raw.setupCompleted;
    return config;
}
export function findRetiredConfigKeys(raw) {
    const present = new Set(Object.keys(raw));
    return RETIRED_CONFIG_KEYS.filter((key) => present.has(key));
}
export function readConfigResult() {
    const result = readRawConfigResult();
    return { config: selectConfig(result.raw), state: result.state };
}
export function readConfig() {
    return readConfigResult().config;
}
function writeRawConfig(raw) {
    const dir = configDir();
    const p = configFilePath();
    fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    try {
        fs.chmodSync(dir, PRIVATE_DIR_MODE);
    }
    catch {
    }
    fs.writeFileSync(p, JSON.stringify(raw, null, 2), { mode: PRIVATE_FILE_MODE });
    try {
        fs.chmodSync(p, PRIVATE_FILE_MODE);
    }
    catch {
    }
}
export class ConfigUnreadableError extends Error {
    constructor(p) {
        super(`Refusing to modify ${p}: the existing config could not be read, so saving ` +
            'would silently delete settings already in it. Fix or remove the file, then retry.');
        this.name = 'ConfigUnreadableError';
    }
}
export function updateConfig(partial) {
    const result = readRawConfigResult();
    if (result.state === 'unreadable')
        throw new ConfigUnreadableError(configFilePath());
    const raw = { ...result.raw };
    for (const key of CONFIG_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(partial, key))
            continue;
        const value = partial[key];
        if (value === undefined)
            delete raw[key];
        else
            raw[key] = value;
    }
    writeRawConfig(raw);
    return selectConfig(raw);
}
export function getConfigDir() {
    return configDir();
}
export function getConfigPath() {
    return configFilePath();
}
//# sourceMappingURL=config.js.map