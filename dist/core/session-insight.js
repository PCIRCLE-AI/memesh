import { redactSecrets } from './paths.js';
import { truncateTitle } from './title.js';
import { remember } from './operations.js';
export const MIN_TOOL_CALLS = 3;
export const HEAVY_SESSION_TOOL_CALLS = 20;
export function bashEditedPaths(cmd) {
    if (typeof cmd !== 'string')
        return [];
    const found = new Set();
    for (const re of [
        /(?:^|[^<])>\s*"?([^\s"'>|&;]+)"?\s*<<\s*['"]?\w+['"]?/g,
        /\bcat\s*>\s*"?([^\s"'>|&;]+)"?/g,
        /\btee\s+(?:-a\s+)?"?([^\s"'>|&;]+)"?/g,
        /\bsed\s+-i(?:\s+'')?\s+(?:'[^']*'|"[^"]*")\s+"?([^\s"'>|&;]+)"?/g,
        /Path\(\s*['"]([^'"]+)['"]\s*\)\s*\.write_text\(/g,
        /writeFileSync\(\s*['"]([^'"]+)['"]/g,
    ]) {
        let m;
        while ((m = re.exec(cmd)) !== null) {
            if (m[1] && !m[1].startsWith('/dev/') && !m[1].startsWith('/tmp/'))
                found.add(m[1]);
        }
    }
    return [...found];
}
function basename(p) {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
}
const FILE_WRITE_TOOLS = new Set(['write_file', 'patch', 'edit_file', 'Write', 'Edit', 'MultiEdit']);
const SHELL_TOOLS = new Set(['terminal', 'shell', 'bash', 'Bash']);
const KNOWN_READ_ONLY_TOOLS = new Set([
    'read_file', 'search_files', 'list_files', 'web_search', 'web_extract', 'Read', 'Grep', 'Glob',
    'memesh_recall', 'memesh_remember', 'memesh_forget', 'memory', 'todo',
]);
function parseArgs(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw))
        return raw;
    if (typeof raw !== 'string')
        return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
function contentText(content) {
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => (part && typeof part === 'object' && typeof part.text === 'string'
            ? part.text : ''))
            .join(' ');
    }
    return '';
}
function toolResultError(content) {
    const text = contentText(content);
    let body;
    try {
        body = JSON.parse(text);
    }
    catch {
        return 'unreadable';
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
        return 'unreadable';
    const b = body;
    const failed = (typeof b.error === 'string' && b.error.trim() !== '')
        || b.success === false
        || (typeof b.exit_code === 'number' && b.exit_code !== 0);
    if (!failed)
        return null;
    const detail = typeof b.error === 'string' && b.error.trim() !== '' ? b.error : text;
    return detail;
}
export function activityFromChatMessages(messages) {
    const filesEdited = new Set();
    const bashCommands = [];
    const errorsEncountered = [];
    const unrecognized = new Set();
    let toolCallCount = 0;
    let toolResultsNonJson = 0;
    for (const msg of Array.isArray(messages) ? messages : []) {
        if (!msg || typeof msg !== 'object')
            continue;
        const m = msg;
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
            for (const call of m.tool_calls) {
                const fn = call && typeof call === 'object' ? call.function : undefined;
                const name = fn && typeof fn === 'object' ? fn.name : undefined;
                if (typeof name !== 'string' || name === '')
                    continue;
                toolCallCount++;
                const args = parseArgs(fn.arguments);
                if (FILE_WRITE_TOOLS.has(name)) {
                    const fp = args.path ?? args.file_path;
                    if (typeof fp === 'string' && fp)
                        filesEdited.add(basename(fp));
                }
                else if (SHELL_TOOLS.has(name)) {
                    const cmd = args.command;
                    for (const fp of bashEditedPaths(cmd))
                        filesEdited.add(basename(fp));
                    if (typeof cmd === 'string' && cmd.length > 10 && !cmd.startsWith('ls') && !cmd.startsWith('cd')) {
                        bashCommands.push(redactSecrets(cmd).slice(0, 100));
                    }
                }
                else if (!KNOWN_READ_ONLY_TOOLS.has(name)) {
                    unrecognized.add(name);
                }
            }
        }
        else if (m.role === 'tool') {
            const err = toolResultError(m.content);
            if (err === 'unreadable')
                toolResultsNonJson++;
            else if (err !== null)
                errorsEncountered.push(redactSecrets(err).slice(0, 200));
        }
    }
    return {
        filesEdited: [...filesEdited],
        bashCommands,
        errorsEncountered,
        toolCallCount,
        unrecognizedTools: [...unrecognized],
        toolResultsNonJson,
    };
}
function fileTagsFor(files) {
    const tags = new Set();
    for (const f of files) {
        if (!f)
            continue;
        tags.add(`file:${f}`);
        const noExt = f.replace(/\.[^.]+$/, '');
        if (noExt && noExt !== f)
            tags.add(`file:${noExt}`);
    }
    return [...tags];
}
export function buildSessionInsights(activity, ctx) {
    if (activity.toolCallCount < MIN_TOOL_CALLS)
        return [];
    const { filesEdited, errorsEncountered, bashCommands, toolCallCount } = activity;
    const baseTags = [`session:${ctx.sessionId}`, ...ctx.baseTags];
    const titlePrefix = `${ctx.date ?? new Date().toISOString().slice(0, 10)} ${ctx.titleLabel}`;
    const out = [];
    if (filesEdited.length > 0) {
        out.push({
            name: `session-${ctx.sessionId}-files`,
            type: 'session-insight',
            title: truncateTitle(`${titlePrefix}: edited ${filesEdited.length} file(s)`),
            observations: [
                `Session edited ${filesEdited.length} file(s): ${filesEdited.join(', ')}`,
                `Total tool calls: ${toolCallCount}`,
            ],
            tags: [...baseTags, ...fileTagsFor(filesEdited)],
        });
    }
    if (errorsEncountered.length > 0 && filesEdited.length > 0) {
        out.push({
            name: `session-${ctx.sessionId}-fixes`,
            type: 'session-insight',
            title: truncateTitle(`${titlePrefix}: fixed ${errorsEncountered.length} error(s)`),
            observations: [
                `Fixed ${errorsEncountered.length} error(s) by editing ${filesEdited.join(', ')}`,
                ...errorsEncountered.slice(0, 3).map((e) => `Error: ${e.slice(0, 100)}`),
            ],
            tags: [...baseTags, 'type:bugfix', ...fileTagsFor(filesEdited)],
        });
    }
    if (toolCallCount >= HEAVY_SESSION_TOOL_CALLS) {
        out.push({
            name: `session-${ctx.sessionId}-summary`,
            type: 'session-insight',
            title: truncateTitle(`${titlePrefix}: significant session (${toolCallCount} tool calls)`),
            observations: [
                `Significant session: ${toolCallCount} tool calls, ${filesEdited.length} files edited`,
                ...bashCommands.slice(0, 3).map((c) => `Command: ${c}`),
            ],
            tags: [...baseTags, 'type:heavy-session'],
        });
    }
    return out;
}
export function captureChatSession(input) {
    const activity = activityFromChatMessages(input.messages);
    const counts = {
        toolCallCount: activity.toolCallCount,
        filesEdited: activity.filesEdited.length,
        errorsEncountered: activity.errorsEncountered.length,
        unrecognizedTools: activity.unrecognizedTools,
        toolResultsNonJson: activity.toolResultsNonJson,
    };
    const entities = buildSessionInsights(activity, {
        sessionId: input.sessionId,
        baseTags: input.baseTags,
        titleLabel: input.titleLabel,
    });
    if (entities.length === 0) {
        const reason = activity.toolCallCount < MIN_TOOL_CALLS
            ? `too little activity to be worth saving (${activity.toolCallCount} tool call(s))`
            : `no rule matched (no edited file and fewer than ${HEAVY_SESSION_TOOL_CALLS} tool calls)`;
        return { outcome: 'skipped', reason, written: [], ...counts };
    }
    for (const e of entities) {
        remember({ ...e, sourceHost: input.sourceHost });
    }
    return { outcome: 'wrote', written: entities.map((e) => e.name), ...counts };
}
//# sourceMappingURL=session-insight.js.map