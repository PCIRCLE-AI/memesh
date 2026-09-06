#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
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

export interface CodexSessionCompanionDependencies {
  connect?: typeof connectRouterHost;
  realpath?: typeof fs.realpathSync;
}

interface ValidCodexSessionStart {
  threadId: string;
  workspace: string;
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

async function main(): Promise<void> {
  const configPath = path.join(getMemeshDirFromDbPath(), 'hosts', 'codex-session.json');
  const input = await readHookInput();
  const session = validateCodexSessionStart(input, { PLUGIN_ROOT: process.env.PLUGIN_ROOT }, fs.realpathSync);
  if (!session) return;
  const connection = await connectCodexSessionCompanion(
    readCodexSessionConfigIfPresent(configPath),
    session,
    fs.realpathSync,
    connectRouterHost,
  );
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void connection.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
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
