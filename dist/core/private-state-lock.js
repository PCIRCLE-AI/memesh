import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
export const PRIVATE_STATE_BUSY = 'MEMESH_PRIVATE_STATE_BUSY';
const STALE_MS = 15_000;
const LOCK_FILE = 'private-state.lock';
function sleepMs(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function holderIsGone(lock, now) {
    let st;
    try {
        st = fs.statSync(lock);
    }
    catch {
        return false;
    }
    if (now - st.mtimeMs > STALE_MS)
        return true;
    try {
        const holder = JSON.parse(fs.readFileSync(lock, 'utf8'));
        if (holder.host !== os.hostname() || typeof holder.pid !== 'number')
            return false;
        try {
            process.kill(holder.pid, 0);
            return false;
        }
        catch (err) {
            return err.code === 'ESRCH';
        }
    }
    catch {
        return false;
    }
}
export function withPrivateStateLock(memeshDir, deadlineAt, fn) {
    fs.mkdirSync(memeshDir, { recursive: true, mode: 0o700 });
    const lock = path.join(memeshDir, LOCK_FILE);
    for (;;) {
        let fd;
        try {
            fd = fs.openSync(lock, 'wx', 0o600);
        }
        catch (err) {
            if (err.code !== 'EEXIST')
                throw err;
        }
        if (fd !== undefined) {
            try {
                fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() }));
            }
            finally {
                fs.closeSync(fd);
            }
            try {
                return fn();
            }
            finally {
                fs.rmSync(lock, { force: true });
            }
        }
        const now = Date.now();
        if (holderIsGone(lock, now)) {
            const aside = `${lock}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
            try {
                fs.renameSync(lock, aside);
                fs.rmSync(aside, { force: true });
            }
            catch { }
            continue;
        }
        if (now >= deadlineAt) {
            throw Object.assign(new Error('the private-session state is locked by another process; nothing was changed'), { code: PRIVATE_STATE_BUSY });
        }
        sleepMs(10 + Math.floor(Math.random() * 15));
    }
}
//# sourceMappingURL=private-state-lock.js.map