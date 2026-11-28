import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
const CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_CALL_LINE_BYTES = 64 * 1024 * 1024;
export const PRE_COMPACT_READ_BUDGET_MS = 6000;
export function deadlineFor(budgetMs, nowMs = Date.now(), uptimeMs = performance.now()) {
    if (!Number.isFinite(budgetMs))
        throw new Error(`a hook budget must be a number of milliseconds, not ${budgetMs}`);
    return nowMs + Math.max(0, budgetMs - uptimeMs);
}
export function forEachTranscriptLine(filePath, deadlineAt, onLine) {
    const fd = fs.openSync(filePath, 'r');
    try {
        if (fs.fstatSync(fd).isDirectory())
            throw Object.assign(new Error('transcript path is a directory'), { code: 'EISDIR' });
        const chunk = Buffer.alloc(CHUNK_BYTES);
        let pieces = [];
        let pending = 0;
        let longLines = 0;
        const endLine = (last) => {
            if (pending + last.length <= MAX_CALL_LINE_BYTES)
                onLine(pieces.length === 0 ? last : Buffer.concat([...pieces, last]));
            else
                longLines++;
            pieces = [];
            pending = 0;
        };
        for (;;) {
            if (Date.now() > deadlineAt)
                return { timedOut: true, longLines };
            const n = fs.readSync(fd, chunk, 0, chunk.length, null);
            if (n === 0)
                break;
            const data = chunk.subarray(0, n);
            let from = 0;
            for (let nl = data.indexOf(10); nl !== -1; nl = data.indexOf(10, from)) {
                endLine(data.subarray(from, nl));
                from = nl + 1;
            }
            const rest = n - from;
            if (rest > 0) {
                if (pending + rest <= MAX_CALL_LINE_BYTES)
                    pieces.push(Buffer.from(data.subarray(from)));
                else
                    pieces = [];
                pending += rest;
            }
        }
        if (pending > 0)
            endLine(Buffer.alloc(0));
        return { timedOut: false, longLines };
    }
    finally {
        fs.closeSync(fd);
    }
}
//# sourceMappingURL=transcript-lines.js.map