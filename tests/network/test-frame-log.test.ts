// The frame log is a test hook, but it ships and holds message contents: owner-only,
// never through a symlink, never in a folder others can read.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendTestFrameLog } from '../../src/network/test-frame-log.js';
import { makeHome, removeTree } from './helpers.js';

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
