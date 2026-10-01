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
const SK_KEY = 'sk[-_][^\\s"\\\\]{4,}[A-Za-z0-9]';
const NAMED_VALUE = '(?:api[-_]?key|access[-_]?token|auth[-_]?token|refresh[-_]?token|session[-_]?token|token|secret|password|passwd|pwd|signature)=[^&\\s"\'<>]{8,}';
export const SECRET_PATTERN_SOURCES = [
    '-----BEGIN[A-Z ]*PRIVATE KEY-----(?:[\\s\\S]*?-----END[A-Z ]*PRIVATE KEY-----|[\\s\\S]*)',
    '(?:postgres|postgresql|mysql|mariadb|mongodb(?:\\+srv)?|redis|rediss|amqp|amqps)://[^\\s:@/]+:[^\\s:@/]+@',
    'eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}',
    'SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}',
    '[srp]k_(?:live|test)_[A-Za-z0-9]{16,}',
    'npm_[A-Za-z0-9]{36}',
    `\\b${SK_KEY}`,
    'Bearer(?:\\s|\\\\[nrt])+[A-Za-z0-9_.\\-]{16,}',
    `(?<![A-Za-z0-9])${NAMED_VALUE}`,
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
    let out = '';
    let at = 0;
    for (const [start, end] of gluedAfter(input, merge(spans))) {
        out += `${input.slice(at, start)}${REDACTED}`;
        at = end;
    }
    return out + input.slice(at);
}
function merge(spans) {
    spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const merged = [];
    for (const [start, end] of spans) {
        const last = merged[merged.length - 1];
        if (last && start < last[1])
            last[1] = Math.max(last[1], end);
        else
            merged.push([start, end]);
    }
    return merged;
}
const GLUED = [SK_KEY, NAMED_VALUE].map((s) => new RegExp(s, 'iy'));
function gluedAfter(input, spans) {
    const out = [];
    let next = 0;
    while (next < spans.length) {
        const [start] = spans[next];
        let end = spans[next][1];
        next++;
        const skipTo = GLUED.map(() => start);
        for (let at = start; at <= end && end < input.length; at++) {
            GLUED.forEach((pattern, i) => {
                if (at < skipTo[i])
                    return;
                pattern.lastIndex = at;
                const m = pattern.exec(input);
                if (m === null)
                    return;
                skipTo[i] = at + m[0].length;
                end = Math.max(end, skipTo[i]);
            });
            while (next < spans.length && spans[next][0] <= end)
                end = Math.max(end, spans[next++][1]);
        }
        out.push([start, end]);
    }
    return out;
}
const PRIVATE_KEY_MARKER = /-----(BEGIN|END)[A-Z ]*PRIVATE KEY-----/gi;
const PRIVATE_KEY_END = /-----END[A-Z ]*PRIVATE KEY-----/i;
const ANY_PRIVATE_KEY_MARKER = /-----(?:BEGIN|END)[A-Z ]*PRIVATE KEY-----/i;
const REDACTED = '***REDACTED***';
const nativeJson = JSON;
const looksLikeJson = (text) => /^\s*[[{"]/.test(text);
const JSON_ESCAPE = /\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g;
const ESCAPED_CHAR = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
function readEscapes(text) {
    for (let level = 0; level <= 8; level++) {
        const read = text.replace(JSON_ESCAPE, (_, hex, c) => hex === undefined ? ESCAPED_CHAR[c] : String.fromCharCode(parseInt(hex, 16)));
        if (read === text)
            return text;
        text = read;
    }
    return undefined;
}
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
    const read = readEscapes(text);
    if (read !== undefined && holdsPartOfKey(read))
        return true;
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
        if (holdsPartOfKeyDecoded(input) || [...jsonTexts(parsed)].some(holdsPartOfKeyDecoded)) {
            return { text: JSON.stringify(mapJson(parsed, () => REDACTED, () => REDACTED)), masked: true };
        }
        let masked = false;
        const value = mapJson(parsed, (s) => { const r = redactOne(s); if (r.masked)
            masked = true; return r.text; }, (k) => { const r = redactRaw(k); if (r !== k)
            masked = true; return r; });
        const read = readEscapes(input);
        if (read === undefined)
            return { text: REDACTED, masked: true };
        const maskedInText = asRaw.masked || redactRaw(read) !== read;
        return { text: JSON.stringify(value), masked: masked || maskedInText };
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
    if (observations === undefined)
        return redactTextValues(entry);
    const title = version.title;
    const titleTexts = typeof title === 'string' ? [title] : title === undefined || title === null ? [] : [...textsIn(title)];
    if ([...titleTexts, ...observations].some(holdsPartOfKeyDecoded)) {
        return {
            ...version,
            ...(titleTexts.length === 0 ? {} : { title: typeof title === 'string' ? REDACTED : mapJson(JSON.parse(JSON.stringify(title)), () => REDACTED, () => REDACTED) }),
            observations: observations.map(() => REDACTED),
        };
    }
    return {
        ...version,
        ...(typeof title === 'string' ? { title: redactSecrets(title) } : titleTexts.length === 0 ? {} : { title: redactTextValues(title) }),
        observations: observations.map(redactSecrets),
    };
}
export function textsIn(value) {
    const serialized = value === undefined ? undefined : JSON.stringify(value);
    return new Set(serialized === undefined ? [] : jsonTexts(JSON.parse(serialized)));
}
export function metadataRefusal(value, known, beside = []) {
    const serialized = value === undefined ? undefined : JSON.stringify(value);
    if (serialized === undefined)
        return undefined;
    const stack = [JSON.parse(serialized)];
    while (stack.length > 0) {
        const node = stack.pop();
        if (typeof node === 'string') {
            if (!known.has(node) && holdsPartOfKeyDecoded(node))
                return 'its metadata holds part of a private key (a BEGIN or END line without the rest). Nothing was written; remove that text and try again';
        }
        else if (Array.isArray(node)) {
            for (const item of node)
                stack.push(item);
        }
        else if (node !== null && typeof node === 'object') {
            for (const [key, inner] of Object.entries(node)) {
                if (!known.has(key) && (holdsPartOfKeyDecoded(key) || redactRaw(key) !== key))
                    return 'a metadata key name holds a credential or part of a private key. Nothing was written; remove that text and try again';
                stack.push(inner);
            }
        }
    }
    return besideRefusal(addsNewText(value, known), beside);
}
export function besideRefusal(addsText, beside) {
    if (!addsText)
        return undefined;
    for (const text of beside) {
        if (holdsPartOfKeyDecoded(text)) {
            return 'it adds new text to a memory that holds a BEGIN or END line of a private key without the rest, '
                + 'so MeMesh cannot tell whether the new text continues that key (the line alone is not proof of a key). '
                + 'Nothing was written. To clear such a line in the memory\'s metadata, run `memesh unpin --name <name>` first '
                + '(it adds no text, and masks every part of a key in the metadata, history included); to remove such a line '
                + 'from its observations, run `memesh forget --name <name> --observation "<that line>"`';
        }
    }
    return undefined;
}
export function addsNewText(value, known) {
    const serialized = value === undefined ? undefined : JSON.stringify(value);
    if (serialized === undefined)
        return false;
    const stack = [JSON.parse(serialized)];
    while (stack.length > 0) {
        const node = stack.pop();
        if (typeof node === 'string') {
            if (!known.has(node))
                return true;
        }
        else if (Array.isArray(node)) {
            for (const item of node)
                stack.push(item);
        }
        else if (node !== null && typeof node === 'object') {
            for (const [key, inner] of Object.entries(node)) {
                if (!known.has(key))
                    return true;
                stack.push(inner);
            }
        }
    }
    return false;
}
export function clearPartsOfKey(metadata) {
    const history = metadata.replaced_history;
    const entries = Array.isArray(history)
        ? { replaced_history: history.map((entry) => ([...textsIn(entry)].some(holdsPartOfKeyDecoded) ? redactVersionText(entry) : entry)) }
        : {};
    const clear = (text) => (holdsPartOfKeyDecoded(text) ? REDACTED : text);
    return mapJson({ ...metadata, ...entries }, clear, clear);
}
//# sourceMappingURL=paths.js.map