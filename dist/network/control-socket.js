import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { NetworkError, networkDir } from './types.js';
import { parseMembershipAction } from './membership.js';
const SOCKET_PATH_MAX_BYTES = 103;
const PROBE_DEADLINE_MS = 4_000;
const REQUEST_DEADLINE_MS = 2_000;
const REQUEST_MAX_BYTES = 512;
const REPLY_MAX_BYTES = 8 * 1024;
const STARTUP_LOCK_WAIT_MS = 5_000;
const STARTUP_LOCK_EMPTY_STALE_MS = 1_500;
export function controlPath(dataDir) {
    if (process.platform === 'win32') {
        return `\\\\.\\pipe\\memesh-bridge-${createHash('sha256').update(dataDir).digest('hex').slice(0, 32)}`;
    }
    return path.join(networkDir(dataDir), 'bridge.sock');
}
export function controlPathFits(dataDir) {
    return Buffer.byteLength(controlPath(dataDir)) <= SOCKET_PATH_MAX_BYTES;
}
export function assertControlPathFits(dataDir) {
    if (controlPathFits(dataDir))
        return;
    throw new NetworkError('invalid_option', `The MeMesh data folder's path is too long for this computer's local sockets (${dataDir}). Use a shorter one with MEMESH_DIR or MEMESH_DB_PATH.`);
}
function dataDirIdentity(dataDir) {
    try {
        return fs.realpathSync.native(dataDir);
    }
    catch {
        return dataDir;
    }
}
function tokenPath(dataDir) {
    return path.join(networkDir(dataDir), 'control.token');
}
const TOKEN_FORMAT = /^[0-9a-f]{64}$/;
function ensureControlToken(dataDir) {
    const file = tokenPath(dataDir);
    const existing = readControlToken(dataDir);
    if (existing !== null)
        return existing;
    const temporary = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, randomBytes(32).toString('hex'), { mode: 0o600 });
    try {
        fs.chmodSync(temporary, 0o600);
        if (fs.existsSync(file) && readControlToken(dataDir) === null)
            fs.rmSync(file, { force: true });
        fs.linkSync(temporary, file);
    }
    catch (err) {
        if (err.code !== 'EEXIST')
            throw err;
    }
    finally {
        fs.rmSync(temporary, { force: true });
    }
    return readControlToken(dataDir);
}
function readControlToken(dataDir) {
    try {
        const token = fs.readFileSync(tokenPath(dataDir), 'utf8');
        return TOKEN_FORMAT.test(token) ? token : null;
    }
    catch {
        return null;
    }
}
function tokensMatch(given, expected) {
    if (typeof given !== 'string')
        return false;
    const left = createHash('sha256').update(given).digest();
    return timingSafeEqual(left, createHash('sha256').update(expected).digest());
}
function parseReply(line, dataDir) {
    try {
        const reply = JSON.parse(line);
        const valid = Number.isSafeInteger(reply?.pid) && reply?.pid > 0 && typeof reply?.ready === 'boolean';
        return valid && reply?.data_dir === dataDirIdentity(dataDir) ? reply : null;
    }
    catch {
        return null;
    }
}
function request(dataDir, op, deadlineMs, expectedPid) {
    return new Promise((resolve) => {
        const socket = net.createConnection(controlPath(dataDir));
        let text = '';
        const finish = (result) => {
            clearTimeout(timer);
            socket.destroy();
            resolve(result);
        };
        const timer = setTimeout(() => finish(null), deadlineMs);
        socket.once('connect', () => socket.write(`${JSON.stringify({ op: typeof op === 'string' ? op : 'membership', ...(typeof op === 'string' ? {} : { action: op }), ...(expectedPid === undefined ? {} : { expected_pid: expectedPid }), token: readControlToken(dataDir) })}\n`));
        socket.on('data', (chunk) => {
            text += chunk.toString('utf8');
            if (text.length > (typeof op === 'string' ? REPLY_MAX_BYTES : 32 * 1024)) {
                finish(null);
                return;
            }
            const newline = text.indexOf('\n');
            if (newline === -1)
                return;
            finish(parseReply(text.slice(0, newline), dataDir));
        });
        socket.once('error', (err) => {
            finish(['ECONNREFUSED', 'ENOENT', 'ENOTDIR'].includes(String(err.code)) ? 'not-running' : null);
        });
        socket.once('close', () => finish(null));
    });
}
export async function probeBridge(dataDir, deadlineMs = PROBE_DEADLINE_MS) {
    if (!controlPathFits(dataDir))
        return { kind: 'not-running' };
    const reply = await request(dataDir, 'hello', deadlineMs);
    if (reply === 'not-running')
        return { kind: 'not-running' };
    return reply === null ? { kind: 'unresponsive' } : { kind: 'running', pid: reply.pid, ready: reply.ready };
}
export async function askBridgeToStop(dataDir, expectedPid) {
    const reply = await request(dataDir, 'stop', PROBE_DEADLINE_MS, expectedPid);
    return reply !== null && reply !== 'not-running';
}
export async function askBridgeMembership(dataDir, action, expectedPid) {
    parseMembershipAction(action);
    const reply = await request(dataDir, action, 25_000);
    if (!reply || reply === 'not-running' || reply.pid !== expectedPid)
        throw new Error('Membership confirmation unavailable; do not assume it completed.');
    if (reply.error)
        throw new Error(reply.error);
    if (!reply.membership || reply.membership.action !== action.action || reply.membership.network_id !== action.network_id)
        throw new Error('Invalid membership confirmation.');
    return reply.membership;
}
export function identityOf(file) {
    try {
        const { dev, ino } = fs.lstatSync(file);
        return { dev, ino };
    }
    catch {
        return null;
    }
}
const sameFile = (a, b) => a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
export function readPidLock(lock) {
    const fd = fs.openSync(lock, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    try {
        const stat = fs.fstatSync(fd);
        return stat.isFile() ? { stat, raw: fs.readFileSync(fd, 'utf8').trim() } : null;
    }
    finally {
        fs.closeSync(fd);
    }
}
export function takeOverStaleLock(lock, judged) {
    const aside = `${lock}.stale-${process.pid}`;
    try {
        fs.renameSync(lock, aside);
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return;
        throw err;
    }
    try {
        if (sameFile(identityOf(aside), judged))
            return;
        fs.linkSync(aside, lock);
    }
    catch (err) {
        if (err.code !== 'EEXIST')
            throw err;
    }
    finally {
        fs.rmSync(aside, { force: true });
    }
}
function removeStartupClaim(lock, owner) {
    try {
        fs.unlinkSync(path.join(lock, owner));
    }
    catch (err) {
        if (['ENOENT', 'ENOTDIR'].includes(err.code ?? ''))
            return;
        throw err;
    }
    removeEmptyStartupLock(lock);
}
function removeEmptyStartupLock(lock) {
    try {
        fs.rmdirSync(lock);
    }
    catch (err) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes(err.code ?? ''))
            throw err;
    }
}
export function processIsGone(pid) {
    try {
        process.kill(pid, 0);
        return false;
    }
    catch (err) {
        return err.code === 'ESRCH';
    }
}
function clearDeadStartupLock(lock) {
    try {
        if (fs.lstatSync(lock).isDirectory()) {
            const owners = fs.readdirSync(lock);
            if (owners.length === 0)
                return removeEmptyStartupLock(lock);
            const owner = owners.length === 1 ? owners[0] : '';
            const match = /^([1-9][0-9]*)-[0-9a-f]{32}$/.exec(owner);
            if (match && processIsGone(Number(match[1])))
                removeStartupClaim(lock, owner);
            return;
        }
        const opened = readPidLock(lock);
        if (!opened)
            return;
        const { stat: judged, raw } = opened;
        const age = Date.now() - judged.mtimeMs;
        const stale = /^[1-9][0-9]*$/.test(raw) ? processIsGone(Number(raw)) : age >= STARTUP_LOCK_EMPTY_STALE_MS;
        if (stale && sameFile(identityOf(lock), judged))
            fs.unlinkSync(lock);
    }
    catch (err) {
        const code = err.code;
        if (code === 'EPERM' && fs.lstatSync(lock).isDirectory())
            return;
        if (!['ENOENT', 'ENOTDIR', 'EISDIR'].includes(code ?? ''))
            throw err;
    }
}
async function withStartupLock(dataDir, use) {
    const lock = path.join(networkDir(dataDir), 'bridge.sock.startup.lock');
    const giveUpAt = Date.now() + STARTUP_LOCK_WAIT_MS;
    const owner = `${process.pid}-${randomBytes(16).toString('hex')}`;
    const prepared = fs.mkdtempSync(`${lock}.pending-`);
    let acquired = false;
    try {
        fs.writeFileSync(path.join(prepared, owner), '', { mode: 0o600, flag: 'wx' });
        for (;;) {
            try {
                fs.renameSync(prepared, lock);
                acquired = true;
                break;
            }
            catch (err) {
                if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR', 'EPERM', 'EACCES'].includes(err.code ?? ''))
                    throw err;
                clearDeadStartupLock(lock);
                if (Date.now() >= giveUpAt)
                    throw new Error('Another network bridge is starting and did not finish.', { cause: err });
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
        }
        return await use(() => fs.existsSync(path.join(lock, owner)));
    }
    finally {
        if (acquired)
            removeStartupClaim(lock, owner);
        else
            fs.rmSync(prepared, { recursive: true, force: true });
    }
}
function listen(server, target) {
    return new Promise((resolve, reject) => {
        const onError = (err) => {
            server.off('listening', onListening);
            if (err.code === 'EADDRINUSE')
                resolve('in-use');
            else
                reject(err);
        };
        const onListening = () => {
            server.off('error', onError);
            resolve('listening');
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(target);
    });
}
export function removeStaleSocket(target, judged) {
    if (process.platform === 'win32')
        return;
    if (!sameFile(identityOf(target), judged))
        return;
    if (!fs.lstatSync(target).isSocket()) {
        throw new Error(`${target} exists and is not a socket, so the network bridge cannot use it.`);
    }
    fs.unlinkSync(target);
}
function parseOp(line, token) {
    try {
        const request = JSON.parse(line);
        if (!tokensMatch(request.token, token))
            return null;
        if (request.expected_pid !== undefined && request.expected_pid !== process.pid)
            return null;
        if (request.op === 'membership' && Object.keys(request).sort().join(',') === 'action,op,token')
            return parseMembershipAction(request.action);
        return request.op === 'hello' || request.op === 'stop' ? request.op : null;
    }
    catch {
        return null;
    }
}
function serveConnection(socket, identity, token, handlers) {
    let text = '';
    let handled = false;
    socket.setTimeout(REQUEST_DEADLINE_MS, () => socket.destroy());
    socket.on('error', (err) => handlers.onProblem(`Control connection failed: ${err.message}`));
    socket.on('data', (chunk) => {
        if (handled)
            return;
        text += chunk.toString('utf8');
        if (text.length > REQUEST_MAX_BYTES) {
            socket.destroy();
            return;
        }
        const newline = text.indexOf('\n');
        if (newline === -1)
            return;
        handled = true;
        const op = parseOp(text.slice(0, newline), token);
        if (op === null) {
            socket.destroy();
            return;
        }
        const reply = { data_dir: identity, pid: process.pid, ready: handlers.isReady() };
        if (typeof op === 'object') {
            socket.setTimeout(25_000);
            if (!handlers.membership || !handlers.isReady()) {
                socket.destroy();
                return;
            }
            void handlers.membership(op).then(({ result, afterReply }) => {
                socket.end(`${JSON.stringify({ ...reply, membership: result })}\n`, () => afterReply?.());
                if (socket.destroyed)
                    afterReply?.();
            }).catch((error) => {
                socket.end(`${JSON.stringify({ ...reply, error: error instanceof Error ? error.message : 'Membership failed' })}\n`);
            });
            return;
        }
        socket.end(`${JSON.stringify(reply)}\n`, () => {
            if (op === 'stop')
                handlers.stop();
        });
    });
}
export async function holdControlSocket(dataDir, handlers) {
    assertControlPathFits(dataDir);
    const identity = dataDirIdentity(dataDir);
    const target = controlPath(dataDir);
    for (let attempt = 0; attempt < 5; attempt++) {
        const held = await withStartupLock(dataDir, async (holdsLock) => {
            const token = ensureControlToken(dataDir);
            const server = net.createServer((socket) => serveConnection(socket, identity, token, handlers));
            server.on('error', (err) => handlers.onProblem(`Control socket failed: ${err.message}`));
            for (let tries = 0; tries < 3; tries++) {
                if ((await listen(server, target)) === 'listening')
                    return heldBy(server, target);
                const judged = identityOf(target);
                const probe = await probeBridge(dataDir);
                if (probe.kind === 'running')
                    return { kind: 'already-running' };
                if (probe.kind === 'unresponsive')
                    return { kind: 'holder-unresponsive' };
                if (!holdsLock())
                    return 'lost-the-lock';
                removeStaleSocket(target, judged);
            }
            throw new Error('The network bridge control socket stayed in use.');
        });
        if (held !== 'lost-the-lock')
            return held;
    }
    throw new Error('Another network bridge kept taking over the start.');
}
function heldBy(server, target) {
    let bound = identityOf(target);
    const ownership = () => {
        if (process.platform === 'win32')
            return 'ours';
        let current;
        try {
            const { dev, ino } = fs.lstatSync(target);
            current = { dev, ino };
        }
        catch (err) {
            return err.code === 'ENOENT' ? 'lost' : 'unreadable';
        }
        bound ??= current;
        return sameFile(current, bound) ? 'ours' : 'lost';
    };
    const stillOurs = () => ownership() !== 'lost';
    return {
        kind: 'held',
        ownership,
        stillOurs,
        close: () => {
            if (stillOurs())
                server.close();
            else
                server.unref();
        },
    };
}
//# sourceMappingURL=control-socket.js.map