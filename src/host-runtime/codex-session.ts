#!/usr/bin/env node

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalAgentScopeId } from '../core/agent-scope-id.js';
import {
  automaticCodexSessionPrincipal,
  isValidCodexThreadId,
  resolveCodexSessionPrincipal,
} from '../core/codex-session-principal.js';
import { getAgentRouterSocketPath, getMemeshDirFromDbPath, getProjectName } from '../core/paths.js';
import {
  assertSecureLocalHostRuntimeSupported,
  ensureRouterTokenFile,
  readHostConfigFile,
  readTokenFile,
  normalizeConfiguredRouterSocket,
  requiredString,
} from './config.js';
import { AgentRouterProtocolError } from '../core/agent-router.js';
import { connectRouterHost, routerOutdatedDetail, type RouterHostConnection } from './router-client.js';

const MAX_HOOK_INPUT_BYTES = 64 * 1024;

export interface CodexSessionHostConfig extends Record<string, unknown> {
  router_socket: unknown;
  token_file: unknown;
  /** Ignored (#474) — `configuredCodexSessionConfig` derives the routing
   *  project from `workspace` instead. Kept only so an old config file that
   *  still has this field does not fail to parse. */
  project?: unknown;
  principal_id: unknown;
  workspace: unknown;
  work_summary?: unknown;
}

export interface CodexSessionStartInput {
  hook_event_name?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  source?: unknown;
}

interface CodexCompanionState {
  version: 1;
  pid: number;
  thread_id: string;
  workspace: string;
  token: string;
  control_socket: string;
  /** The inode of the socket this companion bound. Absent in a record from before #518, whose socket is then never removed on its behalf. */
  control_socket_ino?: string;
}

export interface CodexSessionCompanionDependencies {
  connect?: typeof connectRouterHost;
  realpath?: typeof fs.realpathSync;
}

interface ValidCodexSessionStart {
  threadId: string;
  workspace: string;
}

const CONTROL_TIMEOUT_MS = 2_000;
const SESSION_END_GRACE_MS = 45_000;

function lifecycleDirectory(dataDir: string): string {
  const directory = path.join(dataDir, 'runtime', 'codex-session');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Codex companion lifecycle directory must be a real private directory.');
  fs.chmodSync(directory, 0o700);
  return directory;
}

export function codexCompanionStatePath(dataDir: string, threadId: string): string {
  return path.join(lifecycleDirectory(dataDir), `${threadId}.json`);
}

export function codexCompanionControlSocketPath(dataDir: string, threadId: string): string {
  const digest = createHash('sha256').update(threadId).digest('hex').slice(0, 8);
  // Keep this filename shorter than agent-router-v2.sock. Any data directory
  // already accepted by the router therefore also fits macOS AF_UNIX limits.
  return path.join(dataDir, `c-${digest}.sock`);
}

function readCompanionState(statePath: string): CodexCompanionState | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(statePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const state = parsed as Partial<CodexCompanionState>;
    if (state.version !== 1 || typeof state.pid !== 'number' || !Number.isSafeInteger(state.pid) || state.pid <= 1
      || !isValidCodexThreadId(state.thread_id)
      || typeof state.workspace !== 'string' || !path.isAbsolute(state.workspace)
      || typeof state.token !== 'string' || !/^[0-9a-f]{32}$/.test(state.token)
      || typeof state.control_socket !== 'string' || !path.isAbsolute(state.control_socket)
      || (state.control_socket_ino !== undefined
        && (typeof state.control_socket_ino !== 'string' || !/^[0-9]+$/.test(state.control_socket_ino)))) return null;
    return state as CodexCompanionState;
  } catch (error) {
    if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writeCompanionState(statePath: string, state: CodexCompanionState): void {
  const temporary = `${statePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(state)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, statePath);
  fs.chmodSync(statePath, 0o600);
}

function writePrivateJson(file: string, value: unknown): void {
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/** A start refused for a reason the user can act on. It reaches the launcher the way an outdated router's reason does. */
class CompanionRefusal extends Error {}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The detached companion has no stdio, so why it could not stop cleanly is
 * appended to an owner-private log in the data directory. If even that fails,
 * stderr is the last channel left.
 */
function recordCompanionFailure(dataDir: string, line: string): void {
  const text = `[${new Date().toISOString()}] ${line}\n`;
  try {
    fs.appendFileSync(path.join(dataDir, 'codex-companion.log'), text, { mode: 0o600 });
  } catch (error) {
    fs.writeSync(2, `memesh-host-codex-session: ${text.trimEnd()} (log unwritable: ${errorText(error)})\n`);
  }
}

/** The one-line reason to show a user for `error`, else ''. */
function companionFailureDetail(error: unknown): string {
  return routerOutdatedDetail(error) || (error instanceof CompanionRefusal ? ` ${error.message}` : '');
}

/**
 * The detached companion runs with no stdio, so a reason the user must act on
 * (an outdated router, #518) travels back to the waiting SessionStart
 * launcher through this owner-private file. It is named after the launch file,
 * which is random per launch, so a reused pid never reads another launch's reason.
 */
function companionFailurePath(launchFile: string): string {
  return `${launchFile}.failed`;
}

/**
 * A reason no launcher is still waiting for (its launcher was killed or timed
 * out), or the temporary file of a companion that died before renaming it.
 */
function removeUnclaimedFailures(directory: string): void {
  const cutoff = Date.now() - 60_000;
  for (const name of fs.readdirSync(directory)) {
    if (!/\.failed(\.[0-9a-f]{12}\.tmp)?$/.test(name)) continue;
    const file = path.join(directory, name);
    try {
      if (fs.lstatSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function publishCompanionFailure(file: string, value: unknown): void {
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  writePrivateJson(temporary, value);
  fs.renameSync(temporary, file);
}

function takeCompanionFailure(file: string): Error | null {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  fs.unlinkSync(file);
  const parsed = JSON.parse(raw) as { code?: unknown; message?: unknown };
  if (typeof parsed.message !== 'string') return null;
  if (parsed.code === 'router_outdated') return new AgentRouterProtocolError('router_outdated', parsed.message.slice(0, 1000));
  if (parsed.code === 'companion_busy') return new CompanionRefusal(parsed.message.slice(0, 1000));
  return null;
}

async function launchDetachedCompanion(
  dataDir: string,
  session: ValidCodexSessionStart,
  input: CodexSessionStartInput,
): Promise<void> {
  const directory = lifecycleDirectory(dataDir);
  removeUnclaimedFailures(directory);
  const launchFile = path.join(directory, `launch-${process.pid}-${randomBytes(8).toString('hex')}.json`);
  writePrivateJson(launchFile, input);
  let child: ReturnType<typeof spawn> | null = null;
  try {
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--companion', launchFile], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    if (!Number.isSafeInteger(child.pid)) throw new Error('Detached Codex companion did not receive a process identity.');
    child.unref();
    const statePath = codexCompanionStatePath(dataDir, session.threadId);
    const deadline = Date.now() + CONTROL_TIMEOUT_MS;
    const failurePath = companionFailurePath(launchFile);
    // Check, then stop at the deadline, then wait: the last check always comes
    // after the last wait, so a reason published just before the deadline wins.
    for (;;) {
      if (readCompanionState(statePath)?.pid === child.pid) return;
      const failure = takeCompanionFailure(failurePath);
      if (failure) throw failure;
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Detached Codex companion did not publish its lifecycle state before the hook timeout.');
  } catch (error) {
    // Stop the companion and wait for it to finish its own cleanup, so the next
    // start does not meet its socket and a reason it published meanwhile is still shown.
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const stopped = Date.now() + CONTROL_TIMEOUT_MS;
      while (child.exitCode === null && child.signalCode === null && Date.now() < stopped) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    let outcome: unknown;
    try { outcome = takeCompanionFailure(companionFailurePath(launchFile)) ?? error; } catch (takeError) { outcome = takeError; }
    for (const file of [launchFile, companionFailurePath(launchFile)]) {
      try { fs.unlinkSync(file); } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
      }
    }
    throw outcome;
  }
}

function readDetachedLaunchInput(dataDir: string, launchFile: string): CodexSessionStartInput {
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
      const parsed: unknown = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Codex companion launch input must be an object.');
      }
      return parsed as CodexSessionStartInput;
    } finally {
      fs.unlinkSync(launchFile);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function removeOwnState(statePath: string, token: string): void {
  const state = readCompanionState(statePath);
  if (state?.token === token) fs.unlinkSync(statePath);
}

function pidIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function socketInode(socketPath: string): string {
  return String(fs.lstatSync(socketPath, { bigint: true }).ino);
}

/** Whether `socketPath` is still the socket with inode `ino`. */
function socketIsSame(socketPath: string, ino: string | undefined): boolean {
  if (ino === undefined) return false;
  try {
    const stat = fs.lstatSync(socketPath, { bigint: true });
    return stat.isSocket() && String(stat.ino) === ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** How to check a control socket is unused before deleting it by hand. */
function unusedSocketCheck(socketPath: string): string {
  return `If \`lsof -U | grep '${socketPath}'\` prints nothing, delete that file`;
}

function legacySocketNote(socketPath: string): string {
  return `its record came from an older MeMesh and did not say which socket was its own, so ${socketPath} is left in place. `
    + `${unusedSocketCheck(socketPath)}`;
}

/**
 * Clear the record of a companion whose process is gone. Returns the socket
 * path it had to leave in place (a record from before #518 names no inode),
 * else null.
 */
function removeStaleState(statePath: string, state: CodexCompanionState): string | null {
  if (!pidIsGone(state.pid)) return null;
  // Move the record aside in one step: only the process whose rename took THIS
  // record may remove its socket, so two cleaners cannot both act on it.
  const taken = `${statePath}.${randomBytes(6).toString('hex')}.stale`;
  try { fs.renameSync(statePath, taken); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (readCompanionState(taken)?.token !== state.token) {
    // A newer companion replaced the record after it was read: put it back, touch nothing else.
    try { fs.linkSync(taken, statePath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    fs.unlinkSync(taken);
    return null;
  }
  fs.unlinkSync(taken);
  if (socketIsSame(state.control_socket, state.control_socket_ino)) {
    fs.unlinkSync(state.control_socket);
  } else if (state.control_socket_ino === undefined && fs.existsSync(state.control_socket)) {
    return state.control_socket;
  }
  return null;
}

/** Ask a running companion to terminate/retire over its control socket. Exported so `scripts/qa/live-journey.mjs` speaks the one protocol instead of a copy. */
export async function requestExactCompanionControl(
  state: CodexCompanionState,
  action: 'terminate' | 'retire',
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(state.control_socket);
    let response = '';
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
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

async function terminatePriorExactCompanion(dataDir: string, session: ValidCodexSessionStart): Promise<void> {
  const statePath = codexCompanionStatePath(dataDir, session.threadId);
  const state = readCompanionState(statePath);
  if (!state) {
    if (fs.existsSync(statePath)) throw new Error('Codex companion lifecycle state is malformed; refusing to replace it.');
    return;
  }
  if (state.thread_id !== session.threadId || state.workspace !== session.workspace) {
    throw new Error('Codex companion lifecycle state belongs to another exact session; refusing cross-thread termination.');
  }
  if (!await requestExactCompanionControl(state, 'terminate')) {
    const leftSocket = removeStaleState(statePath, state);
    if (leftSocket) {
      throw new CompanionRefusal(`companion_busy: the last MeMesh companion for this Codex session has exited, but ${legacySocketNote(leftSocket)} `
        + 'and start the session again.');
    }
    if (fs.existsSync(statePath)) {
      const current = readCompanionState(statePath);
      if (current?.token !== state.token) {
        throw new CompanionRefusal(`companion_busy: another MeMesh companion for this Codex session replaced ${statePath} while this start was checking it. `
          + `Start the session again${current ? `; if this keeps happening, check that \`ps -p ${current.pid}\` is a MeMesh companion` : ''}.`);
      }
      // Its process is still running: never signal a PID on the record's word alone.
      throw new CompanionRefusal(`companion_busy: process ${state.pid}, which ${statePath} names as this Codex session's companion, `
        + `is still running but does not answer on ${state.control_socket}. If \`ps -p ${state.pid}\` shows a MeMesh companion, `
        + `stop it with \`kill ${state.pid}\`; otherwise delete ${statePath}. Then start the session again.`);
    }
    return;
  }
  const deadline = Date.now() + CONTROL_TIMEOUT_MS;
  while (fs.existsSync(statePath) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (fs.existsSync(statePath)) throw new Error('Prior exact Codex companion acknowledged termination but did not remove its lifecycle state.');
}

export async function supersedeCodexSessionCompanion(
  dataDir: string,
  hookInput: CodexSessionStartInput,
  environment: { PLUGIN_ROOT?: string },
  realpath: typeof fs.realpathSync = fs.realpathSync,
): Promise<boolean> {
  const session = validateCodexSessionStart(hookInput, environment, realpath);
  if (!session) return false;
  await terminatePriorExactCompanion(dataDir, session);
  return true;
}

function createCompanionControlServer(
  socketPath: string,
  token: string,
  control: (action: 'terminate' | 'retire') => void,
): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let input = '';
      // A peer that hangs up before the reply would otherwise crash this process with EPIPE.
      socket.on('error', () => {});
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => { input += chunk; });
      socket.once('end', () => {
        try {
          const message: unknown = JSON.parse(input.trim());
          const record = message as { action?: unknown; token?: unknown };
          if ((record.action !== 'terminate' && record.action !== 'retire') || record.token !== token) {
            socket.end('rejected\n');
            return;
          }
          socket.end('terminated\n');
          queueMicrotask(() => control(record.action as 'terminate' | 'retire'));
        } catch {
          socket.end('rejected\n');
        }
      });
    });
    server.once('error', (error: NodeJS.ErrnoException) => reject(error.code === 'EADDRINUSE'
      ? new CompanionRefusal(`companion_busy: ${socketPath} is still in place, and nothing records whether an earlier companion `
        + `for this Codex session still uses it. ${unusedSocketCheck(socketPath)} and start the session again.`)
      : error));
    server.listen(socketPath, () => resolve(server));
  });
}

/**
 * Bind one living Codex hook process to the router for the lifetime of the
 * ordinary CLI session. The router invokes native queue locally; this process
 * supplies authenticated presence and heartbeats while the adapter receives
 * the bounded full message.
 */
export async function startCodexSessionCompanion(
  config: CodexSessionHostConfig | undefined,
  hookInput: CodexSessionStartInput,
  environment: { PLUGIN_ROOT?: string },
  dependencies: CodexSessionCompanionDependencies = {},
): Promise<RouterHostConnection | null> {
  const realpath = dependencies.realpath ?? fs.realpathSync;
  const session = validateCodexSessionStart(hookInput, environment, realpath);
  if (!session) return null;
  return connectCodexSessionCompanion(config, session, realpath, dependencies.connect ?? connectRouterHost);
}

function connectCodexSessionCompanion(
  config: CodexSessionHostConfig | undefined,
  session: ValidCodexSessionStart,
  realpath: typeof fs.realpathSync,
  connect: typeof connectRouterHost,
): Promise<RouterHostConnection> {
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

function validateCodexSessionStart(
  hookInput: CodexSessionStartInput,
  environment: { PLUGIN_ROOT?: string },
  realpath: typeof fs.realpathSync,
): ValidCodexSessionStart | null {
  if (hookInput.hook_event_name !== 'SessionStart') return null;
  if (hookInput.source !== 'startup' && hookInput.source !== 'resume') return null;
  if (typeof environment.PLUGIN_ROOT !== 'string' || environment.PLUGIN_ROOT.length === 0) return null;

  const threadId = hookInput.session_id;
  if (!isValidCodexThreadId(threadId)) return null;

  return {
    threadId,
    workspace: requiredExistingDirectory(hookInput.cwd, 'cwd', realpath),
  };
}

function validateCodexSessionEnd(
  hookInput: CodexSessionStartInput,
  environment: { PLUGIN_ROOT?: string },
  realpath: typeof fs.realpathSync,
): ValidCodexSessionStart | null {
  if (hookInput.hook_event_name !== 'SessionEnd') return null;
  if (typeof environment.PLUGIN_ROOT !== 'string' || environment.PLUGIN_ROOT.length === 0) return null;
  const threadId = hookInput.session_id;
  if (!isValidCodexThreadId(threadId)) return null;
  return { threadId, workspace: requiredExistingDirectory(hookInput.cwd, 'cwd', realpath) };
}

interface ResolvedCodexSessionConfig {
  router_socket: string;
  auth_token: string;
  project: string;
  principal_id: string;
  work_summary?: string;
}

function configuredCodexSessionConfig(
  config: CodexSessionHostConfig,
  session: ValidCodexSessionStart,
  realpath: typeof fs.realpathSync,
): ResolvedCodexSessionConfig {
  // The workspace-match decision (does this config apply to THIS session, or
  // does it fall back to the automatic identity) is the one piece the
  // SessionStart hook needs too — factored into `resolveCodexSessionPrincipal`
  // (src/core/codex-session-principal.ts) so the hook and the router
  // registration can never disagree about a Codex session's principal.
  const principal = resolveCodexSessionPrincipal(config, session, realpath);
  if (principal.source === 'automatic') {
    return automaticCodexSessionConfig(session);
  }
  const resolved: ResolvedCodexSessionConfig = {
    router_socket: normalizeConfiguredRouterSocket(config.router_socket),
    auth_token: readTokenFile(config.token_file),
    // #474: same derivation `automaticCodexSessionConfig` below uses.
    // `config.project` used to be taken verbatim here, so a workspace set up
    // with the documented bare-label example (`agent setup codex-session
    // --project my-project`) registered under a project no other host in
    // the same directory would ever derive — the exact cross-host discovery
    // gap this fix closes, just reached through this override instead of
    // the Claude default. The override's real, remaining purpose is a
    // STABLE PRINCIPAL for one workspace (see `principal_id` below); the
    // project was always incidental to that.
    project: canonicalAgentScopeId(getProjectName(session.workspace)),
    principal_id: requiredString(principal.principalId, 'principal_id'),
    ...(config.work_summary == null ? {} : { work_summary: requiredString(config.work_summary, 'work_summary') }),
  };
  return resolved;
}

function automaticCodexSessionConfig(session: ValidCodexSessionStart): ResolvedCodexSessionConfig {
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

function ensureOwnerPrivateDataDirectory(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dataDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('The MeMesh data directory must be a real owner-private directory.');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('The MeMesh data directory must be owned by the current user.');
  }
  fs.chmodSync(dataDir, 0o700);
  if ((fs.lstatSync(dataDir).mode & 0o077) !== 0) {
    throw new Error('The MeMesh data directory must be owner-private.');
  }
}

function requiredAbsolutePath(value: unknown, field: string): string {
  const result = requiredString(value, field);
  if (!path.isAbsolute(result)) throw new Error(`${field} must be an absolute path.`);
  return result;
}

function requiredExistingDirectory(
  value: unknown,
  field: string,
  realpath: typeof fs.realpathSync,
): string {
  const resolved = realpath(requiredAbsolutePath(value, field));
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`${field} must be a directory.`);
  return resolved;
}

async function readHookInput(): Promise<CodexSessionStartInput> {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input, 'utf8') > MAX_HOOK_INPUT_BYTES) {
      throw new Error('Codex SessionStart hook input exceeds the byte limit.');
    }
  }
  const value: unknown = JSON.parse(input);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Codex SessionStart hook input must be an object.');
  }
  return value as CodexSessionStartInput;
}

/** Returns a note for the user when the session ended but something had to be left in place, else null. */
async function endExactCodexSessionCompanion(dataDir: string, session: ValidCodexSessionStart): Promise<string | null> {
  const statePath = codexCompanionStatePath(dataDir, session.threadId);
  const state = readCompanionState(statePath);
  if (!state) {
    if (fs.existsSync(statePath)) throw new Error('Codex companion lifecycle state is malformed; refusing SessionEnd cleanup.');
    return null;
  }
  if (state.thread_id !== session.threadId || state.workspace !== session.workspace) {
    throw new Error('Codex SessionEnd does not match the stored companion identity; refusing cross-thread termination.');
  }
  if (await requestExactCompanionControl(state, 'retire')) return null;
  const leftSocket = removeStaleState(statePath, state);
  if (leftSocket) return `session ended. Its companion had already exited, but ${legacySocketNote(leftSocket)}.`;
  if (fs.existsSync(statePath)) {
    throw new Error('Codex SessionEnd could not prove the stored companion identity; refusing PID-based termination.');
  }
  return null;
}

export async function endCodexSessionCompanion(
  dataDir: string,
  hookInput: CodexSessionStartInput,
  environment: { PLUGIN_ROOT?: string },
  realpath: typeof fs.realpathSync = fs.realpathSync,
): Promise<boolean> {
  const session = validateCodexSessionEnd(hookInput, environment, realpath);
  if (!session) return false;
  await endExactCodexSessionCompanion(dataDir, session);
  return true;
}

async function runDetachedCompanion(
  dataDir: string,
  input: CodexSessionStartInput,
  failurePath: string,
): Promise<void> {
  const session = validateCodexSessionStart(input, { PLUGIN_ROOT: process.env.PLUGIN_ROOT }, fs.realpathSync);
  if (!session) return;
  ensureOwnerPrivateDataDirectory(dataDir);
  const statePath = codexCompanionStatePath(dataDir, session.threadId);
  const token = randomBytes(16).toString('hex');
  const socketPath = codexCompanionControlSocketPath(dataDir, session.threadId);
  let socketIno: string | undefined;
  let retirement: NodeJS.Timeout | null = null;
  let connection: RouterHostConnection | null = null;
  let control: net.Server | null = null;
  let cleanup: Promise<boolean> | null = null;
  // The one cleanup path. Signals, control requests, retirement and a failed
  // start all share it; it runs once. Closing a listening server unlinks its
  // pathname by name (libuv), whoever holds that pathname by then, so the server
  // is closed only while the pathname is still this process's socket. Otherwise
  // it stays open until the process exits, which removes nothing.
  const shutdown = (): Promise<boolean> => cleanup ??= (async () => {
    if (retirement) clearTimeout(retirement);
    const problems: string[] = [];
    try { await connection?.close(); } catch (error) { problems.push(`closing its router connection: ${errorText(error)}`); }
    let ownsPath = false;
    try { ownsPath = socketIsSame(socketPath, socketIno); } catch (error) {
      problems.push(`checking ${socketPath}, left in place: ${errorText(error)}`);
    }
    if (ownsPath) await new Promise<void>((resolve) => control?.close(() => resolve()) ?? resolve());
    removeOwnState(statePath, token);
    if (problems.length > 0) recordCompanionFailure(dataDir, `companion ${process.pid} stopped with problems: ${problems.join('; ')}`);
    return problems.length > 0;
  })();
  const exitAfterShutdown = () => {
    void shutdown().then((failed) => {
      if (failed) process.exitCode = 1;
      // No argument: a failed start already set exitCode, and must keep it.
      process.exit();
    }, (error: unknown) => {
      recordCompanionFailure(dataDir, `companion ${process.pid} could not finish stopping: ${errorText(error)}`);
      process.exit(1);
    });
  };
  const controlLifecycle = (action: 'terminate' | 'retire') => {
    if (action === 'terminate') {
      exitAfterShutdown();
      return;
    }
    if (retirement || cleanup) return;
    retirement = setTimeout(exitAfterShutdown, SESSION_END_GRACE_MS);
  };
  // From the start, not only after registration: the launcher stops a
  // companion that has not registered by its deadline, and that must still
  // close and remove the control socket.
  process.once('SIGINT', exitAfterShutdown);
  process.once('SIGTERM', exitAfterShutdown);
  try {
    await terminatePriorExactCompanion(dataDir, session);
    control = await createCompanionControlServer(socketPath, token, controlLifecycle);
    socketIno = socketInode(socketPath);
    connection = await connectCodexSessionCompanion(
      readCodexSessionConfigIfPresent(path.join(dataDir, 'hosts', 'codex-session.json')),
      session,
      fs.realpathSync,
      connectRouterHost,
    );
    writeCompanionState(statePath, {
      version: 1,
      pid: process.pid,
      thread_id: session.threadId,
      workspace: session.workspace,
      token,
      control_socket: socketPath,
      control_socket_ino: socketIno,
    });
  } catch (error) {
    process.exitCode = 1;
    try {
      // Published before cleanup: the launcher waits for this process to exit
      // after reading it, and a signal arriving during cleanup cannot drop it.
      const detail = companionFailureDetail(error);
      if (detail) {
        publishCompanionFailure(failurePath, {
          code: error instanceof CompanionRefusal ? 'companion_busy' : 'router_outdated',
          message: (error as Error).message,
        });
      }
    } finally {
      await shutdown();
    }
    throw error;
  }
}

/** What the one stderr line says failed: a SessionEnd is not a registration. */
let failureLead = 'session registration failed.';

async function main(): Promise<void> {
  const dataDir = getMemeshDirFromDbPath();
  if (process.argv[2] === '--companion') {
    const launchFile = process.argv[3];
    if (typeof launchFile !== 'string') throw new Error('Codex companion launch input is required.');
    await runDetachedCompanion(dataDir, readDetachedLaunchInput(dataDir, launchFile), companionFailurePath(launchFile));
    return;
  }
  const input = await readHookInput();
  const ending = validateCodexSessionEnd(input, { PLUGIN_ROOT: process.env.PLUGIN_ROOT }, fs.realpathSync);
  if (ending) {
    failureLead = 'session end failed.';
    ensureOwnerPrivateDataDirectory(dataDir);
    const note = await endExactCodexSessionCompanion(dataDir, ending);
    if (note) fs.writeSync(2, `memesh-host-codex-session: ${note}\n`);
    return;
  }
  const session = validateCodexSessionStart(input, { PLUGIN_ROOT: process.env.PLUGIN_ROOT }, fs.realpathSync);
  if (!session) return;
  ensureOwnerPrivateDataDirectory(dataDir);
  await launchDetachedCompanion(dataDir, session, input);
}

function readCodexSessionConfigIfPresent(configPath: string): CodexSessionHostConfig | undefined {
  try {
    fs.lstatSync(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return readHostConfigFile<CodexSessionHostConfig>(configPath);
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  try {
    return fs.realpathSync(entrypoint) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    await main();
  } catch (error) {
    // Written synchronously, then exit at once: Node's ordinary teardown would
    // close a control server a failed companion left open because its pathname
    // now belongs to another process, and closing it unlinks that pathname.
    fs.writeSync(2, `memesh-host-codex-session: ${failureLead}${companionFailureDetail(error)}\n`);
    process.exit(1);
  }
}
