import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadOrCreateRemoteToken, remoteTokenStartupNotice } from '../../src/transports/http/server.js';

describe('remote token startup notice says where the token really came from', () => {
  let dir: string;
  let previousDir: string | undefined;
  let previousEnv: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-remote-token-'));
    previousDir = process.env.MEMESH_DIR;
    previousEnv = process.env.MEMESH_REMOTE_TOKEN;
    process.env.MEMESH_DIR = dir;
  });
  afterEach(() => {
    if (previousDir === undefined) delete process.env.MEMESH_DIR; else process.env.MEMESH_DIR = previousDir;
    if (previousEnv === undefined) delete process.env.MEMESH_REMOTE_TOKEN; else process.env.MEMESH_REMOTE_TOKEN = previousEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the message when the environment variable is in use', () => {
    process.env.MEMESH_REMOTE_TOKEN = 'a'.repeat(32);
    const loaded = loadOrCreateRemoteToken();
    expect(loaded.source).toBe('env');
    const notice = remoteTokenStartupNotice(loaded);
    expect(notice).toContain('Token loaded from MEMESH_REMOTE_TOKEN.');
    expect(notice).not.toContain('ignored');
  });

  it('says the variable was ignored when it is too short, and names the file actually used', () => {
    process.env.MEMESH_REMOTE_TOKEN = 'short';
    fs.writeFileSync(path.join(dir, 'remote-token'), `${'b'.repeat(64)}\n`, { mode: 0o600 });
    const loaded = loadOrCreateRemoteToken();
    expect(loaded.source).toBe('file');
    expect(loaded.envIgnored).toBe(true);
    expect(loaded.token.toString('utf8')).toBe('b'.repeat(64));
    const notice = remoteTokenStartupNotice(loaded);
    expect(notice).toContain('MEMESH_REMOTE_TOKEN is shorter than 16 characters and was ignored');
    expect(notice).toContain(path.join(dir, 'remote-token'));
    expect(notice).not.toContain('Token loaded from MEMESH_REMOTE_TOKEN');
  });

  it('adds the same warning when a too-short variable led to a freshly generated file', () => {
    process.env.MEMESH_REMOTE_TOKEN = 'short';
    const loaded = loadOrCreateRemoteToken();
    expect(loaded.freshlyCreated).toBe(true);
    const notice = remoteTokenStartupNotice(loaded);
    expect(notice).toContain('bearer token generated');
    expect(notice).toContain('MEMESH_REMOTE_TOKEN is shorter than 16 characters and was ignored');
    // The override line tells the operator how long a usable value must be.
    expect(notice).toContain('Override: set MEMESH_REMOTE_TOKEN (at least 16 characters).');
  });

  it('prints the ignored warning as its own line, not glued into the sentence before it', () => {
    process.env.MEMESH_REMOTE_TOKEN = 'short';
    fs.writeFileSync(path.join(dir, 'remote-token'), `${'b'.repeat(64)}\n`, { mode: 0o600 });
    const lines = remoteTokenStartupNotice(loadOrCreateRemoteToken()).trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^MeMesh HTTP: remote bind requires Authorization: Bearer <token>\. Token loaded from .*remote-token\.$/);
    expect(lines[1]).toBe('  MEMESH_REMOTE_TOKEN is shorter than 16 characters and was ignored.');
  });

  it('does not call an empty variable "ignored": an empty string is the same as unset', () => {
    process.env.MEMESH_REMOTE_TOKEN = '';
    fs.writeFileSync(path.join(dir, 'remote-token'), `${'d'.repeat(64)}\n`, { mode: 0o600 });
    const loaded = loadOrCreateRemoteToken();
    expect(loaded.envIgnored).toBe(false);
    expect(remoteTokenStartupNotice(loaded)).not.toContain('ignored');
  });

  it('is unchanged when no variable is set', () => {
    delete process.env.MEMESH_REMOTE_TOKEN;
    fs.writeFileSync(path.join(dir, 'remote-token'), `${'c'.repeat(64)}\n`, { mode: 0o600 });
    const loaded = loadOrCreateRemoteToken();
    expect(loaded.envIgnored).toBe(false);
    const notice = remoteTokenStartupNotice(loaded);
    expect(notice).toContain(`Token loaded from ${path.join(dir, 'remote-token')}.`);
    expect(notice).not.toContain('ignored');
  });
});
