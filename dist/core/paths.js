import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
export const AGENT_ROUTER_SOCKET_FILENAME = 'agent-router-v2.sock';
const LEGACY_AGENT_ROUTER_SOCKET_FILENAME = 'agent-router.sock';
export function homeDir() {
    const home = process.env.HOME;
    if (home && home.length > 0)
        return home;
    const fromOs = os.homedir();
    if (fromOs && fromOs.length > 0)
        return fromOs;
    return os.userInfo().homedir;
}
export function memeshDir() {
    return process.env.MEMESH_DIR ?? path.join(homeDir(), '.memesh');
}
export function getDbPath() {
    return process.env.MEMESH_DB_PATH ?? path.join(memeshDir(), 'knowledge-graph.db');
}
export function getMemeshDirFromDbPath() {
    return process.env.MEMESH_DB_PATH
        ? path.dirname(process.env.MEMESH_DB_PATH)
        : memeshDir();
}
export function getAgentRouterSocketPath() {
    return path.join(getMemeshDirFromDbPath(), AGENT_ROUTER_SOCKET_FILENAME);
}
export function normalizeAgentRouterSocketPath(socketPath) {
    const dataDir = getMemeshDirFromDbPath();
    return socketPath === path.join(dataDir, LEGACY_AGENT_ROUTER_SOCKET_FILENAME)
        ? getAgentRouterSocketPath()
        : socketPath;
}
export function getProjectName(cwdInput) {
    const cwd = cwdInput && cwdInput.length > 0 ? cwdInput : process.cwd();
    const cached = projectNameCache.get(cwd);
    if (cached !== undefined)
        return cached;
    const resolved = resolveProjectIdentity(cwd);
    projectNameCache.set(cwd, resolved);
    return resolved;
}
const projectNameCache = new Map();
function resolveProjectIdentity(cwd) {
    const remote = tryGit(cwd, ['config', '--get', 'remote.origin.url']);
    if (remote) {
        const locator = canonicalRemoteLocator(remote);
        if (locator) {
            const label = path.posix.basename(locator).replace(/\.git$/i, '');
            return projectIdentity(label, locator);
        }
    }
    const root = tryGit(cwd, ['rev-parse', '--show-toplevel']);
    const commonDir = root
        ? tryGit(cwd, ['rev-parse', '--git-common-dir'])
        : null;
    const absoluteCommonDir = commonDir ? path.resolve(cwd, commonDir) : null;
    const localPath = absoluteCommonDir && path.basename(absoluteCommonDir) === '.git'
        ? path.dirname(absoluteCommonDir)
        : (root ?? cwd);
    let real;
    try {
        real = fs.realpathSync.native(localPath);
    }
    catch {
        real = path.resolve(localPath);
    }
    return projectIdentity(path.basename(real), real);
}
const PROJECT_HASH_HEX_LENGTH = 32;
const PROJECT_ID_MAX_LENGTH = 200;
const PROJECT_LABEL_MAX_LENGTH = PROJECT_ID_MAX_LENGTH - PROJECT_HASH_HEX_LENGTH - 1;
function projectIdentity(label, locator) {
    const readable = label.normalize('NFC').slice(0, PROJECT_LABEL_MAX_LENGTH) || 'project';
    const suffix = createHash('sha256').update(locator).digest('hex').slice(0, PROJECT_HASH_HEX_LENGTH);
    return `${readable}~${suffix}`;
}
function tryGit(cwd, args) {
    try {
        const out = execFileSync('git', ['-C', cwd, ...args], {
            encoding: 'utf8',
            timeout: 2000,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const trimmed = out.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    catch {
        return null;
    }
}
export function gitRepoRoot(cwdInput) {
    const cwd = cwdInput && cwdInput.length > 0 ? cwdInput : process.cwd();
    return tryGit(cwd, ['rev-parse', '--show-toplevel']);
}
export function canonicalRemoteLocator(remote) {
    const value = remote.trim();
    if (!value)
        return null;
    if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value))
        return null;
    let host;
    let port = '';
    let user;
    let remotePath;
    let transport;
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
        let parsed;
        try {
            parsed = new URL(value);
        }
        catch {
            return null;
        }
        if (parsed.protocol === 'file:' || !parsed.hostname)
            return null;
        host = parsed.hostname.toLowerCase();
        port = parsed.port;
        const protocol = parsed.protocol.toLowerCase();
        if ((protocol === 'ssh:' || protocol === 'git+ssh:') && port === '22')
            port = '';
        user = parsed.username;
        remotePath = parsed.pathname;
        transport = protocol === 'ssh:' || protocol === 'git+ssh:'
            ? 'ssh-absolute'
            : protocol.slice(0, -1);
    }
    else {
        const scp = /^(?:([^@]+)@)?(\[[^\]]+\]|[^:/]+):(.+)$/.exec(value);
        if (!scp)
            return null;
        user = scp[1] ?? '';
        host = scp[2].toLowerCase();
        remotePath = scp[3];
        transport = remotePath.startsWith('/') ? 'ssh-absolute' : 'ssh-relative';
    }
    const pathWithoutSlashes = remotePath.replace(/^\/+|\/+$/g, '');
    if (!host || !pathWithoutSlashes)
        return null;
    const endpoint = `${host}${port ? `:${port}` : ''}`;
    const standardGithub = host === 'github.com'
        && port === ''
        && (transport === 'https' || ((transport === 'ssh-relative' || transport === 'ssh-absolute') && user === 'git'));
    const normalizedPath = standardGithub
        ? pathWithoutSlashes.replace(/\.git$/i, '')
        : pathWithoutSlashes;
    if (standardGithub)
        return `${endpoint}/${normalizedPath}`;
    const authority = transport.startsWith('ssh-') && user ? `${user}@${endpoint}` : endpoint;
    return `${transport}://${authority}/${normalizedPath}`;
}
export function _clearProjectNameCache() {
    projectNameCache.clear();
}
export const SECRET_PATTERN_SOURCES = [
    '-----BEGIN[A-Z ]*PRIVATE KEY-----(?:[\\s\\S]*?-----END[A-Z ]*PRIVATE KEY-----|[\\s\\S]*)',
    '(?:postgres|postgresql|mysql|mariadb|mongodb(?:\\+srv)?|redis|rediss|amqp|amqps)://[^\\s:@/]+:[^\\s:@/]+@',
    'eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}',
    'SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}',
    '[srp]k_(?:live|test)_[A-Za-z0-9]{16,}',
    'npm_[A-Za-z0-9]{36}',
    '\\bsk[-_][^\\s"\\\\]{4,}[A-Za-z0-9]',
    'Bearer(?:\\s|\\\\[nrt])+[A-Za-z0-9_.\\-]{16,}',
    '(?<![A-Za-z0-9])(?:api[-_]?key|access[-_]?token|auth[-_]?token|refresh[-_]?token|session[-_]?token|token|secret|password|passwd|pwd|signature)=[^&\\s"\'<>]{8,}',
    'ghp_[A-Za-z0-9]{30,}',
    'gho_[A-Za-z0-9]{30,}',
    'gh[sur]_[A-Za-z0-9]{30,}',
    'github_pat_[A-Za-z0-9_]{20,}',
    'A(?:KIA|SIA)[A-Z0-9]{16}',
    'AIza[A-Za-z0-9_-]{30,}',
    'xox[baprs]-[A-Za-z0-9-]{10,}',
];
const SECRET_PATTERNS = SECRET_PATTERN_SOURCES.map((s) => new RegExp(s, 'gi'));
function redactRaw(input) {
    let out = input;
    for (let before = ''; out !== before;) {
        before = out;
        out = maskMatches(out);
    }
    return out;
}
function maskMatches(input) {
    const spans = [];
    const budget = 4 * input.length + 1024;
    let work = 0;
    search: for (const pattern of SECRET_PATTERNS) {
        pattern.lastIndex = 0;
        for (let m = pattern.exec(input); m !== null; m = pattern.exec(input)) {
            work += m[0].length;
            if (work > budget) {
                spans.push([m.index, input.length]);
                pattern.lastIndex = 0;
                break search;
            }
            spans.push([m.index, m.index + m[0].length]);
            pattern.lastIndex = m.index + 1;
        }
    }
    if (spans.length === 0)
        return input;
    spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    let out = '';
    let at = 0;
    let open;
    for (const span of spans) {
        if (open && span[0] < open[1]) {
            open[1] = Math.max(open[1], span[1]);
            continue;
        }
        if (open) {
            out += `${input.slice(at, open[0])}***REDACTED***`;
            at = open[1];
        }
        open = [span[0], span[1]];
    }
    if (open)
        out += `${input.slice(at, open[0])}***REDACTED***`;
    return out + input.slice(open ? open[1] : at);
}
const PRIVATE_KEY_MARKER = /-----(BEGIN|END)[A-Z ]*PRIVATE KEY-----/gi;
const PRIVATE_KEY_END = /-----END[A-Z ]*PRIVATE KEY-----/i;
const ANY_PRIVATE_KEY_MARKER = /-----(?:BEGIN|END)[A-Z ]*PRIVATE KEY-----/i;
const REDACTED = '***REDACTED***';
const nativeJson = JSON;
const looksLikeJson = (text) => /^\s*[[{"]/.test(text);
function holdsPartOfKey(text) {
    let open = false;
    for (const [, marker] of text.matchAll(PRIVATE_KEY_MARKER)) {
        if (marker.toUpperCase() === 'BEGIN')
            open = true;
        else if (open)
            open = false;
        else
            return true;
    }
    return open;
}
function* jsonTexts(value) {
    const stack = [value];
    while (stack.length > 0) {
        const node = stack.pop();
        if (typeof node === 'string')
            yield node;
        else if (Array.isArray(node))
            for (const item of node)
                stack.push(item);
        else if (node !== null && typeof node === 'object' && !nativeJson.isRawJSON?.(node)) {
            for (const [key, inner] of Object.entries(node)) {
                yield key;
                stack.push(inner);
            }
        }
    }
}
function holdsPartOfKeyDecoded(text) {
    if (holdsPartOfKey(text))
        return true;
    if (!looksLikeJson(text) || !(text.includes('\\') || ANY_PRIVATE_KEY_MARKER.test(text)))
        return false;
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (err) {
        return !(err instanceof SyntaxError);
    }
    for (const inner of jsonTexts(parsed))
        if (inner !== text && holdsPartOfKeyDecoded(inner))
            return true;
    return false;
}
function mapJson(node, text, key, skipKeys) {
    if (typeof node === 'string')
        return text(node);
    if (Array.isArray(node))
        return node.map((item) => mapJson(item, text, key));
    if (node === null || typeof node !== 'object' || nativeJson.isRawJSON?.(node))
        return node;
    const out = {};
    const lastSuffix = new Map();
    for (const [name, inner] of Object.entries(node)) {
        const safe = key(name);
        let unique = safe;
        if (Object.prototype.hasOwnProperty.call(out, unique)) {
            let n = lastSuffix.get(safe) ?? 1;
            do {
                n++;
                unique = `${safe} (${n})`;
            } while (Object.prototype.hasOwnProperty.call(out, unique));
            lastSuffix.set(safe, n);
        }
        Object.defineProperty(out, unique, {
            value: skipKeys?.has(name) ? inner : mapJson(inner, text, key),
            enumerable: true, writable: true, configurable: true,
        });
    }
    return out;
}
function redactSet(items) {
    if (items.some(holdsPartOfKeyDecoded))
        return { texts: items.map(() => REDACTED), masked: true };
    let masked = false;
    const texts = items.map((item) => {
        const r = redactOne(item);
        if (r.masked)
            masked = true;
        return r.text;
    });
    return { texts, masked };
}
export function redactSecretList(items) {
    return redactSet(items).texts;
}
export function redactTitleAndObservations(title, observations) {
    const head = title === undefined ? [] : [title];
    const texts = redactSecretList([...head, ...(observations === undefined ? [] : observations)]);
    return {
        ...(title === undefined ? {} : { title: texts[0] }),
        ...(observations === undefined ? {} : { observations: texts.slice(head.length) }),
    };
}
export function holdsSecret(items) {
    return redactSet(items).masked;
}
const keepNumberSpelling = (_key, value, context) => typeof value === 'number' && context?.source !== undefined && nativeJson.rawJSON ? nativeJson.rawJSON(context.source) : value;
function redactOne(input) {
    const raw = redactRaw(input);
    const asRaw = { text: raw, masked: raw !== input };
    if (!looksLikeJson(input))
        return asRaw;
    if (!asRaw.masked && !input.includes('\\') && !PRIVATE_KEY_END.test(input))
        return asRaw;
    try {
        const parsed = JSON.parse(input, keepNumberSpelling);
        if ([...jsonTexts(parsed)].some(holdsPartOfKeyDecoded)) {
            return { text: JSON.stringify(mapJson(parsed, () => REDACTED, () => REDACTED)), masked: true };
        }
        let masked = false;
        const value = mapJson(parsed, (s) => { const r = redactOne(s); if (r.masked)
            masked = true; return r.text; }, (k) => { const r = redactRaw(k); if (r !== k)
            masked = true; return r; });
        return { text: JSON.stringify(value), masked: masked || asRaw.masked };
    }
    catch (err) {
        return err instanceof SyntaxError ? asRaw : { text: REDACTED, masked: true };
    }
}
export function redactSecrets(input) {
    return redactOne(input).text;
}
export function redactUserPaths(text) {
    const home = homeDir();
    const roots = new Set();
    const add = (root) => {
        if (!root || !path.isAbsolute(root))
            return;
        roots.add(root);
        try {
            roots.add(fs.realpathSync(root));
        }
        catch { }
    };
    add(home);
    const isInside = (child) => {
        const rel = path.relative(home, child);
        return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    };
    for (const dir of [memeshDir(), path.dirname(getDbPath())]) {
        if (dir && !isInside(dir))
            add(dir);
    }
    const flags = process.platform === 'linux' ? 'g' : 'gi';
    let out = text;
    for (const root of [...roots].sort((a, b) => b.length - a.length)) {
        const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const body = escaped.replace(/\\\\|\//g, '[\\\\/]{1,2}');
        out = out.replace(new RegExp(`(?<![\\w~](?:[\\\\/]{1,2})?)${body}(?=[\\\\/]|$)`, flags), '~');
    }
    return out;
}
export function redactMemoryText(text) {
    return redactUserPaths(redactSecrets(text));
}
export function redactTextValues(value, skipKeys = new Set()) {
    if (value === undefined)
        return undefined;
    const serialized = JSON.stringify(value);
    if (serialized === undefined)
        return undefined;
    return mapJson(JSON.parse(serialized), redactSecrets, redactRaw, skipKeys);
}
export function redactVersionText(entry) {
    const rest = redactTextValues(entry, new Set(['title', 'observations']));
    if (rest === null || typeof rest !== 'object' || Array.isArray(rest))
        return rest;
    const version = rest;
    const observations = Array.isArray(version.observations) && version.observations.every((o) => typeof o === 'string')
        ? version.observations : undefined;
    if (observations === undefined || (version.title !== undefined && typeof version.title !== 'string')) {
        return redactTextValues(entry);
    }
    const title = typeof version.title === 'string' ? [version.title] : [];
    const texts = redactSecretList([...title, ...observations]);
    return { ...version, ...(title.length > 0 ? { title: texts[0] } : {}), observations: texts.slice(title.length) };
}
export function textsIn(value) {
    const serialized = value === undefined ? undefined : JSON.stringify(value);
    return new Set(serialized === undefined ? [] : jsonTexts(JSON.parse(serialized)));
}
export function metadataRefusal(value, known) {
    const serialized = value === undefined ? undefined : JSON.stringify(value);
    if (serialized === undefined)
        return undefined;
    const stack = [JSON.parse(serialized)];
    while (stack.length > 0) {
        const node = stack.pop();
        if (typeof node === 'string') {
            if (!known.has(node) && holdsPartOfKeyDecoded(node))
                return 'its metadata holds part of a private key (a BEGIN or END line without the rest)';
        }
        else if (Array.isArray(node)) {
            for (const item of node)
                stack.push(item);
        }
        else if (node !== null && typeof node === 'object') {
            for (const [key, inner] of Object.entries(node)) {
                if (!known.has(key) && (holdsPartOfKeyDecoded(key) || redactRaw(key) !== key))
                    return 'a metadata key name holds a credential or part of a private key';
                stack.push(inner);
            }
        }
    }
    return undefined;
}
//# sourceMappingURL=paths.js.map