import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { NetworkError, networkDir } from './types.js';
const SOCKET_PATH_MAX_BYTES = 103;
const PROBE_DEADLINE_MS = 4_000;
const REQUEST_DEADLINE_MS = 2_000;
const REQUEST_MAX_BYTES = 512;
const REPLY_MAX_BYTES = 8 * 1024;
const STARTUP_LOCK_WAIT_MS = 5_000;
const STARTUP_LOCK_STALE_MS = 30_000;
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
        return fs.realpathSync(dataDir);
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
function request(dataDir, op, deadlineMs) {
    return new Promise((resolve) => {
        const socket = net.createConnection(controlPath(dataDir));
        let text = '';
        const finish = (result) => {
            clearTimeout(timer);
            socket.destroy();
            resolve(result);
        };
        const timer = setTimeout(() => finish(null), deadlineMs);
        socket.once('connect', () => socket.write(`${JSON.stringify({ op, token: readControlToken(dataDir) })}\n`));
        socket.on('data', (chunk) => {
            text += chunk.toString('utf8');
            if (text.length > REPLY_MAX_BYTES)
                finish(null);
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
export async function askBridgeToStop(dataDir) {
    const reply = await request(dataDir, 'stop', PROBE_DEADLINE_MS);
    return reply !== null && reply !== 'not-running';
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
async function withStartupLock(dataDir, use) {
    const lock = path.join(networkDir(dataDir), 'bridge.sock.startup.lock');
    const giveUpAt = Date.now() + STARTUP_LOCK_WAIT_MS;
    let mine;
    for (;;) {
        try {
            const fd = fs.openSync(lock, 'wx', 0o600);
            const { dev, ino } = fs.fstatSync(fd);
            mine = { dev, ino };
            fs.writeSync(fd, `${process.pid}\n`);
            fs.closeSync(fd);
            break;
        }
        catch (err) {
            if (err.code !== 'EEXIST')
                throw err;
            const judged = identityOf(lock);
            if (judged !== null && startupLockIsStale(lock)) {
                takeOverStaleLock(lock, judged);
                continue;
            }
            if (Date.now() >= giveUpAt)
                throw new Error('Another network bridge is starting and did not finish.', { cause: err });
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    }
    try {
        return await use(() => sameFile(identityOf(lock), mine));
    }
    finally {
        if (sameFile(identityOf(lock), mine))
            fs.rmSync(lock, { force: true });
    }
}
function startupLockIsStale(lock) {
    try {
        if (Date.now() - fs.statSync(lock).mtimeMs >= STARTUP_LOCK_STALE_MS)
            return true;
        process.kill(Number(fs.readFileSync(lock, 'utf8').trim()), 0);
        return false;
    }
    catch (err) {
        return err.code === 'ESRCH';
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
        return request.op === 'hello' || request.op === 'stop' ? request.op : null;
    }
    catch {
        return null;
    }
}
function serveConnection(socket, identity, token, handlers) {
    let text = '';
    socket.setTimeout(REQUEST_DEADLINE_MS, () => socket.destroy());
    socket.on('error', (err) => handlers.onProblem(`Control connection failed: ${err.message}`));
    socket.on('data', (chunk) => {
        text += chunk.toString('utf8');
        if (text.length > REQUEST_MAX_BYTES) {
            socket.destroy();
            return;
        }
        const newline = text.indexOf('\n');
        if (newline === -1)
            return;
        const op = parseOp(text.slice(0, newline), token);
        if (op === null) {
            socket.destroy();
            return;
        }
        const reply = { data_dir: identity, pid: process.pid, ready: handlers.isReady() };
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
    const bound = identityOf(target);
    const stillOurs = () => process.platform === 'win32' || sameFile(identityOf(target), bound);
    return {
        kind: 'held',
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