/**
 * "Don't remember this session": the agent calls the `private_session` tool.
 * This module holds the ONE answer to "is this session private?" that every
 * reader of a session's content asks (`decidePrivacy`): the hooks, the note
 * importer, the dreamer, the session activity other agents see, and doctor.
 *
 * Three answers, exactly:
 *  - `yes`: real evidence of a call: the marker the PostToolUse hook wrote at
 *    the call, a call record in the transcript, in a subagent's transcript or
 *    in a parent rollout of a forked Codex thread, or a call in a chat list.
 *  - `no`: everything was read and there is no call.
 *  - `unchecked(reason, kind)`: something could not be read in time or at all.
 *    The callers then store nothing and record an error, and decide again at
 *    their next run; `unchecked` is never written anywhere that reads back as
 *    `yes` (the marker is only ever written for a real call).
 *
 * Only the record type and the tool name count. Text that names the tool, a
 * tool result, an assistant reply and a user message never do. A call counts
 * even when its result was an error (the record is there either way).
 *
 * Every read has a byte cap and a deadline the caller takes from its own time
 * budget; going past either is `unchecked`, never `no` and never a hang. A
 * missing file means `no` only for the main transcript itself: a file that
 * vanishes while the check reads it is `unchecked`.
 *
 * Runtime-leaf: imports only node builtins, so the hooks can load a verbatim
 * copy (see scripts/generate-hook-core.mjs).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const PRIVATE_SESSION_TOOL = 'private_session';

/**
 * How long a private session may be silent before it is treated as gone, and
 * how far back a note counts as possibly written by a session whose transcript
 * could not be read for names. The one copy of this number.
 */
export const PRIVATE_WINDOW_MS = 6 * 60 * 60 * 1000;
/** A fork whose parent rollout has not been found for this long is not expected to turn up. */
export const PARENT_NOT_FOUND_PERSISTENT_MS = 7 * 24 * 60 * 60 * 1000;

/** The session's own files (transcript and subagent transcripts) together: above this nothing is scanned. */
export const PRIVATE_CHECK_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** Bytes read per step; the deadline is checked before each. */
const CHUNK_BYTES = 8 * 1024 * 1024;
/** A line that names the tool and is longer than this cannot be judged (it is not read whole). */
export const MAX_CALL_LINE_BYTES = 64 * 1024 * 1024;
/** The first line of a rollout: a `session_meta` header longer than this cannot be read. */
const HEADER_MAX_BYTES = 4 * 1024 * 1024;
const NEEDLE = Buffer.from(PRIVATE_SESSION_TOOL);
/**
 * A record of a call has one of these record types somewhere in its line (see
 * `isToolCall`): a line that only names the tool in text is not parsed.
 */
const CALL_RECORD_TYPES = ['"tool_use"', '"McpToolCall"', '"function_call"', '"compacted"'].map((s) => Buffer.from(s));
/** A fork of a fork of a fork…: how many parents are followed up one chain, and how many in all. */
const MAX_FORK_DEPTH = 5;
const MAX_PARENTS = 8;
/** A parent rollout larger than this is not scanned. */
const PARENT_MAX_BYTES = 1024 * 1024 * 1024;
/** An archived parent (`.jsonl.zst`): the largest file read and the largest it may expand to. */
const PARENT_ZST_MAX_BYTES = 128 * 1024 * 1024;
const PARENT_ZST_MAX_OUTPUT = 512 * 1024 * 1024;
/** Time left that an archived parent needs: expanding it cannot be interrupted. */
const ZST_MIN_TIME_MS = 1000;
/** Subagent transcripts: how deep (their number is bounded by the size cap and the deadline). */
const SUBAGENT_MAX_DEPTH = 3;
/** A temporary file older than this was left by a writer that died between writing and renaming. */
const STALE_TEMP_MS = 60_000;

export type UncheckedReason = 'marker_unreadable' | 'unreadable' | 'timeout' | 'parent_not_found'
  | 'parent_unreadable' | 'too_large' | 'parent_too_large' | 'fork_too_deep' | 'header_unreadable'
  | 'no_zstd' | 'no_session_id';
export type UncheckedKind = 'transient' | 'persistent';

/**
 * Whether a reason can pass on its own (`transient`: checked again and let
 * through once it clears) or stays until someone acts (`persistent`: doctor
 * says what holds and what releasing it would cost). Both are decided again at
 * every run; the kind only changes what doctor says.
 */
export const UNCHECKED_KIND: Readonly<Record<UncheckedReason, UncheckedKind>> = Object.freeze({
  marker_unreadable: 'transient',
  unreadable: 'transient',
  timeout: 'transient',
  parent_not_found: 'transient',
  parent_unreadable: 'transient',
  too_large: 'persistent',
  parent_too_large: 'persistent',
  fork_too_deep: 'persistent',
  header_unreadable: 'persistent',
  no_zstd: 'persistent',
  no_session_id: 'persistent',
});

/**
 * The kind of a reason that has held since `since`: a parent rollout still
 * missing after `PARENT_NOT_FOUND_PERSISTENT_MS` is not coming back.
 */
export function uncheckedKind(reason: UncheckedReason, since?: number, now = Date.now()): UncheckedKind {
  if (reason === 'parent_not_found' && typeof since === 'number' && now - since >= PARENT_NOT_FOUND_PERSISTENT_MS) return 'persistent';
  return UNCHECKED_KIND[reason] ?? 'transient';
}

export type PrivacyEvidence = 'marker' | 'transcript' | 'subagent' | 'fork_parent' | 'messages';
export type Unchecked = { state: 'unchecked'; reason: UncheckedReason; kind: UncheckedKind; detail: string };
export type PrivacyState = { state: 'yes'; evidence: PrivacyEvidence } | { state: 'no' } | Unchecked;

const unchecked = (reason: UncheckedReason, detail: string): Unchecked => ({ state: 'unchecked', reason, kind: UNCHECKED_KIND[reason], detail });

/** Thrown by the readers below; `decidePrivacy` turns it into an answer. */
class CheckFailure extends Error {
  constructor(readonly reason: UncheckedReason, message: string) { super(message); }
}

const errCode = (err: unknown): string => (err as NodeJS.ErrnoException)?.code ?? 'error';

const MCP_TOOL_NAME = new RegExp(`^mcp__.+__${PRIVATE_SESSION_TOOL}$`);

/**
 * Is this the name of the tool? The host prefixes the server the user registered
 * (`mcp__<any server name>__private_session`), and the server name is the user's
 * choice, so any server name counts: taking another server's tool for this one
 * only stores less, while missing a real call stores what the person asked not
 * to keep. The bare name counts too.
 */
export function isPrivateToolName(name: string): boolean {
  return name === PRIVATE_SESSION_TOOL || MCP_TOOL_NAME.test(name);
}

/** The file name a per-session record (marker, holds) is kept under: the id itself when it is a plain token, else a hash of it. */
export function sessionFileName(sessionId: string): string {
  return `${/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ? sessionId : crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}.json`;
}

/** Where the verdicts of transcript files are remembered between processes. */
export const privateCheckCacheDir = (memeshDir: string): string => path.join(memeshDir, 'private-check-cache');

/** Where the marker of a session is kept. */
export function privateMarkerPath(memeshDir: string, sessionId: string): string {
  return path.join(memeshDir, 'private-sessions', sessionFileName(sessionId));
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** A `tool_use` block of the tool anywhere in a parsed row (a subagent's calls are nested in `progress` rows); a result is never entered. */
function hasToolUse(node: unknown, depth = 0): boolean {
  if (depth > 16 || node === null || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((item) => hasToolUse(item, depth + 1));
  const obj = node as Record<string, unknown>;
  if (obj.type === 'tool_use') return typeof obj.name === 'string' && isPrivateToolName(obj.name);
  if (obj.type === 'tool_result') return false;
  return Object.values(obj).some((value) => hasToolUse(value, depth + 1));
}

/**
 * One parsed transcript line: a record of a call to the tool.
 * Claude Code: a `tool_use` block whose name is the tool under any server
 * prefix, in an `assistant` row or nested in a subagent's `progress` row.
 * Codex, three structured forms: an `item_completed` event whose item is an
 * `McpToolCall` (a script that calls the tool leaves one too); a `function_call`
 * response item in an `mcp__` namespace; and, after a compaction, a
 * `compacted` record whose `replacement_history_metadata[].mcp_attribution.sources[]`
 * names the tool. The text of a script is never read here: a comment, a string
 * or a patch that merely contains the call is not a call.
 */
function isToolCall(entry: Record<string, unknown>): boolean {
  const payload = record(entry.payload);
  if (entry.type === 'event_msg') {
    const item = record(payload?.item);
    return payload?.type === 'item_completed' && item?.type === 'McpToolCall' && item.tool === PRIVATE_SESSION_TOOL;
  }
  if (entry.type === 'response_item') {
    return payload?.type === 'function_call' && typeof payload.namespace === 'string' && payload.namespace.startsWith('mcp__') && payload.name === PRIVATE_SESSION_TOOL;
  }
  if (entry.type === 'compacted') {
    const history = payload?.replacement_history_metadata;
    return Array.isArray(history) && history.some((meta) => {
      const sources = record(record(meta)?.mcp_attribution)?.sources;
      return Array.isArray(sources) && sources.some((source) => record(source)?.tool_name === PRIVATE_SESSION_TOOL);
    });
  }
  return hasToolUse(entry);
}

/**
 * The same question over a chat-format message list (Hermes): an assistant
 * message with a tool call to `private_session`, under its own name or with the
 * host's `memesh_` prefix.
 */
export function chatCallsPrivateTool(messages: unknown): boolean {
  return Array.isArray(messages) && messages.some((message) => {
    const calls = record(message)?.tool_calls;
    return record(message)?.role === 'assistant' && Array.isArray(calls) && calls.some((call) => {
      const name = record(record(call)?.function)?.name;
      return name === PRIVATE_SESSION_TOOL || name === `memesh_${PRIVATE_SESSION_TOOL}`;
    });
  });
}

/** What one file says: a call in it, the threads it was forked from, and whether its header was readable. */
interface FileVerdict { found: boolean; forks: string[]; headerBroken: boolean }

/**
 * One judgement over a file, fed line by line. The header (`session_meta`, the
 * first line) names the threads a Codex thread was forked from. A fork carries
 * the parent's `response_item`s but not its events, so a call the parent made
 * may not show in the child: the parent's own rollout is read too, and both
 * header fields are followed when both are present. The child's own file is
 * read whole like any transcript, so a call recorded in it counts as well.
 */
class Scan {
  found = false;
  forks: string[] = [];
  /** The first line names a session header but cannot be read: whether the thread is a fork cannot be told. */
  headerBroken = false;

  constructor(private readonly deadlineAt = Number.POSITIVE_INFINITY) {}

  header(line: Buffer): void {
    if (!line.includes('"session_meta"')) return;
    if (line.length > HEADER_MAX_BYTES) { this.headerBroken = true; return; }
    try {
      const payload = record(record(JSON.parse(line.toString('utf8')))?.payload);
      // Codex writes either field only when the thread is a fork; a thread that is not one has
      // neither. A field that is present but is not a non-empty string is a damaged header.
      for (const field of [payload?.forked_from_id, payload?.parent_thread_id]) {
        if (field === undefined || field === null) continue;
        if (typeof field !== 'string' || field === '') { this.headerBroken = true; continue; }
        if (!this.forks.includes(field)) this.forks.push(field);
      }
    } catch {
      this.headerBroken = true;
    }
  }

  /** One whole line that holds the tool name: parsed only when it can be a call record, and only within the deadline. */
  line(line: Buffer): void {
    if (!CALL_RECORD_TYPES.some((type) => line.includes(type))) return;
    if (Date.now() > this.deadlineAt) throw new CheckFailure('timeout', 'the check ran out of time');
    try {
      const entry = record(JSON.parse(line.toString('utf8')));
      if (entry !== null && isToolCall(entry)) this.found = true;
    } catch {
      // A line that is not JSON is not a record.
    }
  }

  /** Complete lines already in memory. A line without the tool name is never parsed. */
  feed(buf: Buffer): void {
    let from = 0;
    while (!this.found) {
      const hit = buf.indexOf(NEEDLE, from);
      if (hit === -1) return;
      const start = buf.lastIndexOf(10, hit) + 1;
      let end = buf.indexOf(10, hit);
      if (end === -1) end = buf.length;
      from = end + 1;
      if (end - start > MAX_CALL_LINE_BYTES) throw new CheckFailure('too_large', 'a line that names the tool is too long to read');
      this.line(buf.subarray(start, end));
    }
  }

  verdict(): FileVerdict { return { found: this.found, forks: this.forks, headerBroken: this.headerBroken }; }
}

const asBuffer = (bytes: string | Uint8Array): Buffer => (typeof bytes === 'string'
  ? Buffer.from(bytes)
  : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));

/** A whole file already in memory: its header, then every line. */
function scanBytes(bytes: Buffer, deadlineAt: number): FileVerdict {
  const scan = new Scan(deadlineAt);
  const nl = bytes.indexOf(10);
  scan.header(nl === -1 ? bytes : bytes.subarray(0, nl));
  scan.feed(bytes);
  return scan.verdict();
}

/**
 * Calls `onLine` with every line of a file, read in pieces in time linear in
 * its size: an unfinished line is kept as a list of pieces and joined once, when
 * it ends, and a line longer than `MAX_CALL_LINE_BYTES` is not kept at all (it
 * is counted in `longLines`). Stops before a piece once `deadlineAt` has passed
 * (`timedOut`). For the hooks that read a transcript for something other than
 * the call (note names, tool counts); the check itself is `decidePrivacy`.
 */
export function forEachTranscriptLine(filePath: string, deadlineAt: number, onLine: (line: Buffer) => void): { timedOut: boolean; longLines: number } {
  const fd = fs.openSync(filePath, 'r');
  try {
    if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('transcript path is a directory'), { code: 'EISDIR' });
    const chunk = Buffer.alloc(CHUNK_BYTES);
    let pieces: Buffer[] = [];
    let pending = 0; // bytes of the unfinished line
    let longLines = 0;
    const endLine = (last: Buffer): void => {
      if (pending + last.length <= MAX_CALL_LINE_BYTES) onLine(pieces.length === 0 ? last : Buffer.concat([...pieces, last]));
      else longLines++;
      pieces = []; pending = 0;
    };
    for (;;) {
      if (Date.now() > deadlineAt) return { timedOut: true, longLines };
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      const data = chunk.subarray(0, n);
      let from = 0;
      for (let nl = data.indexOf(10); nl !== -1; nl = data.indexOf(10, from)) {
        endLine(data.subarray(from, nl));
        from = nl + 1;
      }
      const rest = n - from;
      if (rest > 0) {
        if (pending + rest <= MAX_CALL_LINE_BYTES) pieces.push(Buffer.from(data.subarray(from)));
        else pieces = [];
        pending += rest;
      }
    }
    if (pending > 0) endLine(Buffer.alloc(0));
    return { timedOut: false, longLines };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Reads a plain file in pieces, in time linear in its size and memory bounded
 * by one piece plus one line: a line is kept only until it ends, and a line
 * longer than `MAX_CALL_LINE_BYTES` is followed without being kept (if it turns
 * out to name the tool, it cannot be judged). The deadline is checked before
 * every piece.
 */
function scanPlain(filePath: string, deadlineAt: number): FileVerdict {
  let fd: number;
  try { fd = fs.openSync(filePath, 'r'); } catch (err) { throw new CheckFailure('unreadable', `a transcript cannot be read (${errCode(err)})`); }
  const scan = new Scan(deadlineAt);
  try {
    if (fs.fstatSync(fd).isDirectory()) throw new CheckFailure('unreadable', 'a transcript path is a directory');
    const chunk = Buffer.alloc(CHUNK_BYTES);
    let tail: Buffer = Buffer.alloc(0); // the line that has not ended yet (only while it is short enough)
    let tailDropped = false; // the line that has not ended yet was too long to keep
    let tailHasNeedle = false;
    let first = true;
    const overlap = NEEDLE.length - 1;
    const endLine = (rest: Buffer): void => {
      if (tailDropped) {
        if (tailHasNeedle || Buffer.concat([tail.subarray(Math.max(0, tail.length - overlap)), rest]).includes(NEEDLE)) {
          throw new CheckFailure('too_large', 'a line that names the tool is too long to read');
        }
        if (first) { scan.headerBroken = scan.headerBroken || tail.includes('"session_meta"'); first = false; }
      } else {
        const line = tail.length === 0 ? rest : Buffer.concat([tail, rest]);
        if (first) { scan.header(line); first = false; }
        if (line.includes(NEEDLE)) {
          if (line.length > MAX_CALL_LINE_BYTES) throw new CheckFailure('too_large', 'a line that names the tool is too long to read');
          scan.line(line);
        }
      }
      tail = Buffer.alloc(0); tailDropped = false; tailHasNeedle = false;
    };
    for (;;) {
      if (scan.found) break;
      if (Date.now() > deadlineAt) throw new CheckFailure('timeout', 'the check ran out of time');
      let n: number;
      try { n = fs.readSync(fd, chunk, 0, chunk.length, null); } catch (err) { throw new CheckFailure('unreadable', `a transcript cannot be read (${errCode(err)})`); }
      if (n === 0) break;
      const data = chunk.subarray(0, n);
      const firstNl = data.indexOf(10);
      if (firstNl === -1) {
        // The line goes on: keep it while it is short enough to judge, else only remember whether it named the tool.
        if (!tailDropped && tail.length + n <= MAX_CALL_LINE_BYTES) {
          tail = Buffer.concat([tail, data]);
        } else {
          const joined = Buffer.concat([tail.subarray(Math.max(0, tail.length - overlap)), data]);
          tailHasNeedle = tailHasNeedle || joined.includes(NEEDLE) || (!tailDropped && tail.includes(NEEDLE));
          if (first && !tailDropped) scan.headerBroken = scan.headerBroken || Buffer.concat([tail, data]).subarray(0, HEADER_MAX_BYTES).includes('"session_meta"');
          tailDropped = true;
          tail = Buffer.from(data.subarray(Math.max(0, n - overlap)));
        }
        continue;
      }
      endLine(data.subarray(0, firstNl));
      const lastNl = data.lastIndexOf(10);
      if (lastNl > firstNl) scan.feed(data.subarray(firstNl + 1, lastNl + 1));
      tail = Buffer.from(data.subarray(lastNl + 1));
    }
    if (!scan.found && (tail.length > 0 || tailDropped)) endLine(Buffer.alloc(0));
  } finally {
    fs.closeSync(fd);
  }
  return scan.verdict();
}

function scanZst(filePath: string, deadlineAt: number): FileVerdict {
  if (typeof zlib.zstdDecompressSync !== 'function') throw new CheckFailure('no_zstd', 'this Node cannot read an archived (.zst) rollout');
  if (deadlineAt - Date.now() < ZST_MIN_TIME_MS) throw new CheckFailure('timeout', 'too little time is left to expand an archived rollout');
  let bytes: Buffer;
  try {
    bytes = zlib.zstdDecompressSync(fs.readFileSync(filePath), { maxOutputLength: PARENT_ZST_MAX_OUTPUT });
  } catch (err) {
    const code = errCode(err);
    throw new CheckFailure(code === 'ERR_BUFFER_TOO_LARGE' ? 'parent_too_large' : 'parent_unreadable', `an archived rollout cannot be read (${code})`);
  }
  return scanBytes(bytes, deadlineAt);
}

/** Writes `data` to `file` whole or not at all (a temporary file renamed over it), the file 0600 and its folder 0700. */
export function writeFileAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, data, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** Removes the temporary files a writer that died left in `dir` (a live writer holds one for milliseconds). Returns how many. */
export function removeStaleTemps(dir: string, now = Date.now()): number {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return 0; } // no folder, or one that cannot be listed: its reader reports that
  let removed = 0;
  for (const name of names.filter((n) => n.endsWith('.tmp'))) {
    try { const p = path.join(dir, name); if (now - fs.statSync(p).mtimeMs > STALE_TEMP_MS) { fs.rmSync(p, { force: true }); removed++; } } catch { /* gone */ }
  }
  return removed;
}

/**
 * A file's verdict, remembered by path, size, modification time, change time
 * and inode: size and mtime can be put back by a replacement, the change time
 * and the inode cannot. In memory, and on disk under `cacheDir` (a hook is a
 * new process each time), one entry per path. Only what the file's own bytes
 * say is remembered, never an answer about the session: `unchecked` is decided
 * again every time. A missing, damaged or unwritable entry is only a re-scan.
 */
const remembered = new Map<string, { key: string; verdict: FileVerdict }>();

function fileVerdict(file: string, stat: fs.Stats, zst: boolean, cacheDir: string | undefined, deadlineAt: number): FileVerdict {
  const key = `${file}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}\0${stat.ino}`;
  const hit = remembered.get(file);
  if (hit?.key === key) return hit.verdict;
  const cacheFile = cacheDir === undefined ? undefined : path.join(cacheDir, `${crypto.createHash('sha256').update(file).digest('hex').slice(0, 40)}.json`);
  if (cacheFile !== undefined) {
    try {
      const saved = record(JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
      if (saved?.key === key && typeof saved.found === 'boolean' && typeof saved.headerBroken === 'boolean'
        && Array.isArray(saved.forks) && saved.forks.every((f) => typeof f === 'string')) {
        const verdict = { found: saved.found, forks: saved.forks as string[], headerBroken: saved.headerBroken };
        remembered.set(file, { key, verdict });
        return verdict;
      }
    } catch { /* no usable entry: scan */ }
  }
  const verdict = zst ? scanZst(file, deadlineAt) : scanPlain(file, deadlineAt);
  remembered.set(file, { key, verdict });
  if (cacheFile !== undefined) {
    try { writeFileAtomic(cacheFile, JSON.stringify({ key, ...verdict })); } catch { /* a cache that cannot be written is only slower */ }
  }
  return verdict;
}

/** Cache entries looked at per run, and removed per run, at most. */
const CACHE_PRUNE_LOOK = 200;
const CACHE_PRUNE_MAX = 50;

/**
 * Removes the cache entries of files that are gone (and temporary files a
 * crashed writer left), looking at a bounded number of entries per run from a
 * random start, so a large cache is worked through over several runs. A cache
 * that cannot be listed is left alone: it only makes the check slower.
 * Returns how many entries were removed.
 */
export function prunePrivateCheckCache(cacheDir: string, now = Date.now()): number {
  let names: string[];
  try { names = fs.readdirSync(cacheDir); } catch { return 0; }
  let removed = removeStaleTemps(cacheDir, now);
  const start = names.length === 0 ? 0 : Math.floor(Math.random() * names.length);
  for (let i = 0; i < Math.min(names.length, CACHE_PRUNE_LOOK) && removed < CACHE_PRUNE_MAX; i++) {
    const name = names[(start + i) % names.length];
    const entry = path.join(cacheDir, name);
    try {
      if (!name.endsWith('.json')) continue;
      const key = record(JSON.parse(fs.readFileSync(entry, 'utf8')))?.key;
      const file = typeof key === 'string' ? key.split('\0')[0] : '';
      let gone = file === '';
      if (!gone) { try { fs.statSync(file); } catch (err) { gone = errCode(err) === 'ENOENT'; } }
      if (gone) { fs.rmSync(entry, { force: true }); removed++; }
    } catch { /* damaged or vanished: rewritten or gone next time */ }
  }
  return removed;
}

/**
 * The transcript and the transcripts of the subagents it ran. Claude Code keeps
 * a subagent's rows in `<transcript without .jsonl>/subagents/**.jsonl`; a call
 * made there is part of the session. Throws a `CheckFailure` when the folder
 * exists but cannot be listed, is nested deeper than is checked, or `deadlineAt`
 * passes while it is listed (`timeout`): none of that is "no subagents".
 */
export function sessionTranscriptFiles(transcriptPath: string, deadlineAt = Number.POSITIVE_INFINITY): string[] {
  const files = [transcriptPath];
  const walk = (dir: string, depth: number): void => {
    if (Date.now() > deadlineAt) throw new CheckFailure('timeout', 'the check ran out of time listing the subagents folder');
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // No subagents folder is the normal case; one that cannot be read is not "no subagents".
      if (errCode(err) === 'ENOENT' || errCode(err) === 'ENOTDIR') return;
      throw new CheckFailure('unreadable', `the subagents folder cannot be read (${errCode(err)})`);
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= SUBAGENT_MAX_DEPTH) throw new CheckFailure('too_large', 'the subagents folder is nested deeper than can be checked');
        walk(child, depth + 1);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(child);
    }
  };
  walk(`${transcriptPath.replace(/\.jsonl$/, '')}/subagents`, 0);
  return files;
}

/** The newest write among a session's files, or undefined when they cannot be listed by `deadlineAt` (the caller treats that as live). */
export function sessionLastWriteMs(transcriptPath: string, deadlineAt = Number.POSITIVE_INFINITY): number | undefined {
  let files: string[];
  try { files = sessionTranscriptFiles(transcriptPath, deadlineAt); } catch { return undefined; }
  let newest = 0;
  for (const file of files) {
    try { newest = Math.max(newest, fs.statSync(file).mtimeMs); } catch (err) { if (errCode(err) !== 'ENOENT') return undefined; }
  }
  return newest;
}

/** The rollout of a Codex thread by id, in `sessions/` or `archived_sessions/` under `codexHome`; a plain `.jsonl` before a `.jsonl.zst`. */
export function findCodexRollout(codexHome: string, id: string, deadlineAt = Number.POSITIVE_INFINITY): { file: string; zst: boolean } | undefined {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return undefined;
  const plain = `-${id}.jsonl`;
  const zst = `${plain}.zst`;
  // One walk per folder. A directory entry says what it is; only a symbolic link needs a `statSync`
  // (which follows it, to a day folder as to a rollout; a dangling one is skipped).
  const walk = (dir: string, depth: number, found: { plain?: string; zst?: string }): void => {
    if (Date.now() > deadlineAt) throw new CheckFailure('timeout', 'the check ran out of time looking for a parent rollout');
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // A folder that is not there holds no rollout; one that cannot be read may hold the parent.
      if (errCode(err) === 'ENOENT' || errCode(err) === 'ENOTDIR') return;
      throw new CheckFailure('parent_unreadable', `a folder that may hold the parent rollout cannot be read (${errCode(err)})`);
    }
    for (const entry of entries) {
      if (found.plain) return;
      const child = path.join(dir, entry.name);
      let isFile = entry.isFile();
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try { const st = fs.statSync(child); isFile = st.isFile(); isDir = st.isDirectory(); } catch { continue; }
      }
      if (isFile && entry.name.startsWith('rollout-')) {
        if (entry.name.endsWith(plain)) found.plain = child;
        else if (entry.name.endsWith(zst)) found.zst ??= child;
      } else if (isDir && depth < 3) {
        walk(child, depth + 1, found);
      }
    }
  };
  const roots = ['sessions', 'archived_sessions'].map((d) => path.join(codexHome, d));
  const found: { plain?: string; zst?: string } = {};
  // sessions/ first, then archived_sessions/; a plain file beats a compressed one anywhere.
  for (const root of roots) { walk(root, 0, found); if (found.plain) return { file: found.plain, zst: false }; }
  return found.zst ? { file: found.zst, zst: true } : undefined;
}

/** The Codex home (the folder holding `sessions/` and `archived_sessions/`) a rollout sits under, if any. */
function codexHomeOf(file: string): string | undefined {
  let dir = path.dirname(file);
  for (;;) {
    const base = path.basename(dir);
    if (base === 'sessions' || base === 'archived_sessions') return path.dirname(dir);
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/**
 * Is this session private? The one answer for every reader of a session's
 * content. In this order: a chat list given by the caller; the marker the
 * PostToolUse hook wrote at the call (its existence is the evidence, whatever
 * it holds); the transcript and its subagents' transcripts; for a fork, every
 * parent named in its header, up to `MAX_FORK_DEPTH` along a chain and
 * `MAX_PARENTS` in all. A `yes` anywhere is the answer; otherwise the first
 * reason that could not be settled (a lasting one before a passing one);
 * otherwise `no`.
 *
 * `snapshot` is the transcript's bytes as the caller already read them (the
 * dreamer packages exactly these): they are judged instead of the file, so a
 * transcript removed or replaced after it was read cannot answer for them;
 * the marker, the subagents' transcripts and the parents are still read.
 */
export function decidePrivacy(input: {
  sessionId?: string;
  transcriptPath?: string;
  snapshot?: Uint8Array;
  messages?: unknown;
  memeshDir: string;
  deadlineAt: number;
  cacheDir?: string;
}): PrivacyState {
  let candidate: Unchecked | undefined;
  const note = (reason: UncheckedReason, detail: string): void => {
    if (candidate === undefined || (candidate.kind === 'transient' && UNCHECKED_KIND[reason] === 'persistent')) candidate = unchecked(reason, detail);
  };
  const noteFailure = (err: unknown, fallback: UncheckedReason): void => {
    if (err instanceof CheckFailure) note(err.reason, err.message);
    else note(fallback, `a transcript cannot be read (${errCode(err)})`);
  };
  const settled = (): PrivacyState => candidate ?? { state: 'no' };

  if (input.messages !== undefined && chatCallsPrivateTool(input.messages)) return { state: 'yes', evidence: 'messages' };
  if (typeof input.sessionId === 'string' && input.sessionId !== '') {
    try {
      fs.statSync(privateMarkerPath(input.memeshDir, input.sessionId));
      return { state: 'yes', evidence: 'marker' };
    } catch (err) {
      // No marker is the ordinary case; a markers folder that is not a folder (ENOTDIR) is not "no marker".
      if (errCode(err) !== 'ENOENT') note('marker_unreadable', `the private-session marker cannot be read (${errCode(err)})`);
    }
  }
  const transcriptPath = input.transcriptPath;
  const snapshot = input.snapshot === undefined ? undefined : asBuffer(input.snapshot);
  if (typeof transcriptPath !== 'string' || transcriptPath === '') {
    // Bytes with no file behind them: they are judged alone (a fork's parents cannot be looked for without the file's place).
    if (snapshot === undefined) return settled();
    let alone: FileVerdict | undefined;
    try { alone = scanBytes(snapshot, input.deadlineAt); } catch (err) { noteFailure(err, 'unreadable'); }
    if (alone?.found) return { state: 'yes', evidence: 'transcript' };
    if (alone?.headerBroken) note('header_unreadable', 'the first line of the rollout is damaged, so whether it is a fork cannot be told');
    else if (alone && alone.forks.length > 0) note('parent_not_found', 'the parent rollout of this forked thread cannot be looked for without the transcript\'s path');
    return settled();
  }

  const stats: Array<{ file: string; stat: fs.Stats }> = [];
  if (snapshot === undefined) {
    // The one place where a missing file means "no": the transcript itself is not there, so there is nothing to look in.
    let mainStat: fs.Stats;
    try {
      mainStat = fs.statSync(transcriptPath);
    } catch (err) {
      if (errCode(err) === 'ENOENT') return settled();
      note('unreadable', `the transcript cannot be read (${errCode(err)})`);
      return settled();
    }
    if (!mainStat.isFile()) { note('unreadable', 'the transcript path is not a file'); return settled(); }
    stats.push({ file: transcriptPath, stat: mainStat });
  }

  let files: string[];
  try { files = sessionTranscriptFiles(transcriptPath, input.deadlineAt); } catch (err) { noteFailure(err, 'unreadable'); files = [transcriptPath]; }
  for (const file of files.slice(1)) {
    try { stats.push({ file, stat: fs.statSync(file) }); }
    catch (err) { note('unreadable', `a subagent transcript cannot be read (${errCode(err)})`); }
  }
  const total = stats.reduce((sum, s) => sum + s.stat.size, snapshot?.length ?? 0);
  if (total > PRIVATE_CHECK_MAX_BYTES) {
    note('too_large', 'the session\'s transcripts are too large to check');
    return settled();
  }

  let main: FileVerdict | undefined;
  if (snapshot !== undefined) {
    try { main = scanBytes(snapshot, input.deadlineAt); }
    catch (err) { noteFailure(err, 'unreadable'); }
    if (main?.found) return { state: 'yes', evidence: 'transcript' };
  }
  for (const { file, stat } of stats) {
    let verdict: FileVerdict;
    try { verdict = fileVerdict(file, stat, false, input.cacheDir, input.deadlineAt); }
    catch (err) { noteFailure(err, 'unreadable'); continue; }
    if (verdict.found) return { state: 'yes', evidence: file === transcriptPath ? 'transcript' : 'subagent' };
    if (file === transcriptPath) main = verdict;
  }
  if (main === undefined) return settled();
  if (main.headerBroken) { note('header_unreadable', 'the first line of the rollout is damaged, so whether it is a fork cannot be told'); return settled(); }

  // Every parent named, breadth first.
  const queue = main.forks.map((id) => ({ id, from: transcriptPath, depth: 0 }));
  const seen = new Set<string>();
  let parents = 0;
  while (queue.length > 0) {
    const { id, from, depth } = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (depth >= MAX_FORK_DEPTH || ++parents > MAX_PARENTS) { note('fork_too_deep', `the thread is forked more than ${MAX_FORK_DEPTH} levels deep, or from more than ${MAX_PARENTS} rollouts`); continue; }
    const home = codexHomeOf(from);
    let parent: { file: string; zst: boolean } | undefined;
    try { parent = home === undefined ? undefined : findCodexRollout(home, id, input.deadlineAt); }
    catch (err) { noteFailure(err, 'parent_unreadable'); continue; }
    if (parent === undefined) { note('parent_not_found', 'the parent rollout of this forked thread was not found'); continue; }
    let stat: fs.Stats;
    try { stat = fs.statSync(parent.file); }
    catch (err) { note('parent_unreadable', `the parent rollout cannot be read (${errCode(err)})`); continue; }
    if (stat.size > (parent.zst ? PARENT_ZST_MAX_BYTES : PARENT_MAX_BYTES)) { note('parent_too_large', 'the parent rollout is too large to check'); continue; }
    let verdict: FileVerdict;
    try { verdict = fileVerdict(parent.file, stat, parent.zst, input.cacheDir, input.deadlineAt); }
    catch (err) {
      if (err instanceof CheckFailure && err.reason === 'unreadable') note('parent_unreadable', err.message.replace('a transcript', 'the parent rollout'));
      else noteFailure(err, 'parent_unreadable');
      continue;
    }
    if (verdict.found) return { state: 'yes', evidence: 'fork_parent' };
    if (verdict.headerBroken) { note('header_unreadable', 'the first line of a parent rollout is damaged, so whether it is a fork cannot be told'); continue; }
    for (const next of verdict.forks) queue.push({ id: next, from: parent.file, depth: depth + 1 });
  }
  return settled();
}
