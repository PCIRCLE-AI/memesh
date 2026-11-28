import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MemeshDatabase } from '../src/storage/sqlite.js';
import { buildIsolatedRuntimeEnv } from '../scripts/lib/isolated-env.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageVersion = (JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version;
const temporaryDirectories: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) await stop(child);
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'm-')));
  temporaryDirectories.push(root);
  fs.cpSync(path.join(repoRoot, 'dist'), path.join(root, 'dist'), { recursive: true });
  fs.cpSync(path.join(repoRoot, '.codex-plugin'), path.join(root, '.codex-plugin'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(root, 'package.json'));
  fs.cpSync(path.join(repoRoot, 'scripts/hooks'), path.join(root, 'scripts/hooks'), { recursive: true });
  fs.cpSync(path.join(repoRoot, 'hooks'), path.join(root, 'hooks'), { recursive: true });
  expect(fs.existsSync(path.join(root, 'node_modules'))).toBe(false);
  return root;
}

describe('Codex plugin fresh consumer', () => {
  it('declares only conversation hooks, never a retired companion launcher', () => {
    for (const filename of ['hooks/hooks.json', '.codex-plugin/plugin.json']) {
      const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, filename), 'utf8'));
      const events = filename.startsWith('.codex-plugin') ? manifest.hooks.hooks : manifest.hooks;
      const commands = (groups: Array<{ hooks: Array<{ command: string }> }> = []) => groups.flatMap(group => group.hooks.map(hook => hook.command));
      expect(Object.values(events).flatMap(groups => commands(groups as never))).not.toContain('${CLAUDE_PLUGIN_ROOT}/dist/host-runtime/codex-session.js');
      expect(commands(events.SessionStart)).toEqual([
        '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-start.js',
        '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/messages.js',
      ]);
      expect(commands(events.UserPromptSubmit)).toContain('${CLAUDE_PLUGIN_ROOT}/scripts/hooks/messages.js');
    }
  });

  it('runs packaged SessionStart hooks with synthetic Codex identity, without a companion or router', () => {
    const pluginRoot = packagedPluginWithoutNodeModules();
    const packed = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));
    expect(packed.dependencies ?? {}).not.toHaveProperty('sqlite-vec');
    expect(fs.existsSync(path.join(pluginRoot, 'dist/core/embedder.js'))).toBe(false);
    const dataDirectory = path.join(pluginRoot, 'data');
    const runtimeHome = path.join(pluginRoot, 'home');
    fs.mkdirSync(runtimeHome, { mode: 0o700 });
    fs.mkdirSync(dataDirectory, { mode: 0o700 });
    const dbPath = path.join(dataDirectory, 'knowledge-graph.db');
    fs.writeFileSync(path.join(dataDirectory, 'config.json'), JSON.stringify({ autoUpdate: 'off', updateCheck: false, autoCapture: false }), { mode: 0o600 });
    const environment = buildIsolatedRuntimeEnv({ PATH: path.dirname(process.execPath),
      TMPDIR: pluginRoot, MEMESH_AUTO_UPDATE: 'off', MEMESH_AUTO_CAPTURE: 'false', MEMESH_SKIP_UPDATE_CHECK: '1',
      MEMESH_HOOK_HOST: 'codex', CODEX_PLUGIN_ROOT: pluginRoot }, { runtimeHome, memeshDir: dataDirectory, dbPath });
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'));
    const session = '01a041b4-5c67-75b3-9505-4e33d7942b8e';
    const commands = manifest.hooks.hooks.SessionStart.flatMap((group: { hooks: Array<{ command: string }> }) => group.hooks.map(hook => hook.command));
    expect(commands).toHaveLength(2); // Refuse stale wiring before executing it.
    for (const command of commands) {
      const entry = path.normalize(command.replace('${CLAUDE_PLUGIN_ROOT}', pluginRoot));
      expect(path.dirname(entry)).toBe(path.join(pluginRoot, 'scripts', 'hooks'));
      const result = spawnSync(process.execPath, [entry], { cwd: pluginRoot, env: environment,
        input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: session, cwd: pluginRoot }),
        encoding: 'utf8', timeout: 10_000 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    }
    const database = new MemeshDatabase(path.join(dataDirectory, 'messages.db'), { readOnly: true });
    try {
      const row = database.prepare('SELECT id,host,pid,wake,is_local FROM conversations WHERE id=?').get(session) as { id: string; host: string; pid: number; wake: string; is_local: number };
      expect(row).toMatchObject({ id: session, host: 'codex', pid: process.pid, is_local: 1 });
      expect(JSON.parse(row.wake)).toEqual({ thread: session });
      expect(database.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({ count: 0 });
    } finally { database.close(); }
    for (const relative of ['agent-router-v2.sock', 'agent-router.sock', 'agent-router.token', 'runtime/codex-session', 'hosts/codex-session.json']) {
      expect(fs.existsSync(path.join(dataDirectory, relative)), relative).toBe(false);
    }
    const outcomes = fs.readFileSync(path.join(dataDirectory, 'hook-outcomes.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(outcomes.some(row => row.hook === 'messages' && row.outcome === 'skipped')).toBe(true);
    expect(outcomes.some(row => row.hook === 'messages' && row.outcome === 'error')).toBe(false);
  });

  it('declares the bundled MCP server for a zero-config Codex plugin install', () => {
    const plugin = JSON.parse(fs.readFileSync(path.join(repoRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
    expect(plugin.mcpServers).toBe('./.codex-plugin/mcp.json');

    const manifest = JSON.parse(
      fs.readFileSync(path.join(repoRoot, plugin.mcpServers), 'utf8'),
    );
    expect(Object.keys(manifest)).toEqual(['mcpServers']);
    // The exact server entry is pinned in plugin-mcp-manifest.test.ts.
    expect(manifest.mcpServers.memesh).toMatchObject({
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
    expect(result.stdout.trim()).toBe(packageVersion);
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
