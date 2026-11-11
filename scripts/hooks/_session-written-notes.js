/**
 * The note files a session's own tool inputs name, in any notes folder of its
 * projects root (`<root>/<project>/memory/`), and the folders it reached.
 *
 * A session "wrote" a note when any string in any of its tool inputs mentions
 * the note's FILE NAME: a file tool's target (Claude Code's own or an MCP
 * server's, whatever the field is called), the text of a Bash command, a Task
 * prompt; on Codex, the input of a `function_call` or `custom_tool_call` row.
 * The name is matched, not the path and not the shell syntax, so `echo > f`,
 * `cp`, `mv`, `tee`, `python -c`, `~/…`, `$HOME/…`, `cd` and a relative path,
 * `x/../memory`, a symlinked folder, upper case, a name with spaces and a
 * backslash-escaped space are all covered without listing any of them. A name
 * split by shell quotes (`sec"ret".md`, `'a''b.md'`) and a simple brace list
 * (`{a,b}.md`) are read joined and expanded too, and both sides are compared
 * in Unicode NFC (a name typed composed matches one stored decomposed). A
 * command that only reads the file also counts: that errs on the side of
 * storing less.
 *
 * A session "reached" a folder when a tool input names a note in it, or names
 * the folder's project (`<project>` and `memory` in one string), or names the
 * projects root itself without a project (then every folder is reached). A
 * write that names no file (`cp -r` of a whole folder, a script that makes up
 * the name) can only land in a folder the session reached, and the caller
 * holds every note changed there while the session ran.
 *
 * What is read: the transcript and its subagents' transcripts
 * (`<transcript without .jsonl>/subagents/**.jsonl`), including a subagent's
 * tool calls that the host records as `progress` rows.
 *
 * Cost: one pass over the bytes. A line is parsed only when it holds a
 * `tool_use` and something that can spell `.md` or `memory`; the work per
 * `.md` found is bounded by the longest note name. The pass has an absolute
 * deadline checked between lines and between `.md` hits (a host kills a hook at
 * its limit): when it passes, or a transcript cannot be read, `complete` is
 * false and the caller holds by time instead, which stores less.
 */
import { readdirSync, statSync } from 'fs';
import { basename, dirname, join } from 'path';
import { forEachTranscriptLine, PRIVATE_CHECK_MAX_BYTES, sessionTranscriptFiles } from './_generated/private-session.js';

const SKIPPED_DIRS = new Set(['.git', 'node_modules']);
// A row that can carry a tool's input: Claude Code's `tool_use` block, Codex's `function_call` and `custom_tool_call` items.
const TOOL_ROWS = ['"tool_use"', '"function_call"', '"custom_tool_call"'].map((s) => Buffer.from(s));

const record = (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null);

/** Every `.md` file under dir, as absolute paths. */
function listNoteFiles(dir) {
  const files = [];
  const walk = (current) => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { if (!SKIPPED_DIRS.has(entry.name)) walk(child); continue; }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(child);
    }
  };
  walk(dir);
  return files;
}

const isWord = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45;
const TIMEOUT = Symbol('scan time budget used up');

/**
 * Adds to `hit` every note name (a key of `names`) that `text` mentions as a
 * whole name. Work per `.md` found is bounded by the longest note name, not by
 * the line, and `tick` is called for each one so a deadline can stop the scan
 * anywhere in a line.
 */
function collect(text, names, maxLen, hit, tick) {
  let at = text.indexOf('.md');
  while (at !== -1) {
    tick();
    const end = at + 3;
    if (end >= text.length || !isWord(text.charCodeAt(end))) {
      const min = Math.max(0, end - maxLen);
      for (let start = at; start >= min; start--) {
        if (start > 0 && isWord(text.charCodeAt(start - 1))) continue;
        const name = text.slice(start, end);
        if (names.has(name)) hit.add(name);
      }
    }
    at = text.indexOf('.md', at + 1);
  }
}

/** A name as it is compared: composed (NFC), lower case. */
const comparable = (text) => text.normalize('NFC').toLowerCase();

/**
 * Every simple brace list (`{a,b}`, no nesting, no spaces) expanded with the
 * word around it, one expansion at a time (`tick` before each, so a deadline
 * stops a huge list). The word is taken at most `maxLen` characters each way.
 */
function* braceExpansions(text, maxLen, tick) {
  const stop = (c) => c === ' ' || c === '\n' || c === '\t' || c === '{' || c === '}' || c === '"' || c === "'";
  for (const m of text.matchAll(/\{([^{}\s]{0,4096})\}/g)) {
    if (!m[1].includes(',')) continue;
    let start = m.index;
    for (const lo = Math.max(0, start - maxLen); start > lo && !stop(text[start - 1]);) start--;
    let end = m.index + m[0].length;
    for (const hi = Math.min(text.length, end + maxLen); end < hi && !stop(text[end]);) end++;
    const pre = text.slice(start, m.index);
    const post = text.slice(m.index + m[0].length, end);
    for (const item of m[1].split(',')) { tick(); yield pre + item + post; }
  }
}

/**
 * The readings of a string: as it is; with every backslash dropped
 * (`my\ note.md`); with a written `\n`, `\t` or `\r` (a Codex script's source)
 * read as a space; with shell quotes and backslashes dropped (`sec"ret".md`);
 * and each of those with its brace lists expanded (`{"secret",other}.md`).
 */
function* readings(text, maxLen, tick) {
  const lower = comparable(text);
  const out = [lower];
  if (lower.includes('\\')) out.push(lower.replace(/\\/g, ''));
  if (/\\[ntr]/.test(lower)) out.push(lower.replace(/\\[ntr]/g, ' '));
  if (lower.includes('"') || lower.includes("'")) out.push(lower.replace(/["'\\]/g, ''));
  yield* out;
  if (lower.includes('{')) for (const base of out) yield* braceExpansions(base, maxLen, tick);
}

/**
 * Codex: the input of a `function_call` (`arguments`, a JSON text) or a
 * `custom_tool_call` (`input`, the script) row, as it is and, when it is JSON,
 * every string inside it.
 */
function codexInputStrings(entry, out) {
  const payload = record(entry?.payload);
  if (entry?.type !== 'response_item' || (payload?.type !== 'function_call' && payload?.type !== 'custom_tool_call')) return;
  for (const value of [payload.arguments, payload.input]) {
    if (typeof value !== 'string') continue;
    out.push(value);
    try { toolInputStrings(JSON.parse(value), out, true); } catch { /* a script, not JSON */ }
  }
}

/** Every string inside the input of every `tool_use` in a parsed row, wherever the host nests it. */
function toolInputStrings(node, out, inInput = false, depth = 0) {
  if (depth > 16) return;
  if (typeof node === 'string') { if (inInput) out.push(node); return; }
  if (Array.isArray(node)) { for (const item of node) toolInputStrings(item, out, inInput, depth + 1); return; }
  const obj = record(node);
  if (!obj) return;
  const isUse = obj.type === 'tool_use';
  for (const [key, value] of Object.entries(obj)) {
    toolInputStrings(value, out, inInput || (isUse && key === 'input'), depth + 1);
  }
}

// A row that can name a note or a notes folder has `.md` or `memory` (any case), or a `\uXXXX` escape that could spell one.
const PREFILTER = ['.md', '.MD', '.Md', '.mD', 'memory', 'MEMORY', 'Memory', '\\u'].map((s) => Buffer.from(s));

/**
 * The notes the session's transcripts name, in any of `folders` (real paths of
 * notes folders; the session's own folder is reached whatever its tool inputs
 * say), and the folders it reached. Never throws for a transcript that cannot
 * be read: `complete` is then false and `reason` says why (`time`: the
 * deadline passed; `unreadable`: a transcript or the subagents folder could not
 * be read; `too_large`: past the size the private check reads), and the
 * caller holds by time. `deadlineAt` is an absolute time (ms since the epoch).
 *
 * Returns `{ byDir: Map<folder, string[]>, reached: Set<folder>, complete, reason }`.
 */
export function notePathsWrittenInTranscript(transcriptPath, folders, { ownDir, deadlineAt } = {}) {
  // The caller's deadline, always: a default here once let a hook read past the time its host gives it.
  if (!Number.isFinite(deadlineAt)) throw new Error('notePathsWrittenInTranscript needs a deadline');
  const list = Array.isArray(folders) ? folders : [folders];
  const own = ownDir ?? (Array.isArray(folders) ? undefined : folders);
  const byName = new Map();
  let maxLen = 0;
  for (const dir of list) {
    for (const abs of listNoteFiles(dir)) {
      const name = comparable(basename(abs));
      byName.set(name, [...(byName.get(name) ?? []), abs]);
      maxLen = Math.max(maxLen, name.length);
    }
  }
  // A folder is reached by its project's name (`<root>/<project>/memory`): long and distinctive.
  const projects = list.map((dir) => ({ dir, project: basename(dirname(dir)).toLowerCase() })).filter((p) => p.project.length >= 3);
  const rootMentions = list.length > 0 ? ['.claude/projects', dirname(dirname(list[0])).toLowerCase()] : [];
  const needles = [...PREFILTER, ...rootMentions.map((m) => Buffer.from(m)), ...(list.length > 0 ? [Buffer.from(dirname(dirname(list[0])))] : [])];
  const hit = new Set();
  const reached = new Set(own ? [own] : []);
  let reachedAll = false;
  let reason;
  let ticks = 0;
  const tick = () => { if ((++ticks & 1023) === 0 && Date.now() > deadlineAt) throw TIMEOUT; };
  const names = new Set(byName.keys());
  const look = (text) => {
    for (const reading of readings(text, maxLen, tick)) {
      collect(reading, names, maxLen, hit, tick);
      if (reachedAll || !reading.includes('memory') && !rootMentions.some((m) => reading.includes(m))) continue;
      let named = false;
      for (const { dir, project } of projects) { if (Date.now() > deadlineAt) throw TIMEOUT; if (reading.includes(project)) { reached.add(dir); named = true; } }
      if (!named && rootMentions.some((m) => reading.includes(m))) reachedAll = true;
    }
  };
  const feed = (line) => {
    if (Date.now() > deadlineAt) throw TIMEOUT;
    if (!TOOL_ROWS.some((row) => line.includes(row)) || !needles.some((spelling) => line.includes(spelling))) return;
    let entry;
    try { entry = JSON.parse(line.toString('utf8')); } catch { return; }
    const strings = [];
    toolInputStrings(entry, strings);
    codexInputStrings(entry, strings);
    for (const text of strings) look(text);
  };
  const readOne = (file) => {
    const read = forEachTranscriptLine(file, deadlineAt, feed);
    if (read.timedOut) throw TIMEOUT;
    // A line longer than the private check reads cannot be judged here either: hold by time.
    if (read.longLines > 0) throw new Error('a line is too long to read');
  };
  let files;
  try {
    files = sessionTranscriptFiles(transcriptPath, deadlineAt);
  } catch (err) {
    files = [transcriptPath];
    reason = err?.reason === 'timeout' ? 'time' : 'unreadable';
  }
  let total = 0;
  for (const file of files) { try { total += statSync(file).size; } catch { /* read below says so */ } }
  if (total > PRIVATE_CHECK_MAX_BYTES) {
    reason = 'too_large';
  } else {
    for (const file of files) {
      try {
        readOne(file);
      } catch (err) {
        if (err === TIMEOUT) { reason = 'time'; break; }
        reason = 'unreadable';
      }
    }
  }
  const byDir = new Map();
  for (const name of hit) {
    for (const abs of byName.get(name)) {
      const dir = list.find((d) => abs.startsWith(d + '/') || abs.startsWith(d + '\\'));
      if (dir === undefined) continue;
      byDir.set(dir, [...(byDir.get(dir) ?? []), abs]);
      // A name found in one folder only reaches it; a name every folder has (MEMORY.md) holds those files, not the folders.
      if (byName.get(name).length === 1) reached.add(dir);
    }
  }
  if (reachedAll) for (const dir of list) reached.add(dir);
  return { byDir, reached, complete: reason === undefined, reason };
}

