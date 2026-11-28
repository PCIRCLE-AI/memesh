import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadOrCreateRemoteToken, remoteTokenStartupNotice } from '../../src/transports/http/server.js';
import * as windowsPermissions from '../../src/core/windows-permissions.js';
import { expectPrivateFile, makeWindowsAclPublic, readWindowsAcl, windowsAclFixture } from '../helpers/permissions.js';

describe('remote token startup notice says where the token really came from', () => {
  let dir: string;
  let previousDir: string | undefined;
  let previousEnv: string | undefined;

  function writeFixtureToken(value: string): string {
    const file = path.join(dir, 'remote-token');
    fs.writeFileSync(file, value + '\n', { mode: 0o600 });
    if (process.platform === 'win32') windowsPermissions.makeWindowsPathsPrivate([file]);
    return file;
  }

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-remote-token-')));
    if (process.platform === 'win32') windowsPermissions.makeWindowsPathsPrivate([dir]);
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
    const unused = path.join(dir, 'untouched');
    process.env.MEMESH_DIR = unused;
    const loaded = loadOrCreateRemoteToken();
    expect(loaded.source).toBe('env');
    const notice = remoteTokenStartupNotice(loaded);
    expect(notice).toContain('Token loaded from MEMESH_REMOTE_TOKEN.');
    expect(notice).not.toContain('ignored');
    expect(loaded.token.toString('utf8')).toBe('a'.repeat(32));
    expect(notice, 'the token itself must never reach startup output').not.toContain('a'.repeat(32));
    expect(fs.existsSync(unused)).toBe(false);
  });

  it('says the variable was ignored when it is too short, and names the file actually used', () => {
    process.env.MEMESH_REMOTE_TOKEN = 'short';
    writeFixtureToken('b'.repeat(64));
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
    const file = path.join(dir, 'remote-token');
    const permissions = process.platform === 'win32' ? 'restricted Windows access' : 'mode 600';
    expect(notice).toContain(`Token file: ${file} (${permissions})`);
    expect(notice).toContain(`Rotate by deleting ${file} and restarting.`);
    expectPrivateFile(file);
    expect(fs.readFileSync(file, 'utf8').trim()).toBe(loaded.token.toString('utf8'));
    expect(notice, 'the token itself must never reach startup output').not.toContain(loaded.token.toString('utf8'));
  });

  it('prints the ignored warning as its own line, not glued into the sentence before it', () => {
    process.env.MEMESH_REMOTE_TOKEN = 'short';
    writeFixtureToken('b'.repeat(64));
    const lines = remoteTokenStartupNotice(loadOrCreateRemoteToken()).trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^MeMesh HTTP: remote bind requires Authorization: Bearer <token>\. Token loaded from .*remote-token\.$/);
    expect(lines[1]).toBe('  MEMESH_REMOTE_TOKEN is shorter than 16 characters and was ignored.');
  });

  it('does not call an empty variable "ignored": an empty string is the same as unset', () => {
    process.env.MEMESH_REMOTE_TOKEN = '';
    writeFixtureToken('d'.repeat(64));
    const loaded = loadOrCreateRemoteToken();
    expect(loaded.envIgnored).toBe(false);
    expect(remoteTokenStartupNotice(loaded)).not.toContain('ignored');
  });

  it('is unchanged when no variable is set', () => {
    delete process.env.MEMESH_REMOTE_TOKEN;
    writeFixtureToken('c'.repeat(64));
    const loaded = loadOrCreateRemoteToken();
    expect(loaded.envIgnored).toBe(false);
    const notice = remoteTokenStartupNotice(loaded);
    expect(notice).toContain(`Token loaded from ${path.join(dir, 'remote-token')}.`);
    expect(notice).not.toContain('ignored');
    expect(notice, 'the token itself must never reach startup output').not.toContain('c'.repeat(64));
  });

  it.runIf(process.platform === 'win32')('refuses a public existing data root without adding a token or changing its ACL', () => {
    delete process.env.MEMESH_REMOTE_TOKEN;
    const acl = makeWindowsAclPublic(dir);
    expect(() => loadOrCreateRemoteToken()).toThrow(/Cannot verify private Windows permissions/);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(readWindowsAcl(dir)).toEqual(acl);
  });

  it.runIf(process.platform === 'win32')('reuses an owner-read-only token and refuses an unsafe existing token without rewriting it', () => {
    delete process.env.MEMESH_REMOTE_TOKEN;
    const value = 'f'.repeat(64);
    const file = writeFixtureToken(value);
    const denied = windowsAclFixture(file, 'deny');
    expect(loadOrCreateRemoteToken().token.equals(Buffer.from(value))).toBe(true);
    expect(readWindowsAcl(file)).toEqual(denied);

    const publicAcl = makeWindowsAclPublic(file);
    expect(() => loadOrCreateRemoteToken()).toThrow(/Cannot verify private Windows permissions/);
    expect(fs.readFileSync(file, 'utf8')).toBe(value + '\n');
    expect(readWindowsAcl(file)).toEqual(publicAcl);
    windowsAclFixture(file, 'restore');
  });

  it.runIf(process.platform === 'win32')('leaves an ACL-failed token unpublished and can retry in a new data directory', () => {
    delete process.env.MEMESH_REMOTE_TOKEN;
    process.env.MEMESH_DIR = path.join(dir, 'new-data');
    const makePrivate = windowsPermissions.makeWindowsPathsPrivate;
    const acl = vi.spyOn(windowsPermissions, 'makeWindowsPathsPrivate').mockImplementationOnce(([stage]) => {
      expect(fs.readdirSync(stage)).toEqual([]);
      throw new Error('injected remote token directory ACL refusal');
    });
    try {
      expect(() => loadOrCreateRemoteToken()).toThrow('injected remote token directory ACL refusal');
      expect(fs.readdirSync(dir)).toEqual([]);
      acl.mockImplementationOnce(makePrivate);
      acl.mockImplementationOnce(([stage]) => {
        expect(fs.statSync(stage).size).toBe(0);
        throw new Error('injected remote token file ACL refusal');
      });
      expect(() => loadOrCreateRemoteToken()).toThrow('injected remote token file ACL refusal');
      expect(fs.readdirSync(process.env.MEMESH_DIR!)).toEqual([]);
      const retry = loadOrCreateRemoteToken();
      expect(retry.freshlyCreated).toBe(true);
      expectPrivateFile(retry.tokenPath);
      expect(loadOrCreateRemoteToken().token.equals(retry.token)).toBe(true);
    } finally { acl.mockRestore(); }
  });

  it.runIf(process.platform === 'win32')('reads the winner of token publication even while the winner still has its staging link', () => {
    delete process.env.MEMESH_REMOTE_TOKEN;
    const file = path.join(dir, 'remote-token');
    const competingStage = path.join(dir, 'competing-stage');
    const value = 'b'.repeat(64);
    const link = fs.linkSync;
    const race = vi.spyOn(fs, 'linkSync').mockImplementationOnce((staged, destination) => {
      expect(destination).toBe(file);
      fs.writeFileSync(competingStage, value + '\n', { mode: 0o600, flag: 'wx' });
      windowsPermissions.makeWindowsPathsPrivate([competingStage]);
      link(competingStage, file);
      return link(staged, destination);
    });
    try {
      const loaded = loadOrCreateRemoteToken();
      expect(loaded.freshlyCreated).toBe(false);
      expect(loaded.token.equals(Buffer.from(value))).toBe(true);
      expect(fs.statSync(file).nlink).toBe(2);
      expectPrivateFile(file);
      expect(fs.readdirSync(dir).sort()).toEqual(['competing-stage', 'remote-token']);
    } finally { race.mockRestore(); }
  });
});
