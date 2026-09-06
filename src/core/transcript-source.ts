// Read-only, project-scoped transcript discovery for agent work packages.

import fs from 'fs';

import path from 'path';

import { homeDir } from './paths.js';

// Raw Claude transcripts can contain tool traffic that never enters a work
// package. Keep reads bounded before parsing; the package itself remains
// capped at 64 KiB below the transport boundary.
export const MAX_TRANSCRIPT_SOURCE_BYTES = 8 * 1024 * 1024;
export const MAX_TRANSCRIPT_SCAN_BYTES = 16 * 1024 * 1024;
export const MAX_TRANSCRIPT_CANDIDATES = 256;

export interface TranscriptSnapshot {
  bytes: Buffer;
  modifiedAt: string;
  sizeBytes: number;
  device: string;
  inode: string;
  modifiedAtNanoseconds: string;
  changedAtNanoseconds: string;
}

interface TranscriptSnapshotRead {
  snapshot: TranscriptSnapshot | null;
  aggregateLimitExceeded: boolean;
}

export function readTranscriptSnapshot(
  transcriptPath: string,
  expected?: Omit<TranscriptSnapshot, 'bytes'>,
): TranscriptSnapshot | null {
  return readTranscriptSnapshotWithin(transcriptPath, expected, MAX_TRANSCRIPT_SOURCE_BYTES).snapshot;
}

function readTranscriptSnapshotWithin(
  transcriptPath: string,
  expected: Omit<TranscriptSnapshot, 'bytes'> | undefined,
  aggregateBytesRemaining: number,
): TranscriptSnapshotRead {
  let fd: number | undefined;
  try {
    if (fs.lstatSync(transcriptPath).isSymbolicLink()) return { snapshot: null, aggregateLimitExceeded: false };
    fd = fs.openSync(transcriptPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(fd, { bigint: true });
    const sizeBytes = Number(before.size);
    if (!before.isFile() || sizeBytes < 0 || sizeBytes > MAX_TRANSCRIPT_SOURCE_BYTES) {
      return { snapshot: null, aggregateLimitExceeded: false };
    }
    if (sizeBytes > aggregateBytesRemaining) return { snapshot: null, aggregateLimitExceeded: true };
    const identity = {
      modifiedAt: new Date(Number(before.mtimeNs / 1_000_000n)).toISOString(),
      sizeBytes,
      device: before.dev.toString(),
      inode: before.ino.toString(),
      modifiedAtNanoseconds: before.mtimeNs.toString(),
      changedAtNanoseconds: before.ctimeNs.toString(),
    };
    if (expected && Object.entries(identity).some(([key, value]) =>
      expected[key as keyof typeof expected] !== value)) return { snapshot: null, aggregateLimitExceeded: false };

    const bytes = Buffer.allocUnsafe(sizeBytes);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) return { snapshot: null, aggregateLimitExceeded: false };
      offset += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      return { snapshot: null, aggregateLimitExceeded: false };
    }
    return { snapshot: { bytes, ...identity }, aggregateLimitExceeded: false };
  } catch {
    return { snapshot: null, aggregateLimitExceeded: false };
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
  /** Descriptor identity and change metadata used to reject path swaps and in-place rewrites. */
  device: string;
  inode: string;
  modifiedAtNanoseconds: string;
  changedAtNanoseconds: string;
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
    const dirStat = fs.lstatSync(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return [];
    names = fs.readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort();
  } catch {
    return []; // no transcript dir for this project yet
  }
  // Refuse an attacker-controlled directory fan-out instead of selecting an
  // arbitrary subset whose newest member could depend on enumeration order.
  if (names.length > MAX_TRANSCRIPT_CANDIDATES) return [];

  // Bound aggregate transcript bytes before content reads. This metadata pass
  // is itself bounded by MAX_TRANSCRIPT_CANDIDATES; descriptor reads below
  // still revalidate the file against races and per-file limits.
  let plannedBytes = 0;
  const eligibleNames: string[] = [];
  try {
    for (const name of names) {
      const stat = fs.lstatSync(path.join(dir, name));
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_TRANSCRIPT_SOURCE_BYTES
        || stat.mtimeMs < cutoffMs) continue;
      plannedBytes += stat.size;
      if (plannedBytes > MAX_TRANSCRIPT_SCAN_BYTES) return [];
      eligibleNames.push(name);
    }
  } catch {
    return [];
  }

  const sessions: TranscriptSession[] = [];
  let bytesRead = 0;
  for (const name of eligibleNames) {
    const full = path.join(dir, name);

    const read = readTranscriptSnapshotWithin(full, undefined, MAX_TRANSCRIPT_SCAN_BYTES - bytesRead);
    if (read.aggregateLimitExceeded) return [];
    const snapshot = read.snapshot;
    if (!snapshot) continue;
    bytesRead += snapshot.sizeBytes;
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
        device: snapshot.device,
        inode: snapshot.inode,
        modifiedAtNanoseconds: snapshot.modifiedAtNanoseconds,
        changedAtNanoseconds: snapshot.changedAtNanoseconds,
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
