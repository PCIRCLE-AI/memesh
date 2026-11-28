// =============================================================================
// transcript-lines — read a host transcript line by line, in pieces, on a clock
// =============================================================================
//
// A long session's transcript is larger than one string can be (about 512 MiB
// in Node). PreCompact counts the transcript's tool calls, so it reads the file
// in pieces and hands each line to a callback, stops before a piece once its
// own deadline has passed (`timedOut`), and does not keep a line longer than
// `MAX_CALL_LINE_BYTES` (a Codex `compacted` record can be that long; it is no
// tool call): such a line is counted in `longLines` and said with the count.
//
// Only node builtins are imported: `generate-hook-core.mjs` mirrors this module
// into `scripts/hooks/_generated/` for the hooks.

import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

const CHUNK_BYTES = 8 * 1024 * 1024;
/** Lines over this are not read. */
export const MAX_CALL_LINE_BYTES = 64 * 1024 * 1024;

/**
 * How long, counted from the start of the hook's process, PreCompact lets itself
 * read the transcript. The host kills the hook at its 10 s limit; the database
 * lock wait (2 s) comes after the read, and both stay a second under the limit
 * so the outcome record is written.
 */
export const PRE_COMPACT_READ_BUDGET_MS = 6000;

/**
 * An absolute deadline (ms since the epoch) for a budget counted from the start
 * of this process. Throws for a budget that is not a number: an absent budget
 * made the deadline NaN, and a NaN deadline never passes, so the read it was
 * meant to bound ran until the host killed the hook and left no record.
 */
export function deadlineFor(budgetMs: number, nowMs: number = Date.now(), uptimeMs: number = performance.now()): number {
  if (!Number.isFinite(budgetMs)) throw new Error(`a hook budget must be a number of milliseconds, not ${budgetMs}`);
  return nowMs + Math.max(0, budgetMs - uptimeMs);
}

/**
 * Calls `onLine` with every line of a file, read in pieces in time linear in
 * its size: an unfinished line is kept as a list of pieces and joined once, when
 * it ends, and a line longer than `MAX_CALL_LINE_BYTES` is not kept at all (it
 * is counted in `longLines`). Stops before a piece once `deadlineAt` has passed
 * (`timedOut`).
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
