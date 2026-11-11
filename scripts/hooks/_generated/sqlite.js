// ============================================================================
// AUTO-GENERATED from src/storage/sqlite.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
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
    catch {
        return null;
    }
    finally {
        process.emitWarning = original;
    }
}
const loadedSqlite = loadNodeSqlite();
class MissingDatabaseSync {
    constructor() {
        assertNodeSupported();
        throw new Error('node:sqlite did not load');
    }
}
export const DatabaseSync = loadedSqlite?.DatabaseSync ?? MissingDatabaseSync;
export const MIN_NODE_VERSION = '22.16.0';
export const MIN_NODE_SERIES = MIN_NODE_VERSION.split('.').slice(0, 2).join('.');
export class UnsupportedNodeError extends Error {
    code = 'NODE_TOO_OLD';
    fix;
    constructor(problem) {
        super(problem.message);
        this.name = 'UnsupportedNodeError';
        this.fix = problem.fix;
    }
}
export function isUnsupportedNode(err) {
    return err?.code === 'NODE_TOO_OLD';
}
export class SqliteSelfCheckError extends Error {
    code = 'SQLITE_SELF_CHECK_FAILED';
    advice = 'Your database is not the problem. Run the command again; if it keeps failing, free some memory or restart, then run `memesh doctor`.';
    constructor(cause) {
        super(`MeMesh could not check this Node's SQLite (${cause instanceof Error ? cause.message : String(cause)}).`, { cause });
        this.name = 'SqliteSelfCheckError';
    }
}
export function isSqliteSelfCheckFailure(err) {
    return err?.code === 'SQLITE_SELF_CHECK_FAILED';
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
        let probe;
        try {
            probe = new DatabaseSync(':memory:');
            const throwaway = probe;
            ftsProbe = fts5ProbeResult(() => throwaway.exec('CREATE VIRTUAL TABLE memesh_fts5_probe USING fts5(a)'));
        }
        catch (err) {
            throw new SqliteSelfCheckError(err);
        }
        finally {
            try {
                probe?.close();
            }
            catch { }
        }
    }
    return ftsProbe;
}
export function nodeProblem(version = process.versions.node, fts5Available = hasFts5, sqliteLoaded = loadedSqlite !== null) {
    const shown = version.replace(/^v/, '');
    const official = `the official Node ${MIN_NODE_SERIES} or newer from nodejs.org`;
    if (!atLeastMinimumNode(version)) {
        return {
            kind: 'too-old',
            message: `This Node (v${shown}) lacks the full-text search MeMesh needs; upgrade to Node ${MIN_NODE_SERIES} or newer and run memesh again.`,
            fix: `Upgrade Node to ${MIN_NODE_SERIES} or newer, then run \`memesh doctor\` again.`,
        };
    }
    if (!sqliteLoaded) {
        return {
            kind: 'sqlite-switched-off',
            message: `This Node (v${shown}) is new enough, but its built-in SQLite (node:sqlite) is switched off; remove the --no-experimental-sqlite option (from the command line, the NODE_OPTIONS environment variable or a Node config file), or install ${official}, and run memesh again.`,
            fix: `Remove the --no-experimental-sqlite option (from the command line, NODE_OPTIONS or a Node config file), or install ${official}, then run \`memesh doctor\` again.`,
        };
    }
    if (!fts5Available()) {
        return {
            kind: 'no-fts5',
            message: `This Node build (v${shown}) lacks the full-text search (FTS5) MeMesh needs; install ${official} and run memesh again.`,
            fix: `Install ${official}, then run \`memesh doctor\` again.`,
        };
    }
    return null;
}
export function nodeSupportProblem(version, fts5Available, sqliteLoaded) {
    return nodeProblem(version, fts5Available, sqliteLoaded)?.message ?? null;
}
export function assertNodeSupported() {
    const problem = nodeProblem();
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
