import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getMemeshDirFromDbPath } from './paths.js';
export const JOURNEY_TIMEOUT_MS = 30_000;
export const JOURNEY_SKIP_ENV = 'MEMESH_SKIP_POST_INSTALL_JOURNEY';
const PROJECT = 'memesh-journey';
const SENDER = 'journey-sender';
const RECIPIENT = 'journey-recipient';
const REINSTALL = 'Reinstall with `npm install -g @pcircle/memesh@latest`, then run `memesh doctor --journey`. If it still fails, run `memesh feedback`.';
const PASSTHROUGH_ENV = [
    'PATH', 'PATHEXT', 'SystemRoot', 'ComSpec',
    'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
];
export function journeyEnv(scratch, base = process.env, platform = process.platform) {
    const P = platform === 'win32' ? path.win32 : path;
    const env = {};
    for (const name of PASSTHROUGH_ENV) {
        const key = platform === 'win32' ? Object.keys(base).find((k) => k.toUpperCase() === name.toUpperCase()) : name;
        const value = key === undefined ? undefined : base[key];
        if (key === undefined || value === undefined)
            continue;
        const isTempFolder = /^(TMPDIR|TMP|TEMP)$/i.test(key);
        if (isTempFolder && value === '')
            continue;
        env[key] = isTempFolder && !P.isAbsolute(value) ? P.resolve(value) : value;
    }
    const dataDir = P.join(scratch, '.memesh');
    env.HOME = scratch;
    env.USERPROFILE = scratch;
    if (platform === 'win32') {
        env.APPDATA = P.join(scratch, 'AppData', 'Roaming');
        env.LOCALAPPDATA = P.join(scratch, 'AppData', 'Local');
    }
    env.MEMESH_DIR = dataDir;
    env.MEMESH_DB_PATH = P.join(dataDir, 'knowledge-graph.db');
    env.MEMESH_AUTO_CAPTURE = 'false';
    return env;
}
export function killCommandFor(platform, pid, systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows') {
    return platform === 'win32'
        ? { kind: 'taskkill', command: path.win32.join(systemRoot, 'System32', 'taskkill.exe'), args: ['/pid', String(pid), '/T', '/F'] }
        : { kind: 'group', pid };
}
export function descendantPids(root, run = spawnSync) {
    for (const ps of ['/bin/ps', '/usr/bin/ps']) {
        const r = run(ps, ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
        if (r.error || r.status !== 0)
            continue;
        const children = new Map();
        for (const line of String(r.stdout).split('\n')) {
            const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
            if (!m)
                continue;
            const parent = Number(m[2]);
            const list = children.get(parent);
            if (list)
                list.push(Number(m[1]));
            else
                children.set(parent, [Number(m[1])]);
        }
        const found = [];
        const queue = [root];
        while (queue.length > 0) {
            const below = children.get(queue.shift());
            if (!below)
                continue;
            for (const pid of below) {
                found.push(pid);
                queue.push(pid);
            }
        }
        return found;
    }
    return [];
}
export function killTree(child, platform = process.platform, run = spawnSync, outputOpen = true) {
    if (child.pid === undefined)
        return false;
    const exited = child.exitCode != null || child.signalCode != null;
    if (exited && (platform === 'win32' || !outputOpen))
        return true;
    const cmd = killCommandFor(platform, child.pid);
    try {
        if (cmd.kind === 'group') {
            const below = exited ? [] : descendantPids(cmd.pid, run);
            let delivered = false;
            try {
                process.kill(-cmd.pid, 'SIGKILL');
                delivered = true;
            }
            catch (err) {
                delivered = err.code === 'ESRCH';
            }
            for (const pid of below) {
                try {
                    process.kill(pid, 'SIGKILL');
                }
                catch { }
            }
            if (delivered)
                return true;
        }
        else {
            const r = run(cmd.command, cmd.args, { stdio: 'ignore', windowsHide: true });
            if (!r.error && r.status === 0)
                return true;
        }
    }
    catch { }
    try {
        return child.kill('SIGKILL');
    }
    catch {
        return false;
    }
}
export function timeoutReason(budgetMs, unstoppedPid) {
    return unstoppedPid === undefined
        ? `Did not finish within the ${formatBudget(budgetMs)} budget and was stopped.`
        : `Did not finish within the ${formatBudget(budgetMs)} budget, and it could not be stopped: process ${unstoppedPid} may still be running. End it by hand (Task Manager on Windows, \`kill ${unstoppedPid}\` elsewhere).`;
}
export function formatBudget(ms) {
    return ms < 10_000 ? `${(ms / 1000).toFixed(1).replace(/\.0$/, '')} s` : `${Math.round(ms / 1000)} s`;
}
const liveChildren = new Set();
function outputStillOpen(child) {
    return [child.stdout, child.stderr].some((pipe) => pipe !== null && pipe !== undefined && !pipe.readableEnded);
}
const liveScratch = new Set();
const CLEANUP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];
function cleanUpOnSignals() {
    const listeners = new Map();
    const remove = () => {
        for (const [signal, listener] of listeners)
            process.removeListener(signal, listener);
    };
    for (const signal of CLEANUP_SIGNALS) {
        const listener = () => {
            for (const child of liveChildren)
                killTree(child, process.platform, spawnSync, outputStillOpen(child));
            const stuck = [];
            for (const dir of liveScratch) {
                try {
                    fs.rmSync(dir, { recursive: true, force: true });
                }
                catch { }
                if (fs.existsSync(dir))
                    stuck.push(dir);
            }
            const note = stuck.length === 0
                ? 'Interrupted: the install journey was stopped and its throwaway folder was removed.'
                : `Interrupted: the install journey was stopped, but its throwaway folder could not be removed: ${stuck.join(', ')}. It is safe to delete by hand.`;
            try {
                fs.writeSync(2, `${note}\n`);
            }
            catch { }
            remove();
            try {
                process.kill(process.pid, signal);
            }
            catch {
                process.exit(128 + (os.constants.signals[signal] ?? 1));
            }
        };
        try {
            process.on(signal, listener);
            listeners.set(signal, listener);
        }
        catch { }
    }
    return remove;
}
const EXIT_GRACE_MS = 500;
function runChild(entry, args, stdin, env, cwd, budgetMs) {
    return new Promise((resolve) => {
        const out = [];
        const err = [];
        let timedOut = false;
        let settled = false;
        let child;
        const clocks = {};
        const settle = (outcome, killGroup) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(clocks.budget);
            clearTimeout(clocks.grace);
            if (child) {
                if (killGroup)
                    killTree(child, process.platform, spawnSync, outputStillOpen(child));
                liveChildren.delete(child);
                child.stdout?.destroy();
                child.stderr?.destroy();
                child.stdin?.destroy();
                if (outcome.unstoppedPid !== undefined)
                    child.unref();
            }
            resolve({ ...outcome, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut });
        };
        try {
            child = spawn(process.execPath, [entry, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
        }
        catch (e) {
            settle({ status: null, spawnError: e instanceof Error ? e.message : String(e) }, false);
            return;
        }
        const started = child;
        liveChildren.add(started);
        clocks.budget = setTimeout(() => {
            timedOut = true;
            const stopped = killTree(started);
            settle({ status: null, ...(stopped || started.pid === undefined ? {} : { unstoppedPid: started.pid }) }, false);
        }, Math.max(budgetMs, 1));
        started.stdout?.on('data', (chunk) => { out.push(chunk); });
        started.stderr?.on('data', (chunk) => { err.push(chunk); });
        started.once('error', (e) => settle({ status: null, spawnError: e.message }, false));
        started.once('exit', (status) => {
            if (settled)
                return;
            clearTimeout(clocks.budget);
            clocks.grace = setTimeout(() => settle({ status }, true), EXIT_GRACE_MS);
        });
        started.once('close', (status) => settle({ status }, false));
        started.stdin?.on('error', () => { });
        started.stdin?.end(stdin ?? '');
    });
}
function tail(text, max = 300) {
    const trimmed = text.trim();
    return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
}
function parseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}
export async function runInstallJourney(options, testHooks = {}) {
    const started = Date.now();
    const timeoutMs = testHooks.timeoutMs ?? JOURNEY_TIMEOUT_MS;
    const entry = testHooks.cliEntry ?? path.join(options.packageRoot, 'dist', 'transports', 'cli', 'cli.js');
    const nonce = crypto.randomBytes(5).toString('hex');
    const noteText = `journey check ${nonce}`;
    const payload = `journey message ${nonce}`;
    const steps = [];
    let timedOut = false;
    let failedStep;
    let storedName = '';
    let messageId = '';
    let scratch = '';
    let cleaned = false;
    let cleanupError;
    const stopSignalCleanup = cleanUpOnSignals();
    try {
        scratch = path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-journey-')));
        liveScratch.add(scratch);
        const dataDir = path.join(scratch, '.memesh');
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ updateCheck: false }), { mode: 0o600 });
        const env = journeyEnv(scratch);
        if (!fs.existsSync(entry)) {
            steps.push({
                id: 'remember', did: 'Start the installed memesh command', ok: false, result: 'not found', ms: 0,
                reason: `${entry} does not exist, so the installed package is incomplete.`, fix: REINSTALL,
            });
            failedStep = 'remember';
        }
        const specs = [
            {
                id: 'remember',
                did: 'Store a note (memesh remember)',
                args: () => ['remember', noteText, '--json'],
                check: (out) => {
                    const json = asRecord(parseJson(out));
                    if (json?.stored !== true || typeof json.name !== 'string') {
                        return { ok: false, reason: `remember did not report the note as stored. It printed: ${tail(out) || '(nothing)'}`, fix: REINSTALL };
                    }
                    storedName = json.name;
                    return { ok: true, result: `stored as "${json.name}"` };
                },
            },
            {
                id: 'recall',
                did: 'Search for that note (memesh recall)',
                args: () => ['recall', nonce, '--json'],
                check: (out) => {
                    const json = asRecord(parseJson(out));
                    const entities = Array.isArray(json?.entities) ? json.entities : undefined;
                    if (!entities)
                        return { ok: false, reason: `recall printed something that is not a result list: ${tail(out) || '(nothing)'}`, fix: REINSTALL };
                    const hit = entities.some((e) => asRecord(e)?.name === storedName);
                    if (!hit) {
                        return {
                            ok: false,
                            reason: `The note was stored but a search for it found ${entities.length === 0 ? 'nothing' : `${entities.length} other result(s)`}. Saving and searching are not talking to the same data.`,
                            fix: 'Run `memesh reindex`, then `memesh doctor --journey`. If it still fails, reinstall with `npm install -g @pcircle/memesh@latest` and run `memesh feedback`.',
                        };
                    }
                    return { ok: true, result: `found it among ${entities.length} result(s)` };
                },
            },
            {
                id: 'send',
                did: 'Send a message to a local agent (memesh message send)',
                args: () => ['message', 'send', '--project', PROJECT, '--sender', SENDER, '--recipient', RECIPIENT, '--idempotency-key', `journey-${nonce}`, '--payload-stdin'],
                stdin: () => payload,
                check: (out) => {
                    const json = asRecord(parseJson(out));
                    if (typeof json?.message_id !== 'string' || json.message_id.length === 0) {
                        return { ok: false, reason: `send did not return a message id. It printed: ${tail(out) || '(nothing)'}`, fix: REINSTALL };
                    }
                    messageId = json.message_id;
                    return { ok: true, result: `queued message ${messageId}` };
                },
            },
            {
                id: 'fetch',
                did: 'Read the message back (memesh message fetch)',
                args: () => ['message', 'fetch', '--project', PROJECT, '--recipient', RECIPIENT, '--message-id', messageId],
                check: (out) => {
                    const json = asRecord(parseJson(out));
                    if (json?.payload !== payload) {
                        return {
                            ok: false,
                            reason: json ? `The message came back with different content (expected "${payload}", got ${JSON.stringify(json.payload)}).` : `fetch printed something that is not a message: ${tail(out) || '(nothing)'}`,
                            fix: REINSTALL,
                        };
                    }
                    return { ok: true, result: 'content matches what was sent' };
                },
            },
        ];
        if (!failedStep) {
            for (const spec of specs) {
                const remaining = timeoutMs - (Date.now() - started);
                const stepStart = Date.now();
                if (remaining <= 0) {
                    timedOut = true;
                    steps.push({ id: spec.id, did: spec.did, ok: false, result: 'not run', ms: 0, reason: `The journey ran out of its ${formatBudget(timeoutMs)} budget before this step.`, fix: 'Close other heavy programs and run `memesh doctor --journey` again. A healthy install finishes in a few seconds.' });
                    failedStep = spec.id;
                    break;
                }
                const out = await runChild(entry, spec.args(), spec.stdin?.(), env, scratch, remaining);
                const ms = Date.now() - stepStart;
                if (out.timedOut) {
                    timedOut = true;
                    steps.push({ id: spec.id, did: spec.did, ok: false, result: 'timed out', ms, reason: timeoutReason(timeoutMs, out.unstoppedPid), fix: 'Run `memesh doctor --journey` again; if it keeps timing out, run `memesh doctor` to see which part of the install is slow or stuck.' });
                    failedStep = spec.id;
                    break;
                }
                if (out.spawnError) {
                    steps.push({ id: spec.id, did: spec.did, ok: false, result: 'could not start', ms, reason: `Node could not start the installed command: ${out.spawnError}`, fix: REINSTALL });
                    failedStep = spec.id;
                    break;
                }
                if (out.status !== 0) {
                    steps.push({ id: spec.id, did: spec.did, ok: false, result: `exited with code ${out.status ?? 'none'}`, ms, reason: `The command failed: ${tail(out.stderr) || tail(out.stdout) || '(no output)'}`, fix: REINSTALL });
                    failedStep = spec.id;
                    break;
                }
                const verdict = spec.check(out.stdout);
                if (!verdict.ok) {
                    steps.push({ id: spec.id, did: spec.did, ok: false, result: 'unexpected result', ms, reason: verdict.reason, fix: verdict.fix });
                    failedStep = spec.id;
                    break;
                }
                steps.push({ id: spec.id, did: spec.did, ok: true, result: verdict.result, ms });
            }
        }
    }
    catch (err) {
        const id = 'prepare';
        steps.push({
            id, did: 'Prepare the throwaway folder', ok: false, result: 'could not prepare', ms: 0,
            reason: err instanceof Error ? err.message : String(err),
            fix: 'Check that the system temp folder exists, is writable and has free space (it is set by TMPDIR, or TEMP/TMP on Windows), then run `memesh doctor --journey`.',
        });
        failedStep = id;
    }
    finally {
        if (scratch === '') {
            cleaned = true;
        }
        else {
            try {
                fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
                cleaned = !fs.existsSync(scratch);
                if (!cleaned)
                    cleanupError = 'folder still present after removal';
            }
            catch (err) {
                cleanupError = err instanceof Error ? err.message : String(err);
            }
            liveScratch.delete(scratch);
        }
        stopSignalCleanup();
    }
    return {
        ok: failedStep === undefined && steps.length === 4,
        steps,
        failedStep,
        timedOut,
        elapsedMs: Date.now() - started,
        scratchDir: scratch,
        cleaned,
        cleanupError,
    };
}
export function formatJourney(result) {
    const lines = ['Install journey — store, search, send and read back, in a throwaway folder (your memory database is not touched)'];
    for (const step of result.steps) {
        lines.push(`  ${step.ok ? '✅' : '❌'} ${step.did} → ${step.result} (${(step.ms / 1000).toFixed(1)}s)`);
        if (!step.ok) {
            lines.push(`     Why: ${step.reason}`);
            lines.push(`     Fix: ${step.fix}`);
        }
    }
    const seconds = (result.elapsedMs / 1000).toFixed(1);
    lines.push(result.ok
        ? `Journey PASSED in ${seconds}s: memesh can store, find, send and read back on this machine. Live delivery to a running agent is not checked here; \`memesh doctor\` reports on the router.`
        : result.failedStep === 'prepare'
            ? `Journey could not run: this machine's temp folder is not usable, so memesh itself was not checked.`
            : `Journey FAILED${result.timedOut ? ' (timed out)' : ''} at "${result.failedStep}" after ${seconds}s. The core feature above is not working on this install.`);
    if (!result.cleaned)
        lines.push(`Note: the throwaway folder ${result.scratchDir} could not be removed (${result.cleanupError ?? 'unknown reason'}); it is safe to delete by hand.`);
    return lines;
}
export function journeyRecordPath(dir = getMemeshDirFromDbPath()) {
    return path.join(dir, 'post-install-journey.json');
}
export function toJourneyRecord(result, version, trigger, now = new Date()) {
    const failed = result.steps.find((s) => !s.ok);
    return {
        ok: result.ok, at: now.toISOString(), version, trigger,
        ...(failed ? { failedStep: failed.id, reason: failed.reason, fix: failed.fix } : {}),
    };
}
export function writeJourneyRecord(record, dir = getMemeshDirFromDbPath()) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = journeyRecordPath(dir);
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
        const fd = fs.openSync(temporary, 'wx', 0o600);
        try {
            fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
            fs.fchmodSync(fd, 0o600);
        }
        finally {
            fs.closeSync(fd);
        }
        fs.renameSync(temporary, target);
    }
    catch (err) {
        try {
            fs.unlinkSync(temporary);
        }
        catch { }
        throw err;
    }
}
export function readJourneyRecord(dir = getMemeshDirFromDbPath()) {
    let raw;
    try {
        raw = fs.readFileSync(journeyRecordPath(dir), 'utf8');
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return undefined;
        return { unreadable: err instanceof Error ? err.message : String(err) };
    }
    const json = asRecord(parseJson(raw));
    const complete = json !== undefined && typeof json.ok === 'boolean' && typeof json.at === 'string' && typeof json.version === 'string'
        && (json.ok || (typeof json.failedStep === 'string' && typeof json.reason === 'string'));
    if (!json || !complete) {
        return { unreadable: 'post-install-journey.json is not a journey record' };
    }
    return json;
}
export function refreshExistingJourneyRecord(result, version) {
    const existing = readJourneyRecord();
    if (existing === undefined || 'unreadable' in existing)
        return;
    try {
        writeJourneyRecord(toJourneyRecord(result, version, 'doctor'));
    }
    catch (err) {
        console.error(`Could not update the saved journey result: ${err instanceof Error ? err.message : String(err)}`);
    }
}
export function journeySkipped(flagNoJourney, env = process.env) {
    if (flagNoJourney === false)
        return true;
    const raw = env[JOURNEY_SKIP_ENV];
    return raw !== undefined && raw !== '' && raw !== '0' && raw.toLowerCase() !== 'false';
}
export async function runPostInstallJourney(input, testHooks = {}) {
    if (journeySkipped(input.journeyFlag)) {
        console.log(`Install journey skipped (${input.journeyFlag === false ? '--no-journey' : JOURNEY_SKIP_ENV}). Run it any time: memesh doctor --journey`);
        return;
    }
    console.log('');
    try {
        const result = await runInstallJourney({ packageRoot: input.packageRoot }, testHooks);
        const lines = formatJourney(result);
        if (result.ok) {
            for (const line of lines)
                console.log(line);
        }
        else {
            for (const line of lines)
                console.error(line);
            console.error('The install itself finished; this does not undo it. `memesh doctor` will keep showing this until the journey passes.');
        }
        try {
            writeJourneyRecord(toJourneyRecord(result, input.version, input.trigger));
        }
        catch (err) {
            console.error(`Could not save the journey result for \`memesh doctor\`: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    catch (err) {
        console.error(`Install journey could not run: ${err instanceof Error ? err.message : String(err)}`);
    }
}
//# sourceMappingURL=doctor-journey.js.map