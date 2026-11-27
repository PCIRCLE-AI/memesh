import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { makeWindowsPathsPrivate, verifyWindowsPathsPrivate } from '../../src/core/windows-permissions.js';
import { databaseFiles, requirePrivateWritableDirectory } from '../../src/core/file-mode.js';
import { ConversationMessages } from '../../src/core/conversation-messages.js';
import { removeTempDir } from '../helpers/temp-dir.js';
import { windowsAclFixture } from '../helpers/permissions.js';
import { parseTraceLine, traceScript } from '../../scripts/diagnose-windows-messages-entry.mjs';
import { claimWindowsHookState, prepareWindowsHookState, windowsHookStateDeadline } from '../../scripts/hooks/_shared.js';

const roots: string[] = [];
function directory(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-acl-')));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) removeTempDir(root);
});

describe('Windows permissions bridge', () => {
  it('passes literal Unicode, quotes and shell metacharacters only as encoded stdin data', () => {
    const dir = path.join(directory(), "空 白 ' $(not-a-command); marker");
    fs.mkdirSync(dir);
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    const exec = vi.spyOn(childProcess, 'execFileSync').mockReturnValue('{"ok":true}');
    makeWindowsPathsPrivate([dir, path.join(dir, 'missing.db')], dir);
    const [command, args, options] = exec.mock.calls[0];
    expect(command).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', expect.any(String)]);
    const script = Buffer.from((args as string[])[4], 'base64').toString('utf16le');
    expect(script).not.toContain('not-a-command');
    expect(script).toContain("Import-Module -Name ([IO.Path]::Combine($PSHOME, 'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop");
    const frame = String((options as { input: string }).input);
    expect(frame).toMatch(/^[A-Za-z0-9+/=]+\n$/);
    expect(JSON.parse(Buffer.from(frame.trim(), 'base64').toString('utf8'))).toEqual({ paths: [dir], writableDirectory: dir, readOnly: false });
    expect(options).toMatchObject({ timeout: 15000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  });

  it.each(['{"ok":false}', '{}', 'not JSON'])('refuses an unverified response: %s', output => {
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(childProcess, 'execFileSync').mockReturnValue(output);
    expect(() => makeWindowsPathsPrivate([directory()])).toThrow(/Cannot verify private Windows permissions/);
  });

  it('fails closed when PowerShell cannot run, without adding permissions or a shell fallback', () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    const exec = vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => { throw new Error('access denied'); });
    expect(() => makeWindowsPathsPrivate([directory()])).toThrow(/Cannot verify private Windows permissions/);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('does not launch a process for absent optional SQLite sidecars', () => {
    const exec = vi.spyOn(childProcess, 'execFileSync');
    makeWindowsPathsPrivate([path.join(directory(), 'absent.db')]);
    expect(exec).not.toHaveBeenCalled();
  });

  it('sends readonly verification without a write probe', () => {
    const dir = directory();
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    const exec = vi.spyOn(childProcess, 'execFileSync').mockReturnValue('{"ok":true}');
    verifyWindowsPathsPrivate([dir]);
    const frame = String((exec.mock.calls[0][2] as { input: string }).input);
    expect(JSON.parse(Buffer.from(frame.trim(), 'base64').toString('utf8'))).toEqual({ paths: [dir], readOnly: true });
  });

  it('passes a shorter hook timeout through to both permission subprocesses', () => {
    const dir = directory();
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    const exec = vi.spyOn(childProcess, 'execFileSync').mockReturnValue('{"ok":true}');
    verifyWindowsPathsPrivate([dir], 1200);
    makeWindowsPathsPrivate([dir], undefined, 450);
    expect(exec.mock.calls.map(call => call[2])).toEqual([
      expect.objectContaining({ timeout: 1200 }),
      expect.objectContaining({ timeout: 450 }),
    ]);
  });

  it.each([0, -1, NaN, Infinity])('refuses an invalid timeout without starting PowerShell: %s', timeout => {
    const dir = directory();
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    const exec = vi.spyOn(childProcess, 'execFileSync');
    expect(() => verifyWindowsPathsPrivate([dir], timeout)).toThrow(/Cannot verify private Windows permissions/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('retries a first-time Windows hook state leaf after a transient ACL timeout', () => {
    const root = fs.realpathSync.native(directory());
    const leaf = path.join(root, 'decision-nudge-flags');
    const file = path.join(leaf, 'first-ExitPlanMode.flag');
    vi.stubEnv('MEMESH_DB_PATH', path.join(root, 'test.db'));
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    const readOnlyChecks: boolean[] = [];
    vi.spyOn(childProcess, 'execFileSync').mockImplementation(((_, __, options: { input: string }) => {
      const request = JSON.parse(Buffer.from(options.input.trim(), 'base64').toString());
      readOnlyChecks.push(request.readOnly);
      if (readOnlyChecks.length === 1) throw Object.assign(new Error('controlled ACL timeout'), { code: 'ETIMEDOUT' });
      if (request.readOnly) throw new Error('controlled inherited ACL rejection');
      return '{"ok":true}';
    }) as typeof childProcess.execFileSync);

    const prepare = () => prepareWindowsHookState(file, windowsHookStateDeadline(5000), true);
    expect(prepare).toThrow(expect.objectContaining({
      code: 'MEMESH_PRIVATE_PATH', cause: expect.objectContaining({ code: 'ETIMEDOUT' }),
    }));
    expect(fs.existsSync(leaf)).toBe(false);
    const state = prepare();
    expect(claimWindowsHookState(state, '123')).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('123');
    expect(readOnlyChecks).toEqual([false, false, false]);
  });
});

const fixture = windowsAclFixture;

function withFailureTrace<T>(action: () => T): T {
  let traceFile: string | undefined;
  let exec: ReturnType<typeof vi.spyOn> | undefined;
  const inherited = process.env.MEMESH_WINDOWS_MESSAGES_PHASE_FILE;
  try {
    traceFile = path.join(directory(), '.windows-acl-trace');
    fs.writeFileSync(traceFile, '', { mode: 0o600, flag: 'wx' });
    process.env.MEMESH_WINDOWS_MESSAGES_PHASE_FILE = traceFile;
    const original = childProcess.execFileSync;
    exec = vi.spyOn(childProcess, 'execFileSync').mockImplementation(((command, args, options) => {
      const argv = Array.isArray(args) ? args : [];
      const index = argv.indexOf('-EncodedCommand');
      let traced: string | null = null;
      try { traced = index >= 0 ? traceScript(String(argv[index + 1])) : null; } catch {}
      return original(command, traced ? [...argv.slice(0, index + 1), traced, ...argv.slice(index + 2)] : argv, options);
    }) as typeof childProcess.execFileSync);
  } catch { /* observation setup must leave an already-created trace cleanable */ }
  try {
    return action();
  } catch (error) {
    try {
      if (traceFile) {
        const events = fs.readFileSync(traceFile, 'utf8').split(/\r?\n/).map(parseTraceLine).filter(Boolean).slice(-40);
        process.stderr.write(`MEMESH_WINDOWS_ACL_TRACE ${JSON.stringify(events)}\n`);
      }
    } catch { /* observation cannot replace the original failure */ }
    throw error;
  } finally {
    try { exec?.mockRestore(); } catch {}
    try { if (traceFile) fs.rmSync(traceFile, { force: true }); } catch {}
    if (inherited === undefined) delete process.env.MEMESH_WINDOWS_MESSAGES_PHASE_FILE;
    else process.env.MEMESH_WINDOWS_MESSAGES_PHASE_FILE = inherited;
  }
}

describe('Windows permission diagnostic projection', () => {
  it('instruments the separate protection persist and reread phases', () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    const exec = vi.spyOn(childProcess, 'execFileSync').mockReturnValue('{"ok":true}');
    makeWindowsPathsPrivate([directory()]);
    const encoded = (exec.mock.calls[0][1] as string[])[4];
    const traced = traceScript(encoded);
    expect(traced).not.toBeNull();
    const script = Buffer.from(traced!, 'base64').toString('utf16le');
    expect(script).toContain("Trace-Phase 'ps-acl-protect-set'");
    expect(script).toContain("Trace-Phase 'ps-acl-protect-read-done'");
  });

  it('keeps only bounded reason and ACL-shape fields', () => {
    expect(parseTraceLine('ps-reason-rights-changed 12')).toEqual({ phase: 'ps-reason-rights-changed', elapsedMs: 12 });
    expect(parseTraceLine('shape 12 expected,1,other,allow,-2147483648,3,0')).toEqual({ phase: 'ps-acl-shape', elapsedMs: 12, side: 'expected', total: 1, rules: [{ subject: 'other', type: 'allow', rights: -2147483648, inherit: 3, propagation: 0 }] });
    expect(parseTraceLine('shape 12 expected,1,other,allow,7,3,0 secret')).toBeNull();
    expect(parseTraceLine('shape 12 expected,1,unknown,allow,7,4,0')).toBeNull();
  });

  it.each(['setup', 'cleanup'])('keeps the original error when trace %s fails', fault => {
    const prior = process.env.MEMESH_WINDOWS_MESSAGES_PHASE_FILE;
    const error = new Error('original failure');
    if (fault === 'setup') vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => { throw new Error('trace setup failed'); });
    else vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => { throw new Error('trace cleanup failed'); });
    let caught: unknown;
    try { withFailureTrace(() => { throw error; }); } catch (failure) { caught = failure; }
    expect(caught).toBe(error);
    expect(process.env.MEMESH_WINDOWS_MESSAGES_PHASE_FILE).toBe(prior);
    expect(vi.isMockFunction(childProcess.execFileSync)).toBe(false);
  });

});

describe.runIf(process.platform === 'win32')('actual Windows private paths', () => {
  it('accepts a safe inherited ACL and rejects a public inherited ACL without changing either', () => {
    const privateParent = directory();
    makeWindowsPathsPrivate([privateParent], privateParent);
    const safe = path.join(privateParent, 'safe.db');
    fs.writeFileSync(safe, 'fixture');
    const safeBefore = fixture(safe, 'read');
    expect(safeBefore.protected).toBe(false);
    expect(() => verifyWindowsPathsPrivate([safe])).not.toThrow();
    expect(fixture(safe, 'read')).toEqual(safeBefore);

    const publicParent = directory();
    fixture(publicParent, 'public');
    const publicFile = path.join(publicParent, 'public.db');
    fs.writeFileSync(publicFile, 'fixture');
    const publicBefore = fixture(publicFile, 'read');
    expect(publicBefore.protected).toBe(false);
    expect(publicBefore.rules).toContainEqual(expect.objectContaining({ sid: 'S-1-1-0', type: 'Allow' }));
    expect(() => verifyWindowsPathsPrivate([publicFile])).toThrow(/Cannot verify private Windows permissions/);
    expect(fixture(publicFile, 'read')).toEqual(publicBefore);
  });

  it('refuses a public DACL without repairing it', () => {
    const file = path.join(directory(), 'public.db');
    fs.writeFileSync(file, 'fixture');
    fixture(file, 'public');
    expect(() => verifyWindowsPathsPrivate([file])).toThrow(/Cannot verify private Windows permissions/);
    expect(fixture(file, 'read').rules).toContainEqual(expect.objectContaining({ sid: 'S-1-1-0', type: 'Allow' }));
  });

  it('protects new message sidecars and repairs explicitly public existing message files', () => {
    const dir = path.join(directory(), "空 白 ' $(literal); path");
    fs.mkdirSync(dir);
    const db = path.join(dir, 'messages.db');
    expect(fixture(dir, 'public').rules).toContainEqual(expect.objectContaining({ sid: 'S-1-1-0', type: 'Allow' }));
    const first = new ConversationMessages({ file: db });
    let reopened: ConversationMessages | undefined;
    try {
      for (const id of ['A', 'B']) first.register({ id, host: 'codex', machine: first.machine, pid: process.pid, wake: {} });
      const sent = first.send('A', { recipient: 'B', kind: 'task', body: 'retained message' }).message;
      for (const file of [dir, ...databaseFiles(db)]) {
        expect(fs.existsSync(file)).toBe(true);
        expect(fixture(file, 'read').rules).not.toContainEqual(expect.objectContaining({ sid: 'S-1-1-0', type: 'Allow' }));
      }
      for (const file of [dir, ...databaseFiles(db)]) {
        expect(fixture(file, 'public').rules).toContainEqual(expect.objectContaining({ sid: 'S-1-1-0', type: 'Allow' }));
      }
      reopened = new ConversationMessages({ file: db });
      for (const file of [dir, ...databaseFiles(db)]) {
        const acl = fixture(file, 'read');
        expect(acl.protected).toBe(true);
        expect(acl.rules).not.toContainEqual(expect.objectContaining({ sid: 'S-1-1-0', type: 'Allow' }));
      }
      expect(reopened.read('B', sent.id).body).toBe('retained message');
      expect(fs.readdirSync(dir).sort()).toEqual(['messages.db', 'messages.db-shm', 'messages.db-wal']);
    } finally { reopened?.close(); first.close(); }
  });

  it('preserves an owner write denial and rejects the actual directory write probe', () => {
    const dir = directory();
    fixture(dir, 'deny');
    try {
      const before = fixture(dir, 'read').rules.filter(rule => rule.type === 'Deny');
      expect(before.length).toBeGreaterThan(0);
      expect(() => withFailureTrace(() => requirePrivateWritableDirectory(dir, 'messages must remain owner-private'))).toThrow(/Cannot verify private Windows permissions/);
      expect(fixture(dir, 'read').rules.filter(rule => rule.type === 'Deny')).toEqual(before);
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally { fixture(dir, 'restore'); }
  });

  it('does not restore write access to a read-only file', () => {
    const dir = directory();
    const db = path.join(dir, 'readonly.db');
    fs.writeFileSync(db, 'fixture');
    fs.chmodSync(db, 0o444);
    try {
      withFailureTrace(() => {
        makeWindowsPathsPrivate([db]);
        expect(fs.statSync(db).mode & 0o200).toBe(0);
      });
    } finally { fs.chmodSync(db, 0o600); }
  });

  it('protects a fresh inherited message-store directory', () => {
    const parent = directory();
    fixture(parent, 'public');
    const dir = path.join(parent, 'inherited');
    fs.mkdirSync(dir);
    let store: ConversationMessages | undefined;
    try {
      const before = fixture(dir, 'read');
      expect(before.protected).toBe(false);
      expect(before.rules).toContainEqual(expect.objectContaining({ sid: 'S-1-1-0', type: 'Allow' }));
      withFailureTrace(() => {
        store = new ConversationMessages({ file: path.join(dir, 'messages.db') });
        const acl = fixture(dir, 'read');
        expect(acl.protected).toBe(true);
        expect(acl.rules).not.toContainEqual(expect.objectContaining({ sid: 'S-1-1-0', type: 'Allow' }));
      });
    } finally { store?.close(); }
  });
});
