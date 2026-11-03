import fs from 'fs';
import path from 'path';
import { homeDir, memeshDir } from './paths.js';
import { citationRulePath, removeCitationRule, writeCitationRule } from './citation-rule.js';
import { pluginHostConfigRoot } from './install-channel.js';
export function settingsHaveMemeshHooks(settingsPath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        for (const entries of Object.values(parsed.hooks ?? {})) {
            if (!Array.isArray(entries))
                continue;
            for (const entry of entries) {
                for (const hook of entry.hooks ?? []) {
                    if (hook?._memesh === true)
                        return true;
                }
            }
        }
    }
    catch { }
    return false;
}
const MARKER_FILE = 'install-hooks.json';
export function detectPluginRuntime(installedPluginsPathImpl) {
    const defaultPath = path.join(pluginHostConfigRoot('claude-code'), 'plugins', 'installed_plugins.json');
    const targetPath = installedPluginsPathImpl ?? defaultPath;
    if (!fs.existsSync(targetPath))
        return null;
    try {
        const raw = fs.readFileSync(targetPath, 'utf8');
        const j = JSON.parse(raw);
        const entries = j?.plugins?.['memesh@pcircle-memesh'];
        if (!Array.isArray(entries) || entries.length === 0)
            return null;
        const active = entries.find((entry) => typeof entry === 'object'
            && entry !== null
            && typeof entry.installPath === 'string'
            && entry.installPath.length > 0);
        if (!active)
            return null;
        return {
            installPath: active.installPath,
            version: typeof active.version === 'string' ? active.version : 'unknown',
        };
    }
    catch {
        return null;
    }
}
function settingsPathFor(scope, cwd) {
    if (scope === 'project') {
        return path.join(cwd, '.claude', 'settings.json');
    }
    return path.join(pluginHostConfigRoot('claude-code'), 'settings.json');
}
function writeSettingsSync(targetPath, data) {
    fs.writeFileSync(targetPath, data, 'utf8');
}
const isJsonObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const refuse = (p, what) => new Error(`settings file at ${p}${what}; refusing to modify`);
function assertHooksShape(hooks, p) {
    if (!isJsonObject(hooks))
        throw refuse(p, ': "hooks" is not an object');
    for (const [event, entries] of Object.entries(hooks)) {
        if (!Array.isArray(entries))
            throw refuse(p, `: hooks.${event} is not a list`);
        entries.forEach((entry, i) => {
            const where = `hooks.${event}[${i}]`;
            if (!isJsonObject(entry))
                throw refuse(p, `: ${where} is not an object`);
            if (!Array.isArray(entry.hooks))
                throw refuse(p, `: ${where}.hooks is not a list`);
            entry.hooks.forEach((h, j) => {
                if (!isJsonObject(h))
                    throw refuse(p, `: ${where}.hooks[${j}] is not an object`);
            });
        });
    }
}
function readSettings(p) {
    if (!fs.existsSync(p))
        return {};
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    catch {
        throw refuse(p, ' is not valid JSON');
    }
    if (!isJsonObject(parsed))
        throw refuse(p, ' is not a JSON object');
    if (parsed.hooks !== undefined)
        assertHooksShape(parsed.hooks, p);
    return parsed;
}
function backupSettings(settingsPath) {
    if (!fs.existsSync(settingsPath))
        return null;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${settingsPath}.bak-pre-memesh-${ts}`;
    fs.copyFileSync(settingsPath, backup);
    return backup;
}
function loadPluginHooks(pluginRoot) {
    const manifestPath = path.join(pluginRoot, 'hooks', 'hooks.json');
    if (!fs.existsSync(manifestPath)) {
        throw new Error(`plugin hooks manifest not found at ${manifestPath}`);
    }
    const damaged = () => new Error(`memesh's own hooks file at ${manifestPath} is damaged and cannot be read; reinstall memesh and run install-hooks again`);
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    }
    catch {
        throw damaged();
    }
    if (manifest === null || typeof manifest !== 'object' || manifest.hooks === null || typeof manifest.hooks !== 'object') {
        throw damaged();
    }
    const out = {};
    for (const [event, entries] of Object.entries(manifest.hooks)) {
        out[event] = entries.map((entry) => ({
            matcher: entry.matcher,
            hooks: entry.hooks.map((h) => ({
                type: h.type,
                command: h.command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot),
                ...(h.timeout !== undefined ? { timeout: h.timeout } : {}),
                _memesh: true,
            })),
        }));
    }
    return out;
}
function isMemeshEntry(entry) {
    return entry.hooks.length > 0 && entry.hooks.every((h) => h._memesh === true);
}
function entryAlreadyPresent(existing, desired) {
    return existing.some((e) => {
        if (e.matcher !== desired.matcher)
            return false;
        if (!isMemeshEntry(e))
            return false;
        if (e.hooks.length !== desired.hooks.length)
            return false;
        const cmds = new Set(e.hooks.map((h) => h.command));
        return desired.hooks.every((h) => cmds.has(h.command));
    });
}
export function installHooks(opts) {
    const cwd = opts.cwd ?? process.cwd();
    const settingsPath = settingsPathFor(opts.scope, cwd);
    const writeRule = () => (opts.dryRun
        ? { path: citationRulePath(opts.scope, homeDir(), cwd), action: 'unchanged' }
        : writeCitationRule(opts.scope, homeDir(), cwd));
    const pluginRuntime = detectPluginRuntime(opts.installedPluginsPathImpl);
    if (pluginRuntime && !opts.forceOverPlugin) {
        const citationRule = writeRule();
        return {
            settingsPath,
            backupPath: null,
            scope: opts.scope,
            added: 0,
            skipped: 0,
            pruned: 0,
            conflicts: [],
            markerPath: path.join(memeshDir(), MARKER_FILE),
            pluginRuntimeDetected: pluginRuntime,
            citationRule,
            settingsWritten: false,
            markerWritten: false,
        };
    }
    const desired = loadPluginHooks(opts.pluginRoot);
    const settings = readSettings(settingsPath);
    const citationRule = writeRule();
    const existing = settings.hooks ?? {};
    let added = 0;
    let skipped = 0;
    let pruned = 0;
    const conflicts = [];
    const desiredKeys = new Set(Object.entries(desired).flatMap(([event, entries]) => entries.map((e) => `${event}\u0000${e.matcher ?? '*'}`)));
    for (const [event, entries] of Object.entries(existing)) {
        const kept = entries.filter((e) => !(isMemeshEntry(e) && !desiredKeys.has(`${event}\u0000${e.matcher ?? '*'}`)));
        pruned += entries.length - kept.length;
        if (kept.length === 0)
            delete existing[event];
        else
            existing[event] = kept;
    }
    for (const [event, desiredEntries] of Object.entries(desired)) {
        if (!existing[event])
            existing[event] = [];
        for (const desiredEntry of desiredEntries) {
            const live = existing[event];
            if (entryAlreadyPresent(live, desiredEntry)) {
                skipped++;
                continue;
            }
            const overlap = live.filter((e) => e.matcher === desiredEntry.matcher && !isMemeshEntry(e));
            if (overlap.length > 0) {
                conflicts.push({
                    event,
                    matcher: desiredEntry.matcher ?? '*',
                    existingCount: overlap.reduce((n, e) => n + e.hooks.length, 0),
                });
            }
            existing[event] = [
                ...live.filter((e) => !(e.matcher === desiredEntry.matcher && isMemeshEntry(e))),
                desiredEntry,
            ];
            added++;
        }
    }
    const markerPath = path.join(memeshDir(), MARKER_FILE);
    let backupPath = null;
    let settingsWritten = false;
    let markerWritten = false;
    if (!opts.dryRun) {
        if (added > 0 || pruned > 0) {
            backupPath = backupSettings(settingsPath);
            settings.hooks = existing;
            fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
            writeSettingsSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
            settingsWritten = true;
        }
        const marker = {
            version: opts.pluginVersion,
            plugin_root: opts.pluginRoot,
            scope: opts.scope,
            settings_path: settingsPath,
        };
        const current = readInstallMarker();
        const markerCurrent = current !== null
            && Object.keys(marker).every((key) => current[key] === marker[key]);
        if (settingsWritten || !markerCurrent) {
            fs.mkdirSync(path.dirname(markerPath), { recursive: true });
            fs.writeFileSync(markerPath, JSON.stringify({ installed_at: new Date().toISOString(), ...marker }, null, 2) + '\n', 'utf8');
            markerWritten = true;
        }
    }
    return {
        citationRule,
        settingsPath,
        backupPath,
        scope: opts.scope,
        added,
        skipped,
        pruned,
        conflicts,
        markerPath,
        settingsWritten,
        markerWritten,
    };
}
export function uninstallHooks(opts) {
    const cwd = opts.cwd ?? process.cwd();
    const settingsPath = settingsPathFor(opts.scope, cwd);
    const settings = fs.existsSync(settingsPath) ? readSettings(settingsPath) : null;
    const citationRule = opts.dryRun
        ? { path: citationRulePath(opts.scope, homeDir(), cwd), action: 'absent' }
        : removeCitationRule(opts.scope, homeDir(), cwd);
    if (!settings) {
        return { settingsPath, backupPath: null, removed: 0, citationRule };
    }
    const existing = settings.hooks ?? {};
    let removed = 0;
    for (const [event, entries] of Object.entries(existing)) {
        const before = entries.length;
        existing[event] = entries.filter((e) => !isMemeshEntry(e));
        removed += before - existing[event].length;
        if (existing[event].length === 0) {
            delete existing[event];
        }
    }
    if (Object.keys(existing).length === 0) {
        delete settings.hooks;
    }
    else {
        settings.hooks = existing;
    }
    let backupPath = null;
    if (!opts.dryRun && removed > 0) {
        backupPath = backupSettings(settingsPath);
        writeSettingsSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
        const markerPath = path.join(memeshDir(), MARKER_FILE);
        if (fs.existsSync(markerPath)) {
            try {
                fs.unlinkSync(markerPath);
            }
            catch { }
        }
    }
    return { settingsPath, backupPath, removed, citationRule };
}
export function readInstallMarker() {
    const markerPath = path.join(memeshDir(), MARKER_FILE);
    if (!fs.existsSync(markerPath))
        return null;
    try {
        return JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=install-hooks.js.map