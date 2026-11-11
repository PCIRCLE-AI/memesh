// The install journey: store a note, find it again, send a message, fetch it
// back — once, in a throwaway folder, through the installed `memesh` command.
//
// WHY IT SPAWNS THE CLI AND DOES NOT CALL remember()/recall() DIRECTLY
//
// The question this answers is "does the thing the user just installed work?".
// A function call from inside this process proves the TypeScript compiles; it
// cannot prove the packaged bundle, its native SQLite binding, its argument
// parsing or its stdin handling work, and those are exactly what breaks after
// an install. So every step is a real `node <package>/dist/transports/cli/cli.js`
// child, the same entry the `memesh` command resolves to.
//
// WHY THE CHILD GETS AN ALLOW-LISTED ENVIRONMENT
//
// `src/core/paths.ts` resolves MEMESH_DB_PATH and MEMESH_DIR BEFORE it falls
// back to HOME, so pinning HOME alone is not isolation: a MEMESH_DB_PATH
// exported in the user's shell would send the journey at their real graph.
// Instead of deleting the variables we know about (and missing the next one),
// the child is handed only what it needs to start (PATH, the OS temp folder)
// plus paths we set. The sender session id the CLI would otherwise take from
// the caller's environment is gone for the same reason.
//
// WHAT THE JOURNEY DOES NOT PROVE
//
// The message steps prove the durable inbox: a message is stored, and read back
// byte for byte. They do not prove live delivery to a running agent, because
// that needs a running router and a registered host session, which a throwaway
// folder does not have, and starting them here would reach the sockets and
// processes of the user's real hosts. `memesh doctor` already reports on the
// router (MEMESH_DOCTOR_PROBE_MESSAGE_ROUTER=1 probes it); the journey says so
// in its own output instead of letting a green line imply more.
//
// WHAT HAPPENS WHEN IT IS INTERRUPTED OR HANGS
//
// On POSIX each step runs in its own process group, and a step that outlives
// its budget is killed with that group plus any descendant found through its
// parent id, even one that moved to another group. On Windows the step's
// process tree is stopped with `taskkill /T` (by parent id, not a job object).
// What cannot be reached either way: a process whose parent had already exited
// before the budget ended (it has been re-parented and nothing links it to the
// step any more). Within that limit the budget holds: a grandchild holding the step's output pipe cannot keep the journey
// waiting, and a step that exited in time is judged by how it exited, with at
// most half a second more to collect its last output. SIGINT, SIGTERM, SIGHUP
// and SIGQUIT stop the running step and remove the throwaway folder before the
// signal takes its usual effect. SIGKILL cannot be caught; that one leaves the
// folder in the system temp folder.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getMemeshDirFromDbPath } from './paths.js';

/** `prepare` is the journey's own scaffolding (the throwaway folder), not something memesh was asked to do. */
export type JourneyStepId = 'prepare' | 'remember' | 'recall' | 'send' | 'fetch';

export interface JourneyStep {
  id: JourneyStepId;
  /** What was done, in words a user can follow. */
  did: string;
  ok: boolean;
  /** What came back. */
  result: string;
  /** Present when `ok` is false: why it failed. */
  reason?: string;
  /** Present when `ok` is false: what to do about it. */
  fix?: string;
  ms: number;
}

export interface JourneyResult {
  ok: boolean;
  steps: JourneyStep[];
  failedStep?: JourneyStepId;
  timedOut: boolean;
  elapsedMs: number;
  /** The throwaway folder the journey used; it no longer exists when `cleaned` is true. */
  scratchDir: string;
  cleaned: boolean;
  cleanupError?: string;
}

export interface JourneyOptions {
  /** Root of the installed package (the folder holding `dist/`). */
  packageRoot: string;
}

/**
 * Used only by tests, as a second argument; the CLI never passes it. They are
 * not options, and not read from the environment either: a variable in the
 * user's shell must not be able to choose which program the journey runs.
 */
export interface JourneyTestHooks {
  /** A different CLI entry (a wrapper that breaks one step). */
  cliEntry?: string;
  /** Whole-journey budget instead of the default. */
  timeoutMs?: number;
}

export const JOURNEY_TIMEOUT_MS = 30_000;
export const JOURNEY_SKIP_ENV = 'MEMESH_SKIP_POST_INSTALL_JOURNEY';

const PROJECT = 'memesh-journey';
const SENDER = 'journey-sender';
const RECIPIENT = 'journey-recipient';
const REINSTALL = 'Reinstall with `npm install -g @pcircle/memesh@latest`, then run `memesh doctor --journey`. If it still fails, run `memesh feedback`.';

/**
 * Only these variables reach the child; see the header for why. Windows needs
 * SystemRoot (Node's crypto and DNS fail without it), ComSpec and PATHEXT.
 * Windows names are case-insensitive (`Path`), so they match that way there.
 */
const PASSTHROUGH_ENV = [
  'PATH', 'PATHEXT', 'SystemRoot', 'ComSpec',
  'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
];

export function journeyEnv(scratch: string, base: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const P = platform === 'win32' ? path.win32 : path;
  const env: NodeJS.ProcessEnv = {};
  for (const name of PASSTHROUGH_ENV) {
    const key = platform === 'win32' ? Object.keys(base).find((k) => k.toUpperCase() === name.toUpperCase()) : name;
    const value = key === undefined ? undefined : base[key];
    if (key === undefined || value === undefined) continue;
    const isTempFolder = /^(TMPDIR|TMP|TEMP)$/i.test(key);
    // An empty temp variable names no folder: resolved, it would become the
    // current folder. Left out, the step falls back to the system default.
    if (isTempFolder && value === '') continue;
    // The step runs with the throwaway folder as its working directory, so a
    // relative temp folder would be resolved a second time from there.
    env[key] = isTempFolder && !P.isAbsolute(value) ? P.resolve(value) : value;
  }
  const dataDir = P.join(scratch, '.memesh');
  env.HOME = scratch;
  env.USERPROFILE = scratch;
  if (platform === 'win32') {
    // Not passed through, and set so nothing can resolve them to the real ones.
    env.APPDATA = P.join(scratch, 'AppData', 'Roaming');
    env.LOCALAPPDATA = P.join(scratch, 'AppData', 'Local');
  }
  env.MEMESH_DIR = dataDir;
  env.MEMESH_DB_PATH = P.join(dataDir, 'knowledge-graph.db');
  env.MEMESH_AUTO_CAPTURE = 'false';
  return env;
}

/** How a timed-out step and everything it started is stopped. */
export type KillCommand =
  | { kind: 'group'; pid: number }
  | { kind: 'taskkill'; command: string; args: string[] };

/** taskkill by its full path: a bare name is looked up in PATH (and, on Windows, possibly the current folder first). */
export function killCommandFor(platform: NodeJS.Platform, pid: number, systemRoot: string = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows'): KillCommand {
  return platform === 'win32'
    ? { kind: 'taskkill', command: path.win32.join(systemRoot, 'System32', 'taskkill.exe'), args: ['/pid', String(pid), '/T', '/F'] }
    : { kind: 'group', pid };
}

/** What `killTree` needs of a child process (a real ChildProcess, or a stand-in in a test). */
export interface KillTarget {
  pid?: number | undefined;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/**
 * The processes below `root`, found through their parent ids (POSIX `ps`, by its
 * full path). A descendant in another process group is found this way. One whose
 * parent had already exited is re-parented and cannot be.
 */
export function descendantPids(root: number, run: typeof spawnSync = spawnSync): number[] {
  for (const ps of ['/bin/ps', '/usr/bin/ps']) {
    const r = run(ps, ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
    if (r.error || r.status !== 0) continue;
    const children = new Map<number, number[]>();
    for (const line of String(r.stdout).split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!m) continue;
      const parent = Number(m[2]);
      const list = children.get(parent);
      if (list) list.push(Number(m[1]));
      else children.set(parent, [Number(m[1])]);
    }
    const found: number[] = [];
    const queue = [root];
    while (queue.length > 0) {
      const below = children.get(queue.shift()!);
      if (!below) continue; // a leaf
      for (const pid of below) {
        found.push(pid);
        queue.push(pid);
      }
    }
    return found;
  }
  return [];
}

/**
 * Stop a step and what it started. Returns whether a kill was delivered.
 * POSIX: the step's process group and every descendant found through parent
 * ids; an exited step is left alone once its output is closed (`outputOpen`
 * false). Windows: `taskkill /T /F`, unless the step already exited (its pid
 * may be someone else's by now; its leftover children are then not stopped). A
 * `taskkill` that is missing or fails does not throw (spawnSync reports it in
 * its result), so it is checked, and the direct child is killed instead. `run`
 * is a parameter so a test can stand in `taskkill` and `ps`.
 */
export function killTree(child: KillTarget, platform: NodeJS.Platform = process.platform, run: typeof spawnSync = spawnSync, outputOpen = true): boolean {
  if (child.pid === undefined) return false;
  const exited = child.exitCode != null || child.signalCode != null;
  // An exited step's pid is free for reuse once nothing it started is left, and
  // a group or tree kill aimed at it would then hit an unrelated process. With
  // its output closed nothing is left holding it; with it open something is.
  if (exited && (platform === 'win32' || !outputOpen)) return true;
  const cmd = killCommandFor(platform, child.pid);
  try {
    if (cmd.kind === 'group') {
      // An exited step's pid may be another process's by now: no lookup below it.
      const below = exited ? [] : descendantPids(cmd.pid, run);
      let delivered = false;
      try {
        process.kill(-cmd.pid, 'SIGKILL');
        delivered = true;
      } catch (err) {
        delivered = (err as NodeJS.ErrnoException).code === 'ESRCH'; // the group is already gone
      }
      for (const pid of below) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* gone, or not ours */ }
      }
      if (delivered) return true;
    } else {
      const r = run(cmd.command, cmd.args, { stdio: 'ignore', windowsHide: true });
      if (!r.error && r.status === 0) return true;
    }
  } catch { /* fall through to the direct child */ }
  try { return child.kill('SIGKILL'); } catch { return false; }
}

/** Why a step that ran past its budget failed; says so when it could not be stopped. */
export function timeoutReason(budgetMs: number, unstoppedPid?: number): string {
  return unstoppedPid === undefined
    ? `Did not finish within the ${formatBudget(budgetMs)} budget and was stopped.`
    : `Did not finish within the ${formatBudget(budgetMs)} budget, and it could not be stopped: process ${unstoppedPid} may still be running. End it by hand (Task Manager on Windows, \`kill ${unstoppedPid}\` elsewhere).`;
}

/** "0.3 s", "1.5 s", "30 s": a sub-second budget must not read "0 s". */
export function formatBudget(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1).replace(/\.0$/, '')} s` : `${Math.round(ms / 1000)} s`;
}

// What an interrupt has to clean up: running steps and throwaway folders.
const liveChildren = new Set<ChildProcess>();

/** Whether anything may still hold the step's output: both pipes have not ended. */
function outputStillOpen(child: ChildProcess): boolean {
  // No pipe at all cannot hold anything.
  return [child.stdout, child.stderr].some((pipe) => pipe !== null && pipe !== undefined && !pipe.readableEnded);
}
const liveScratch = new Set<string>();

const CLEANUP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

/** Until the returned function runs, these signals clean up first and then take their usual effect. */
function cleanUpOnSignals(): () => void {
  const listeners = new Map<NodeJS.Signals, () => void>();
  const remove = (): void => {
    for (const [signal, listener] of listeners) process.removeListener(signal, listener);
  };
  for (const signal of CLEANUP_SIGNALS) {
    const listener = (): void => {
      for (const child of liveChildren) killTree(child, process.platform, spawnSync, outputStillOpen(child));
      const stuck: string[] = [];
      for (const dir of liveScratch) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* checked below */ }
        if (fs.existsSync(dir)) stuck.push(dir);
      }
      const note = stuck.length === 0
        ? 'Interrupted: the install journey was stopped and its throwaway folder was removed.'
        : `Interrupted: the install journey was stopped, but its throwaway folder could not be removed: ${stuck.join(', ')}. It is safe to delete by hand.`;
      // Written synchronously: the process is about to take the signal's effect.
      try { fs.writeSync(2, `${note}\n`); } catch { /* no stderr */ }
      remove();
      try {
        process.kill(process.pid, signal);
      } catch {
        // A platform that cannot send a signal to itself (ENOSYS on Windows): end the way a signal would.
        process.exit(128 + (os.constants.signals[signal] ?? 1));
      }
    };
    try {
      process.on(signal, listener);
      listeners.set(signal, listener);
    } catch { /* a platform that cannot listen for this signal */ }
  }
  return remove;
}

interface RunOutcome {
  status: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
  timedOut: boolean;
  /** Set when a timed-out step could not be stopped. */
  unstoppedPid?: number;
}

/** After a step exits, how long a grandchild still holding its output may delay the verdict. */
const EXIT_GRACE_MS = 500;

function runChild(entry: string, args: string[], stdin: string | undefined, env: NodeJS.ProcessEnv, cwd: string, budgetMs: number): Promise<RunOutcome> {
  return new Promise((resolve) => {
    // Bytes are joined before decoding: a chunk can end inside a multi-byte character.
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    let child: ChildProcess | undefined;
    const clocks: { budget?: NodeJS.Timeout; grace?: NodeJS.Timeout } = {};
    const settle = (outcome: Omit<RunOutcome, 'stdout' | 'stderr' | 'timedOut'>, killGroup: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(clocks.budget);
      clearTimeout(clocks.grace);
      if (child) {
        if (killGroup) killTree(child, process.platform, spawnSync, outputStillOpen(child));
        liveChildren.delete(child);
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
        // A step that could not be stopped is still running; it must not keep
        // this process (which is about to report that) from ending.
        if (outcome.unstoppedPid !== undefined) child.unref();
      }
      resolve({ ...outcome, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut });
    };
    try {
      // Its own process group (POSIX), so the whole tree can be killed at once.
      child = spawn(process.execPath, [entry, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    } catch (e) {
      settle({ status: null, spawnError: e instanceof Error ? e.message : String(e) }, false);
      return;
    }
    const started = child;
    liveChildren.add(started);
    // Settles on its own clock: waiting for 'close' would wait for every
    // process still holding the pipes.
    clocks.budget = setTimeout(() => {
      timedOut = true;
      const stopped = killTree(started);
      settle({ status: null, ...(stopped || started.pid === undefined ? {} : { unstoppedPid: started.pid }) }, false);
    }, Math.max(budgetMs, 1));
    started.stdout?.on('data', (chunk: Buffer) => { out.push(chunk); });
    started.stderr?.on('data', (chunk: Buffer) => { err.push(chunk); });
    started.once('error', (e) => settle({ status: null, spawnError: e.message }, false));
    started.once('exit', (status) => {
      if (settled) return;
      // It finished in time: how it exited is the verdict, not the budget clock.
      clearTimeout(clocks.budget);
      clocks.grace = setTimeout(() => settle({ status }, true), EXIT_GRACE_MS);
    });
    started.once('close', (status) => settle({ status }, false));
    started.stdin?.on('error', () => { /* the child exited before reading; its status says why */ });
    started.stdin?.end(stdin ?? '');
  });
}

function tail(text: string, max = 300): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

interface Verdict { ok: true; result: string; keep?: string }
interface Failure { ok: false; reason: string; fix: string }

interface StepSpec {
  id: JourneyStepId;
  did: string;
  args: () => string[];
  stdin?: () => string;
  check: (stdout: string) => Verdict | Failure;
}

export async function runInstallJourney(options: JourneyOptions, testHooks: JourneyTestHooks = {}): Promise<JourneyResult> {
  const started = Date.now();
  const timeoutMs = testHooks.timeoutMs ?? JOURNEY_TIMEOUT_MS;
  const entry = testHooks.cliEntry ?? path.join(options.packageRoot, 'dist', 'transports', 'cli', 'cli.js');
  const nonce = crypto.randomBytes(5).toString('hex');
  const noteText = `journey check ${nonce}`;
  const payload = `journey message ${nonce}`;
  const steps: JourneyStep[] = [];
  let timedOut = false;
  let failedStep: JourneyStepId | undefined;
  let storedName = '';
  let messageId = '';

  let scratch = '';
  let cleaned = false;
  let cleanupError: string | undefined;
  const stopSignalCleanup = cleanUpOnSignals();
  try {
    scratch = path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-journey-')));
    liveScratch.add(scratch);
    const dataDir = path.join(scratch, '.memesh');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    // Without this the CLI starts a detached update check that would reach
    // the network and outlive the folder we are about to delete.
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ updateCheck: false }), { mode: 0o600 });
    const env = journeyEnv(scratch);

    if (!fs.existsSync(entry)) {
      steps.push({
        id: 'remember', did: 'Start the installed memesh command', ok: false, result: 'not found', ms: 0,
        reason: `${entry} does not exist, so the installed package is incomplete.`, fix: REINSTALL,
      });
      failedStep = 'remember';
    }

    const specs: StepSpec[] = [
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
          if (!entities) return { ok: false, reason: `recall printed something that is not a result list: ${tail(out) || '(nothing)'}`, fix: REINSTALL };
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
  } catch (err) {
    // A failure of the harness itself (the temp folder, the filesystem) is
    // still a failed journey with a reason, never an exception to the caller.
    const id: JourneyStepId = 'prepare';
    steps.push({
      id, did: 'Prepare the throwaway folder', ok: false, result: 'could not prepare', ms: 0,
      reason: err instanceof Error ? err.message : String(err),
      fix: 'Check that the system temp folder exists, is writable and has free space (it is set by TMPDIR, or TEMP/TMP on Windows), then run `memesh doctor --journey`.',
    });
    failedStep = id;
  } finally {
    if (scratch === '') {
      cleaned = true; // nothing was created
    } else {
      try {
        fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        cleaned = !fs.existsSync(scratch);
        if (!cleaned) cleanupError = 'folder still present after removal';
      } catch (err) {
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

export function formatJourney(result: JourneyResult): string[] {
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
  if (!result.cleaned) lines.push(`Note: the throwaway folder ${result.scratchDir} could not be removed (${result.cleanupError ?? 'unknown reason'}); it is safe to delete by hand.`);
  return lines;
}

// --- the record `memesh doctor` reads ---

export interface JourneyRecord {
  ok: boolean;
  at: string;
  version: string;
  trigger: 'install-hooks' | 'setup' | 'doctor';
  failedStep?: JourneyStepId;
  reason?: string;
  fix?: string;
}

export function journeyRecordPath(dir: string = getMemeshDirFromDbPath()): string {
  return path.join(dir, 'post-install-journey.json');
}

export function toJourneyRecord(result: JourneyResult, version: string, trigger: JourneyRecord['trigger'], now: Date = new Date()): JourneyRecord {
  const failed = result.steps.find((s) => !s.ok);
  return {
    ok: result.ok, at: now.toISOString(), version, trigger,
    ...(failed ? { failedStep: failed.id, reason: failed.reason, fix: failed.fix } : {}),
  };
}

/**
 * Written to a new private file and renamed into place: a rename replaces the
 * name itself, so a symlink left at the record's path is replaced instead of
 * followed (it used to overwrite whatever the link pointed at), and a reader
 * never sees a half-written record.
 */
export function writeJourneyRecord(record: JourneyRecord, dir: string = getMemeshDirFromDbPath()): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = journeyRecordPath(dir);
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
      fs.fchmodSync(fd, 0o600);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, target);
  } catch (err) {
    try { fs.unlinkSync(temporary); } catch { /* never created, or already renamed */ }
    throw err;
  }
}

/** `undefined` = never recorded. A record that cannot be read is reported, not hidden. */
export function readJourneyRecord(dir: string = getMemeshDirFromDbPath()): JourneyRecord | undefined | { unreadable: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(journeyRecordPath(dir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return { unreadable: err instanceof Error ? err.message : String(err) };
  }
  const json = asRecord(parseJson(raw));
  const complete = json !== undefined && typeof json.ok === 'boolean' && typeof json.at === 'string' && typeof json.version === 'string'
    // A failure record says which step and why; without them doctor would print "undefined".
    && (json.ok || (typeof json.failedStep === 'string' && typeof json.reason === 'string'));
  if (!json || !complete) {
    return { unreadable: 'post-install-journey.json is not a journey record' };
  }
  return json as unknown as JourneyRecord;
}

/**
 * A manual `memesh doctor --journey` writes nothing into ~/.memesh, with one
 * exception: if an install already left a readable, valid record there, the
 * fresh result replaces it, so `memesh doctor` stops warning about a failure
 * that is fixed. No record, or one that cannot be read or is not a record: no
 * write, no folder created.
 */
export function refreshExistingJourneyRecord(result: JourneyResult, version: string): void {
  const existing = readJourneyRecord();
  if (existing === undefined || 'unreadable' in existing) return;
  try {
    writeJourneyRecord(toJourneyRecord(result, version, 'doctor'));
  } catch (err) {
    console.error(`Could not update the saved journey result: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** True when the user switched the automatic run off (flag or environment). */
export function journeySkipped(flagNoJourney: boolean | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (flagNoJourney === false) return true; // commander's --no-journey sets journey=false
  const raw = env[JOURNEY_SKIP_ENV];
  return raw !== undefined && raw !== '' && raw !== '0' && raw.toLowerCase() !== 'false';
}

/**
 * Run after a successful install step. Never throws and never changes the
 * caller's exit code: a failed journey is printed loudly and recorded for
 * `memesh doctor`, nothing more.
 */
export async function runPostInstallJourney(input: {
  packageRoot: string;
  version: string;
  trigger: 'install-hooks' | 'setup';
  /** commander's `opts.journey`: false when --no-journey was given. */
  journeyFlag?: boolean;
}, testHooks: JourneyTestHooks = {}): Promise<void> {
  if (journeySkipped(input.journeyFlag)) {
    console.log(`Install journey skipped (${input.journeyFlag === false ? '--no-journey' : JOURNEY_SKIP_ENV}). Run it any time: memesh doctor --journey`);
    return;
  }
  console.log('');
  try {
    const result = await runInstallJourney({ packageRoot: input.packageRoot }, testHooks);
    const lines = formatJourney(result);
    if (result.ok) {
      for (const line of lines) console.log(line);
    } else {
      for (const line of lines) console.error(line);
      console.error('The install itself finished; this does not undo it. `memesh doctor` will keep showing this until the journey passes.');
    }
    try {
      writeJourneyRecord(toJourneyRecord(result, input.version, input.trigger));
    } catch (err) {
      console.error(`Could not save the journey result for \`memesh doctor\`: ${err instanceof Error ? err.message : String(err)}`);
    }
  } catch (err) {
    console.error(`Install journey could not run: ${err instanceof Error ? err.message : String(err)}`);
  }
}
