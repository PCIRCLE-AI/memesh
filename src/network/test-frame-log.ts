// A TEST HOOK, off in production: when MEMESH_TEST_NETWORK_FRAME_LOG names a file,
// the bridge appends every frame it reads there, message contents included, so a
// test can prove nothing from memory crosses. Because it ships, it is written as
// carefully as real data: an owner-only file (0600) in an owner-only folder, never
// through a symlink, and a refusal is reported instead of writing somewhere else.

import fs from 'node:fs';
import path from 'node:path';
import { makeWindowsPathsPrivate, verifyWindowsPathsPrivate } from '../core/windows-permissions.js';

function windowsLogEntry(file: string, directory: boolean, expected?: fs.BigIntStats): fs.BigIntStats {
  const entry = fs.lstatSync(file, { bigint: true });
  if (entry.isSymbolicLink() || entry.ino === 0n || !(directory ? entry.isDirectory() : entry.isFile() && entry.nlink === 1n)
    || path.relative(file, fs.realpathSync(file)) !== ''
    || (expected && (entry.dev !== expected.dev || entry.ino !== expected.ino))) {
    throw new Error(`unsafe or changed frame log path: ${file}`);
  }
  return entry;
}

function appendWindowsFrameLog(file: string, folder: string, bytes: Buffer): string | null {
  try {
    const directory = windowsLogEntry(folder, true);
    verifyWindowsPathsPrivate([folder]);
    windowsLogEntry(folder, true, directory);

    const existing = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (existing) windowsLogEntry(file, false, existing);
    const create = existing ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL;
    windowsLogEntry(folder, true, directory);
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | create, 0o600);
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      windowsLogEntry(folder, true, directory);
      windowsLogEntry(file, false, opened);
      if (existing && (opened.dev !== existing.dev || opened.ino !== existing.ino)) {
        throw new Error(`frame log path changed while opening: ${file}`);
      }
      makeWindowsPathsPrivate([file]);
      windowsLogEntry(folder, true, directory);
      windowsLogEntry(file, false, opened);
      fs.writeSync(fd, `${bytes.toString('utf8')}\n`);
      return null;
    } finally { fs.closeSync(fd); }
  } catch (error) {
    return `the frame log ${file} could not be opened safely (${error instanceof Error ? error.message : String(error)})`;
  }
}

/** Append one frame. Null when written; otherwise why it was refused. */
export function appendTestFrameLog(file: string, bytes: Buffer): string | null {
  const absolute = path.resolve(file);
  const folder = path.dirname(absolute);
  if (process.platform === 'win32') return appendWindowsFrameLog(absolute, folder, bytes);
  let folderStat: fs.Stats;
  try {
    folderStat = fs.lstatSync(folder);
  } catch {
    return `the frame log folder ${folder} does not exist`;
  }
  if (folderStat.isSymbolicLink() || !folderStat.isDirectory()) return `the frame log folder ${folder} is not a plain folder`;
  // Never loosen or tighten someone else's folder (it could be /tmp): refuse unless already private.
  if ((folderStat.mode & 0o077) !== 0) return `the frame log folder ${folder} is readable by others`;
  if (typeof process.getuid === 'function' && folderStat.uid !== process.getuid()) return `the frame log folder ${folder} belongs to another user`;
  let fd: number;
  try {
    // O_NOFOLLOW: a symlink at the file's path is refused by the system, not followed.
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  } catch (err) {
    return `the frame log ${file} could not be opened safely (${(err as NodeJS.ErrnoException).code ?? 'error'})`;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return `the frame log ${file} is not a regular file`;
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, `${bytes.toString('utf8')}\n`);
    return null;
  } finally {
    fs.closeSync(fd);
  }
}
