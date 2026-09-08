import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProjectName } from '../../src/core/paths.js';
import { execFileSync } from 'node:child_process';
import {
  codexCompanionControlSocketPath,
  codexCompanionStatePath,
  endCodexSessionCompanion,
  startCodexSessionCompanion,
  supersedeCodexSessionCompanion,
} from '../../src/host-runtime/codex-session.js';

const tempDirs: string[] = [];
const threadId = '01a041b4-5c67-75b3-9505-4e33d7942b8e';
const originalDbPath = process.env.MEMESH_DB_PATH;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  if (originalDbPath === undefined) delete process.env.MEMESH_DB_PATH;
  else process.env.MEMESH_DB_PATH = originalDbPath;
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-codex-session-'));
  tempDirs.push(dir);
  const tokenFile = path.join(dir, 'router.token');
  fs.writeFileSync(tokenFile, 'test-token\n', { mode: 0o600 });
  return {
    config: {
      router_socket: path.join(dir, 'router.sock'),
      token_file: tokenFile,
      project: 'project-a',
      principal_id: 'principal-a',
      workspace: dir,
      model: 'gpt-5.6-sol',
      work_summary: 'review MeMesh delivery',
    },
    hook: { hook_event_name: 'SessionStart', session_id: threadId, cwd: dir, source: 'startup' },
  };
}

function automaticDataDir(dir: string): string {
  const dataDir = path.join(dir, 'memesh-data');
  process.env.MEMESH_DB_PATH = path.join(dataDir, 'knowledge-graph.db');
  return dataDir;
}

async function stageCompanionState(input: {
  dataDir: string;
  id?: string;
  workspace: string;
  token?: string;
  pid?: number;
  malformed?: boolean;
}) {
  const id = input.id ?? threadId;
  const statePath = codexCompanionStatePath(input.dataDir, id);
  const controlSocket = codexCompanionControlSocketPath(input.dataDir, id);
  const token = input.token ?? 'a'.repeat(32);
  if (input.malformed) {
    fs.writeFileSync(statePath, '{not-json\n', { mode: 0o600 });
    return { statePath, controlSocket, close: async () => undefined, seen: () => false };
  }
  fs.writeFileSync(statePath, `${JSON.stringify({
    version: 1,
    pid: input.pid ?? process.pid,
    thread_id: id,
    workspace: fs.realpathSync(input.workspace),
    token,
    control_socket: controlSocket,
  })}\n`, { mode: 0o600 });
  const actions: string[] = [];
  const server = net.createServer((socket) => {
    let text = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { text += chunk; });
    socket.once('end', () => {
      const message = JSON.parse(text) as { action?: string; token?: string };
      if ((message.action === 'terminate' || message.action === 'retire') && message.token === token) {
        actions.push(message.action);
        if (message.action === 'terminate') fs.unlinkSync(statePath);
        socket.end('terminated\n');
      } else socket.end('rejected\n');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(controlSocket, () => resolve());
  });
  return {
    statePath,
    controlSocket,
    close: async () => new Promise<void>((resolve) => server.close(() => resolve())),
    seen: (action: string) => actions.includes(action),
  };
}

describe('ordinary Codex session companion', () => {
  it.skipIf(process.platform === 'win32')('preserves an exact owner-private explicit workspace identity and keeps delivery out of the companion', async () => {
    const { config, hook } = fixture();
    const close = vi.fn(async () => undefined);
    const connect = vi.fn(async (input) => {
      await expect(input.deliver({} as never)).rejects.toThrow('owned by the router adapter');
      return { connection_id: 'connection-a', generation: 1, close };
    });

    await expect(startCodexSessionCompanion(
      config, hook, { PLUGIN_ROOT: '/plugin' }, { connect: connect as never },
    )).resolves.toMatchObject({ connection_id: 'connection-a', generation: 1 });

    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      socket_path: config.router_socket,
      auth_token: 'test-token',
      identity: {
        project: 'project-a', principal_id: 'principal-a',
        session_instance_id: threadId, adapter_kind: 'codex-cli-queue',
        model: 'gpt-5.6-sol', work_summary: 'review MeMesh delivery',
      },
    }));
  });

  it.skipIf(process.platform === 'win32')('automatically registers an ordinary SessionStart without writing a host config', async () => {
    const { config, hook } = fixture();
    const dataDir = automaticDataDir(config.workspace as string);
    const connect = vi.fn(async () => ({ connection_id: 'automatic', generation: 1, close: async () => undefined }));

    await expect(startCodexSessionCompanion(
      undefined, hook, { PLUGIN_ROOT: '/plugin' }, { connect: connect as never },
    )).resolves.toMatchObject({ connection_id: 'automatic', generation: 1 });

    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      socket_path: path.join(dataDir, 'agent-router-v2.sock'),
      auth_token: expect.stringMatching(/^[0-9a-f]{64}$/),
      identity: {
        project: getProjectName(config.workspace as string),
        principal_id: `codex-thread-${threadId}`,
        session_instance_id: threadId,
        adapter_kind: 'codex-cli-queue',
      },
    }));
    expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dataDir, 'agent-router.token')).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(dataDir, 'hosts', 'codex-session.json'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('derives automatic Codex scope from the full remote identity, not a colliding basename', async () => {
    const { config, hook } = fixture();
    const dataDir = automaticDataDir(config.workspace as string);
    execFileSync('git', ['-C', config.workspace as string, 'init'], { stdio: 'ignore' });
    execFileSync('git', ['-C', config.workspace as string, 'remote', 'add', 'origin', 'https://github.com/owner-a/shared.git'], { stdio: 'ignore' });
    const connect = vi.fn(async () => ({ connection_id: 'automatic', generation: 1, close: async () => undefined }));

    await startCodexSessionCompanion(
      undefined, hook, { PLUGIN_ROOT: '/plugin' }, { connect: connect as never },
    );

    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      socket_path: path.join(dataDir, 'agent-router-v2.sock'),
      identity: expect.objectContaining({ project: expect.stringMatching(/^shared~[0-9a-f]{32}$/) }),
    }));
  });

  it.skipIf(process.platform === 'win32')('accepts a resume SessionStart for automatic registration', async () => {
    const { config, hook } = fixture();
    automaticDataDir(config.workspace as string);
    const connect = vi.fn(async () => ({ connection_id: 'resume', generation: 1, close: async () => undefined }));

    await expect(startCodexSessionCompanion(
      undefined, { ...hook, source: 'resume' }, { PLUGIN_ROOT: '/plugin' }, { connect: connect as never },
    )).resolves.toMatchObject({ connection_id: 'resume' });
    expect(connect).toHaveBeenCalledOnce();
  });

  it.skipIf(process.platform === 'win32')('uses automatic identity for a valid explicit config from another workspace', async () => {
    const { config, hook } = fixture();
    const dataDir = automaticDataDir(config.workspace as string);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-codex-other-'));
    tempDirs.push(other);
    const connect = vi.fn(async () => ({ connection_id: 'automatic', generation: 1, close: async () => undefined }));

    await startCodexSessionCompanion(
      config, { ...hook, cwd: other }, { PLUGIN_ROOT: '/plugin' }, { connect: connect as never },
    );

    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      socket_path: path.join(dataDir, 'agent-router-v2.sock'),
      identity: {
        project: getProjectName(other),
        principal_id: `codex-thread-${threadId}`,
        session_instance_id: threadId,
        adapter_kind: 'codex-cli-queue',
      },
    }));
    const identity = (connect.mock.calls as unknown as Array<[{ identity: Record<string, unknown> }]>)[0]?.[0].identity;
    expect(identity).not.toHaveProperty('model');
    expect(identity).not.toHaveProperty('work_summary');
  });

  it.skipIf(process.platform === 'win32')('ignores a deleted legacy workspace before reading its stale token file', async () => {
    const { config, hook } = fixture();
    const dataDir = automaticDataDir(config.workspace as string);
    const deletedWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-codex-deleted-'));
    fs.rmSync(deletedWorkspace, { recursive: true });
    const connect = vi.fn(async () => ({ connection_id: 'automatic', generation: 1, close: async () => undefined }));

    await startCodexSessionCompanion(
      { ...config, workspace: deletedWorkspace, token_file: path.join(deletedWorkspace, 'missing.token') },
      hook,
      { PLUGIN_ROOT: '/plugin' },
      { connect: connect as never },
    );

    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      socket_path: path.join(dataDir, 'agent-router-v2.sock'),
      identity: expect.objectContaining({
        project: getProjectName(config.workspace as string),
        principal_id: `codex-thread-${threadId}`,
      }),
    }));
  });

  it.skipIf(process.platform === 'win32')('still rejects a missing token for the matching explicit workspace', async () => {
    const { config, hook } = fixture();
    const missingToken = path.join(config.workspace as string, 'missing.token');
    const connect = vi.fn();

    await expect(startCodexSessionCompanion(
      { ...config, token_file: missingToken }, hook, { PLUGIN_ROOT: '/plugin' }, { connect: connect as never },
    )).rejects.toMatchObject({ code: 'ENOENT' });

    expect(connect).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong event', { hook_event_name: 'PreCompact' }, { PLUGIN_ROOT: '/plugin' }],
    ['no hook identity', { session_id: undefined }, { PLUGIN_ROOT: '/plugin' }],
    ['invalid hook identity', { session_id: 'not-a-uuid' }, { PLUGIN_ROOT: '/plugin' }],
    ['compact lifecycle', { source: 'compact' }, { PLUGIN_ROOT: '/plugin' }],
    ['unknown lifecycle', { source: 'clear' }, { PLUGIN_ROOT: '/plugin' }],
    ['missing Codex plugin marker', {}, {}],
    ['Claude-only plugin marker', {}, { PLUGIN_ROOT: undefined, CLAUDE_PLUGIN_ROOT: '/plugin' }],
    ['empty Codex plugin marker', {}, { PLUGIN_ROOT: '' }],
  ])('fails closed before automatic state creation for %s', async (_label, hookOverride, environment) => {
    const { config, hook } = fixture();
    const dataDir = automaticDataDir(config.workspace as string);
    const connect = vi.fn();
    await expect(startCodexSessionCompanion(
      undefined, { ...hook, ...hookOverride }, environment, { connect: connect as never },
    )).resolves.toBeNull();
    expect(connect).not.toHaveBeenCalled();
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('rejects a non-absolute cwd before automatic state creation', async () => {
    const { config, hook } = fixture();
    const dataDir = automaticDataDir(config.workspace as string);
    const connect = vi.fn();
    await expect(startCodexSessionCompanion(
      undefined, { ...hook, cwd: 'relative-workspace' }, { PLUGIN_ROOT: '/plugin' }, { connect: connect as never },
    )).rejects.toThrow(/cwd must be an absolute path/i);
    expect(connect).not.toHaveBeenCalled();
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('rejects a missing cwd before automatic state creation', async () => {
    const { config, hook } = fixture();
    const dataDir = automaticDataDir(config.workspace as string);
    const connect = vi.fn();
    await expect(startCodexSessionCompanion(
      undefined, { ...hook, cwd: undefined }, { PLUGIN_ROOT: '/plugin' }, { connect: connect as never },
    )).rejects.toThrow(/cwd must be a bounded non-empty string/i);
    expect(connect).not.toHaveBeenCalled();
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('rejects a regular-file cwd before automatic state creation', async () => {
    const { config, hook } = fixture();
    const dataDir = automaticDataDir(config.workspace as string);
    const connect = vi.fn();
    await expect(startCodexSessionCompanion(
      undefined, { ...hook, cwd: config.token_file }, { PLUGIN_ROOT: '/plugin' }, { connect: connect as never },
    )).rejects.toThrow(/cwd must be a directory/i);
    expect(connect).not.toHaveBeenCalled();
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('does not fall back to automatic registration from malformed explicit config', async () => {
    const { config, hook } = fixture();
    const dataDir = automaticDataDir(config.workspace as string);
    const connect = vi.fn();

    await expect(startCodexSessionCompanion(
      { ...config, workspace: 'relative-workspace' }, hook, { PLUGIN_ROOT: '/plugin' }, { connect: connect as never },
    )).rejects.toThrow(/workspace must be an absolute path/i);

    expect(connect).not.toHaveBeenCalled();
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('does not fall back from a regular-file explicit workspace', async () => {
    const { config, hook } = fixture();
    const dataDir = automaticDataDir(config.workspace as string);
    const connect = vi.fn();

    await expect(startCodexSessionCompanion(
      { ...config, workspace: config.token_file }, hook, { PLUGIN_ROOT: '/plugin' }, { connect: connect as never },
    )).rejects.toThrow(/workspace must be a directory/i);

    expect(connect).not.toHaveBeenCalled();
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('does not inspect an unrelated workspace token before automatic registration', async () => {
    const { config, hook } = fixture();
    const dataDir = automaticDataDir(config.workspace as string);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-codex-other-'));
    tempDirs.push(other);
    fs.chmodSync(config.token_file as string, 0o644);
    const connect = vi.fn(async () => ({ connection_id: 'automatic', generation: 1, close: async () => undefined }));

    await startCodexSessionCompanion(
      config, { ...hook, cwd: other }, { PLUGIN_ROOT: '/plugin' }, { connect: connect as never },
    );

    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      socket_path: path.join(dataDir, 'agent-router-v2.sock'),
      identity: expect.objectContaining({ project: getProjectName(other) }),
    }));
  });

  it.runIf(process.platform === 'win32')('fails closed before connecting to the router', async () => {
    const { config, hook } = fixture();
    const connect = vi.fn();

    await expect(startCodexSessionCompanion(
      config, hook, { PLUGIN_ROOT: '/plugin' }, { connect },
    )).rejects.toThrow(/secure local host runtime is not supported on Windows/i);

    expect(connect).not.toHaveBeenCalled();
    expect(fs.existsSync(config.router_socket as string)).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('Codex SessionEnd companion lifecycle', () => {
  const plugin = { PLUGIN_ROOT: '/plugin' };

  it('reads the checked state descriptor even if its pathname is replaced', async () => {
    const { config, hook } = fixture();
    const dataDir = automaticDataDir(config.workspace as string);
    const staged = await stageCompanionState({ dataDir, workspace: config.workspace as string });
    const originalStat = fs.statSync(staged.statePath);
    const realFstat = fs.fstatSync;
    const realLstat = fs.lstatSync;
    let replaced = false;
    const replaceAfterCheck = (stat: fs.Stats) => {
      if (!replaced && stat.ino === originalStat.ino && stat.dev === originalStat.dev) {
        replaced = true;
        fs.renameSync(staged.statePath, `${staged.statePath}.original`);
        fs.writeFileSync(staged.statePath, '{replacement-invalid-json', { mode: 0o600 });
      }
      return stat;
    };
    const fstat = vi.spyOn(fs, 'fstatSync').mockImplementation(((...args: Parameters<typeof fs.fstatSync>) =>
      replaceAfterCheck(realFstat(...args) as fs.Stats)) as typeof fs.fstatSync);
    const lstat = vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: Parameters<typeof fs.lstatSync>) =>
      replaceAfterCheck(realLstat(...args) as fs.Stats)) as typeof fs.lstatSync);
    try {
      await expect(endCodexSessionCompanion(dataDir, { ...hook, hook_event_name: 'SessionEnd' }, plugin)).resolves.toBe(true);
      expect(replaced).toBe(true);
      expect(staged.seen('retire')).toBe(true);
    } finally {
      fstat.mockRestore();
      lstat.mockRestore();
      await staged.close();
    }
  });

  it('SessionEnd starts bounded retirement for only the exact matching companion', async () => {
    const { config, hook } = fixture();
    const dataDir = automaticDataDir(config.workspace as string);
    const staged = await stageCompanionState({ dataDir, workspace: config.workspace as string });
    try {
      await expect(endCodexSessionCompanion(
        dataDir,
        { ...hook, hook_event_name: 'SessionEnd' },
        plugin,
      )).resolves.toBe(true);
      expect(staged.seen('retire')).toBe(true);
      expect(staged.seen('terminate')).toBe(false);
      expect(fs.existsSync(staged.statePath)).toBe(true);
    } finally {
      await staged.close();
    }
  });

  it('resume supersession terminates the prior exact companion before a replacement may register', async () => {
    const { config, hook } = fixture();
    const dataDir = automaticDataDir(config.workspace as string);
    const staged = await stageCompanionState({ dataDir, workspace: config.workspace as string });
    try {
      await expect(supersedeCodexSessionCompanion(
        dataDir,
        { ...hook, source: 'resume' },
        plugin,
      )).resolves.toBe(true);
      expect(staged.seen('terminate')).toBe(true);
      expect(fs.existsSync(staged.statePath)).toBe(false);
    } finally {
      await staged.close();
    }
  });

  it('rejects malformed lifecycle state without sending a signal or replacing it', async () => {
    const { config, hook } = fixture();
    const dataDir = automaticDataDir(config.workspace as string);
    const staged = await stageCompanionState({ dataDir, workspace: config.workspace as string, malformed: true });
    await expect(endCodexSessionCompanion(
      dataDir,
      { ...hook, hook_event_name: 'SessionEnd' },
      plugin,
    )).rejects.toThrow(/malformed/);
    expect(fs.existsSync(staged.statePath)).toBe(true);
  });

  it('refuses a foreign workspace state and never contacts its control socket', async () => {
    const { config, hook } = fixture();
    const dataDir = automaticDataDir(config.workspace as string);
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-codex-foreign-'));
    tempDirs.push(foreign);
    const staged = await stageCompanionState({ dataDir, workspace: foreign });
    try {
      await expect(endCodexSessionCompanion(
        dataDir,
        { ...hook, hook_event_name: 'SessionEnd' },
        plugin,
      )).rejects.toThrow(/does not match.*cross-thread/i);
      expect(staged.seen('terminate')).toBe(false);
      expect(staged.seen('retire')).toBe(false);
    } finally {
      await staged.close();
    }
  });

  it('removes a stale dead-PID state but never sends a PID signal', async () => {
    const { config, hook } = fixture();
    const dataDir = automaticDataDir(config.workspace as string);
    const staged = await stageCompanionState({
      dataDir,
      workspace: config.workspace as string,
      pid: 2_147_483_647,
    });
    await staged.close();
    await expect(endCodexSessionCompanion(
      dataDir,
      { ...hook, hook_event_name: 'SessionEnd' },
      plugin,
    )).resolves.toBe(true);
    expect(fs.existsSync(staged.statePath)).toBe(false);
  });
});
