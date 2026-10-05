// Read-only, project-scoped transcript discovery for agent work packages.

import fs from 'fs';
import { createHash } from 'node:crypto';

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
  contentHash: string;
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
    fd = fs.openSync(transcriptPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (fs.lstatSync(transcriptPath).isSymbolicLink()) return { snapshot: null, aggregateLimitExceeded: false };
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
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    if (expected && contentHash !== expected.contentHash) return { snapshot: null, aggregateLimitExceeded: false };
    return { snapshot: { bytes, contentHash, ...identity }, aggregateLimitExceeded: false };
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

/** The top-level `cwd` of one transcript line, or null. A malformed line is not a cwd. */
function lineCwd(line: string): string | null {
  try {
    const entry = JSON.parse(line) as { cwd?: unknown } | null;
    return entry !== null && typeof entry === 'object' && typeof entry.cwd === 'string' && entry.cwd.length > 0 ? entry.cwd : null;
  } catch {
    return null;
  }
}

/**
 * The session's recorded working directory: the first line with a top-level
 * `cwd`, wherever it is (#552). Claude Code transcripts can open with long
 * metadata lines — a 13 KB file-history-snapshot; on one real transcript the
 * first cwd was at byte 102,486 — so a scan of the first 64 KB or 40 lines
 * dropped the project's own sessions. Only lines that mention `"cwd"` are
 * parsed, and a `cwd` nested inside message text is not taken for it.
 */
export function recordedCwd(text: string): string | null {
  let from = 0;
  for (;;) {
    const at = text.indexOf('"cwd"', from);
    if (at < 0) return null;
    const start = text.lastIndexOf('\n', at) + 1;
    const newline = text.indexOf('\n', at);
    const end = newline < 0 ? text.length : newline;
    const cwd = lineCwd(text.slice(start, end));
    if (cwd !== null) return cwd;
    from = end + 1;
  }
}

function sameProjectPath(a: string, b: string): boolean {
  if (path.normalize(a) === path.normalize(b)) return true;
  try {
    if (fs.realpathSync(a) === fs.realpathSync(b)) return true;
  } catch { /* one side unresolvable — cannot prove equivalence, treat as different */ }
  return false;
}

export function transcriptMatchesProject(bytes: Buffer, cwd: string): boolean {
  const sessionCwd = recordedCwd(bytes.toString('utf8'));
  return sessionCwd !== null && sameProjectPath(sessionCwd, cwd);
}

export interface TranscriptSession {
  /** Raw scan-byte identity, independent of filesystem timestamp resolution. */
  contentHash: string;
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

/** Why a transcript inside the time window was not offered (#552). */
export type TranscriptSkipReason =
  | 'too_many_candidates' | 'scan_too_large' | 'too_large' | 'unreadable' | 'no_recorded_cwd' | 'other_project';

export interface ScanOptions {
  /** Project cwd whose transcripts to find. */
  cwd: string;
  /** Called for each transcript left out, with the reason and how many it covers. */
  onSkip?: (reason: TranscriptSkipReason, count: number) => void;
  /** Only sessions modified within this many days. Default 3 (72h). */
  windowDays?: number;
  /** Test seam. */
  now?: Date;
}

export function scanTranscripts(opts: ScanOptions): TranscriptSession[] {
  const cwd = opts.cwd;
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
  if (names.length > MAX_TRANSCRIPT_CANDIDATES) {
    opts.onSkip?.('too_many_candidates', names.length);
    return [];
  }

  // Bound aggregate transcript bytes before content reads. This metadata pass
  // is itself bounded by MAX_TRANSCRIPT_CANDIDATES; descriptor reads below
  // still revalidate the file against races and per-file limits.
  let plannedBytes = 0;
  const eligibleNames: string[] = [];
  for (const name of names) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(path.join(dir, name));
    } catch {
      // Gone or unreadable since the listing (#552): that one session is
      // reported and left out, not the whole scan in silence.
      opts.onSkip?.('unreadable', 1);
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.mtimeMs < cutoffMs) continue;
    if (stat.size > MAX_TRANSCRIPT_SOURCE_BYTES) {
      opts.onSkip?.('too_large', 1);
      continue;
    }
    plannedBytes += stat.size;
    eligibleNames.push(name);
  }
  // Over the budget, every eligible session is left out, so every one of them
  // is counted, not only those seen before the budget ran out.
  if (plannedBytes > MAX_TRANSCRIPT_SCAN_BYTES) {
    opts.onSkip?.('scan_too_large', eligibleNames.length);
    return [];
  }

  const sessions: TranscriptSession[] = [];
  let bytesRead = 0;
  for (const name of eligibleNames) {
    const full = path.join(dir, name);

    const read = readTranscriptSnapshotWithin(full, undefined, MAX_TRANSCRIPT_SCAN_BYTES - bytesRead);
    if (read.aggregateLimitExceeded) {
      opts.onSkip?.('scan_too_large', eligibleNames.length);
      return [];
    }
    const snapshot = read.snapshot;
    if (!snapshot) {
      opts.onSkip?.('unreadable', 1);
      continue;
    }
    bytesRead += snapshot.sizeBytes;
    try {
      if (Date.parse(snapshot.modifiedAt) < cutoffMs) continue;

      const buf = snapshot.bytes;
      let lineCount = 0;
      for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) lineCount++;

      // Slug-collision guard (see projectTranscriptSlug): if this session
      // recorded a cwd and it is NOT the project we are scanning, it belongs
      // to a sibling project that collapsed to the same slug dir — skip it so
      // the "current project only" promise holds. The recorded cwd is read from
      // the buffer we already have (no new I/O, no new path resolution).
      //
      // Compare via sameProjectPath (normalised, then symlink-resolved) so a
      // cosmetic OR a symlink difference (macOS /tmp vs /private/tmp) does not
      // cause a false skip. Still FAIL-CLOSED: a present-but-genuinely-different
      // recorded cwd is dropped so the "current project only" promise holds.
      if (!transcriptMatchesProject(buf, cwd)) {
        opts.onSkip?.(recordedCwd(buf.toString('utf8')) === null ? 'no_recorded_cwd' : 'other_project', 1);
        continue;
      }

      sessions.push({
        contentHash: snapshot.contentHash,
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
