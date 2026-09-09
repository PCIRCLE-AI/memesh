import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MemeshDatabase } from '../src/storage/sqlite.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectories: string[] = [];
const children: ChildProcess[] = [];
const routerSockets: string[] = [];
const companionStates: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) await stop(child);
  for (const statePath of companionStates.splice(0)) await terminateCompanionAt(statePath);
  for (const socketPath of routerSockets.splice(0)) await stopRouterAt(socketPath);
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function terminateCompanionAt(statePath: string): Promise<void> {
  if (!fs.existsSync(statePath)) return;
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
    token: string;
    control_socket: string;
  };
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(state.control_socket);
    let response = '';
    socket.setEncoding('utf8');
    socket.setTimeout(2_000, () => socket.destroy(new Error('Timed out stopping packaged Codex companion.')));
    socket.on('data', chunk => { response += chunk; });
    socket.once('error', reject);
    socket.once('close', hadError => {
      if (hadError) return;
      if (response.trim() !== 'terminated') return reject(new Error(`Packaged Codex companion rejected termination: ${response.trim()}`));
      resolve();
    });
    socket.once('connect', () => socket.end(`${JSON.stringify({ action: 'terminate', token: state.token })}\n`));
  });
  await waitFor(() => !fs.existsSync(statePath), 'the packaged Codex companion lifecycle state to disappear');
}

function waitFor(predicate: () => boolean | Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  return new Promise((resolve, reject) => {
    const check = async () => {
      if (await predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${description}.`));
      setTimeout(check, 25);
    };
    check();
  });
}

function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function stopRouterAt(socketPath: string): Promise<void> {
  for (const value of routerOwners(socketPath)) {
    const pid = Number(value);
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  await waitFor(() => routerOwners(socketPath).length === 0, 'the task-owned packaged router to stop');
}

function routerOwners(socketPath: string): string[] {
  const result = spawnSync('lsof', ['-t', '--', socketPath], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result.stdout.trim().split(/\s+/).filter(Boolean);
}

function tcpPortOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}

async function freeTcpPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a TCP port for the packaged server test.');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function packagedPluginWithoutNodeModules(): string {
  // AF_UNIX socket paths are capped at 103 bytes; keep this root short enough
  // for the automatic `<MEMESH_DIR>/agent-router-v2.sock` path on macOS.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm-'));
  temporaryDirectories.push(root);
  fs.cpSync(path.join(repoRoot, 'dist'), path.join(root, 'dist'), { recursive: true });
  fs.cpSync(path.join(repoRoot, '.codex-plugin'), path.join(root, '.codex-plugin'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(root, 'package.json'));
  expect(fs.existsSync(path.join(root, 'node_modules'))).toBe(false);
  return root;
}

describe('Codex plugin fresh consumer', () => {
  it.skipIf(process.platform === 'win32')('starts and registers SessionStart without third-party runtime modules', async () => {
    const pluginRoot = packagedPluginWithoutNodeModules();
    const dataDirectory = path.join(pluginRoot, 'data');
    const dbPath = path.join(dataDirectory, 'knowledge-graph.db');
    const socketPath = path.join(dataDirectory, 'agent-router-v2.sock');
    const tokenPath = path.join(dataDirectory, 'agent-router.token');
    const statePath = path.join(dataDirectory, 'runtime', 'codex-session', '01a041b4-5c67-75b3-9505-4e33d7942b8e.json');
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: path.join(pluginRoot, 'home'),
      TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
      MEMESH_DIR: dataDirectory,
      MEMESH_DB_PATH: dbPath,
      MEMESH_ROUTER_SOCKET: socketPath,
      MEMESH_ROUTER_TOKEN_FILE: tokenPath,
      MEMESH_AUTO_UPDATE: '0',
      PLUGIN_ROOT: pluginRoot,
    };

    const packed = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));
    expect(packed.dependencies ?? {}).not.toHaveProperty('sqlite-vec');
    expect(fs.existsSync(path.join(pluginRoot, 'dist/core/embedder.js'))).toBe(false);

    const companion = spawn(process.execPath, [path.join(pluginRoot, 'dist/host-runtime/codex-session.js')], {
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(companion);
    companionStates.push(statePath);
    routerSockets.push(socketPath);
    let companionStderr = '';
    companion.stderr!.setEncoding('utf8');
    companion.stderr!.on('data', (chunk: string) => { companionStderr += chunk; });
    companion.stdin!.end(JSON.stringify({
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: '01a041b4-5c67-75b3-9505-4e33d7942b8e',
      cwd: pluginRoot,
    }));

    await waitFor(() => companion.exitCode !== null, 'the short SessionStart launcher to exit');
    expect(companion.exitCode, companionStderr).toBe(0);
    await waitFor(() => fs.existsSync(socketPath) && fs.existsSync(statePath), 'the detached companion lifecycle state and router socket');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { pid: number };
    expect(state.pid).not.toBe(companion.pid);
    await waitFor(() => {
      if (!fs.existsSync(dbPath)) return false;
      const database = new MemeshDatabase(dbPath);
      try {
        const row = database.prepare(
          "SELECT count(*) AS count FROM agent_session_connections WHERE principal_id = 'codex-thread-01a041b4-5c67-75b3-9505-4e33d7942b8e'",
        ).get() as { count: number };
        return row.count === 1;
      } catch {
        return false;
      } finally {
        database.close();
      }
    }, 'the packaged SessionStart companion to register with the router');
    expect(companion.exitCode).toBe(0);
    expect(companionStderr).toBe('');
    expect(fs.existsSync(path.join(dataDirectory, 'hosts', 'codex-session.json'))).toBe(false);
    await terminateCompanionAt(statePath);
    companionStates.splice(companionStates.indexOf(statePath), 1);
  });

  it('declares the bundled MCP server for a zero-config Codex plugin install', () => {
    const plugin = JSON.parse(fs.readFileSync(path.join(repoRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
    expect(plugin.mcpServers).toBe('./.codex-plugin/mcp.json');

    const manifest = JSON.parse(
      fs.readFileSync(path.join(repoRoot, plugin.mcpServers), 'utf8'),
    );
    expect(Object.keys(manifest)).toEqual(['mcpServers']);
    expect(manifest.mcpServers.memesh).toEqual({
      command: 'node',
      args: ['./dist/mcp/server.js'],
      cwd: '.',
    });
    expect(
      fs.existsSync(path.resolve(repoRoot, manifest.mcpServers.memesh.cwd, manifest.mcpServers.memesh.args[0])),
    ).toBe(true);
  });

  it('starts the packaged memesh CLI without third-party modules', () => {
    const pluginRoot = packagedPluginWithoutNodeModules();
    const result = spawnSync(process.execPath, [path.join(pluginRoot, 'dist/transports/cli/cli.js'), '--version'], {
      cwd: pluginRoot,
      env: { ...process.env, HOME: path.join(pluginRoot, 'home'), PLUGIN_ROOT: pluginRoot },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('4.9.2');
  });

  it.skipIf(process.platform === 'win32')('serve binds only the requested port in the packaged CLI', async () => {
    const pluginRoot = packagedPluginWithoutNodeModules();
    const dataDirectory = path.join(pluginRoot, 'data');
    const requestedPort = await freeTcpPort();
    const defaultPortWasOpen = await tcpPortOpen(3737);
    const child = spawn(process.execPath, [path.join(pluginRoot, 'dist/transports/cli/cli.js'), 'serve', '--port', String(requestedPort)], {
      cwd: pluginRoot,
      env: {
        ...process.env,
        HOME: path.join(pluginRoot, 'home'),
        MEMESH_DIR: dataDirectory,
        MEMESH_DB_PATH: path.join(dataDirectory, 'knowledge-graph.db'),
        MEMESH_AUTO_UPDATE: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stderr = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => { stderr += chunk; });
    await waitFor(async () => await tcpPortOpen(requestedPort), 'the packaged server to bind the requested port');
    expect(child.exitCode, stderr).toBeNull();
    // Do not claim ownership of the user's default server port. The fresh
    // consumer must leave an already-running daemon untouched; when no daemon
    // existed before, it must still not bind 3737.
    expect(await tcpPortOpen(3737), stderr).toBe(defaultPortWasOpen);
    await stop(child);
    children.splice(children.indexOf(child), 1);
  });
});
