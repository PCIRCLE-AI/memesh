/**
 * The commands MeMesh prints for the owner to paste into a shell (#520). A
 * legal file name can hold `$(...)`, a backtick, `;` and a single quote, and
 * inside double quotes the first two still run. Every test here prints a
 * command for such a name, runs it with `sh -c` in a folder of its own, and
 * checks two things: the marker file the name tries to create was NOT created,
 * and the chmod reached the right file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDatabase, openDatabase } from '../../src/db.js';
import {
  ownerWriteCommand,
  refuseMismatchedSidecars,
  removeGroupAndOtherAccess,
  requirePrivateWritableDirectory,
  shellQuote,
} from '../../src/core/file-mode.js';

const posixUser = process.platform !== 'win32' && process.getuid?.() !== 0;
const mode = (p: string) => fs.statSync(p).mode & 0o777;

// Each piece tries a different way out of the quotes; the names create m1, m2, m3.
// Also: spaces, a double quote, a newline, and a leading dash on the segment
// (the paths printed here are absolute, so the dash is only mid-path).
const HOSTILE = "-evil$(touch m1)`touch m2`;touch m3;it's \"q\" two  spaces\nnewline";
const MARKERS = ['m1', 'm2', 'm3'];

/** Every `chmod <mode> 'a' 'b'` in a message, as printed (quoted words only). */
function chmodCommands(text: string): string[] {
  return text.match(/chmod [-+a-z]+(?: (?:'[^']*'|\\')+)+/g) ?? [];
}

describe.skipIf(!posixUser)('printed commands do not run what a file name holds', () => {
  let root: string;
  let home: string; // where the commands run; the markers would appear here

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-quote-'));
    home = path.join(root, 'cwd');
    fs.mkdirSync(home);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase();
    const loose = (p: string) => {
      try { fs.chmodSync(p, 0o700); } catch { /* gone */ }
      try { for (const e of fs.readdirSync(p)) loose(path.join(p, e)); } catch { /* a file */ }
    };
    loose(root);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** Run a printed command like the owner's shell would, from `home`. */
  function paste(command: string): void {
    const r = spawnSync('/bin/sh', ['-c', command], { cwd: home, encoding: 'utf8' });
    for (const marker of MARKERS) {
      expect(fs.existsSync(path.join(home, marker)), `${marker} was created by: ${command}`).toBe(false);
    }
    expect(r.status, `${command}\n${r.stderr}`).toBe(0);
  }

  const hostileDb = () => {
    const dir = path.join(root, HOSTILE);
    fs.mkdirSync(dir, { mode: 0o700 });
    return { dir, dbPath: path.join(dir, `${HOSTILE}.db`) };
  };

  it('shellQuote: one word, no expansion, the quote itself escaped', () => {
    const abs = path.join(root, HOSTILE);
    expect(shellQuote('/a b/c')).toBe("'/a b/c'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote('$(x)`y`;z"w')).toBe("'$(x)`y`;z\"w'");
    expect(shellQuote('a\nb')).toBe("'a\nb'");
    const r = spawnSync('/bin/sh', ['-c', `printf %s ${shellQuote(abs)}`], { cwd: home, encoding: 'utf8' });
    expect(r.stdout).toBe(abs);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('a relative path that starts with a dash is printed as ./-R, so mv and rm cannot read it as an option', () => {
    expect(shellQuote('-R')).toBe("'./-R'");
    expect(shellQuote('/abs/-R')).toBe("'/abs/-R'");
    // chmod reads its mode first, so a dash name only bites commands whose
    // first operand is the path: the `mv`/`rm`/`mkdir` doctor and the server print.
    fs.writeFileSync(path.join(home, '-R'), 'x');
    paste(`mv ${shellQuote('-R')} ${shellQuote('-R.backup')}`);
    expect(fs.existsSync(path.join(home, '-R.backup'))).toBe(true);
    expect(fs.existsSync(path.join(home, '-R'))).toBe(false);
    // The unprefixed spelling is the failure this prevents.
    fs.writeFileSync(path.join(home, '-R'), 'x');
    const bare = spawnSync('/bin/sh', ['-c', "mv '-R' 'plain'"], { cwd: home, encoding: 'utf8' });
    expect(bare.status).not.toBe(0);
  });

  it('ownerWriteCommand: the chmod it prints makes the read-only database writable', () => {
    const { dbPath } = hostileDb();
    fs.writeFileSync(dbPath, 'x', { mode: 0o400 });
    const command = ownerWriteCommand(dbPath);
    expect(command).toBe(`run: chmod u+w ${shellQuote(dbPath)}`);
    paste(command!.slice('run: '.length));
    expect(mode(dbPath)).toBe(0o600);
  });

  it('ownerWriteCommand: the -wal and -shm are quoted too', () => {
    const { dbPath } = hostileDb();
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.writeFileSync(file, 'x', { mode: 0o400 });
    paste(ownerWriteCommand(dbPath)!.slice('run: '.length));
    expect([dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map(mode)).toEqual([0o600, 0o600, 0o600]);
  });

  it('sidecar with fewer owner permissions: both printed commands hit the right files', () => {
    const { dbPath } = hostileDb();
    const wal = `${dbPath}-wal`;
    fs.writeFileSync(dbPath, 'x', { mode: 0o600 });
    fs.writeFileSync(wal, '', { mode: 0o400 });
    let error: (Error & { fix?: string }) | undefined;
    try { refuseMismatchedSidecars(dbPath); } catch (err) { error = err as Error & { fix?: string }; }
    expect(error?.fix).toBe(`chmod u+w ${shellQuote(wal)}`);
    const commands = chmodCommands(error!.message);
    expect(commands).toEqual([`chmod u+w ${shellQuote(wal)}`, `chmod u-w ${shellQuote(dbPath)}`]);
    paste(commands[0]);
    expect(mode(wal)).toBe(0o600);
    expect(mode(dbPath)).toBe(0o600);
    paste(commands[1]);
    expect(mode(dbPath)).toBe(0o400);
    expect(mode(wal)).toBe(0o600);
  });

  it('empty sidecar with extra owner permissions: both printed commands hit the right files', () => {
    const { dbPath } = hostileDb();
    const wal = `${dbPath}-wal`;
    fs.writeFileSync(dbPath, 'x', { mode: 0o400 });
    fs.writeFileSync(wal, '', { mode: 0o600 });
    let error: (Error & { fix?: string }) | undefined;
    try { refuseMismatchedSidecars(dbPath); } catch (err) { error = err as Error & { fix?: string }; }
    expect(error?.fix).toBe(`chmod u-w ${shellQuote(wal)}`);
    const commands = chmodCommands(error!.message);
    expect(commands).toEqual([`chmod u-w ${shellQuote(wal)}`, `chmod u+w ${shellQuote(dbPath)}`]);
    paste(commands[0]);
    expect(mode(wal)).toBe(0o400);
    expect(mode(dbPath)).toBe(0o400);
    paste(commands[1]);
    expect(mode(dbPath)).toBe(0o600);
    expect(mode(wal)).toBe(0o400);
  });

  it('removeGroupAndOtherAccess: the chmod in its warning tightens the right file', () => {
    const { dbPath } = hostileDb();
    fs.writeFileSync(dbPath, 'x', { mode: 0o644 });
    fs.chmodSync(dbPath, 0o644);
    const realChmod = fs.chmodSync;
    vi.spyOn(fs, 'chmodSync').mockImplementation((target, m) => {
      if (String(target) === dbPath) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      realChmod(target, m);
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    removeGroupAndOtherAccess(dbPath);
    vi.restoreAllMocks();
    const written = stderr.mock.calls.map((c) => String(c[0])).join('');
    const commands = chmodCommands(written);
    expect(commands).toEqual([`chmod go-rwx ${shellQuote(dbPath)}`]);
    paste(commands[0]);
    expect(mode(dbPath)).toBe(0o600);
  });

  it('requirePrivateWritableDirectory: the chmod in a read-only-folder refusal fixes the right folder', () => {
    const { dir } = hostileDb();
    fs.chmodSync(dir, 0o500);
    let message = '';
    try { requirePrivateWritableDirectory(dir, 'it keeps sockets there'); } catch (err) { message = (err as Error).message; }
    const commands = chmodCommands(message);
    expect(commands).toEqual([`chmod u+w ${shellQuote(dir)}`]);
    paste(commands[0]);
    expect(mode(dir)).toBe(0o700);
  });

  it('openDatabase in a read-only folder: the fix it names makes the folder writable', () => {
    const { dir, dbPath } = hostileDb();
    openDatabase(dbPath);
    closeDatabase();
    for (const s of ['-wal', '-shm']) fs.rmSync(`${dbPath}${s}`, { force: true });
    fs.chmodSync(dir, 0o500);
    let error: (Error & { fix?: string }) | undefined;
    try { openDatabase(dbPath); } catch (err) { error = err as Error & { fix?: string }; }
    expect(error?.fix).toBe(`chmod u+w ${shellQuote(dir)}`);
    expect(chmodCommands(error!.message)).toEqual([`chmod u+w ${shellQuote(dir)}`]);
    paste(error!.fix!);
    expect(mode(dir)).toBe(0o700);
  });

  it('upgrade-plugin.sh: its shq helper quotes the same way', () => {
    const script = fs.readFileSync(path.resolve('scripts/upgrade-plugin.sh'), 'utf8');
    const helper = script.split('\n').find((l) => l.startsWith('shq()'));
    const abs = path.join(root, HOSTILE); // the script's paths are absolute
    expect(helper).toBeDefined();
    const r = spawnSync('bash', ['-c', `${helper}\nshq "$1"`, 'bash', abs], { cwd: home, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(shellQuote(abs));
    // The script prints no path inside double quotes any more.
    expect(script).not.toMatch(/echo .*\\"\$[A-Z_]*(PATH|DIR)\\"/);
  });
});
