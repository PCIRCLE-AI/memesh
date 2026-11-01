import fs from 'node:fs';
import path from 'node:path';
const MAX_BYTES = 1024 * 1024;
export class ClaudeTranscriptReader {
    projectsDir;
    projectSlug;
    session = '';
    file;
    offset = 0;
    identity = '';
    pending = Buffer.alloc(0);
    plan;
    calls = new Set();
    constructor(projectsDir, projectSlug) {
        this.projectsDir = projectsDir;
        this.projectSlug = projectSlug;
    }
    currentTask(session) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(session))
            return undefined;
        if (session !== this.session) {
            this.session = session;
            this.file = undefined;
            this.reset();
        }
        if (!this.file) {
            try {
                for (const entry of fs.readdirSync(this.projectsDir, { withFileTypes: true })) {
                    if (!entry.isDirectory() || (this.projectSlug !== undefined && entry.name !== this.projectSlug))
                        continue;
                    const candidate = path.join(this.projectsDir, entry.name, `${session}.jsonl`);
                    try {
                        if (fs.lstatSync(candidate).isFile()) {
                            this.file = candidate;
                            break;
                        }
                    }
                    catch { }
                }
            }
            catch {
                return undefined;
            }
        }
        if (!this.file)
            return undefined;
        let fd;
        try {
            if (!fs.lstatSync(path.dirname(this.file)).isDirectory())
                return undefined;
            fd = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
            const stat = fs.fstatSync(fd);
            const named = fs.lstatSync(this.file);
            if (!stat.isFile() || !named.isFile() || stat.dev !== named.dev || stat.ino !== named.ino || (typeof process.getuid === 'function' && stat.uid !== process.getuid()))
                return undefined;
            const identity = `${stat.dev}:${stat.ino}`;
            if (this.identity !== identity || stat.size < this.offset || stat.size - this.offset > MAX_BYTES) {
                this.reset();
                this.identity = identity;
                this.offset = Math.max(0, stat.size - MAX_BYTES);
            }
            const start = this.offset;
            const buffer = Buffer.alloc(stat.size - start);
            const n = fs.readSync(fd, buffer, 0, buffer.length, this.offset);
            this.offset += n;
            let bytes = Buffer.concat([this.pending, buffer.subarray(0, n)]);
            if (start > 0 && start === stat.size - MAX_BYTES) {
                const firstNewline = bytes.indexOf(10);
                bytes = firstNewline < 0 ? Buffer.alloc(0) : bytes.subarray(firstNewline + 1);
            }
            let newline;
            while ((newline = bytes.indexOf(10)) >= 0) {
                this.consume(bytes.subarray(0, newline).toString('utf8'));
                bytes = bytes.subarray(newline + 1);
            }
            this.pending = Buffer.from(bytes);
            if (this.pending.length > MAX_BYTES) {
                this.reset();
                return undefined;
            }
            if (this.pending.length)
                return undefined;
            return this.plan?.find(item => item.status === 'in_progress')?.content;
        }
        catch {
            this.file = undefined;
            this.reset();
            return undefined;
        }
        finally {
            if (fd !== undefined)
                fs.closeSync(fd);
        }
    }
    reset() { this.offset = 0; this.identity = ''; this.pending = Buffer.alloc(0); this.plan = undefined; this.calls.clear(); }
    consume(line) {
        let record;
        try {
            record = JSON.parse(line);
        }
        catch {
            return;
        }
        if (!record || typeof record !== 'object' || !('type' in record) || record.type !== 'assistant' || !('message' in record) || !record.message || typeof record.message !== 'object' || !('role' in record.message) || record.message.role !== 'assistant' || !('content' in record.message))
            return;
        const content = record.message.content;
        if (!Array.isArray(content))
            return;
        for (const call of content) {
            if (call?.type !== 'tool_use' || !['TodoWrite', 'mcp__ccd_turn__update_plan'].includes(call.name))
                continue;
            if (typeof call.id !== 'string' || !call.id) {
                this.plan = undefined;
                continue;
            }
            if (this.calls.has(call.id))
                continue;
            this.calls.add(call.id);
            const input = call.input;
            if (call.name === 'mcp__ccd_turn__update_plan' && input?.advance === true && Object.keys(input).length === 1) {
                const index = this.plan?.findIndex(item => item.status === 'in_progress') ?? -1;
                if (!this.plan || index < 0) {
                    this.plan = undefined;
                    continue;
                }
                this.plan[index].status = 'completed';
                const next = this.plan.slice(index + 1).find(item => item.status === 'pending');
                if (next)
                    next.status = 'in_progress';
                continue;
            }
            const items = call.name === 'TodoWrite' ? input?.todos : input?.items;
            if (call.name !== 'TodoWrite' && !['first_task', 'continuation'].includes(input?.scope)) {
                this.plan = undefined;
                continue;
            }
            if (!Array.isArray(items) || !items.length || items.some(item => typeof item?.content !== 'string' || !['pending', 'in_progress', 'completed'].includes(item.status)) || items.filter(item => item.status === 'in_progress').length > 1) {
                this.plan = undefined;
                continue;
            }
            this.plan = items.map(item => ({ content: item.content, status: item.status }));
        }
    }
}
//# sourceMappingURL=claude-transcript.js.map