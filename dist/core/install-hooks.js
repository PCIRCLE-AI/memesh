import fs from 'fs';
import path from 'path';
import { homeDir, memeshDir } from './paths.js';
import { CITATION_RULE_BODY, citationRulePath, citationRuleState } from './citation-rule.js';
import { pluginHostConfigRoot } from './install-channel.js';
import { assertCanDelete, assertCanWrite, assertFolderWritable, Changes, refuse, whyFailed } from './safe-write.js';
export function settingsHaveMemeshHooks(settingsPath) {
    try {
        const parsed = readSettings(settingsPath);
        return Object.values(parsed?.hooks ?? {}).some((entries) => entries.some((entry) => entry.hooks.some((hook) => hook._memesh === true)));
    }
    catch {
        return false;
    }
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
const isJsonObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const settingsRefusal = (p, what) => refuse('settings file', p, what, 'refusing to modify');
function assertHooksShape(hooks, fail) {
    if (!isJsonObject(hooks))
        throw fail('"hooks" is not an object');
    for (const [event, entries] of Object.entries(hooks)) {
        if (!Array.isArray(entries))
            throw fail(`hooks.${event} is not a list`);
        entries.forEach((entry, i) => {
            const where = `hooks.${event}[${i}]`;
            if (!isJsonObject(entry))
                throw fail(`${where} is not an object`);
            if (!Array.isArray(entry.hooks))
                throw fail(`${where}.hooks is not a list`);
            entry.hooks.forEach((h, j) => {
                if (!isJsonObject(h))
                    throw fail(`${where}.hooks[${j}] is not an object`);
            });
        });
    }
}
function readSettings(p) {
    if (!fs.existsSync(p))
        return null;
    let text;
    try {
        text = fs.readFileSync(p, 'utf8');
    }
    catch (err) {
        throw refuse('settings file', p, ` cannot be read (${whyFailed(err)})`);
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        throw settingsRefusal(p, ' is not valid JSON');
    }
    if (!isJsonObject(parsed))
        throw settingsRefusal(p, ' is not a JSON object');
    if (parsed.hooks !== undefined)
        assertHooksShape(parsed.hooks, (what) => settingsRefusal(p, `: ${what}`));
    return parsed;
}
function readRuleState(scope, cwd) {
    try {
        return citationRuleState(scope, homeDir(), cwd);
    }
    catch (err) {
        throw refuse('citation rule file', citationRulePath(scope, homeDir(), cwd), ` cannot be read (${whyFailed(err)})`);
    }
}
function loadPluginHooks(pluginRoot) {
    const manifestPath = path.join(pluginRoot, 'hooks', 'hooks.json');
    if (!fs.existsSync(manifestPath)) {
        throw new Error(`plugin hooks manifest not found at ${manifestPath}`);
    }
    const damaged = (why) => refuse("memesh's own hooks file", manifestPath, ` is damaged (${why}) and cannot be used`, 'nothing was changed; reinstall memesh and run install-hooks again');
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    }
    catch (err) {
        throw damaged(err instanceof SyntaxError ? 'it is not valid JSON' : whyFailed(err));
    }
    if (!isJsonObject(manifest))
        throw damaged('it is not a JSON object');
    assertHooksShape(manifest.hooks, damaged);
    const declared = manifest.hooks;
    if (Object.values(declared).every((entries) => entries.length === 0))
        throw damaged('it declares no hooks');
    const out = {};
    for (const [event, entries] of Object.entries(declared)) {
        out[event] = entries.map((entry) => ({
            matcher: entry.matcher,
            hooks: entry.hooks.map((h, j) => {
                if (typeof h.command !== 'string')
                    throw damaged(`hooks.${event}[].hooks[${j}].command is not a string`);
                return {
                    type: h.type,
                    command: h.command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot),
                    ...(h.timeout !== undefined ? { timeout: h.timeout } : {}),
                    _memesh: true,
                };
            }),
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
function withRollback(fn) {
    const changes = new Changes();
    try {
        return fn(changes);
    }
    catch (err) {
        changes.rollBack();
        throw err;
    }
}
const BACKUP_SUFFIX = () => `.bak-pre-memesh-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const RULE_ACTION = { missing: 'created', stale: 'updated', current: 'unchanged', 'foreign-file': 'foreign-file' };
export function installHooks(opts) {
    const cwd = opts.cwd ?? process.cwd();
    return withRollback((changes) => installHooksUnguarded(opts, cwd, changes));
}
function installHooksUnguarded(opts, cwd, changes) {
    const settingsPath = settingsPathFor(opts.scope, cwd);
    const markerPath = path.join(memeshDir(), MARKER_FILE);
    const write = !opts.dryRun;
    const rule = readRuleState(opts.scope, cwd);
    const ruleWritten = write && (rule.state === 'missing' || rule.state === 'stale');
    const citationRule = { path: rule.path, action: write ? RULE_ACTION[rule.state] : 'unchanged' };
    const writeRule = () => {
        if (!ruleWritten)
            return;
        changes.mkdir(path.dirname(rule.path));
        changes.write(rule.path, CITATION_RULE_BODY);
    };
    const pluginRuntime = detectPluginRuntime(opts.installedPluginsPathImpl);
    if (pluginRuntime && !opts.forceOverPlugin) {
        if (ruleWritten)
            assertCanWrite(rule.path, 'citation rule file');
        writeRule();
        return {
            settingsPath,
            backupPath: null,
            scope: opts.scope,
            added: 0,
            skipped: 0,
            pruned: 0,
            conflicts: [],
            markerPath,
            pluginRuntimeDetected: pluginRuntime,
            citationRule,
            settingsWritten: false,
            markerWritten: false,
        };
    }
    const desired = loadPluginHooks(opts.pluginRoot);
    const settings = readSettings(settingsPath) ?? {};
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
    const marker = {
        version: opts.pluginVersion,
        plugin_root: opts.pluginRoot,
        scope: opts.scope,
        settings_path: settingsPath,
    };
    const current = readInstallMarker();
    const markerCurrent = current !== null
        && Object.keys(marker).every((key) => current[key] === marker[key]);
    const settingsNeeded = write && (added > 0 || pruned > 0);
    const markerNeeded = write && (settingsNeeded || !markerCurrent);
    if (settingsNeeded) {
        assertCanWrite(settingsPath, 'settings file');
        if (fs.existsSync(settingsPath))
            assertFolderWritable(path.dirname(settingsPath));
    }
    if (markerNeeded)
        assertCanWrite(markerPath, 'install marker file');
    if (ruleWritten)
        assertCanWrite(rule.path, 'citation rule file');
    let backupPath = null;
    if (settingsNeeded) {
        if (fs.existsSync(settingsPath))
            backupPath = changes.copyNew(settingsPath, BACKUP_SUFFIX());
        settings.hooks = existing;
        changes.mkdir(path.dirname(settingsPath));
        changes.write(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    }
    if (markerNeeded) {
        changes.mkdir(path.dirname(markerPath));
        changes.write(markerPath, JSON.stringify({ installed_at: new Date().toISOString(), ...marker }, null, 2) + '\n');
    }
    writeRule();
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
        settingsWritten: settingsNeeded,
        markerWritten: markerNeeded,
    };
}
export function uninstallHooks(opts) {
    const cwd = opts.cwd ?? process.cwd();
    return withRollback((changes) => uninstallHooksUnguarded(opts, cwd, changes));
}
function uninstallHooksUnguarded(opts, cwd, changes) {
    const settingsPath = settingsPathFor(opts.scope, cwd);
    const markerPath = path.join(memeshDir(), MARKER_FILE);
    const write = !opts.dryRun;
    const settings = readSettings(settingsPath);
    const rule = readRuleState(opts.scope, cwd);
    let removed = 0;
    if (settings) {
        const existing = settings.hooks ?? {};
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
    }
    const ruleRemoved = write && (rule.state === 'current' || rule.state === 'stale');
    const settingsWritten = write && settings !== null && removed > 0;
    const markerRemoved = settingsWritten && fs.existsSync(markerPath);
    if (settingsWritten) {
        assertCanWrite(settingsPath, 'settings file');
        assertFolderWritable(path.dirname(settingsPath));
    }
    if (markerRemoved)
        assertCanDelete(markerPath, 'install marker file');
    if (ruleRemoved)
        assertCanDelete(rule.path, 'citation rule file');
    let backupPath = null;
    if (settingsWritten) {
        backupPath = changes.copyNew(settingsPath, BACKUP_SUFFIX());
        changes.write(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    }
    if (markerRemoved)
        changes.remove(markerPath);
    if (ruleRemoved)
        changes.remove(rule.path);
    const action = !write ? 'absent' : ruleRemoved ? 'removed' : rule.state === 'foreign-file' ? 'foreign-file' : 'absent';
    return { settingsPath, backupPath, removed, citationRule: { path: rule.path, action } };
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