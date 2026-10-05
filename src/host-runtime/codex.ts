#!/usr/bin/env node

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CodexAppServerDisconnectedError,
  CodexAppServerTimeoutError,
  createCodexAppServerAdapter,
  startCodexAppServerThread,
  type CodexAppServerAdapterOptions,
  type CodexAppServerThread,
  type StartCodexAppServerThreadInput,
} from '../host-adapters/codex-app-server.js';
import { canonicalAgentScopeId } from '../core/agent-scope-id.js';
import { getProjectName } from '../core/paths.js';
import {
  assertSecureLocalHostRuntimeSupported,
  normalizeConfiguredRouterSocket,
  readHostConfig,
  readTokenFile,
  requiredString,
} from './config.js';
import { runHostEntry } from './entry.js';
import { connectRouterHost, type RouterHostConnection } from './router-client.js';

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const STARTUP_RETRY_MS = 50;

type SpawnManagedCodex = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

type StartManagedThread = (
  input: StartCodexAppServerThreadInput,
  options?: CodexAppServerAdapterOptions,
) => Promise<CodexAppServerThread>;

export interface ManagedCodexHostConfig extends Record<string, unknown> {
  router_socket: unknown;
  token_file: unknown;
  /** Ignored (#474) — `normalizeConfig` derives the routing project from
   *  `workspace` instead, the same way `codex-session.ts`'s automatic path
   *  does, so this host and a Claude session or Codex thread started in the
   *  same directory always land in the same project. Kept only so an old
   *  config file that still has this field does not fail to parse. */
  project?: unknown;
  principal_id: unknown;
  /** A caller may supply the launcher-created session id; otherwise a new one is created once. */
  session_instance_id?: unknown;
  control_socket: unknown;
  workspace: unknown;
  codex_command?: unknown;
  startup_timeout_ms?: unknown;
  work_summary?: unknown;
}

export interface ManagedCodexHost {
  readonly thread_id: string;
  readonly session_instance_id: string;
  readonly process: ChildProcess;
  /** Settles when a newer registration of this session replaced it (#532). */
  readonly superseded: Promise<void>;
  close(): Promise<void>;
}

export interface ManagedCodexHostDependencies {
  spawn?: SpawnManagedCodex;
  start_thread?: StartManagedThread;
  create_adapter?: typeof createCodexAppServerAdapter;
  connect_router_host?: typeof connectRouterHost;
  wait?: (milliseconds: number) => Promise<void>;
}

interface NormalizedConfig {
  routerSocket: string;
  tokenFile: unknown;
  project: string;
  principalId: string;
  sessionInstanceId: string;
  controlSocket: string;
  workspace: string;
  codexCommand: string;
  startupTimeoutMs: number;
  workSummary: string | undefined;
}

/**
 * Start an owned `codex app-server`, create its active thread, then and only
 * then register that exact session with the router. It intentionally has no
 * path for attaching to an arbitrary externally-created Codex session.
 */
export async function startManagedCodexHost(
  config: ManagedCodexHostConfig,
  dependencies: ManagedCodexHostDependencies = {},
): Promise<ManagedCodexHost> {
  assertSecureLocalHostRuntimeSupported();
  const normalized = normalizeConfig(config);
  assertUnusedPrivateSocketPath(normalized.controlSocket);

  const spawnManagedCodex = dependencies.spawn ?? spawn;
  const startThread = dependencies.start_thread ?? startCodexAppServerThread;
  const createAdapter = dependencies.create_adapter ?? createCodexAppServerAdapter;
  const connectHost = dependencies.connect_router_host ?? connectRouterHost;
  const wait = dependencies.wait ?? delay;
  const child = spawnManagedCodex(normalized.codexCommand, [
    'app-server',
    '--listen',
    `unix://${normalized.controlSocket}`,
  ], {
    shell: false,
    stdio: 'ignore',
    windowsHide: true,
  });

  let routerConnection: RouterHostConnection | undefined;
  let reportSuperseded!: () => void;
  const superseded = new Promise<void>((resolve) => { reportSuperseded = resolve; });
  let closeTask: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closeTask ??= (async () => {
      try {
        await routerConnection?.close();
      } finally {
        // The owned Codex stops even when the router close fails (#532).
        if (isChildRunning(child)) child.kill('SIGTERM');
      }
    })();
    return closeTask;
  };
  const onChildEnded = () => { void close(); };
  child.once('exit', onChildEnded);
  child.once('error', onChildEnded);

  try {
    const thread = await waitForManagedThread({
      child,
      controlSocket: normalized.controlSocket,
      workspace: normalized.workspace,
      timeoutMs: normalized.startupTimeoutMs,
      startThread,
      wait,
    });
    assertPrivateControlSocket(normalized.controlSocket);

    const adapter = createAdapter();
    routerConnection = await connectHost({
      socket_path: normalized.routerSocket,
      auth_token: readTokenFile(normalized.tokenFile),
      identity: {
        project: normalized.project,
        principal_id: normalized.principalId,
        session_instance_id: normalized.sessionInstanceId,
        adapter_kind: 'codex-app-server',
        ...(normalized.workSummary === undefined ? {} : { work_summary: normalized.workSummary }),
      },
      async deliver(delivery) {
        const receipt = await adapter.queue({
          control_socket_path: normalized.controlSocket,
          thread_id: thread.thread_id,
          routing: {
            project: delivery.envelope.project,
            sender: delivery.envelope.sender,
            recipient: delivery.envelope.recipient,
            message_id: delivery.envelope.message_id,
            delivery_id: delivery.delivery_id,
            correlation_id: delivery.envelope.correlation_id,
          },
          envelope: delivery.envelope,
        });
        return {
          host: receipt.host,
          status: receipt.status,
          thread_id: receipt.thread_id,
          client_user_message_id: receipt.client_user_message_id,
          queued_submission_id: receipt.queued_submission_id,
        };
      },
      on_superseded: reportSuperseded,
    });
    if (closeTask !== undefined || !isChildRunning(child)) {
      // The owned Codex ended while the router was being reached. Its close already ran
      // with no connection to close, and the supervision that reports a death is attached
      // only after this returns, so without this the router would keep a live-looking
      // session whose app-server is gone.
      // The exit is the failure to report; a close that fails too is kept as its cause.
      let closeError: unknown;
      try {
        await routerConnection.close();
      } catch (error) {
        closeError = error;
      }
      throw new Error(
        'Managed Codex app-server exited while this host was registering with the router.',
        closeError === undefined ? undefined : { cause: closeError },
      );
    }
    return {
      thread_id: thread.thread_id,
      session_instance_id: normalized.sessionInstanceId,
      process: child,
      superseded,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function waitForManagedThread(input: {
  child: ChildProcess;
  controlSocket: string;
  workspace: string;
  timeoutMs: number;
  startThread: StartManagedThread;
  wait: (milliseconds: number) => Promise<void>;
}): Promise<CodexAppServerThread> {
  const deadline = Date.now() + input.timeoutMs;
  let lastError: Error | undefined;
  for (;;) {
    if (!isChildRunning(input.child)) {
      throw new Error('Managed Codex app-server exited before creating a thread.');
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw lastError ?? new Error('Managed Codex app-server did not become ready before the startup timeout.');
    }
    try {
      return await input.startThread({
        control_socket_path: input.controlSocket,
        workspace: input.workspace,
        timeout_ms: Math.min(remaining, 1_000),
      });
    } catch (error) {
      if (!isReadinessTransportError(error)) throw error;
      lastError = error;
      await input.wait(Math.min(STARTUP_RETRY_MS, Math.max(1, deadline - Date.now())));
    }
  }
}

function isReadinessTransportError(error: unknown): error is Error {
  return error instanceof CodexAppServerDisconnectedError || error instanceof CodexAppServerTimeoutError;
}

function normalizeConfig(config: ManagedCodexHostConfig): NormalizedConfig {
  const controlSocket = requiredAbsolutePath(config.control_socket, 'control_socket');
  const workspace = fs.realpathSync(requiredAbsolutePath(config.workspace, 'workspace'));
  if (!fs.statSync(workspace).isDirectory()) throw new Error('workspace must be an existing directory.');
  return {
    routerSocket: normalizeConfiguredRouterSocket(config.router_socket),
    tokenFile: config.token_file,
    // #474: same derivation as `codex-session.ts`'s automatic path and the
    // Claude channel host — `config.project` never decides routing.
    project: canonicalAgentScopeId(getProjectName(workspace)),
    principalId: requiredString(config.principal_id, 'principal_id'),
    sessionInstanceId: config.session_instance_id === undefined
      ? randomUUID()
      : requiredString(config.session_instance_id, 'session_instance_id'),
    controlSocket,
    workspace,
    codexCommand: requiredString(config.codex_command ?? 'codex', 'codex_command'),
    startupTimeoutMs: boundedStartupTimeout(config.startup_timeout_ms ?? DEFAULT_STARTUP_TIMEOUT_MS),
    workSummary: config.work_summary === undefined ? undefined : requiredString(config.work_summary, 'work_summary'),
  };
}

function requiredAbsolutePath(value: unknown, field: string): string {
  const resolved = requiredString(value, field);
  if (!path.isAbsolute(resolved)) throw new Error(`${field} must be an absolute path.`);
  return resolved;
}

function boundedStartupTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 60_000) {
    throw new Error('startup_timeout_ms must be an integer between 100 and 60000.');
  }
  return value;
}

function assertUnusedPrivateSocketPath(socketPath: string): void {
  const parent = fs.lstatSync(path.dirname(socketPath));
  assertOwnerPrivate(parent, 'control socket parent directory');
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error('The control socket parent must be a real owner-private directory.');
  }
  if (fs.lstatSync(socketPath, { throwIfNoEntry: false })) {
    throw new Error('The managed control socket path must not already exist.');
  }
}

function assertPrivateControlSocket(socketPath: string): void {
  const socket = fs.lstatSync(socketPath);
  if (!socket.isSocket()) throw new Error('The managed control socket must be a Unix socket.');
  assertOwnerPrivate(socket, 'managed control socket');
}

function assertOwnerPrivate(stat: fs.Stats, label: string): void {
  if ((stat.mode & 0o077) !== 0) throw new Error(`The ${label} must be owner-private.`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`The ${label} must be owned by the current user.`);
  }
}

function isChildRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export interface ManagedCodexHostSupervision {
  onSignal(handler: () => void): void;
  exit(code: number): void;
  /** The owned Codex process ended on its own: the host exits 1 once it drains. */
  fail(): void;
  stderr: { write(text: string): unknown };
}

/**
 * A SIGINT/SIGTERM, or a newer registration of this session replacing it
 * (#532), closes the host and exits 0 (1 if that close fails). If the owned
 * Codex process died first, that failure keeps the exit and neither stops it.
 */
export function superviseManagedCodexHost(host: ManagedCodexHost, io: ManagedCodexHostSupervision): void {
  let stopping = false;
  let failed = false;
  const stop = (reason: string, notice?: string) => {
    if (stopping || failed) return;
    stopping = true;
    if (notice) io.stderr.write(notice);
    void host.close().then(() => io.exit(0), (error: unknown) => {
      io.stderr.write(`memesh-host-codex: closing after the ${reason} failed: ${error instanceof Error ? error.message : String(error)}\n`);
      io.exit(1);
    });
  };
  // After a failure the signal still ends the process, keeping the failure's exit 1.
  io.onSignal(() => (failed ? io.exit(1) : stop('signal')));
  void host.superseded.then(() => stop(
    'replacement',
    'memesh-host-codex: replaced by a newer connection for this session; stopping.\n',
  ));
  host.process.once('exit', () => {
    if (stopping) return;
    failed = true;
    io.fail();
  });
}

async function runManagedCodexHost(): Promise<void> {
  const host = await startManagedCodexHost(readHostConfig<ManagedCodexHostConfig>());
  superviseManagedCodexHost(host, {
    onSignal(handler) {
      process.once('SIGINT', handler);
      process.once('SIGTERM', handler);
    },
    exit: (code) => process.exit(code),
    fail: () => { process.exitCode = 1; },
    stderr: process.stderr,
  });
}

const entryPath = process.argv[1];
if (entryPath && isExecutedModule(entryPath, import.meta.url)) {
  process.exitCode = await runHostEntry('memesh-host-codex', runManagedCodexHost);
}

function isExecutedModule(entryPath: string, moduleUrl: string): boolean {
  try {
    return fs.realpathSync(entryPath) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
