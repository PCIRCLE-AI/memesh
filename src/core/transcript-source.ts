// Read-only, project-scoped transcript discovery for agent work packages.

import fs from 'fs';

import path from 'path';

import { homeDir } from './paths.js';

// Raw Claude transcripts can contain tool traffic that never enters a work
// package. Keep reads bounded before parsing; the package itself remains
// capped at 64 KiB below the transport boundary.
export const MAX_TRANSCRIPT_SOURCE_BYTES = 8 * 1024 * 1024;

export interface TranscriptSnapshot {
  bytes: Buffer;
  modifiedAt: string;
  sizeBytes: number;
}

export function readTranscriptSnapshot(
  transcriptPath: string,
  expected?: { modifiedAt: string; sizeBytes: number },
): TranscriptSnapshot | null {
  let fd: number | undefined;
  try {
    if (fs.lstatSync(transcriptPath).isSymbolicLink()) return null;
    fd = fs.openSync(transcriptPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size < 0 || before.size > MAX_TRANSCRIPT_SOURCE_BYTES) return null;
    const modifiedAt = new Date(before.mtimeMs).toISOString();
    if (expected && (before.size !== expected.sizeBytes || modifiedAt !== expected.modifiedAt)) return null;

    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) return null;
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return null;
    return { bytes, modifiedAt, sizeBytes: before.size };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed / gone */ }
    }
  }
}

export function claudeProjectsDir(): string {
  const override = process.env.CLAUDE_PROJECTS_DIR;
  if (override && override.trim() !== '') return override;
  // homeDir(), not os.homedir(): on Windows os.homedir() ignores HOME, so
  // the isolated test runner's throwaway HOME would be bypassed and this
  // would read the developer's REAL transcripts under test. homeDir() also
  // carries the HOME="" sandbox fallback chain.
  return path.join(homeDir(), '.claude', 'projects');
}

export function projectTranscriptSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function recordedCwd(text: string): string | null {
  let seen = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (++seen > 40) break; // bounded: metadata preamble is only a few lines
    try {
      const entry = JSON.parse(line) as { cwd?: unknown };
      if (typeof entry.cwd === 'string' && entry.cwd.length > 0) return entry.cwd;
    } catch {
      // A malformed line in the preamble must not abort the scan.
    }
  }
  return null;
}

function sameProjectPath(a: string, b: string): boolean {
  if (path.normalize(a) === path.normalize(b)) return true;
  try {
    if (fs.realpathSync(a) === fs.realpathSync(b)) return true;
  } catch { /* one side unresolvable — cannot prove equivalence, treat as different */ }
  return false;
}

export function transcriptMatchesProject(bytes: Buffer, cwd: string): boolean {
  const sessionCwd = recordedCwd(bytes.subarray(0, 65536).toString('utf8'));
  return sessionCwd !== null && sameProjectPath(sessionCwd, cwd);
}

export interface TranscriptSession {
  /** Session id = the transcript filename without .jsonl. */
  sessionId: string;
  /** Absolute path to the .jsonl file. */
  path: string;
  /** Last-modified time (ISO); the window filter and watermark use this. */
  modifiedAt: string;
  /** Total JSONL lines (cheap: a byte scan, not a parse). */
  lineCount: number;
  sizeBytes: number;
}

export interface ScanOptions {
  /** Project cwd whose transcripts to find. Defaults to process.cwd(). */
  cwd?: string;
  /** Only sessions modified within this many days. Default 3 (72h). */
  windowDays?: number;
  /** Test seam. */
  now?: Date;
}

export function scanTranscripts(opts: ScanOptions = {}): TranscriptSession[] {
  const cwd = opts.cwd && opts.cwd.length > 0 ? opts.cwd : process.cwd();
  const windowDays = opts.windowDays ?? 3;
  const now = opts.now ?? new Date();
  const cutoffMs = now.getTime() - windowDays * 86400_000;

  const dir = path.join(claudeProjectsDir(), projectTranscriptSlug(cwd));
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // no transcript dir for this project yet
  }

  const sessions: TranscriptSession[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const full = path.join(dir, name);

    const snapshot = readTranscriptSnapshot(full);
    if (!snapshot) continue;
    try {
      if (Date.parse(snapshot.modifiedAt) < cutoffMs) continue;

      const buf = snapshot.bytes;
      let lineCount = 0;
      for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) lineCount++;

      // Slug-collision guard (see projectTranscriptSlug): if this session
      // recorded a cwd and it is NOT the project we are scanning, it belongs
      // to a sibling project that collapsed to the same slug dir — skip it so
      // the "current project only" promise holds. Decode only a bounded prefix
      // of the buffer we already read (no new I/O, no new path resolution).
      //
      // Compare via sameProjectPath (normalised, then symlink-resolved) so a
      // cosmetic OR a symlink difference (macOS /tmp vs /private/tmp) does not
      // cause a false skip. Still FAIL-CLOSED: a present-but-genuinely-different
      // recorded cwd is dropped so the "current project only" promise holds.
      if (!transcriptMatchesProject(buf, cwd)) continue;

      sessions.push({
        sessionId: name.replace(/\.jsonl$/, ''),
        path: full,
        modifiedAt: snapshot.modifiedAt,
        lineCount,
        sizeBytes: snapshot.sizeBytes,
      });
    } catch {
      continue;
    }
  }

  // Most-recent first — the window's freshest sessions are the ones a mine
  // pass should prioritise under a max-calls budget.
  sessions.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return sessions;
}
