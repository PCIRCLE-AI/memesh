import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import net from 'node:net';
import { claudeCodeSessionFromEnv } from '../core/host-session.js';
import { getAgentRouterSocketPath, getMemeshDirFromDbPath, normalizeAgentRouterSocketPath } from '../core/paths.js';
import { requirePrivateWritableDirectory } from '../core/file-mode.js';
import { resolveMcpProject } from '../transports/mcp/project-context.js';
import { ensureRouterTokenFile } from './config.js';
import { connectRouterHost } from './router-client.js';
import { createClaudeActivity, defaultClaudeDir, readClaudeRegistry } from '../core/session-activity.js';
import { projectTranscriptSlug } from '../core/transcript-source.js';
import { messageNotice } from '../host-adapters/message-notice.js';
import { ClaudeTranscriptReader } from './claude-transcript.js';
export function readRegistrySession() {
    const data = readClaudeRegistry(process.ppid);
    if (!data || typeof data.cwd !== 'string' || typeof data.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.sessionId))
        return undefined;
    return { sessionId: data.sessionId, cwd: data.cwd };
}
function sendNativeNotice(socketPath, content, timeoutMs) {
    return new Promise((resolve, reject) => {
        if (!socketPath || process.platform === 'win32') {
            reject(new Error('Claude native inbox is unavailable.'));
            return;
        }
        try {
            const stat = fs.lstatSync(socketPath);
            if (!stat.isSocket() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid()))
                throw new Error('Claude native inbox is unavailable.');
        }
        catch {
            reject(new Error('Claude native inbox is unavailable.'));
            return;
        }
        const socket = net.createConnection(socketPath);
        const timer = setTimeout(() => finish(new Error('Claude native inbox timed out.')), timeoutMs);
        function finish(error) { clearTimeout(timer); socket.destroy(); if (error)
            reject(error);
        else
            resolve(); }
        socket.once('error', () => finish(new Error('Claude native inbox is unavailable.')));
        socket.once('connect', () => socket.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`, () => finish()));
    });
}
function confirmedNotice(record, session, notice) {
    if (!record || typeof record !== 'object')
        return undefined;
    const entry = record;
    if (entry.sessionId !== session)
        return undefined;
    let text;
    if (entry.type === 'queue-operation' && entry.operation === 'enqueue')
        text = entry.content;
    else if (entry.type === 'user' && entry.origin && typeof entry.origin === 'object' && 'kind' in entry.origin && entry.origin.kind === 'peer' && entry.message && typeof entry.message === 'object' && 'role' in entry.message && entry.message.role === 'user' && 'content' in entry.message && typeof entry.message.content === 'string') {
        const prefix = 'Another Claude session sent a message:\n';
        const content = entry.message.content;
        if (!content.startsWith(prefix))
            return undefined;
        const boundary = content.indexOf('\n\nThis came from another Claude session ', prefix.length);
        if (boundary < 0)
            return undefined;
        text = content.slice(prefix.length, boundary);
    }
    else
        return undefined;
    if (typeof text !== 'string')
        return undefined;
    try {
        const actual = JSON.parse(text);
        const keys = Object.keys(notice);
        if (actual && typeof actual === 'object' && !Array.isArray(actual) && Object.keys(actual).length === keys.length && keys.every(key => actual[key] === notice[key]))
            return entry.type === 'user' ? 'user' : 'enqueue';
    }
    catch { }
    return undefined;
}
export function createClaudeInboxDeliver(options) {
    return async (delivery) => {
        const timeoutMs = options.timeoutMs ?? 3000;
        const notice = messageNotice(delivery.envelope, delivery.delivery_id);
        const currentSession = options.currentSession ?? (() => options.sessionId);
        const session = currentSession();
        if (session !== options.sessionId || (delivery.envelope.target_kind === 'session' && delivery.envelope.recipient !== session)) {
            throw new Error('Claude session changed or does not match the delivery target.');
        }
        const reader = typeof options.reader === 'function' ? options.reader() : options.reader;
        const mark = delivery.envelope.target_kind === 'session' && session ? reader.mark(session) : undefined;
        if (delivery.envelope.target_kind === 'session' && (!session || !mark))
            throw new Error('Claude session transcript is unavailable.');
        const until = Date.now() + timeoutMs;
        await sendNativeNotice(options.socketPath, JSON.stringify(notice), timeoutMs);
        if (delivery.envelope.target_kind === 'session') {
            while (Date.now() < until) {
                if (currentSession() !== session)
                    throw new Error('Claude session changed before notice confirmation.');
                const records = reader.readNew(session, mark);
                if (!records)
                    throw new Error('Claude session transcript is unavailable.');
                for (const record of records) {
                    const confirmation = confirmedNotice(record, session, notice);
                    if (confirmation)
                        return { host: 'claude-inbox', status: 'queued', content: 'notice', confirmation };
                }
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            throw new Error('Claude session notice was not confirmed.');
        }
        return { host: 'claude-inbox', status: 'queued', content: 'notice' };
    };
}
export async function startClaudeInboxPresence(rootUris) {
    if (process.platform === 'win32')
        return undefined;
    const session = claudeCodeSessionFromEnv();
    if (!session)
        throw new Error('Claude online registration skipped: no valid CLAUDE_CODE_SESSION_ID.');
    const binding = resolveMcpProject(process.env.MEMESH_PROJECT_ROOT ?? process.env.CLAUDE_PROJECT_DIR, rootUris);
    if ('error' in binding)
        throw new Error(`Claude online registration skipped: ${binding.reason}`);
    const hookUrl = new URL('../../scripts/hooks/_shared.js', import.meta.url).href;
    const hooks = await import(hookUrl);
    const principal = hooks.resolveMessageRecipient({ ...process.env, MEMESH_HOOK_HOST: 'claude-code' });
    if (!principal)
        return undefined;
    const dataDir = getMemeshDirFromDbPath();
    requirePrivateWritableDirectory(dataDir, 'the local router keeps its lifecycle state there');
    const token = ensureRouterTokenFile(path.join(dataDir, 'agent-router.token'));
    let workspace = process.env.MEMESH_PROJECT_ROOT ?? process.env.CLAUDE_PROJECT_DIR;
    if (!workspace && rootUris?.length === 1) {
        try {
            workspace = fileURLToPath(rootUris[0]);
        }
        catch { }
    }
    return connectRouterHost({
        socket_path: normalizeAgentRouterSocketPath(process.env.MEMESH_ROUTER_SOCKET ?? getAgentRouterSocketPath()),
        auth_token: token,
        identity: {
            project: binding.project, principal_id: principal,
            session_instance_id: session, adapter_kind: 'claude-inbox',
        },
        ...(workspace ? { work_summary: createClaudeActivity(process.ppid, workspace) } : {}),
        deliver: createClaudeInboxDeliver({
            socketPath: process.env.CLAUDE_CODE_MESSAGING_TOKEN ? process.env.CLAUDE_CODE_MESSAGING_SOCKET : undefined,
            sessionId: session,
            reader: () => new ClaudeTranscriptReader(path.join(defaultClaudeDir(), 'projects'), projectTranscriptSlug(readRegistrySession()?.cwd ?? workspace ?? '')),
            currentSession: () => readRegistrySession()?.sessionId,
        }),
        resilience: {
            start_router: () => new Promise((resolve, reject) => {
                const child = spawn(process.execPath, [fileURLToPath(new URL('../host-runtime/router.js', import.meta.url))], {
                    detached: true, shell: false, stdio: 'ignore',
                });
                child.once('spawn', () => { child.unref(); resolve(); });
                child.once('error', reject);
            }),
        },
    });
}
//# sourceMappingURL=claude-inbox.js.map