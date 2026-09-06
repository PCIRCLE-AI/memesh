// ============================================================================
// AUTO-GENERATED from src/core/paths.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
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
        if (locator)
            return projectIdentity(path.posix.basename(locator), locator);
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
export function canonicalRemoteLocator(remote) {
    const value = remote.trim();
    if (!value)
        return null;
    if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value))
        return null;
    let host;
    let port = '';
    let user = '';
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
    const normalizedPath = remotePath
        .replace(/^\/+|\/+$/g, '')
        .replace(/\.git$/i, '');
    if (!host || !normalizedPath)
        return null;
    const endpoint = `${host}${port ? `:${port}` : ''}`;
    const standardGithub = host === 'github.com'
        && port === ''
        && (transport === 'https' || ((transport === 'ssh-relative' || transport === 'ssh-absolute') && user === 'git'));
    if (standardGithub)
        return `${endpoint}/${normalizedPath}`;
    const authority = transport.startsWith('ssh-') && user ? `${user}@${endpoint}` : endpoint;
    return `${transport}://${authority}/${normalizedPath}`;
}
export function _clearProjectNameCache() {
    projectNameCache.clear();
}
export const SECRET_PATTERN_SOURCES = [
    '-----BEGIN[A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END[A-Z ]*PRIVATE KEY-----',
    '-----BEGIN[A-Z ]*PRIVATE KEY-----[\\s\\S]*?(?=\\n[ \\t]*\\n|$)',
    '(?:postgres|postgresql|mysql|mariadb|mongodb(?:\\+srv)?|redis|rediss|amqp|amqps)://[^\\s:@/]+:[^\\s:@/]+@',
    'eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}',
    'SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}',
    '[srp]k_(?:live|test)_[A-Za-z0-9]{16,}',
    'npm_[A-Za-z0-9]{36}',
    '\\bsk[-_][^\\s"\\\\]{4,}[A-Za-z0-9]',
    '(?<![A-Za-z0-9])(?:api[-_]?key|access[-_]?token|auth[-_]?token|refresh[-_]?token|session[-_]?token|token|secret|password|passwd|pwd|signature)=[^&\\s"\'<>]{8,}',
    'ghp_[A-Za-z0-9]{30,}',
    'gho_[A-Za-z0-9]{30,}',
    'gh[sur]_[A-Za-z0-9]{30,}',
    'github_pat_[A-Za-z0-9_]{20,}',
    'A(?:KIA|SIA)[A-Z0-9]{16}',
    'AIza[A-Za-z0-9_-]{30,}',
    'xox[baprs]-[A-Za-z0-9-]{10,}',
    'Bearer(?:\\s|\\\\[nrt])+[A-Za-z0-9_.\\-]{16,}',
];
const SECRET_PATTERNS = SECRET_PATTERN_SOURCES.map((s) => new RegExp(s, 'gi'));
export function redactSecrets(input) {
    let out = input;
    for (const pattern of SECRET_PATTERNS)
        out = out.replace(pattern, '***REDACTED***');
    return out;
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
