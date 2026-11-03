import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { NetworkError, networkDir } from './types.js';
const SOCKET_PATH_MAX_BYTES = 103;
const PROBE_DEADLINE_MS = 4_000;
const REQUEST_DEADLINE_MS = 2_000;
const REQUEST_MAX_BYTES = 256;
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
function parseReply(line, dataDir) {
    try {
        const reply = JSON.parse(line);
        const valid = Number.isSafeInteger(reply?.pid) && typeof reply?.ready === 'boolean';
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
        socket.once('connect', () => socket.write(`${JSON.stringify({ op })}\n`));
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
async function withStartupLock(dataDir, use) {
    const lock = path.join(networkDir(dataDir), 'bridge.sock.startup.lock');
    const giveUpAt = Date.now() + STARTUP_LOCK_WAIT_MS;
    for (;;) {
        try {
            fs.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
            break;
        }
        catch (err) {
            if (err.code !== 'EEXIST')
                throw err;
            if (startupLockIsStale(lock)) {
                fs.rmSync(lock, { force: true });
                continue;
            }
            if (Date.now() >= giveUpAt)
                throw new Error('Another network bridge is starting and did not finish.', { cause: err });
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    }
    try {
        return await use();
    }
    finally {
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
function removeStaleSocket(target) {
    if (process.platform === 'win32')
        return;
    if (!fs.lstatSync(target).isSocket()) {
        throw new Error(`${target} exists and is not a socket, so the network bridge cannot use it.`);
    }
    fs.unlinkSync(target);
}
function parseOp(line) {
    try {
        const { op } = JSON.parse(line);
        return op === 'hello' || op === 'stop' ? op : null;
    }
    catch {
        return null;
    }
}
function serveConnection(socket, identity, handlers) {
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
        const op = parseOp(text.slice(0, newline));
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
    const server = net.createServer((socket) => serveConnection(socket, identity, handlers));
    server.on('error', (err) => handlers.onProblem(`Control socket failed: ${err.message}`));
    return withStartupLock(dataDir, async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
            if ((await listen(server, target)) === 'listening') {
                return { kind: 'held', close: () => { server.close(); } };
            }
            const probe = await probeBridge(dataDir);
            if (probe.kind === 'running')
                return { kind: 'already-running' };
            if (probe.kind === 'unresponsive')
                return { kind: 'holder-unresponsive' };
            removeStaleSocket(target);
        }
        throw new Error('The network bridge control socket stayed in use.');
    });
}
//# sourceMappingURL=control-socket.js.map