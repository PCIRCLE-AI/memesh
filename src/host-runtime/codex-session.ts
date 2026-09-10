#!/usr/bin/env node

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalAgentScopeId } from '../core/agent-scope-id.js';
import { getAgentRouterSocketPath, getMemeshDirFromDbPath, getProjectName } from '../core/paths.js';
import {
  assertSecureLocalHostRuntimeSupported,
  ensureRouterTokenFile,
  readHostConfigFile,
  readTokenFile,
  normalizeConfiguredRouterSocket,
  requiredString,
} from './config.js';
import { connectRouterHost, type RouterHostConnection } from './router-client.js';

const MAX_HOOK_INPUT_BYTES = 64 * 1024;
const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CodexSessionHostConfig extends Record<string, unknown> {
  router_socket: unknown;
  token_file: unknown;
  project: unknown;
  principal_id: unknown;
  workspace: unknown;
  model?: unknown;
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
      || typeof state.thread_id !== 'string' || !CODEX_THREAD_ID.test(state.thread_id)
      || typeof state.workspace !== 'string' || !path.isAbsolute(state.workspace)
      || typeof state.token !== 'string' || !/^[0-9a-f]{32}$/.test(state.token)
      || typeof state.control_socket !== 'string' || !path.isAbsolute(state.control_socket)) return null;
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

async function launchDetachedCompanion(
  dataDir: string,
  session: ValidCodexSessionStart,
  input: CodexSessionStartInput,
): Promise<void> {
  const directory = lifecycleDirectory(dataDir);
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
    while (Date.now() < deadline) {
      if (readCompanionState(statePath)?.pid === child.pid) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Detached Codex companion did not publish its lifecycle state before the hook timeout.');
  } catch (error) {
    child?.kill('SIGTERM');
    try { fs.unlinkSync(launchFile); } catch (unlinkError) {
      if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
    }
    throw error;
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

function removeStaleState(statePath: string, state: CodexCompanionState): void {
  if (!pidIsGone(state.pid)) return;
  removeOwnState(statePath, state.token);
  try {
    const stat = fs.lstatSync(state.control_socket);
    if (stat.isSocket()) fs.unlinkSync(state.control_socket);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
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
    removeStaleState(statePath, state);
    if (fs.existsSync(statePath)) {
      throw new Error('Prior exact Codex companion did not prove its identity over its control socket; refusing PID-based termination.');
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
    server.once('error', reject);
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
      ...(selected.model === undefined ? {} : { model: selected.model }),
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
  if (typeof threadId !== 'string' || !CODEX_THREAD_ID.test(threadId)) return null;

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
  if (typeof threadId !== 'string' || !CODEX_THREAD_ID.test(threadId)) return null;
  return { threadId, workspace: requiredExistingDirectory(hookInput.cwd, 'cwd', realpath) };
}

interface ResolvedCodexSessionConfig {
  router_socket: string;
  auth_token: string;
  project: string;
  principal_id: string;
  model?: string;
  work_summary?: string;
}

function configuredCodexSessionConfig(
  config: CodexSessionHostConfig,
  session: ValidCodexSessionStart,
  realpath: typeof fs.realpathSync,
): ResolvedCodexSessionConfig {
  const configuredWorkspace = resolveConfiguredWorkspace(config.workspace, realpath);
  if (configuredWorkspace === null || configuredWorkspace !== session.workspace) {
    return automaticCodexSessionConfig(session);
  }
  const resolved: ResolvedCodexSessionConfig = {
    router_socket: normalizeConfiguredRouterSocket(config.router_socket),
    auth_token: readTokenFile(config.token_file),
    project: requiredString(config.project, 'project'),
    principal_id: requiredString(config.principal_id, 'principal_id'),
    ...(config.model == null ? {} : { model: requiredString(config.model, 'model') }),
    ...(config.work_summary == null ? {} : { work_summary: requiredString(config.work_summary, 'work_summary') }),
  };
  return resolved;
}

function resolveConfiguredWorkspace(
  value: unknown,
  realpath: typeof fs.realpathSync,
): string | null {
  const workspace = requiredAbsolutePath(value, 'workspace');
  try {
    const resolved = realpath(workspace);
    if (!fs.statSync(resolved).isDirectory()) throw new Error('workspace must be a directory.');
    return resolved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function automaticCodexSessionConfig(session: ValidCodexSessionStart): ResolvedCodexSessionConfig {
  assertSecureLocalHostRuntimeSupported();
  const dataDir = getMemeshDirFromDbPath();
  ensureOwnerPrivateDataDirectory(dataDir);
  return {
    router_socket: getAgentRouterSocketPath(),
    auth_token: ensureRouterTokenFile(path.join(dataDir, 'agent-router.token')),
    project: canonicalAgentScopeId(getProjectName(session.workspace)),
    principal_id: `codex-thread-${session.threadId}`,
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

async function endExactCodexSessionCompanion(dataDir: string, session: ValidCodexSessionStart): Promise<void> {
  const statePath = codexCompanionStatePath(dataDir, session.threadId);
  const state = readCompanionState(statePath);
  if (!state) {
    if (fs.existsSync(statePath)) throw new Error('Codex companion lifecycle state is malformed; refusing SessionEnd cleanup.');
    return;
  }
  if (state.thread_id !== session.threadId || state.workspace !== session.workspace) {
    throw new Error('Codex SessionEnd does not match the stored companion identity; refusing cross-thread termination.');
  }
  if (await requestExactCompanionControl(state, 'retire')) return;
  removeStaleState(statePath, state);
  if (fs.existsSync(statePath)) {
    throw new Error('Codex SessionEnd could not prove the stored companion identity; refusing PID-based termination.');
  }
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

async function runDetachedCompanion(dataDir: string, input: CodexSessionStartInput): Promise<void> {
  const session = validateCodexSessionStart(input, { PLUGIN_ROOT: process.env.PLUGIN_ROOT }, fs.realpathSync);
  if (!session) return;
  ensureOwnerPrivateDataDirectory(dataDir);
  await terminatePriorExactCompanion(dataDir, session);
  const statePath = codexCompanionStatePath(dataDir, session.threadId);
  const token = randomBytes(16).toString('hex');
  const socketPath = codexCompanionControlSocketPath(dataDir, session.threadId);
  if (fs.existsSync(socketPath)) throw new Error('Codex companion control socket already exists; refusing to replace it.');
  let closing = false;
  let retirement: NodeJS.Timeout | null = null;
  let connection: RouterHostConnection | null = null;
  let control: net.Server | null = null;
  const close = () => {
    if (closing) return;
    closing = true;
    void (async () => {
      let failed = false;
      try { await connection?.close(); } catch { failed = true; }
      await new Promise<void>((resolve) => control?.close(() => resolve()) ?? resolve());
      try {
        const stat = fs.lstatSync(socketPath);
        if (stat.isSocket()) fs.unlinkSync(socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failed = true;
      }
      removeOwnState(statePath, token);
      process.exit(failed ? 1 : 0);
    })();
  };
  const controlLifecycle = (action: 'terminate' | 'retire') => {
    if (action === 'terminate') {
      if (retirement) clearTimeout(retirement);
      close();
      return;
    }
    if (retirement || closing) return;
    retirement = setTimeout(close, SESSION_END_GRACE_MS);
  };
  try {
    control = await createCompanionControlServer(socketPath, token, controlLifecycle);
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
    });
  } catch (error) {
    await connection?.close();
    await new Promise<void>((resolve) => control?.close(() => resolve()) ?? resolve());
    try { fs.unlinkSync(socketPath); } catch (unlinkError) {
      if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
    }
    removeOwnState(statePath, token);
    throw error;
  }
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

async function main(): Promise<void> {
  const dataDir = getMemeshDirFromDbPath();
  if (process.argv[2] === '--companion') {
    const launchFile = process.argv[3];
    if (typeof launchFile !== 'string') throw new Error('Codex companion launch input is required.');
    await runDetachedCompanion(dataDir, readDetachedLaunchInput(dataDir, launchFile));
    return;
  }
  const input = await readHookInput();
  const ending = validateCodexSessionEnd(input, { PLUGIN_ROOT: process.env.PLUGIN_ROOT }, fs.realpathSync);
  if (ending) {
    ensureOwnerPrivateDataDirectory(dataDir);
    await endExactCodexSessionCompanion(dataDir, ending);
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
  } catch {
    process.stderr.write('memesh-host-codex-session: session registration failed.\n');
    process.exitCode = 1;
  }
}
