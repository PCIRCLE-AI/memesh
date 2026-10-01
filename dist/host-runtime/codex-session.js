#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalAgentScopeId } from '../core/agent-scope-id.js';
import { automaticCodexSessionPrincipal, isValidCodexThreadId, resolveCodexSessionPrincipal, } from '../core/codex-session-principal.js';
import { getAgentRouterSocketPath, getMemeshDirFromDbPath, getProjectName } from '../core/paths.js';
import { requirePrivateWritableDirectory } from '../core/file-mode.js';
import { assertSecureLocalHostRuntimeSupported, ensureRouterTokenFile, readHostConfigFile, readTokenFile, normalizeConfiguredRouterSocket, requiredString, } from './config.js';
import { AgentRouterProtocolError } from '../core/agent-router.js';
import { connectRouterHost, routerOutdatedDetail } from './router-client.js';
const MAX_HOOK_INPUT_BYTES = 64 * 1024;
const CONTROL_TIMEOUT_MS = 2_000;
const SESSION_END_GRACE_MS = 45_000;
function lifecycleDirectory(dataDir) {
    const directory = path.join(dataDir, 'runtime', 'codex-session');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Codex companion lifecycle directory must be a real private directory.');
    requirePrivateWritableDirectory(directory, 'the Codex session companion keeps its lifecycle state there');
    return directory;
}
export function codexCompanionStatePath(dataDir, threadId) {
    return path.join(lifecycleDirectory(dataDir), `${threadId}.json`);
}
export function codexCompanionControlSocketPath(dataDir, threadId) {
    const digest = createHash('sha256').update(`v2:${threadId}`).digest('hex').slice(0, 8);
    return path.join(dataDir, `c-${digest}.sock`);
}
function readCompanionState(statePath) {
    let fd;
    try {
        fd = fs.openSync(statePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o077) !== 0)
            return null;
        const parsed = JSON.parse(fs.readFileSync(fd, 'utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
            return null;
        const state = parsed;
        if (state.version !== 1 || typeof state.pid !== 'number' || !Number.isSafeInteger(state.pid) || state.pid <= 1
            || !isValidCodexThreadId(state.thread_id)
            || typeof state.workspace !== 'string' || !path.isAbsolute(state.workspace)
            || typeof state.token !== 'string' || !/^[0-9a-f]{32}$/.test(state.token)
            || typeof state.control_socket !== 'string' || !path.isAbsolute(state.control_socket)
            || (state.control_socket_ino !== undefined
                && (typeof state.control_socket_ino !== 'string' || !/^[0-9]+$/.test(state.control_socket_ino))))
            return null;
        return state;
    }
    catch (error) {
        if (['ENOENT', 'ELOOP'].includes(error.code ?? ''))
            return null;
        if (error instanceof SyntaxError)
            return null;
        throw error;
    }
    finally {
        if (fd !== undefined)
            fs.closeSync(fd);
    }
}
function writeCompanionState(statePath, state) {
    const temporary = `${statePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
        fs.writeFileSync(descriptor, `${JSON.stringify(state)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, statePath);
    fs.chmodSync(statePath, 0o600);
}
function writePrivateJson(file, value) {
    const descriptor = fs.openSync(file, 'wx', 0o600);
    try {
        fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
}
class CompanionRefusal extends Error {
}
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
function recordCompanionLog(dataDir, line) {
    const text = `[${new Date().toISOString()}] ${line}\n`;
    try {
        fs.appendFileSync(path.join(dataDir, 'codex-companion.log'), text, { mode: 0o600 });
    }
    catch (error) {
        fs.writeSync(2, `memesh-host-codex-session: ${text.trimEnd()} (log unwritable: ${errorText(error)})\n`);
    }
}
function companionFailureDetail(error) {
    return routerOutdatedDetail(error) || (error instanceof CompanionRefusal ? ` ${error.message}` : '');
}
function companionFailurePath(launchFile) {
    return `${launchFile}.failed`;
}
function removeUnclaimedFailures(directory) {
    const cutoff = Date.now() - 60_000;
    for (const name of fs.readdirSync(directory)) {
        if (!/\.failed(\.[0-9a-f]{12}\.tmp)?$/.test(name))
            continue;
        const file = path.join(directory, name);
        try {
            if (fs.lstatSync(file).mtimeMs < cutoff)
                fs.unlinkSync(file);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
}
function publishCompanionFailure(file, value) {
    const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    writePrivateJson(temporary, value);
    fs.renameSync(temporary, file);
}
function takeCompanionFailure(file) {
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
    fs.unlinkSync(file);
    const parsed = JSON.parse(raw);
    if (typeof parsed.message !== 'string')
        return null;
    if (parsed.code === 'router_outdated')
        return new AgentRouterProtocolError('router_outdated', parsed.message.slice(0, 1000));
    if (parsed.code === 'companion_busy')
        return new CompanionRefusal(parsed.message.slice(0, 1000));
    return null;
}
async function launchDetachedCompanion(dataDir, session, input) {
    const directory = lifecycleDirectory(dataDir);
    removeUnclaimedFailures(directory);
    const launchFile = path.join(directory, `launch-${process.pid}-${randomBytes(8).toString('hex')}.json`);
    writePrivateJson(launchFile, input);
    let child = null;
    try {
        child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--companion', launchFile], {
            detached: true,
            stdio: 'ignore',
            env: process.env,
        });
        if (!Number.isSafeInteger(child.pid))
            throw new Error('Detached Codex companion did not receive a process identity.');
        child.unref();
        const statePath = codexCompanionStatePath(dataDir, session.threadId);
        const deadline = Date.now() + CONTROL_TIMEOUT_MS;
        const failurePath = companionFailurePath(launchFile);
        for (;;) {
            const state = readCompanionState(statePath);
            if (state !== null && state.pid === child.pid && state.registered === true)
                return;
            const failure = takeCompanionFailure(failurePath);
            if (failure)
                throw failure;
            if (Date.now() >= deadline)
                break;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error('Detached Codex companion did not publish its lifecycle state before the hook timeout.');
    }
    catch (error) {
        if (child && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
            const stopped = Date.now() + CONTROL_TIMEOUT_MS;
            while (child.exitCode === null && child.signalCode === null && Date.now() < stopped) {
                await new Promise(resolve => setTimeout(resolve, 25));
            }
        }
        let outcome;
        try {
            outcome = takeCompanionFailure(companionFailurePath(launchFile)) ?? error;
        }
        catch (takeError) {
            outcome = takeError;
        }
        for (const file of [launchFile, companionFailurePath(launchFile)]) {
            try {
                fs.unlinkSync(file);
            }
            catch (unlinkError) {
                if (unlinkError.code !== 'ENOENT')
                    throw unlinkError;
            }
        }
        throw outcome;
    }
}
function readDetachedLaunchInput(dataDir, launchFile) {
    const directory = lifecycleDirectory(dataDir);
    const resolved = fs.realpathSync(launchFile);
    if (path.dirname(resolved) !== fs.realpathSync(directory)) {
        throw new Error('Codex companion launch input resolved outside its private lifecycle directory.');
    }
    const fd = fs.openSync(launchFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o077) !== 0
            || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
            throw new Error('Codex companion launch input must be an owner-private regular file.');
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(fd, 'utf8'));
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                throw new Error('Codex companion launch input must be an object.');
            }
            return parsed;
        }
        finally {
            fs.unlinkSync(launchFile);
        }
    }
    finally {
        fs.closeSync(fd);
    }
}
function removeOwnState(statePath, token) {
    const state = readCompanionState(statePath);
    if (state?.token === token)
        fs.unlinkSync(statePath);
}
function pidIsGone(pid) {
    try {
        process.kill(pid, 0);
        return false;
    }
    catch (error) {
        return error.code === 'ESRCH';
    }
}
function socketInode(socketPath) {
    return String(fs.lstatSync(socketPath, { bigint: true }).ino);
}
function socketIsSame(socketPath, ino) {
    if (ino === undefined)
        return false;
    try {
        const stat = fs.lstatSync(socketPath, { bigint: true });
        return stat.isSocket() && String(stat.ino) === ino;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
}
function removeStaleState(dataDir, statePath, state) {
    if (!pidIsGone(state.pid))
        return;
    const taken = `${statePath}.${randomBytes(6).toString('hex')}.stale`;
    try {
        fs.renameSync(statePath, taken);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw error;
    }
    if (readCompanionState(taken)?.token !== state.token) {
        try {
            fs.linkSync(taken, statePath);
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
        }
        fs.unlinkSync(taken);
        return;
    }
    fs.unlinkSync(taken);
    const cleared = `cleared the record of companion ${state.pid}, which had exited;`;
    if (socketIsSame(state.control_socket, state.control_socket_ino)) {
        fs.unlinkSync(state.control_socket);
        recordCompanionLog(dataDir, `${cleared} removed its socket ${state.control_socket}`);
    }
    else if (state.control_socket_ino === undefined) {
        recordCompanionLog(dataDir, `${cleared} left ${state.control_socket} in place: the record is from before #518 and names no socket inode`);
    }
    else {
        recordCompanionLog(dataDir, `${cleared} ${state.control_socket} is no longer the socket it bound, left in place`);
    }
}
export async function requestExactCompanionControl(state, action) {
    return new Promise((resolve) => {
        const socket = net.createConnection(state.control_socket);
        let response = '';
        let settled = false;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(CONTROL_TIMEOUT_MS, () => finish(false));
        socket.once('error', () => finish(false));
        socket.on('data', (chunk) => { response += chunk.toString(); });
        socket.once('close', () => finish(response.trim() === 'terminated'));
        socket.once('connect', () => socket.end(`${JSON.stringify({ action, token: state.token })}\n`));
    });
}
async function terminatePriorExactCompanion(dataDir, session) {
    const statePath = codexCompanionStatePath(dataDir, session.threadId);
    const state = readCompanionState(statePath);
    if (!state) {
        if (fs.existsSync(statePath))
            throw new Error('Codex companion lifecycle state is malformed; refusing to replace it.');
        return;
    }
    if (state.thread_id !== session.threadId || state.workspace !== session.workspace) {
        throw new Error('Codex companion lifecycle state belongs to another exact session; refusing cross-thread termination.');
    }
    if (state.control_socket_ino !== undefined && state.registered !== true && !pidIsGone(state.pid)) {
        throw new CompanionRefusal(`companion_busy: process ${state.pid} is still starting this Codex session's companion. `
            + 'Start the session again once it has finished.');
    }
    if (!await requestExactCompanionControl(state, 'terminate')) {
        removeStaleState(dataDir, statePath, state);
        if (fs.existsSync(statePath)) {
            const current = readCompanionState(statePath);
            if (current?.token !== state.token) {
                throw new CompanionRefusal(`companion_busy: another MeMesh companion for this Codex session replaced ${statePath} while this start was checking it. `
                    + `Start the session again${current ? `; if this keeps happening, check that \`ps -p ${current.pid}\` is a MeMesh companion` : ''}.`);
            }
            throw new CompanionRefusal(`companion_busy: process ${state.pid}, which ${statePath} names as this Codex session's companion, `
                + `is still running but does not answer on ${state.control_socket}. If \`ps -p ${state.pid}\` shows a MeMesh companion, `
                + `stop it with \`kill ${state.pid}\`${state.control_socket_ino === undefined ? `; otherwise delete ${statePath}` : ''}. Then start the session again.`);
        }
        return;
    }
    const deadline = Date.now() + CONTROL_TIMEOUT_MS;
    while (fs.existsSync(statePath) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (fs.existsSync(statePath))
        throw new Error('Prior exact Codex companion acknowledged termination but did not remove its lifecycle state.');
}
export async function supersedeCodexSessionCompanion(dataDir, hookInput, environment, realpath = fs.realpathSync) {
    const session = validateCodexSessionStart(hookInput, environment, realpath);
    if (!session)
        return false;
    await terminatePriorExactCompanion(dataDir, session);
    return true;
}
function createCompanionControlServer(socketPath, token, control) {
    return new Promise((resolve, reject) => {
        const server = net.createServer((socket) => {
            let input = '';
            socket.on('error', () => { });
            socket.setEncoding('utf8');
            socket.on('data', (chunk) => { input += chunk; });
            socket.once('end', () => {
                try {
                    const message = JSON.parse(input.trim());
                    const record = message;
                    if ((record.action !== 'terminate' && record.action !== 'retire') || record.token !== token) {
                        socket.end('rejected\n');
                        return;
                    }
                    socket.end('terminated\n');
                    queueMicrotask(() => control(record.action));
                }
                catch {
                    socket.end('rejected\n');
                }
            });
        });
        server.once('error', (error) => reject(error.code === 'EADDRINUSE' || error.code === 'EEXIST'
            ? new CompanionRefusal(`companion_busy: ${socketPath} is still in place, and no record shows which companion `
                + 'for this Codex session made it or whether it still uses it, so MeMesh leaves it alone and does not start a second one.')
            : error));
        server.listen(socketPath, () => resolve(server));
    });
}
export async function startCodexSessionCompanion(config, hookInput, environment, dependencies = {}) {
    const realpath = dependencies.realpath ?? fs.realpathSync;
    const session = validateCodexSessionStart(hookInput, environment, realpath);
    if (!session)
        return null;
    return connectCodexSessionCompanion(config, session, realpath, dependencies.connect ?? connectRouterHost);
}
function connectCodexSessionCompanion(config, session, realpath, connect) {
    const selected = config === undefined
        ? automaticCodexSessionConfig(session)
        : configuredCodexSessionConfig(config, session, realpath);
    return connect({
        socket_path: selected.router_socket,
        auth_token: selected.auth_token,
        identity: {
            project: selected.project,
            principal_id: selected.principal_id,
            session_instance_id: session.threadId,
            adapter_kind: 'codex-cli-queue',
            ...(selected.work_summary === undefined ? {} : { work_summary: selected.work_summary }),
        },
        async deliver() {
            throw new Error('Codex CLI queue delivery is owned by the router adapter.');
        },
    });
}
function validateCodexSessionStart(hookInput, environment, realpath) {
    if (hookInput.hook_event_name !== 'SessionStart')
        return null;
    if (hookInput.source !== 'startup' && hookInput.source !== 'resume')
        return null;
    if (typeof environment.PLUGIN_ROOT !== 'string' || environment.PLUGIN_ROOT.length === 0)
        return null;
    const threadId = hookInput.session_id;
    if (!isValidCodexThreadId(threadId))
        return null;
    return {
        threadId,
        workspace: requiredExistingDirectory(hookInput.cwd, 'cwd', realpath),
    };
}
function validateCodexSessionEnd(hookInput, environment, realpath) {
    if (hookInput.hook_event_name !== 'SessionEnd')
        return null;
    if (typeof environment.PLUGIN_ROOT !== 'string' || environment.PLUGIN_ROOT.length === 0)
        return null;
    const threadId = hookInput.session_id;
    if (!isValidCodexThreadId(threadId))
        return null;
    return { threadId, workspace: requiredExistingDirectory(hookInput.cwd, 'cwd', realpath) };
}
function configuredCodexSessionConfig(config, session, realpath) {
    const principal = resolveCodexSessionPrincipal(config, session, realpath);
    if (principal.source === 'automatic') {
        return automaticCodexSessionConfig(session);
    }
    const resolved = {
        router_socket: normalizeConfiguredRouterSocket(config.router_socket),
        auth_token: readTokenFile(config.token_file),
        project: canonicalAgentScopeId(getProjectName(session.workspace)),
        principal_id: requiredString(principal.principalId, 'principal_id'),
        ...(config.work_summary == null ? {} : { work_summary: requiredString(config.work_summary, 'work_summary') }),
    };
    return resolved;
}
function automaticCodexSessionConfig(session) {
    assertSecureLocalHostRuntimeSupported();
    const dataDir = getMemeshDirFromDbPath();
    ensureOwnerPrivateDataDirectory(dataDir);
    return {
        router_socket: getAgentRouterSocketPath(),
        auth_token: ensureRouterTokenFile(path.join(dataDir, 'agent-router.token')),
        project: canonicalAgentScopeId(getProjectName(session.workspace)),
        principal_id: automaticCodexSessionPrincipal(session),
    };
}
function ensureOwnerPrivateDataDirectory(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(dataDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('The MeMesh data directory must be a real owner-private directory.');
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new Error('The MeMesh data directory must be owned by the current user.');
    }
    requirePrivateWritableDirectory(dataDir, 'the Codex session companion keeps its state and control socket there');
    if ((fs.lstatSync(dataDir).mode & 0o077) !== 0) {
        throw new Error('The MeMesh data directory must be owner-private.');
    }
}
function requiredAbsolutePath(value, field) {
    const result = requiredString(value, field);
    if (!path.isAbsolute(result))
        throw new Error(`${field} must be an absolute path.`);
    return result;
}
function requiredExistingDirectory(value, field, realpath) {
    const resolved = realpath(requiredAbsolutePath(value, field));
    if (!fs.statSync(resolved).isDirectory())
        throw new Error(`${field} must be a directory.`);
    return resolved;
}
async function readHookInput() {
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
        input += chunk;
        if (Buffer.byteLength(input, 'utf8') > MAX_HOOK_INPUT_BYTES) {
            throw new Error('Codex SessionStart hook input exceeds the byte limit.');
        }
    }
    const value = JSON.parse(input);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Codex SessionStart hook input must be an object.');
    }
    return value;
}
async function endExactCodexSessionCompanion(dataDir, session) {
    const statePath = codexCompanionStatePath(dataDir, session.threadId);
    const state = readCompanionState(statePath);
    if (!state) {
        if (fs.existsSync(statePath))
            throw new Error('Codex companion lifecycle state is malformed; refusing SessionEnd cleanup.');
        return;
    }
    if (state.thread_id !== session.threadId || state.workspace !== session.workspace) {
        throw new Error('Codex SessionEnd does not match the stored companion identity; refusing cross-thread termination.');
    }
    if (await requestExactCompanionControl(state, 'retire'))
        return;
    removeStaleState(dataDir, statePath, state);
    if (fs.existsSync(statePath)) {
        throw new Error('Codex SessionEnd could not prove the stored companion identity; refusing PID-based termination.');
    }
}
export async function endCodexSessionCompanion(dataDir, hookInput, environment, realpath = fs.realpathSync) {
    const session = validateCodexSessionEnd(hookInput, environment, realpath);
    if (!session)
        return false;
    await endExactCodexSessionCompanion(dataDir, session);
    return true;
}
async function runDetachedCompanion(dataDir, input, failurePath) {
    const session = validateCodexSessionStart(input, { PLUGIN_ROOT: process.env.PLUGIN_ROOT }, fs.realpathSync);
    if (!session)
        return;
    ensureOwnerPrivateDataDirectory(dataDir);
    const statePath = codexCompanionStatePath(dataDir, session.threadId);
    const token = randomBytes(16).toString('hex');
    const socketPath = codexCompanionControlSocketPath(dataDir, session.threadId);
    let socketIno;
    let retirement = null;
    let connection = null;
    let control = null;
    let cleanup = null;
    const shutdown = () => cleanup ??= (async () => {
        if (retirement)
            clearTimeout(retirement);
        const problems = [];
        try {
            await connection?.close();
        }
        catch (error) {
            problems.push(`closing its router connection: ${errorText(error)}`);
        }
        let ownsPath = false;
        try {
            ownsPath = socketIsSame(socketPath, socketIno);
        }
        catch (error) {
            problems.push(`checking ${socketPath}, left in place: ${errorText(error)}`);
        }
        if (ownsPath)
            await new Promise((resolve) => control?.close(() => resolve()) ?? resolve());
        removeOwnState(statePath, token);
        if (problems.length > 0)
            recordCompanionLog(dataDir, `companion ${process.pid} stopped with problems: ${problems.join('; ')}`);
        return problems.length > 0;
    })();
    const exitAfterShutdown = () => {
        void shutdown().then((failed) => {
            if (failed)
                process.exitCode = 1;
            process.exit();
        }, (error) => {
            recordCompanionLog(dataDir, `companion ${process.pid} could not finish stopping: ${errorText(error)}`);
            process.exit(1);
        });
    };
    const controlLifecycle = (action) => {
        if (action === 'terminate') {
            exitAfterShutdown();
            return;
        }
        if (retirement || cleanup)
            return;
        retirement = setTimeout(exitAfterShutdown, SESSION_END_GRACE_MS);
    };
    process.once('SIGINT', exitAfterShutdown);
    process.once('SIGTERM', exitAfterShutdown);
    try {
        await terminatePriorExactCompanion(dataDir, session);
        control = await createCompanionControlServer(socketPath, token, controlLifecycle);
        socketIno = socketInode(socketPath);
        const record = {
            version: 1,
            pid: process.pid,
            thread_id: session.threadId,
            workspace: session.workspace,
            token,
            control_socket: socketPath,
            control_socket_ino: socketIno,
        };
        writeCompanionState(statePath, record);
        connection = await connectCodexSessionCompanion(readCodexSessionConfigIfPresent(path.join(dataDir, 'hosts', 'codex-session.json')), session, fs.realpathSync, connectRouterHost);
        writeCompanionState(statePath, { ...record, registered: true });
    }
    catch (error) {
        process.exitCode = 1;
        try {
            const detail = companionFailureDetail(error);
            if (detail) {
                publishCompanionFailure(failurePath, {
                    code: error instanceof CompanionRefusal ? 'companion_busy' : 'router_outdated',
                    message: error.message,
                });
            }
        }
        finally {
            await shutdown();
        }
        throw error;
    }
}
let failureLead = 'session registration failed.';
async function main() {
    const dataDir = getMemeshDirFromDbPath();
    if (process.argv[2] === '--companion') {
        const launchFile = process.argv[3];
        if (typeof launchFile !== 'string')
            throw new Error('Codex companion launch input is required.');
        await runDetachedCompanion(dataDir, readDetachedLaunchInput(dataDir, launchFile), companionFailurePath(launchFile));
        return;
    }
    const input = await readHookInput();
    const ending = validateCodexSessionEnd(input, { PLUGIN_ROOT: process.env.PLUGIN_ROOT }, fs.realpathSync);
    if (ending) {
        failureLead = 'session end failed.';
        ensureOwnerPrivateDataDirectory(dataDir);
        await endExactCodexSessionCompanion(dataDir, ending);
        return;
    }
    const session = validateCodexSessionStart(input, { PLUGIN_ROOT: process.env.PLUGIN_ROOT }, fs.realpathSync);
    if (!session)
        return;
    ensureOwnerPrivateDataDirectory(dataDir);
    await launchDetachedCompanion(dataDir, session, input);
}
function readCodexSessionConfigIfPresent(configPath) {
    try {
        fs.lstatSync(configPath);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
    return readHostConfigFile(configPath);
}
function isMainModule() {
    const entrypoint = process.argv[1];
    if (!entrypoint)
        return false;
    try {
        return fs.realpathSync(entrypoint) === fs.realpathSync(fileURLToPath(import.meta.url));
    }
    catch {
        return false;
    }
}
if (isMainModule()) {
    try {
        await main();
    }
    catch (error) {
        fs.writeSync(2, `memesh-host-codex-session: ${failureLead}${companionFailureDetail(error)}\n`);
        process.exit(1);
    }
}
//# sourceMappingURL=codex-session.js.map