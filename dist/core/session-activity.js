import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ClaudeTranscriptReader } from '../host-runtime/claude-transcript.js';
import { projectTranscriptSlug } from './transcript-source.js';
import { getMemeshDirFromDbPath, homeDir } from './paths.js';
import { decidePrivacy, findCodexRollout } from './private-session.js';
const MAX_BYTES = 1024 * 1024;
const MAX_REGISTRY_BYTES = 64 * 1024;
function readTail(file, forbiddenModeBits = 0, refuseOverBytes = Infinity) {
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
        const stat = fs.fstatSync(fd);
        const named = fs.lstatSync(file);
        if (!stat.isFile() || named.dev !== stat.dev || named.ino !== stat.ino || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (process.platform !== 'win32' && (stat.mode & forbiddenModeBits) !== 0) || stat.size > refuseOverBytes)
            return undefined;
        const start = Math.max(0, stat.size - MAX_BYTES);
        const bytes = Buffer.alloc(stat.size - start);
        const n = fs.readSync(fd, bytes, 0, bytes.length, start);
        const text = bytes.subarray(0, n).toString('utf8');
        return start ? text.slice(text.indexOf('\n') + 1) : text;
    }
    catch {
        return undefined;
    }
    finally {
        if (fd !== undefined)
            fs.closeSync(fd);
    }
}
export function formatSessionActivity(fields) {
    const parts = [fields.repo, fields.status, fields.title, fields.task ? `進行中：${fields.task}` : undefined].filter((v) => Boolean(v));
    const result = Array.from(parts.join(' · '), char => char.charCodeAt(0) < 32 ? ' ' : char).join('').trim();
    if (!result)
        return undefined;
    return result.slice(0, 200).replace(/[\uD800-\uDBFF]$/, '');
}
export function readCodexTitle(codexHome, session) {
    const text = readTail(path.join(codexHome, 'session_index.jsonl'));
    if (!text)
        return undefined;
    for (const line of text.split('\n').reverse()) {
        try {
            const value = JSON.parse(line);
            if (value.id === session && typeof value.thread_name === 'string' && value.thread_name.trim())
                return value.thread_name.trim();
        }
        catch { }
    }
    return undefined;
}
export function readCodexPlanActivity(dataDir, session, workspace) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(session))
        return undefined;
    const text = readTail(path.join(dataDir, 'codex-plan-activity', `${session}.json`), 0o077);
    try {
        const state = JSON.parse(text ?? '');
        if (state.session !== session || typeof state.workspace !== 'string' || fs.realpathSync(state.workspace) !== fs.realpathSync(workspace))
            return undefined;
        return typeof state.task === 'string' && state.task.trim() ? state.task.trim() : undefined;
    }
    catch {
        return undefined;
    }
}
function repoLabel(workspace) {
    try {
        const value = execFileSync('git', ['rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'], { cwd: workspace, encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n');
        return value.length === 2 && value[0] && value[1] ? `${path.basename(value[0])}@${value[1]}` : undefined;
    }
    catch {
        return undefined;
    }
}
const ACTIVITY_CHECK_MS = 250;
function privateSessionCheck(locate, sessionId) {
    let warned = false;
    return () => {
        const memeshDir = getMemeshDirFromDbPath();
        let transcriptPath;
        let located = true;
        try {
            transcriptPath = locate();
        }
        catch {
            located = false;
        }
        const state = located ? decidePrivacy({
            sessionId, transcriptPath, memeshDir,
            deadlineAt: Date.now() + ACTIVITY_CHECK_MS, cacheDir: path.join(memeshDir, 'private-check-cache'),
        }) : { state: 'unchecked', reason: 'unreadable', kind: 'transient', detail: 'the folder that holds the session\'s rollout cannot be read' };
        if (state.state === 'unchecked' && !warned) {
            warned = true;
            try {
                process.stderr.write(`[memesh] could not check whether this session is private, so its name and task are hidden: ${state.reason}\n`);
            }
            catch { }
        }
        return state.state !== 'no';
    };
}
function liveRollout(codexHome, session) {
    const found = findCodexRollout(codexHome, session);
    if (found === undefined || found.zst)
        return undefined;
    return path.relative(path.join(codexHome, 'archived_sessions'), found.file).startsWith('..') ? found.file : undefined;
}
export const defaultClaudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(homeDir(), '.claude');
const startByPid = new Map();
const unreadableLogged = new Set();
const unreadableUntil = new Map();
const UNREADABLE_RETRY_MS = 30_000;
function processStart(pid) {
    const known = startByPid.get(pid);
    if (known !== undefined)
        return known;
    const retryAt = unreadableUntil.get(pid);
    if (retryAt !== undefined && Date.now() < retryAt)
        return undefined;
    try {
        const text = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
            encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
        }).trim();
        if (!text)
            return null;
        if (startByPid.size >= 64)
            startByPid.clear();
        startByPid.set(pid, text);
        return text;
    }
    catch (error) {
        if (error.status === 1)
            return null;
        if (unreadableUntil.size >= 64)
            unreadableUntil.clear();
        unreadableUntil.set(pid, Date.now() + UNREADABLE_RETRY_MS);
        if (!unreadableLogged.has(pid)) {
            unreadableLogged.add(pid);
            try {
                process.stderr.write(`[memesh] could not read the start time of process ${pid} (${error.message.split('\n')[0]}); its Claude session registry file is used without that check\n`);
            }
            catch { }
        }
        return undefined;
    }
}
export function startsMatch(actual, recorded) {
    const squash = (text) => text.replace(/\s+/g, ' ').trim();
    return squash(actual) === squash(recorded);
}
export function readClaudeRegistry(pid, claudeDir = defaultClaudeDir()) {
    try {
        const value = JSON.parse(readTail(path.join(claudeDir, 'sessions', `${pid}.json`), 0o022, MAX_REGISTRY_BYTES) ?? '');
        if (!value || typeof value !== 'object' || Array.isArray(value) || value.pid !== pid)
            return undefined;
        const { procStart } = value;
        if (typeof procStart === 'string' && process.platform !== 'win32') {
            const actual = processStart(pid);
            if (actual !== undefined && (actual === null || !startsMatch(actual, procStart)))
                return undefined;
        }
        return value;
    }
    catch { }
    return undefined;
}
export function createClaudeActivity(pid, workspace, claudeDir = defaultClaudeDir()) {
    let slug;
    let reader;
    let privateSession;
    let privateFor = '';
    return () => {
        const registry = readClaudeRegistry(pid, claudeDir);
        const status = registry?.status === 'busy' || registry?.status === 'idle' ? registry.status : undefined;
        const title = typeof registry?.name === 'string' ? registry.name : undefined;
        if (registry && typeof registry.cwd === 'string') {
            const currentSlug = projectTranscriptSlug(registry.cwd);
            if (currentSlug !== slug) {
                slug = currentSlug;
                reader = new ClaudeTranscriptReader(path.join(claudeDir, 'projects'), slug);
            }
        }
        const sessionId = typeof registry?.sessionId === 'string' ? registry.sessionId : undefined;
        if (sessionId && reader && privateFor !== `${slug}:${sessionId}`) {
            const r = reader;
            privateFor = `${slug}:${sessionId}`;
            privateSession = privateSessionCheck(() => r.transcriptFile(sessionId), sessionId);
        }
        const isPrivate = sessionId !== undefined && privateSession?.() === true;
        const task = sessionId && !isPrivate ? reader?.currentTask(sessionId) : undefined;
        return formatSessionActivity({ repo: repoLabel(typeof registry?.cwd === 'string' ? registry.cwd : workspace), status, title: isPrivate ? undefined : title, task });
    };
}
export function createCodexActivity(session, workspace, dataDir, codexHome = process.env.CODEX_HOME || path.join(homeDir(), '.codex')) {
    let rollout;
    const privateSession = privateSessionCheck(() => (rollout ??= liveRollout(codexHome, session)), session);
    return () => privateSession()
        ? formatSessionActivity({ repo: repoLabel(workspace) })
        : formatSessionActivity({ repo: repoLabel(workspace), title: readCodexTitle(codexHome, session), task: readCodexPlanActivity(dataDir, session, workspace) });
}
//# sourceMappingURL=session-activity.js.map