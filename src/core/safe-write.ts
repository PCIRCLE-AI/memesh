// =============================================================================
// safe-write — a command that cannot finish must leave the user's files as they were
// =============================================================================
//
// `install-hooks` and `uninstall-hooks` touch four places (settings.json, its backup, the install
// marker, the citation rule). A failure after the first of them left half of an install behind and
// reported failure anyway, or rewrote the settings and reported failure. Two parts fix that:
//
//  1. `assertCanWrite` / `assertCanDelete` / `assertFolderWritable` are asked for EVERY file the run
//     is going to touch, BEFORE the first write. They only look (lstat, stat, access) and create nothing,
//     so a refusal changes nothing, not even a folder's modification time.
//  2. `Changes` is the backstop for what a look cannot see (a full disk, a file replaced while we
//     ran): every write goes through it, and `rollBack` puts back what this run changed.

import fs from 'fs';
import path from 'path';

/** One failure, one sentence: which file, what is wrong, and what became of the files. */
export function refuse(label: string, target: string, what: string, ending = 'nothing was changed'): Error {
  return new Error(`${label} at ${target}${what}; ${ending}`);
}

/** The reason a file operation failed, in words (never the bare errno code). */
export function whyFailed(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  switch (code) {
    case 'EACCES': case 'EPERM': return 'permission denied';
    case 'EISDIR': return 'it is a folder';
    case 'ENOTDIR': return 'a folder on its path is a file';
    case 'ENOENT': return 'it does not exist';
    case 'EROFS': return 'the disk is read-only';
    default: return code ?? (err instanceof Error ? err.message : String(err));
  }
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw refuse('file', p, ` cannot be examined (${whyFailed(err)})`);
  }
}

/**
 * The nearest folder at or above `dir` that exists, which must be a folder (through a link, if it is one)
 * this process can add to. Nothing is created: `mkdir -p` later creates exactly what is missing below it.
 */
export function assertFolderWritable(dir: string): void {
  let probe = dir;
  while (lstatOrNull(probe) === null) {
    const parent = path.dirname(probe);
    if (parent === probe) return;
    probe = parent;
  }
  let target: fs.Stats;
  try {
    target = fs.statSync(probe);
  } catch {
    throw refuse('link', probe, ' points to a place that does not exist');
  }
  if (!target.isDirectory()) throw refuse('folder', probe, ' is not a folder');
  try {
    fs.accessSync(probe, fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    throw refuse('folder', probe, ' cannot be written to (permission denied)');
  }
}

/** `file` can be created, or replaced in place. Folders are only looked at when the file is not there yet. */
export function assertCanWrite(file: string, label: string): void {
  const entry = lstatOrNull(file);
  if (entry === null) return assertFolderWritable(path.dirname(file));
  let target: fs.Stats;
  try {
    target = fs.statSync(file);
  } catch {
    throw refuse(label, file, ' is a link to a file that does not exist');
  }
  if (target.isDirectory()) throw refuse(label, file, ' is a folder, not a file');
  try {
    fs.accessSync(file, fs.constants.W_OK);
  } catch {
    throw refuse(label, file, ' cannot be written (permission denied)');
  }
}

/** `file` can be removed: removing a name needs write access to the folder that holds it. */
export function assertCanDelete(file: string, label: string): void {
  const entry = lstatOrNull(file);
  if (entry === null) return;
  if (entry.isDirectory()) throw refuse(label, file, ' is a folder, not a file');
  const dir = path.dirname(file);
  try {
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    throw refuse('folder', dir, ' cannot be written to (permission denied)');
  }
}

/** The file's bytes, or null when it does not exist: read directly, with no check-then-read race. */
export function readBytesOrNull(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Every change a run makes, with the way back. `rollBack` undoes them newest first; no step may hide the error being reported. */
export class Changes {
  private undo: Array<() => void> = [];

  /** `mkdir -p`; a rollback removes the folders this call created (and only those, only while empty). */
  mkdir(dir: string): void {
    const first = fs.mkdirSync(dir, { recursive: true });
    if (first === undefined) return;
    this.undo.push(() => {
      for (let d = dir; ; d = path.dirname(d)) {
        fs.rmdirSync(d);
        if (d === first) return;
      }
    });
  }

  /**
   * Write a file; a rollback puts the old bytes back, or removes the file when there were none.
   *
   * The CodeQL js/file-system-race rule fires here because the file is read and then written, with a
   * theoretical TOCTOU window. We accept that risk: these are one-shot commands run by a single user,
   * the original bytes are kept in the backup taken before the write, and atomic temp+rename was
   * tried (5c69a262) and broke on Windows with no real-world benefit.
   */
  write(file: string, data: string): void {
    const before = readBytesOrNull(file);
    // codeql[js/file-system-race]: justified — see comment above
    fs.writeFileSync(file, data, 'utf8');
    this.undo.push(() => (before === null ? fs.rmSync(file, { force: true }) : fs.writeFileSync(file, before)));
  }

  /** Remove a file; a rollback writes it back. */
  remove(file: string): void {
    const before = readBytesOrNull(file);
    fs.rmSync(file);
    if (before !== null) this.undo.push(() => fs.writeFileSync(file, before));
  }

  /**
   * Copy `source` to `<source><suffix>`, never over a copy that is already there: a second copy made in
   * the same millisecond gets `-1`, `-2`, ... so the first copy (the only one of the ORIGINAL file) survives.
   * A rollback removes the copy this call made.
   */
  copyNew(source: string, suffix: string): string {
    for (let n = 0; ; n++) {
      const copy = `${source}${suffix}${n === 0 ? '' : `-${n}`}`;
      try {
        fs.copyFileSync(source, copy, fs.constants.COPYFILE_EXCL);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw err;
      }
      this.undo.push(() => fs.rmSync(copy, { force: true }));
      return copy;
    }
  }

  rollBack(): void {
    for (const step of this.undo.splice(0).reverse()) {
      try { step(); } catch { /* the original failure is the one to report */ }
    }
  }
}
