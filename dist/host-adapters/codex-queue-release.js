import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
const DEFAULT_TIMEOUT_MS = 10_000;
const KILL_GRACE_MS = 1_000;
const MAX_READ_BYTES = 1024 * 1024;
const QUEUE_PAGE = 100;
const MEMESH_MESSAGE_PREFIX = '{"message_type":"memesh_message"';
export async function releaseCodexQueue(threadId, queuedSubmissionId, options = {}) {
    let child;
    try {
        child = (options.spawn ?? spawn)('codex', ['app-server', 'proxy'], {
            shell: false,
            stdio: ['pipe', 'pipe', 'ignore'],
            windowsHide: true,
        });
    }
    catch {
        return { status: 'unavailable', reason: 'failed' };
    }
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ status: 'unavailable', reason: 'timeout' }), options.timeout_ms ?? DEFAULT_TIMEOUT_MS);
    });
    try {
        return await Promise.race([attemptRelease(child, threadId, queuedSubmissionId), timeout]);
    }
    finally {
        clearTimeout(timer);
        stop(child);
    }
}
async function attemptRelease(child, threadId, queuedSubmissionId) {
    const exitCode = new Promise((resolve) => {
        child.once('exit', (code) => resolve(code));
        child.on('error', () => resolve(null));
    });
    try {
        const { stdin, stdout } = child;
        if (!stdin || !stdout)
            throw new Error('Codex proxy has no stdio.');
        stdin.on('error', () => { });
        const send = (opcode, payload) => stdin.write(clientFrame(opcode, payload));
        const incoming = serverMessages(stdout, (payload) => send(0xa, payload));
        const reply = async (id) => {
            for (;;) {
                const next = await incoming.next();
                if (next.done)
                    throw new Error('Codex proxy closed.');
                const message = JSON.parse(next.value);
                if (message.id === id)
                    return message;
            }
        };
        const call = (id, method, params) => {
            send(0x1, Buffer.from(JSON.stringify({ id, method, params })));
            return reply(id);
        };
        stdin.write(`GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
            + `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
        const status = await incoming.next();
        if (status.done || !status.value.startsWith('HTTP/1.1 101'))
            throw new Error('Codex proxy refused the upgrade.');
        const initialized = await call(1, 'initialize', {
            clientInfo: { name: 'memesh-host-adapter', version: '1' },
            capabilities: { experimentalApi: true },
        });
        if (initialized.error)
            return { status: 'unavailable', reason: 'rejected' };
        send(0x1, Buffer.from(JSON.stringify({ method: 'initialized', params: {} })));
        const listed = await call(2, 'thread/queue/list', { threadId, limit: QUEUE_PAGE });
        const items = listed.result?.data;
        if (listed.error || !Array.isArray(items))
            return { status: 'unavailable', reason: 'rejected' };
        const morePages = Boolean(listed.result?.nextCursor);
        if (!morePages && !items.some((item) => item.id === queuedSubmissionId))
            return { status: 'empty' };
        if (morePages || !items.every(isMemeshSubmission))
            return { status: 'other_input' };
        const started = await call(3, 'thread/queue/start', { threadId, queuedSubmissionId });
        if (!started.error)
            return { status: 'started' };
        const message = String(started.error.message);
        if (/queued submission not found|queue is empty/i.test(message))
            return { status: 'empty' };
        if (/active or pending turn/i.test(message))
            return { status: 'busy' };
        return { status: 'unavailable', reason: 'rejected' };
    }
    catch {
        child.kill();
        return { status: 'unavailable', reason: await exitCode === 1 ? 'no_daemon' : 'failed' };
    }
}
function stop(child) {
    child.kill();
    if (child.exitCode !== null || child.signalCode !== null)
        return;
    const escalate = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    escalate.unref();
    child.once('exit', () => clearTimeout(escalate));
}
function isMemeshSubmission(item) {
    return Array.isArray(item.input) && item.input.length > 0 && item.input.every((part) => part.type === 'text' && typeof part.text === 'string' && part.text.startsWith(MEMESH_MESSAGE_PREFIX));
}
function clientFrame(opcode, payload) {
    const mask = randomBytes(4);
    const length = payload.length < 126
        ? Buffer.from([0x80 | payload.length])
        : Buffer.from([0x80 | 126, payload.length >> 8, payload.length & 0xff]);
    return Buffer.concat([
        Buffer.from([0x80 | opcode]),
        length,
        mask,
        Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4])),
    ]);
}
async function* serverMessages(stdout, pong) {
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    let read = 0;
    let fragments = [];
    for await (const chunk of stdout) {
        read += chunk.length;
        if (read > MAX_READ_BYTES)
            throw new Error('Codex proxy sent too much data.');
        buffer = Buffer.concat([buffer, chunk]);
        if (!upgraded) {
            const end = buffer.indexOf('\r\n\r\n');
            if (end < 0)
                continue;
            const status = buffer.subarray(0, buffer.indexOf('\r\n')).toString('latin1');
            buffer = buffer.subarray(end + 4);
            upgraded = true;
            yield status;
        }
        for (let frame = parseFrame(buffer); frame; frame = parseFrame(buffer)) {
            buffer = buffer.subarray(frame.size);
            if (frame.opcode === 0x8)
                return;
            if (frame.opcode === 0x9)
                pong(frame.payload);
            if (frame.opcode > 0x2)
                continue;
            fragments.push(frame.payload);
            if (frame.fin) {
                yield Buffer.concat(fragments).toString('utf8');
                fragments = [];
            }
        }
    }
}
function parseFrame(buffer) {
    if (buffer.length < 2)
        return null;
    if (buffer[1] & 0x80)
        throw new Error('Codex proxy sent a masked frame.');
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
        if (buffer.length < 4)
            return null;
        length = buffer.readUInt16BE(2);
        offset = 4;
    }
    else if (length === 127) {
        if (buffer.length < 10)
            return null;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
    }
    if (buffer.length < offset + length)
        return null;
    return {
        fin: (buffer[0] & 0x80) !== 0,
        opcode: buffer[0] & 0x0f,
        payload: buffer.subarray(offset, offset + length),
        size: offset + length,
    };
}
//# sourceMappingURL=codex-queue-release.js.map