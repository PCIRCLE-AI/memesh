import { createRequire } from 'node:module';
function loadNodeSqlite() {
    const require = createRequire(import.meta.url);
    const original = process.emitWarning;
    process.emitWarning = function (warning, ...rest) {
        const text = typeof warning === 'string' ? warning : String(warning?.message ?? warning);
        if (text.includes('SQLite is an experimental feature'))
            return;
        return original.call(process, warning, ...rest);
    };
    try {
        return require('node:sqlite');
    }
    catch (err) {
        return { missing: err instanceof Error ? err.message : String(err) };
    }
    finally {
        process.emitWarning = original;
    }
}
const loadedSqlite = loadNodeSqlite();
class MissingDatabaseSync {
    constructor() {
        const detail = 'missing' in loadedSqlite ? loadedSqlite.missing : 'unknown';
        throw new UnsupportedNodeError(`memesh needs Node's built-in SQLite, which this runtime (${process.version}) does not provide. ` +
            `Upgrade Node to ${MIN_NODE_SERIES} or newer and run memesh again. (${detail})`);
    }
}
const DatabaseSync = 'DatabaseSync' in loadedSqlite
    ? loadedSqlite.DatabaseSync
    : MissingDatabaseSync;
export const MIN_NODE_VERSION = '22.16.0';
export const MIN_NODE_SERIES = MIN_NODE_VERSION.split('.').slice(0, 2).join('.');
export class UnsupportedNodeError extends Error {
    code = 'NODE_TOO_OLD';
    constructor(message) {
        super(message);
        this.name = 'UnsupportedNodeError';
    }
}
export function isUnsupportedNode(err) {
    return err?.code === 'NODE_TOO_OLD';
}
function atLeastMinimumNode(version) {
    const want = MIN_NODE_VERSION.split('.').map(Number);
    const have = version.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10));
    for (let i = 0; i < 3; i++) {
        const h = have[i];
        if (!Number.isFinite(h))
            return false;
        if (h !== want[i])
            return h > want[i];
    }
    return true;
}
export function fts5ProbeResult(createFtsTable) {
    try {
        createFtsTable();
        return true;
    }
    catch (err) {
        if (/no such module/i.test(err instanceof Error ? err.message : String(err)))
            return false;
        throw err;
    }
}
let ftsProbe;
function hasFts5() {
    if (ftsProbe === undefined) {
        const probe = new DatabaseSync(':memory:');
        try {
            ftsProbe = fts5ProbeResult(() => probe.exec('CREATE VIRTUAL TABLE memesh_fts5_probe USING fts5(a)'));
        }
        finally {
            try {
                probe.close();
            }
            catch { }
        }
    }
    return ftsProbe;
}
export function nodeSupportProblem(version = process.versions.node, fts5Available = hasFts5) {
    const shown = version.replace(/^v/, '');
    if (!atLeastMinimumNode(version)) {
        return `This Node (v${shown}) lacks the full-text search MeMesh needs; upgrade to Node ${MIN_NODE_SERIES} or newer and run memesh again.`;
    }
    if (!fts5Available()) {
        return `This Node build (v${shown}) lacks the full-text search (FTS5) MeMesh needs; install the official Node ${MIN_NODE_SERIES} or newer from nodejs.org and run memesh again.`;
    }
    return null;
}
export function assertNodeSupported() {
    const problem = nodeSupportProblem();
    if (problem)
        throw new UnsupportedNodeError(problem);
}
export const BUSY_TIMEOUT_MS = 30_000;
export class MemeshDatabase extends DatabaseSync {
    #depth = 0;
    constructor(path, options = {}) {
        assertNodeSupported();
        super(path, options);
        this.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    }
    pragma(statement) {
        this.exec(`PRAGMA ${statement}`);
    }
    transaction(fn) {
        const run = (mode, ...args) => {
            const nested = this.#depth > 0;
            const savepoint = `memesh_sp_${this.#depth}`;
            this.exec(nested ? `SAVEPOINT ${savepoint}` : `BEGIN${mode}`);
            this.#depth++;
            try {
                const result = fn(...args);
                this.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
                return result;
            }
            catch (err) {
                try {
                    this.exec(nested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK');
                    if (nested)
                        this.exec(`RELEASE ${savepoint}`);
                }
                catch { }
                throw err;
            }
            finally {
                this.#depth--;
            }
        };
        const callable = ((...args) => run('', ...args));
        callable.immediate = (...args) => run(' IMMEDIATE', ...args);
        return callable;
    }
}
//# sourceMappingURL=sqlite.js.map