import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MemeshDatabase } from '../src/storage/sqlite.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectories: string[] = [];
const children: ChildProcess[] = [];
const routerSockets: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) await stop(child);
  for (const socketPath of routerSockets.splice(0)) await stopRouterAt(socketPath);
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
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

    await waitFor(() => fs.existsSync(socketPath) || companion.exitCode !== null, 'the SessionStart-spawned router socket');
    expect(companion.exitCode, companionStderr).toBeNull();
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
    expect(companion.exitCode).toBeNull();
    expect(companionStderr).toBe('');
    expect(fs.existsSync(path.join(dataDirectory, 'hosts', 'codex-session.json'))).toBe(false);
  });

  it('does not let the Codex plugin declare a duplicate MCP server', () => {
    const plugin = JSON.parse(fs.readFileSync(path.join(repoRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
    expect(plugin).not.toHaveProperty('mcpServers');
    expect(fs.existsSync(path.join(repoRoot, '.codex-plugin', 'mcp.json'))).toBe(false);
  });
});
