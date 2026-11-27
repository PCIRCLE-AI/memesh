// The frame log is a test hook, but it ships and holds message contents: owner-only,
// never through a symlink, never in a folder others can read.
import fs from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendTestFrameLog } from '../../src/network/test-frame-log.js';
import * as windowsPermissions from '../../src/core/windows-permissions.js';
import { makeHome, removeTree } from './helpers.js';

// Exercise the actual two courier callers without starting a native endpoint.
// The transport result is controlled; this is not proof of real relay routing.
describe('courier selected-route diagnostics', () => {
  it.each(['relay', 'direct', null])('retains %j for message and receipt without logging payload', async (selectedPath) => {
    const source = fs.readFileSync(path.resolve('src/network/bridge-serve.ts'), 'utf8');
    const start = source.indexOf('  const deliverTo = async');
    const end = source.indexOf('  // What each member was last sent', start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const compiled = await transform(source.slice(start, end), { loader: 'ts', target: 'es2022' });
    const records: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const calls: string[] = [], failures: unknown[] = [];
    const secret = 'SYNTHETIC-BODY-KEY-INVITE-MUST-NOT-BE-LOGGED';
    const store = {
      outgoingFor: () => [{ message: { id: 'message-id', body: secret }, key: secret, invite: secret }],
      receiptsFor: () => [{ message_id: 'message-id', event: 'read', actor: secret, at: '2026-11-15T00:00:00.000Z' }],
      recordCopyAccepted: () => calls.push('copy'), recordReceiptAccepted: () => calls.push('receipt'), close: () => {},
    };
    const ack = { result: selectedPath === 'direct' ? 'duplicate' : 'accepted' };
    const deliver = runInNewContext(`${compiled.code}\ndeliverTo;`, {
      sendingTo: new Set<string>(), stopping: false, messages: () => store, authorize: () => ({}),
      sendFrame: async (_target: string, frame: { kind: string }) => { calls.push(frame.kind); return { ack, path: selectedPath }; },
      appendLog: (_dir: string, event: string, detail: Record<string, unknown>) => records.push({ event, detail }),
      dataDir: 'unused-private-fixture', recordError: (_event: string, error: unknown) => failures.push(error), errorMessage: String,
    }) as (target: string, outgoing: ReturnType<typeof store.outgoingFor>, receipts: ReturnType<typeof store.receiptsFor>) => Promise<void>;
    await deliver('recipient-machine', store.outgoingFor(), store.receiptsFor());
    expect(failures).toEqual([]);
    expect(calls).toEqual(['conversation-message', 'copy', 'conversation-receipt', 'receipt']);
    expect(records).toEqual(['conversation-message', 'conversation-receipt'].map(frame => ({
      event: 'frame_sent', detail: { frame, message_id: 'message-id', result: ack.result, path: selectedPath },
    })));
    expect(JSON.stringify(records)).not.toContain(secret);
  });
});

describe.skipIf(process.platform === 'win32')('the test frame log', () => {
  let dir: string;
  beforeEach(() => { dir = makeHome('fl-'); });
  afterEach(() => removeTree(dir));

  it('is written 0600, even when the file already existed with a looser mode', () => {
    const file = path.join(dir, 'frames.log');
    expect(appendTestFrameLog(file, Buffer.from('one'))).toBeNull();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.chmodSync(file, 0o644);
    expect(appendTestFrameLog(file, Buffer.from('two'))).toBeNull();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).toBe('one\ntwo\n');
  });

  it('refuses a symlink at the file path, and writes nothing through it', () => {
    const target = path.join(dir, 'elsewhere.txt');
    fs.writeFileSync(target, 'untouched', { mode: 0o600 });
    const link = path.join(dir, 'frames.log');
    fs.symlinkSync(target, link);
    expect(appendTestFrameLog(link, Buffer.from('secret'))).toMatch(/could not be opened safely/);
    expect(fs.readFileSync(target, 'utf8')).toBe('untouched');
  });

  it('refuses a folder others can read, and a symlinked folder, without changing either', () => {
    const open = path.join(dir, 'open');
    fs.mkdirSync(open, { mode: 0o755 });
    fs.chmodSync(open, 0o755);
    expect(appendTestFrameLog(path.join(open, 'frames.log'), Buffer.from('x'))).toMatch(/readable by others/);
    expect(fs.statSync(open).mode & 0o777).toBe(0o755);
    expect(fs.existsSync(path.join(open, 'frames.log'))).toBe(false);
    const linked = path.join(dir, 'linked');
    fs.symlinkSync(dir, linked);
    expect(appendTestFrameLog(path.join(linked, 'frames.log'), Buffer.from('x'))).toMatch(/not a plain folder/);
  });
});

describe('the Windows test frame log path', () => {
  let dir: string;
  beforeEach(() => { dir = fs.realpathSync(makeHome('fl-')); });
  afterEach(() => { vi.restoreAllMocks(); removeTree(dir); });

  function appendOnWindows(file: string, body: string): string | null {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try { return appendTestFrameLog(file, Buffer.from(body)); }
    finally { Object.defineProperty(process, 'platform', platform); }
  }

  it('verifies the folder and secures the file before appending any bytes', () => {
    const file = path.join(dir, 'frames.log');
    const verify = vi.spyOn(windowsPermissions, 'verifyWindowsPathsPrivate').mockImplementation(() => {});
    const seen: string[] = [];
    const makePrivate = vi.spyOn(windowsPermissions, 'makeWindowsPathsPrivate').mockImplementation(() => {
      seen.push(fs.readFileSync(file, 'utf8'));
    });
    expect(appendOnWindows(file, 'one')).toBeNull();
    expect(appendOnWindows(file, 'two')).toBeNull();
    expect(verify.mock.calls).toEqual([[[dir]], [[dir]]]);
    expect(makePrivate.mock.calls).toEqual([[[file]], [[file]]]);
    expect(verify.mock.invocationCallOrder[0]).toBeLessThan(makePrivate.mock.invocationCallOrder[0]);
    expect(seen).toEqual(['', 'one\n']);
    expect(fs.readFileSync(file, 'utf8')).toBe('one\ntwo\n');
  });

  it('refuses a directory whose ACL is not private before checking or opening the file', () => {
    const file = path.join(dir, 'frames.log');
    const verify = vi.spyOn(windowsPermissions, 'verifyWindowsPathsPrivate').mockImplementation(() => {
      throw new Error('public directory');
    });
    const makePrivate = vi.spyOn(windowsPermissions, 'makeWindowsPathsPrivate');
    const lstat = vi.spyOn(fs, 'lstatSync');
    const realpath = vi.spyOn(fs, 'realpathSync');
    const open = vi.spyOn(fs, 'openSync');
    expect(appendOnWindows(file, 'secret')).toMatch(/public directory/);
    expect(verify).toHaveBeenCalledWith([dir]);
    expect(lstat.mock.calls.some(([target]) => target === file)).toBe(false);
    expect(realpath.mock.calls.some(([target]) => target === file)).toBe(false);
    expect(open.mock.calls.some(([target]) => target === file)).toBe(false);
    expect(makePrivate).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('refuses to write if the file is replaced while securing its ACL', () => {
    const file = path.join(dir, 'frames.log');
    const moved = path.join(dir, 'original.log');
    fs.writeFileSync(file, 'original');
    vi.spyOn(windowsPermissions, 'verifyWindowsPathsPrivate').mockImplementation(() => {});
    vi.spyOn(windowsPermissions, 'makeWindowsPathsPrivate').mockImplementation(() => {
      fs.renameSync(file, moved);
      fs.writeFileSync(file, 'replacement');
    });
    expect(appendOnWindows(file, 'secret')).toMatch(/unsafe or changed frame log path/);
    expect(fs.readFileSync(moved, 'utf8')).toBe('original');
    expect(fs.readFileSync(file, 'utf8')).toBe('replacement');
  });
});
