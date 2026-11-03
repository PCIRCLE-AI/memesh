import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { processStartTag } from './process-identity.js';
export const MARKER_FILE = '.memesh-install.json';
export const REGISTRY_FILE = 'hermes-installs.json';
export const HERMES_REASONS = {
    installed: 'installed',
    refreshed: 'refreshed to the verified version',
    unchanged: 'already the verified version',
    notOurs: 'left alone: this directory was not installed by MeMesh (it has no install marker)',
    modified: 'left alone: files in this copy were changed after MeMesh installed it',
    markerUnreadable: 'left alone: the install marker could not be read',
    unsafeSource: 'not installed: the provider source holds something other than plain files',
    failed: 'failed',
    linked: 'left alone: it is a symbolic link, somebody pointed it somewhere on purpose, and MeMesh writes neither through it nor over it',
    unreadable: 'left alone: something in this directory cannot be read, so it cannot be told whether it is MeMesh\'s copy or whether it was edited',
    gone: 'a copy MeMesh installed here is no longer there; run `memesh hermes install` (add --path for a copy outside the default place) to put it back',
    restored: 'the copy had been lost to an update that was interrupted; it was put back first',
    busy: 'left alone: another refresh of this copy is running (the next run tries again)',
    linkedHint: 'MeMesh never changes a symbolic link, with or without --force: point --path at a real directory, or remove the link yourself',
};
export function hermesHome(env, accountHome) {
    if (env.HERMES_HOME)
        return path.resolve(env.HERMES_HOME);
    const home = accountHome ?? env.HOME;
    if (!home)
        throw new Error('the Hermes home cannot be worked out: HERMES_HOME is not set and neither is a home directory (pass --path)');
    return path.join(home, '.hermes');
}
export function defaultInstallTargetOrNull(env, accountHome) {
    try {
        return defaultInstallTarget(env, accountHome);
    }
    catch {
        return null;
    }
}
export function defaultInstallTarget(env, accountHome) {
    return path.join(hermesHome(env, accountHome), 'plugins', 'memesh');
}
const SKIPPED = new Set(['__pycache__', '.DS_Store']);
function listFiles(root, dir = root, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIPPED.has(entry.name) || entry.name.endsWith('.pyc'))
            continue;
        const full = path.join(dir, entry.name);
        const rel = path.relative(root, full).split(path.sep).join('/');
        if (rel === MARKER_FILE)
            continue;
        if (entry.isDirectory())
            listFiles(root, full, out);
        else if (entry.isFile())
            out.push(rel);
        else
            throw new Error(`not a plain file: ${rel}`);
    }
    return out.sort();
}
function hashFiles(root) {
    const hashes = {};
    for (const rel of listFiles(root))
        hashes[rel] = createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
    return hashes;
}
function sameHashes(a, b) {
    const ak = Object.keys(a);
    return ak.length === Object.keys(b).length && ak.every((k) => a[k] === b[k]);
}
export function inspectInstall(target) {
    let stat;
    try {
        stat = fs.lstatSync(target);
    }
    catch (err) {
        return err.code === 'ENOENT' ? { state: 'absent' } : { state: 'unreadable', why: errorText(err) };
    }
    if (stat.isSymbolicLink()) {
        let to = '?';
        try {
            to = fs.readlinkSync(target);
        }
        catch { }
        return { state: 'linked', to };
    }
    if (!stat.isDirectory())
        return { state: 'foreign' };
    const markerPath = path.join(target, MARKER_FILE);
    let markerText;
    try {
        markerText = fs.readFileSync(markerPath, 'utf8');
    }
    catch (err) {
        return err.code === 'ENOENT' ? { state: 'foreign' } : { state: 'unreadable', why: errorText(err) };
    }
    let marker;
    try {
        const parsed = JSON.parse(markerText);
        if (parsed.source !== 'memesh' || typeof parsed.version !== 'string' || !parsed.files || typeof parsed.files !== 'object') {
            return { state: 'marker-unreadable' };
        }
        marker = parsed;
    }
    catch {
        return { state: 'marker-unreadable' };
    }
    let modified;
    try {
        modified = !sameHashes(marker.files, hashFiles(target));
    }
    catch (err) {
        return { state: 'unreadable', why: errorText(err) };
    }
    return { state: 'managed', marker, modified };
}
function errorText(err) {
    const e = err;
    return `${e?.code ?? 'error'}${e?.message ? `: ${e.message.replace(/\s+/g, ' ').slice(0, 140)}` : ''}`;
}
function exists(p) {
    try {
        fs.lstatSync(p);
        return true;
    }
    catch {
        return false;
    }
}
function copyDir(from, to) {
    fs.cpSync(from, to, { recursive: true, filter: (src) => !SKIPPED.has(path.basename(src)) && !src.endsWith('.pyc') });
}
function backUp(target, backupRoot, now) {
    fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    const id = createHash('sha256').update(path.resolve(target)).digest('hex').slice(0, 8);
    const stem = path.join(backupRoot, `hermes-provider-${now.toISOString().replace(/[:.]/g, '-')}-${id}`);
    try {
        for (const name of fs.readdirSync(backupRoot)) {
            const m = /^hermes-provider-.*\.partial-(\d+)$/.exec(name);
            if (m && !ownerAlive(Number(m[1]), 'x'))
                fs.rmSync(path.join(backupRoot, name), { recursive: true, force: true });
        }
    }
    catch { }
    let dest = stem;
    for (let n = 2; exists(dest); n += 1)
        dest = `${stem}-${n}`;
    const partial = `${dest}.partial-${process.pid}`;
    try {
        fs.cpSync(target, partial, { recursive: true });
        fs.renameSync(partial, dest);
    }
    catch (err) {
        try {
            fs.rmSync(partial, { recursive: true, force: true });
        }
        catch { }
        throw err;
    }
    return dest;
}
const NEW_PREFIX = '.memesh-new-';
const OLD_PREFIX = '.memesh-old-';
const COPY = 'copy';
const hashTag = (start) => createHash('sha256').update(start).digest('hex').slice(0, 10);
function ownerTag(pid) {
    const start = processStartTag(pid);
    return start === null ? 'x' : hashTag(start);
}
function ownerAlive(pid, tag) {
    try {
        process.kill(pid, 0);
    }
    catch (err) {
        if (err.code === 'ESRCH')
            return false;
    }
    if (tag === 'x')
        return true;
    const now = processStartTag(pid);
    return now === null ? true : hashTag(now) === tag;
}
function stagingPaths(target, owner) {
    const dir = path.dirname(target);
    const base = path.basename(target);
    const newRoot = path.join(dir, `${NEW_PREFIX}${base}-${owner}`);
    const oldRoot = path.join(dir, `${OLD_PREFIX}${base}-${owner}`);
    return { newRoot, fresh: path.join(newRoot, COPY), oldRoot, old: path.join(oldRoot, COPY) };
}
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function leftovers(target, log) {
    const dir = path.dirname(target);
    const base = path.basename(target);
    let names;
    try {
        names = fs.readdirSync(dir);
    }
    catch (err) {
        if (err.code !== 'ENOENT')
            log?.(`hermes: could not list ${dir} for the leftovers of an interrupted refresh (${errorText(err)})`);
        return [];
    }
    const found = [];
    for (const name of names) {
        for (const [prefix, kind] of [[NEW_PREFIX, 'new'], [OLD_PREFIX, 'old']]) {
            if (!name.startsWith(prefix))
                continue;
            const m = new RegExp(`^${escapeRegExp(prefix)}${escapeRegExp(base)}-(\\d+)-([0-9a-f]{10}|x)$`).exec(name);
            if (m)
                found.push({ root: path.join(dir, name), kind, pid: Number(m[1]), tag: m[2] });
        }
    }
    return found;
}
function recoverInterrupted(target, log) {
    const left = leftovers(target, log).filter((l) => !ownerAlive(l.pid, l.tag));
    let restored = false;
    if (!exists(target)) {
        const olds = left
            .filter((l) => l.kind === 'old' && exists(path.join(l.root, COPY)))
            .sort((a, b) => { try {
            return fs.statSync(b.root).mtimeMs - fs.statSync(a.root).mtimeMs;
        }
        catch {
            return 0;
        } });
        if (olds.length > 0) {
            fs.renameSync(path.join(olds[0].root, COPY), target);
            restored = true;
        }
    }
    for (const l of left) {
        if (exists(l.root))
            fs.rmSync(l.root, { recursive: true, force: true });
    }
    return restored;
}
function hasRestorableLeftover(target) {
    if (exists(target))
        return false;
    return leftovers(target).some((l) => l.kind === 'old' && !ownerAlive(l.pid, l.tag) && exists(path.join(l.root, COPY)));
}
function withCopyLock(target, busy, fn) {
    const lockDir = path.join(path.dirname(target), `.memesh-lock-${path.basename(target)}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const take = () => {
        try {
            fs.mkdirSync(lockDir);
        }
        catch (err) {
            if (err.code === 'EEXIST')
                return false;
            throw err;
        }
        fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, tag: ownerTag(process.pid) }));
        return true;
    };
    let held = take();
    if (!held) {
        let owner = null;
        try {
            owner = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
        }
        catch { }
        const running = owner !== null && typeof owner.pid === 'number' && ownerAlive(owner.pid, typeof owner.tag === 'string' ? owner.tag : 'x');
        let youngNoOwner = false;
        if (owner === null) {
            try {
                youngNoOwner = Date.now() - fs.statSync(lockDir).mtimeMs < 60_000;
            }
            catch { }
        }
        if (running || youngNoOwner)
            return busy();
        fs.rmSync(lockDir, { recursive: true, force: true });
        held = take();
        if (!held)
            return busy();
    }
    try {
        return fn();
    }
    finally {
        try {
            fs.rmSync(lockDir, { recursive: true, force: true });
        }
        catch { }
    }
}
function writeCopy(input, replacing, keep) {
    const { sourceDir, target, version, backupRoot, now } = input;
    const files = hashFiles(sourceDir);
    const owner = `${process.pid}-${ownerTag(process.pid)}`;
    const { newRoot, fresh, oldRoot, old } = stagingPaths(target, owner);
    fs.rmSync(newRoot, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.mkdirSync(newRoot, { recursive: true });
    let backup = null;
    let residue = null;
    try {
        copyDir(sourceDir, fresh);
        const marker = { source: 'memesh', version, installedAt: now.toISOString(), files };
        fs.writeFileSync(path.join(fresh, MARKER_FILE), JSON.stringify(marker, null, 2) + '\n');
        if (replacing) {
            if (keep)
                backup = backUp(target, backupRoot, now);
            fs.rmSync(oldRoot, { recursive: true, force: true });
            fs.mkdirSync(oldRoot, { recursive: true });
            fs.renameSync(target, old);
            try {
                fs.renameSync(fresh, target);
            }
            catch (err) {
                fs.renameSync(old, target);
                fs.rmSync(oldRoot, { recursive: true, force: true });
                throw err;
            }
            try {
                fs.rmSync(oldRoot, { recursive: true, force: true });
            }
            catch {
                residue = oldRoot;
            }
        }
        else {
            fs.renameSync(fresh, target);
        }
    }
    finally {
        try {
            fs.rmSync(newRoot, { recursive: true, force: true });
        }
        catch { }
    }
    return { backup, residue };
}
export function installProvider(input) {
    const { target } = input;
    return withCopyLock(target, () => ({ path: target, outcome: 'skipped', reason: HERMES_REASONS.busy, backup: null }), () => installLocked(input));
}
function installLocked(input) {
    const { target, sourceDir, version } = input;
    let restored;
    try {
        restored = recoverInterrupted(target, input.log);
    }
    catch (err) {
        return { path: target, outcome: 'failed', reason: `${HERMES_REASONS.failed}: could not clean up after an interrupted update: ${errorText(err)}`, backup: null };
    }
    const state = inspectInstall(target);
    if (state.state === 'linked')
        return { path: target, outcome: 'skipped', reason: `${HERMES_REASONS.linked} (it points to ${state.to})`, backup: null };
    if (state.state === 'unreadable')
        return { path: target, outcome: 'failed', reason: `${HERMES_REASONS.unreadable} (${state.why})`, backup: null };
    try {
        if (state.state === 'absent') {
            writeCopy(input, false, false);
            return { path: target, outcome: 'installed', reason: HERMES_REASONS.installed, backup: null };
        }
        if (state.state === 'managed' && !state.modified && state.marker.version === version
            && sameHashes(state.marker.files, hashFiles(sourceDir))) {
            return { path: target, outcome: 'unchanged', reason: HERMES_REASONS.unchanged, backup: null };
        }
        if (!input.force) {
            if (state.state === 'foreign')
                return { path: target, outcome: 'skipped', reason: HERMES_REASONS.notOurs, backup: null };
            if (state.state === 'marker-unreadable')
                return { path: target, outcome: 'skipped', reason: HERMES_REASONS.markerUnreadable, backup: null };
            if (state.state === 'managed' && state.modified)
                return { path: target, outcome: 'skipped', reason: HERMES_REASONS.modified, backup: null };
        }
        const keep = !(state.state === 'managed' && !state.modified);
        const { backup, residue } = writeCopy(input, true, keep);
        const notes = [HERMES_REASONS.refreshed];
        if (restored)
            notes.push(HERMES_REASONS.restored);
        if (residue)
            notes.push(`the old copy could not be removed and is still at ${residue}; delete it by hand`);
        return { path: target, outcome: 'refreshed', reason: notes.join('; '), backup };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith('not a plain file'))
            return { path: target, outcome: 'failed', reason: `${HERMES_REASONS.unsafeSource} (${message})`, backup: null };
        return { path: target, outcome: 'failed', reason: `${HERMES_REASONS.failed}: ${message.slice(0, 160)}`, backup: null };
    }
}
function readRegistryState(memeshDir) {
    let text;
    try {
        text = fs.readFileSync(path.join(memeshDir, REGISTRY_FILE), 'utf8');
    }
    catch (err) {
        return err.code === 'ENOENT' ? { ok: true, installs: [] } : { ok: false, why: errorText(err) };
    }
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.installs))
            return { ok: false, why: 'it has no "installs" list' };
        return { ok: true, installs: parsed.installs.filter((p) => typeof p === 'string' && path.isAbsolute(p)) };
    }
    catch (err) {
        return { ok: false, why: `it is not valid JSON (${errorText(err)})` };
    }
}
function readRegistry(memeshDir) {
    const state = readRegistryState(memeshDir);
    return state.ok ? state.installs : [];
}
export function registryProblem(memeshDir) {
    const state = readRegistryState(memeshDir);
    return state.ok ? null : state.why;
}
export function registryProblemResult(memeshDir) {
    const why = registryProblem(memeshDir);
    if (why === null)
        return null;
    return { path: path.join(memeshDir, REGISTRY_FILE), outcome: 'failed', reason: `the list of installed copies cannot be read (${why}): the copies it names are not being updated until it is fixed or removed`, backup: null };
}
export function registerInstall(memeshDir, target) {
    const state = readRegistryState(memeshDir);
    if (!state.ok) {
        throw new Error(`${path.join(memeshDir, REGISTRY_FILE)} cannot be read (${state.why}), so it was not changed: fix or remove it, then run the command again`);
    }
    const installs = new Set(state.installs);
    installs.add(path.resolve(target));
    fs.mkdirSync(memeshDir, { recursive: true, mode: 0o700 });
    const file = path.join(memeshDir, REGISTRY_FILE);
    const temp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify({ installs: [...installs].sort() }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
}
export function candidateInstalls(memeshDir, env, accountHome) {
    const fallback = defaultInstallTargetOrNull(env, accountHome);
    return [...new Set([...(fallback === null ? [] : [fallback]), ...readRegistry(memeshDir)])];
}
export function refreshTargets(memeshDir, env, accountHome) {
    const registered = readRegistry(memeshDir);
    return candidateInstalls(memeshDir, env, accountHome).filter((t) => inspectInstall(t).state !== 'absent' || registered.includes(t) || hasRestorableLeftover(t));
}
export function refreshInstalls(input) {
    const results = [];
    const registry = readRegistryState(input.memeshDir);
    const problem = registryProblemResult(input.memeshDir);
    if (problem)
        results.push(problem);
    if (defaultInstallTargetOrNull(input.env, input.accountHome) === null)
        input.log?.('hermes: there is no home directory and HERMES_HOME is not set, so there is no default place for the provider; only the registered copies are looked at');
    const registered = registry.ok ? registry.installs : [];
    for (const target of refreshTargets(input.memeshDir, input.env, input.accountHome)) {
        const backupRoot = path.join(input.memeshDir, 'backups');
        let restored;
        try {
            restored = recoverInterrupted(target, input.log);
        }
        catch (err) {
            results.push({ path: target, outcome: 'failed', reason: `${HERMES_REASONS.failed}: could not clean up after an interrupted update: ${errorText(err)}`, backup: null });
            continue;
        }
        const state = inspectInstall(target);
        if (state.state === 'absent') {
            if (registered.includes(target))
                results.push({ path: target, outcome: 'failed', reason: HERMES_REASONS.gone, backup: null });
            continue;
        }
        if (state.state === 'foreign') {
            if (registered.includes(target) || restored)
                results.push({ path: target, outcome: 'skipped', reason: restored ? `${HERMES_REASONS.restored}; ${HERMES_REASONS.notOurs}` : HERMES_REASONS.notOurs, backup: null });
            continue;
        }
        const result = installProvider({ sourceDir: input.sourceDir, target, version: input.version, force: false, backupRoot, now: input.now, ...(input.log ? { log: input.log } : {}) });
        if (restored) {
            results.push({ ...result, reason: result.outcome === 'unchanged' ? HERMES_REASONS.restored : `${HERMES_REASONS.restored}; ${result.reason}` });
        }
        else {
            results.push(result);
        }
    }
    return results;
}
export function staleInstalls(memeshDir, env, version, accountHome) {
    return candidateInstalls(memeshDir, env, accountHome).filter((target) => {
        if (hasRestorableLeftover(target))
            return true;
        const state = inspectInstall(target);
        return state.state === 'managed' && !state.modified && state.marker.version !== version;
    });
}
//# sourceMappingURL=hermes-provider.js.map