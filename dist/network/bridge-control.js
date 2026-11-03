import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { logPath, readStatus } from './bridge-state.js';
import { askBridgeToStop, assertControlPathFits, probeBridge } from './control-socket.js';
import { ensureNetworkDir } from './identity.js';
import { EXIT_ALREADY_RUNNING, EXIT_HOLDER_UNRESPONSIVE, NetworkError, SINGLE_MACHINE_NOTE, childEnv, } from './types.js';
const START_DEADLINE_MS = 20_000;
const UNRESPONSIVE_DEADLINE_MS = 8_000;
const STOP_DEADLINE_MS = 10_000;
const POLL_MS = 100;
const CRASH_SIGNALS = new Set(['SIGSEGV', 'SIGBUS', 'SIGILL', 'SIGABRT']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function describeChildDeath(code, signal) {
    if (signal === null)
        return `exited with status ${code}`;
    return CRASH_SIGNALS.has(signal)
        ? `crashed with signal ${signal}, which usually means its native file is damaged`
        : `was stopped by signal ${signal}`;
}
function howToStop(ctx) {
    const pid = readStatus(ctx.dataDir)?.pid;
    const named = pid ? ` Its last recorded process id is ${pid}.` : '';
    return `${named} To stop it yourself, end that process with your system's tools, then run this again.`;
}
function unresponsive(ctx) {
    return new NetworkError('bridge_unresponsive', `Something holds the network bridge's control socket and did not answer. MeMesh will not touch a process it cannot identify.${howToStop(ctx)}`);
}
function spawnBridge(ctx) {
    ensureNetworkDir(ctx.dataDir);
    const log = fs.openSync(logPath(ctx.dataDir), 'a', 0o600);
    try {
        const child = spawn(process.execPath, [ctx.bridgeEntry, 'serve'], {
            detached: true,
            stdio: ['ignore', log, log],
            env: childEnv(ctx),
            windowsHide: true,
        });
        let exit = null;
        child.once('exit', (code, signal) => { exit = { code, signal }; });
        child.once('error', (error) => { exit = { code: null, signal: null, error }; });
        return { child, exited: () => exit };
    }
    finally {
        fs.closeSync(log);
    }
}
function describeFailedStart(ctx, exit, pid) {
    const status = readStatus(ctx.dataDir);
    const lastError = status?.pid === pid ? status?.last_error : null;
    const why = lastError ? ` Its last error: ${lastError}.` : ` See ${logPath(ctx.dataDir)}.`;
    return `The network bridge ${describeChildDeath(exit.code, exit.signal)}.${why} To reinstall its files, run: memesh network up --reinstall. ${SINGLE_MACHINE_NOTE}`;
}
export async function startBridge(ctx) {
    assertControlPathFits(ctx.dataDir);
    const startedAt = Date.now();
    let mine = null;
    for (;;) {
        const probe = await probeBridge(ctx.dataDir, POLL_MS * 20);
        if (probe.kind === 'running' && probe.ready) {
            mine?.child.unref();
            return { pid: probe.pid, started: mine?.child.pid === probe.pid };
        }
        const exit = mine?.exited();
        if (exit && mine) {
            if (exit.error)
                throw new NetworkError('bridge_failed', `The network bridge could not start: ${exit.error.message}. ${SINGLE_MACHINE_NOTE}`);
            if (exit.code === EXIT_HOLDER_UNRESPONSIVE)
                throw unresponsive(ctx);
            if (exit.code !== EXIT_ALREADY_RUNNING) {
                throw new NetworkError('bridge_failed', describeFailedStart(ctx, exit, mine.child.pid));
            }
            mine = null;
        }
        if (probe.kind === 'not-running' && !mine)
            mine = spawnBridge(ctx);
        const elapsed = Date.now() - startedAt;
        if (probe.kind === 'unresponsive' && !mine && elapsed >= UNRESPONSIVE_DEADLINE_MS)
            throw unresponsive(ctx);
        if (elapsed >= START_DEADLINE_MS) {
            mine?.child.kill('SIGKILL');
            throw new NetworkError('bridge_failed', `The network bridge did not start within ${START_DEADLINE_MS / 1000} s. ${SINGLE_MACHINE_NOTE}`);
        }
        await sleep(POLL_MS);
    }
}
export async function stopBridge(ctx) {
    const probe = await probeBridge(ctx.dataDir);
    if (probe.kind === 'not-running')
        return { stopped: false, pid: null };
    if (probe.kind === 'unresponsive')
        throw unresponsive(ctx);
    const notAnswering = () => new NetworkError('bridge_unresponsive', `The network bridge (process ${probe.pid}) was asked to stop and has not exited. To stop it yourself, end process ${probe.pid} with your system's tools.`);
    if (!(await askBridgeToStop(ctx.dataDir)))
        throw notAnswering();
    const giveUpAt = Date.now() + STOP_DEADLINE_MS;
    while (Date.now() < giveUpAt) {
        if ((await probeBridge(ctx.dataDir, POLL_MS * 10)).kind === 'not-running')
            return { stopped: true, pid: probe.pid };
        await sleep(POLL_MS);
    }
    throw notAnswering();
}
//# sourceMappingURL=bridge-control.js.map