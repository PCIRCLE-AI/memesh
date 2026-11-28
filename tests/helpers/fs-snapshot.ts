/**
 * A byte-exact picture of a directory tree, to prove that a command which reported
 * "nothing was changed" changed nothing: every path with its kind, inode, mtime, permissions, size
 * and (for files) sha256, and where a link points. Comparing two pictures compares all of it, so a
 * file rewritten with the same bytes, a leftover backup, a created folder and a changed mode all show.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

export type TreeSnapshot = Record<string, string>;

const readFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

export function readFileSnapshot(file: string) {
  const fd = fs.openSync(file, readFlags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Expected a regular fixture file: ${file}`);
    return { stat, bytes: fs.readFileSync(fd) };
  } finally {
    fs.closeSync(fd);
  }
}

function describe(full: string, contentOnly: boolean, entry: fs.Dirent): string {
  // Keep metadata and bytes from the same file. Unreadable files still have a metadata snapshot.
  let stat: fs.BigIntStats | undefined;
  let sha = 'unreadable';
  if (entry.isFile()) {
    try {
      const fd = fs.openSync(full, readFlags);
      try {
        const opened = fs.fstatSync(fd, { bigint: true });
        const named = fs.lstatSync(full, { bigint: true });
        if (named.isFile() && opened.isFile() && opened.dev === named.dev && opened.ino === named.ino) {
          stat = opened;
          sha = createHash('sha256').update(fs.readFileSync(fd)).digest('hex');
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch { /* keep 'unreadable' */ }
  }
  const st = stat ?? fs.lstatSync(full, { bigint: true });
  const kind = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file';
  // A rollback can put the BYTES back but not the inode or the modification times: `contentOnly` leaves those out.
  const identity = contentOnly ? '' : ` ino=${st.ino} mtime=${st.mtimeNs}`;
  // A folder's own size follows its entry count on some file systems; its entries are listed anyway.
  const size = kind === 'dir' ? '' : ` size=${st.size}`;
  const base = `${kind}${identity} mode=${(st.mode & 0o7777n).toString(8)}${size}`;
  if (kind === 'link') return `${base} -> ${fs.readlinkSync(full)}`;
  if (kind === 'file') return `${base} sha=${sha}`;
  return base;
}

/** Every path under `root` (the root itself excluded), keyed by its path relative to `root`. */
export function snapshotTree(root: string, opts: { contentOnly?: boolean } = {}): TreeSnapshot {
  const out: TreeSnapshot = {};
  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const full = path.join(dir, entry.name);
      out[path.relative(root, full)] = describe(full, opts.contentOnly === true, entry);
      if (fs.lstatSync(full).isDirectory()) walk(full);
    }
  };
  walk(root);
  return out;
}

/** Lines that differ between two snapshots; empty when the trees are identical. */
export function diffSnapshots(before: TreeSnapshot, after: TreeSnapshot): string[] {
  const lines: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] === after[key]) continue;
    if (before[key] === undefined) lines.push(`+ ${key}  ${after[key]}`);
    else if (after[key] === undefined) lines.push(`- ${key}  ${before[key]}`);
    else lines.push(`~ ${key}\n    was ${before[key]}\n    now ${after[key]}`);
  }
  return lines.sort();
}
