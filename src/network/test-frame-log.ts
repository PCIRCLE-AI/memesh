// A TEST HOOK, off in production: when MEMESH_TEST_NETWORK_FRAME_LOG names a file,
// the bridge appends every frame it reads there, message contents included, so a
// test can prove nothing from memory crosses. Because it ships, it is written as
// carefully as real data: an owner-only file (0600) in an owner-only folder, never
// through a symlink, and a refusal is reported instead of writing somewhere else.

import fs from 'node:fs';
import path from 'node:path';

/** Append one frame. Null when written; otherwise why it was refused. */
export function appendTestFrameLog(file: string, bytes: Buffer): string | null {
  const folder = path.dirname(path.resolve(file));
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
