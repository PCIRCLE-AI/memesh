import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireWindowsRepairGuard } from '../../src/core/windows-repair-guard.js';

const sharingError = /unable to open database file/i;

function sqlite(file: string, readOnly = false): number {
  const db = new DatabaseSync(file, { readOnly });
  try {
    if (!readOnly) db.exec('PRAGMA busy_timeout=0; INSERT INTO probe VALUES (2)');
    return Number(db.prepare('SELECT count(*) AS n FROM probe').get()?.n);
  } finally { db.close(); }
}

function startFixture(executable: string, args: string[]) {
  const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const lines = createInterface({ input: child.stdout });
  const ready = Promise.race([
    once(lines, 'line', { signal: AbortSignal.timeout(25_000) }).then(([line]) => line), closed,
  ]);
  return { child, ready, closed };
}

describe.runIf(process.platform === 'win32')('native Windows repair guard', () => {
  let directory: string;
  let file: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-native-repair-'));
    file = path.join(directory, '資料.db');
    const db = new DatabaseSync(file);
    try { db.exec('CREATE TABLE probe (n); INSERT INTO probe VALUES (1)'); }
    finally { db.close(); }
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 }));

  it('atomically replaces its open target through class 65 after ordinary rename fails', async () => {
    const staged = path.join(directory, 'replacement.db');
    const before = fs.readFileSync(file);
    const after = Buffer.from('replacement');
    fs.writeFileSync(staged, after, { flag: 'wx' });
    const guard = await acquireWindowsRepairGuard([file]);
    try {
      expect(() => fs.renameSync(staged, file)).toThrow(/EPERM|EACCES|EBUSY/);
      expect(fs.readFileSync(file)).toEqual(before);
      await guard.replace(staged, file);
      expect(fs.readFileSync(file)).toEqual(after);
      expect(fs.existsSync(staged)).toBe(false);
    } finally { await guard.release(); }
    expect(fs.readFileSync(file)).toEqual(after);
  });

  it('rejects existing SQLite readers and writers and excludes new opens until release', async () => {
    const before = fs.readFileSync(file);
    for (const readOnly of [false, true]) {
      const live = new DatabaseSync(file, { readOnly });
      try {
        expect(live.prepare('SELECT n FROM probe').get()?.n).toBe(1);
        await expect(acquireWindowsRepairGuard([file])).rejects.toThrow('Cannot acquire the Windows repair lock');
        expect(fs.readFileSync(file)).toEqual(before);
      } finally { live.close(); }
    }
    const guard = await acquireWindowsRepairGuard([file]);
    try {
      expect(() => sqlite(file, true)).toThrow(sharingError);
      expect(() => sqlite(file)).toThrow(sharingError);
      expect(fs.readFileSync(file)).toEqual(before);
    } finally { await guard.release(); }
    expect(sqlite(file, true)).toBe(1);
    expect(sqlite(file)).toBe(2);
  });

  it('guards an empty existing sidecar and leaves a missing sidecar absent', async () => {
    const wal = file + '-wal';
    const shm = file + '-shm';
    fs.writeFileSync(wal, '', { flag: 'wx' });
    const guard = await acquireWindowsRepairGuard([file, wal]);
    try {
      expect(() => fs.writeFileSync(wal, 'unexpected')).toThrow();
      expect(fs.statSync(wal).size).toBe(0);
      expect(fs.existsSync(shm)).toBe(false);
      expect(() => sqlite(file)).toThrow(sharingError);
    } finally { await guard.release(); }
    expect(fs.statSync(wal).size).toBe(0);
    expect(fs.existsSync(shm)).toBe(false);
    fs.unlinkSync(wal);
    expect(sqlite(file)).toBe(2);
  });

  it('refuses a writable mapped sidecar and releases the partially acquired main guard', async () => {
    const shm = file + '-shm';
    const system = process.env.SystemRoot ?? process.env.SYSTEMROOT!;
    const powershell = path.win32.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$file = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine()))
$share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
$stream = [IO.FileStream]::new($file, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, $share)
$map = [IO.MemoryMappedFiles.MemoryMappedFile]::CreateFromFile($stream, $null, 0,
  [IO.MemoryMappedFiles.MemoryMappedFileAccess]::ReadWrite, [IO.HandleInheritability]::None, $true)
$view = $map.CreateViewAccessor()
try {
  $stream.Dispose()
  [Console]::WriteLine('READY')
  $null = [Console]::ReadLine()
} finally { $view.Dispose(); $map.Dispose() }
`;
    fs.writeFileSync(shm, Buffer.alloc(4096, 42), { flag: 'wx' });
    const before = fs.readFileSync(shm);
    const main = fs.readFileSync(file);
    const fixture = startFixture(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')]);
    try {
      fixture.child.stdin.write(Buffer.from(shm, 'utf8').toString('base64') + '\n');
      expect(await fixture.ready).toBe('READY');
      await expect(acquireWindowsRepairGuard([file, shm])).rejects.toThrow('Cannot acquire the Windows repair lock');
      expect(fs.readFileSync(file)).toEqual(main);
      expect(fs.readFileSync(shm)).toEqual(before);
      expect(sqlite(file, true)).toBe(1);
    } finally {
      fixture.child.stdin.end();
      const timer = setTimeout(() => fixture.child.kill('SIGKILL'), 5_000);
      try { expect(await fixture.closed).toEqual({ code: 0, signal: null }); }
      finally { clearTimeout(timer); }
    }
  });

  it('releases stock SQLite opens when its Node parent is forcibly terminated', async () => {
    const guardModule = new URL('../../src/core/windows-repair-guard.ts', import.meta.url).href;
    const fixture = startFixture(process.execPath, ['--input-type=module', '-e', `
      import { acquireWindowsRepairGuard } from ${JSON.stringify(guardModule)};
      await acquireWindowsRepairGuard([process.argv[1]]);
      process.stdout.write('READY\\n');
    `, file]);
    try {
      expect(await fixture.ready).toBe('READY');
      expect(() => sqlite(file)).toThrow(sharingError);
      expect(fixture.child.kill('SIGKILL')).toBe(true);
      expect(await fixture.closed).toEqual({ code: null, signal: 'SIGKILL' });
      await expect.poll(() => sqlite(file, true), { timeout: 10_000 }).toBe(1);
      expect(sqlite(file)).toBe(2);
    } finally {
      if (fixture.child.exitCode === null && fixture.child.signalCode === null) fixture.child.kill('SIGKILL');
      await fixture.closed;
      // Node can exit before its guard notices EOF.
      await expect.poll(() => {
        fs.closeSync(fs.openSync(file, 'r+'));
        return true;
      }, { timeout: 5_000 }).toBe(true);
    }
  });
});
