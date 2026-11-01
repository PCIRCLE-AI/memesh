import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ClaudeTranscriptReader } from '../host-runtime/claude-transcript.js';
import { projectTranscriptSlug } from './transcript-source.js';
import { homeDir } from './paths.js';
const MAX_BYTES = 1024 * 1024;
function readTail(file, forbiddenModeBits = 0) {
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
        const stat = fs.fstatSync(fd);
        const named = fs.lstatSync(file);
        if (!stat.isFile() || !named.isFile() || named.dev !== stat.dev || named.ino !== stat.ino || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (process.platform !== 'win32' && (stat.mode & forbiddenModeBits) !== 0))
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
export function createClaudeActivity(pid, workspace, claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(homeDir(), '.claude')) {
    let slug;
    let reader;
    return () => {
        let registry;
        try {
            const value = JSON.parse(readTail(path.join(claudeDir, 'sessions', `${pid}.json`), 0o022) ?? '');
            if (value && typeof value === 'object' && !Array.isArray(value))
                registry = value;
        }
        catch {
            registry = undefined;
        }
        if (registry) {
            try {
                if (registry.pid !== pid || typeof registry.cwd !== 'string' || fs.realpathSync(registry.cwd) !== fs.realpathSync(workspace))
                    registry = undefined;
            }
            catch {
                registry = undefined;
            }
        }
        const status = registry?.status === 'busy' || registry?.status === 'idle' ? registry.status : undefined;
        const title = typeof registry?.name === 'string' ? registry.name : undefined;
        if (registry && typeof registry.cwd === 'string') {
            const currentSlug = projectTranscriptSlug(registry.cwd);
            if (currentSlug !== slug) {
                slug = currentSlug;
                reader = new ClaudeTranscriptReader(path.join(claudeDir, 'projects'), slug);
            }
        }
        const task = typeof registry?.sessionId === 'string' ? reader?.currentTask(registry.sessionId) : undefined;
        return formatSessionActivity({ repo: repoLabel(workspace), status, title, task });
    };
}
export function createCodexActivity(session, workspace, dataDir, codexHome = process.env.CODEX_HOME || path.join(homeDir(), '.codex')) {
    return () => formatSessionActivity({ repo: repoLabel(workspace), title: readCodexTitle(codexHome, session), task: readCodexPlanActivity(dataDir, session, workspace) });
}
//# sourceMappingURL=session-activity.js.map