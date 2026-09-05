import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProjectName } from '../../src/core/paths.js';
import { execFileSync } from 'node:child_process';
import { startCodexSessionCompanion } from '../../src/host-runtime/codex-session.js';

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

  it.skipIf(process.platform === 'win32')('does not bypass an insecure explicit override from another workspace', async () => {
    const { config, hook } = fixture();
    const dataDir = automaticDataDir(config.workspace as string);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-codex-other-'));
    tempDirs.push(other);
    fs.chmodSync(config.token_file as string, 0o644);
    const connect = vi.fn();

    await expect(startCodexSessionCompanion(
      config, { ...hook, cwd: other }, { PLUGIN_ROOT: '/plugin' }, { connect: connect as never },
    )).rejects.toThrow(/router token file must be owner-private/i);

    expect(connect).not.toHaveBeenCalled();
    expect(fs.existsSync(dataDir)).toBe(false);
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
