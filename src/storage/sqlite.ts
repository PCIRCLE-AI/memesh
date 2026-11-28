/**
 * The SQLite driver, and the two methods node:sqlite does not ship.
 *
 * memesh used to run on `better-sqlite3`, whose install script is
 * `prebuild-install || node-gyp rebuild`. That binds the compiled binary to a
 * Node ABI, so a Node upgrade breaks it and `--ignore-scripts` never builds it
 * at all — which is exactly how a `/plugin install` produced a memesh whose
 * hooks silently did nothing, because Claude Code installs plugins with
 * `--ignore-scripts`. `node:sqlite` is part of the runtime: no binary, no
 * install script, nothing to rebuild.
 *
 * The only two things better-sqlite3 had that node:sqlite does not are
 * `db.pragma()` and `db.transaction()`. They are re-added here as a subclass
 * rather than as free functions on purpose: every existing call site keeps its
 * shape, so the migration is a change of driver and not a rewrite of 17
 * transaction bodies whose rollback behaviour is load-bearing.
 */
import { createRequire } from 'node:module';

/**
 * Load node:sqlite without printing Node 22's experimental warning.
 *
 * The warning is emitted once, when the module is first loaded, and memesh
 * supports Node >= 22.16 — so on the rest of the Node 22 LTS line every CLI
 * invocation, every hook and every MCP handshake would print a line users
 * cannot act on. Node 24 and 26 emit nothing.
 *
 * The patch is surgical and temporary: it drops only this one warning, passes
 * every other warning through untouched, and `process.emitWarning` is restored
 * before this function returns — including when the load throws, which is why
 * the restore is in a `finally`. Verified on 22.23.2 (warning suppressed, an
 * unrelated warning still emitted, hook stayed restored), 24.15.0 and 26.5.1.
 *
 * `createRequire` rather than `await import()`: a top-level await here would
 * make every importer of this module async for no gain, and `node:sqlite` is a
 * builtin so `require` resolves it in an ESM file without a file lookup.
 */
function loadNodeSqlite(): typeof import('node:sqlite') | null {
  const require = createRequire(import.meta.url);
  const original = process.emitWarning;
  process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
    const text = typeof warning === 'string' ? warning : String(warning?.message ?? warning);
    if (text.includes('SQLite is an experimental feature')) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (original as any).call(process, warning, ...rest);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  try {
    return require('node:sqlite') as typeof import('node:sqlite');
  } catch {
    // A runtime without `node:sqlite` (Node 20, 22.5 to 22.12 without the flag,
    // or any Node started with --no-experimental-sqlite) must not crash HERE,
    // at import: every entry point, hooks included, imports this module, and a
    // throw during module evaluation reaches the user as a stack trace and, for
    // a hook, a non-zero exit. The failure is deferred to the first open, where
    // it carries the sentence that names the right fix for this Node.
    return null;
  } finally {
    process.emitWarning = original;
  }
}

const loadedSqlite = loadNodeSqlite();

/** What stands in for `DatabaseSync` when `node:sqlite` is absent: it refuses to be constructed. */
class MissingDatabaseSync {
  constructor() {
    assertNodeSupported();
    throw new Error('node:sqlite did not load');
  }
}

export const DatabaseSync: typeof import('node:sqlite').DatabaseSync =
  loadedSqlite?.DatabaseSync ?? (MissingDatabaseSync as unknown as typeof import('node:sqlite').DatabaseSync);

/**
 * The oldest Node whose `node:sqlite` is built with FTS5 (nodejs/node#57621,
 * "sqlite: enable common flags"), which the keyword index needs. 22.13 to
 * 22.15 have `node:sqlite` but not FTS5, so every open failed there with
 * `no such module: fts5`, a message that names neither Node nor the fix.
 * `package.json` `engines.node` and the docs say the same number.
 */
export const MIN_NODE_VERSION = '22.16.0';

/** The floor as users read it in messages ("22.16"). */
export const MIN_NODE_SERIES = MIN_NODE_VERSION.split('.').slice(0, 2).join('.');

/** Why this Node cannot run MeMesh: what to tell the user (`message`, one sentence) and the repair for a `Fix:` line. */
export interface NodeProblem {
  kind: 'too-old' | 'sqlite-switched-off' | 'no-fts5';
  message: string;
  fix: string;
}

/** Why MeMesh cannot use this Node; `code` is what a hook records as its outcome reason, `fix` is the repair that works for this case. */
export class UnsupportedNodeError extends Error {
  readonly code = 'NODE_TOO_OLD';
  readonly fix: string;
  constructor(problem: NodeProblem) {
    super(problem.message);
    this.name = 'UnsupportedNodeError';
    this.fix = problem.fix;
  }
}

/** Is `err` MeMesh's refusal to run on this Node? Callers print its message as the one sentence, not as a database problem. */
export function isUnsupportedNode(err: unknown): err is UnsupportedNodeError {
  return (err as { code?: unknown } | null)?.code === 'NODE_TOO_OLD';
}

/**
 * The self-check of this Node's SQLite could not finish (out of memory, say). Nothing is known to be wrong with the
 * Node or with the user's database, so the advice must not be to upgrade Node or to move the database aside.
 */
export class SqliteSelfCheckError extends Error {
  readonly code = 'SQLITE_SELF_CHECK_FAILED';
  readonly advice = 'Your database is not the problem. Run the command again; if it keeps failing, free some memory or restart, then run `memesh doctor`.';
  constructor(cause: unknown) {
    super(`MeMesh could not check this Node's SQLite (${cause instanceof Error ? cause.message : String(cause)}).`, { cause });
    this.name = 'SqliteSelfCheckError';
  }
}

export function isSqliteSelfCheckFailure(err: unknown): err is SqliteSelfCheckError {
  return (err as { code?: unknown } | null)?.code === 'SQLITE_SELF_CHECK_FAILED';
}

function atLeastMinimumNode(version: string): boolean {
  const want = MIN_NODE_VERSION.split('.').map(Number);
  const have = version.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < 3; i++) {
    const h = have[i];
    if (!Number.isFinite(h)) return false;
    if (h !== want[i]) return h > want[i];
  }
  return true;
}

/** Runs the FTS5 probe statement: true when it works, false only on SQLite's own "no such module", anything else is thrown as itself. */
export function fts5ProbeResult(createFtsTable: () => void): boolean {
  try {
    createFtsTable();
    return true;
  } catch (err) {
    if (/no such module/i.test(err instanceof Error ? err.message : String(err))) return false;
    throw err;
  }
}

let ftsProbe: boolean | undefined;
/** Does this Node's SQLite have FTS5? Asked once per process; a probe that fails for any other reason throws and is not cached. */
function hasFts5(): boolean {
  if (ftsProbe === undefined) {
    let probe: import('node:sqlite').DatabaseSync | undefined;
    try {
      probe = new DatabaseSync(':memory:');
      const throwaway = probe;
      ftsProbe = fts5ProbeResult(() => throwaway.exec('CREATE VIRTUAL TABLE memesh_fts5_probe USING fts5(a)'));
    } catch (err) {
      throw new SqliteSelfCheckError(err);
    } finally {
      // A throwaway in-memory database: a close that throws must not replace the
      // probe's own error, nor turn into a failed open of the real database.
      try { probe?.close(); } catch { /* nothing to save: the answer is already in ftsProbe */ }
    }
  }
  return ftsProbe;
}

/**
 * Why this Node cannot run MeMesh, or `null` when it can. The three causes are
 * different and so is their repair, and this is the only place that words them:
 * a Node that is too old needs upgrading; a new one with `node:sqlite` switched
 * off needs the switch removed; a new one built without FTS5 needs the
 * official build. Checked in that order, and the version first, so a Node 20
 * (which also has no `node:sqlite`) is told to upgrade, not about a flag.
 */
export function nodeProblem(
  version: string = process.versions.node,
  fts5Available: () => boolean = hasFts5,
  sqliteLoaded: boolean = loadedSqlite !== null,
): NodeProblem | null {
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

/** The sentence of {@link nodeProblem}, or `null` when this Node can run MeMesh. */
export function nodeSupportProblem(
  version?: string,
  fts5Available?: () => boolean,
  sqliteLoaded?: boolean,
): string | null {
  return nodeProblem(version, fts5Available, sqliteLoaded)?.message ?? null;
}

/** Throws {@link UnsupportedNodeError} when this Node cannot run MeMesh. */
export function assertNodeSupported(): void {
  const problem = nodeProblem();
  if (problem) throw new UnsupportedNodeError(problem);
}

/** A prepared statement. Named so call sites do not import from node:sqlite. */
export type SqliteStatement = import('node:sqlite').StatementSync;

/** What SQLite hands back in a column, and what it will accept in a binding. */
export type SqlOutputValue = import('node:sqlite').SQLOutputValue;
export type SqlInputValue = import('node:sqlite').SQLInputValue;

/**
 * How a database is opened.
 *
 * `readOnly` is spelled with a capital O, and that is not a detail. Passing
 * better-sqlite3's `readonly` spelling to node:sqlite is not an error — the
 * option is simply not recognised, and the database opens WRITABLE. Three
 * production read paths (the `view` CLI and two hooks) depend on this, so the
 * option is retyped here to make the wrong spelling a compile error rather than
 * a silent loss of protection, and `sqlite-driver.test.ts` proves a read-only
 * handle REJECTS a write rather than merely proving it opens.
 */
export interface OpenOptions {
  readOnly?: boolean;
}

/**
 * How long SQLite waits for a held write lock before giving up.
 *
 * node:sqlite's default is 0 — the first contended write fails instantly with
 * "database is locked". better-sqlite3's was 5000, and memesh was built on
 * that: seven hooks, the CLI, the MCP server and the HTTP server all open one
 * database file, `runOnceMigration` takes the write lock with `.immediate()`,
 * and `tests/migration-atomicity.test.ts` sets `busy_timeout = 1` with the
 * comment "the default 5s would only make the test slow". Carrying the driver
 * swap without carrying this number would have turned every overlap — a
 * post-commit hook landing while a session-summary writes — into a lost
 * capture.
 *
 * Set through PRAGMA rather than the constructor's `timeout` option, which is
 * Node >= 24 and would raise the floor for nothing.
 *
 * Thirty seconds leaves bounded maintenance and migrations enough time to
 * finish while concurrent hooks wait instead of losing a capture.
 */
export const BUSY_TIMEOUT_MS = 30_000;

/** What a `transaction()` wrapper can be called as. */
export interface TransactionFunction<A extends unknown[], R> {
  (...args: A): R;
  /**
   * Take the write lock at BEGIN instead of at the first write, so a
   * concurrent writer fails immediately rather than half way through.
   */
  immediate(...args: A): R;
}

export class MemeshDatabase extends DatabaseSync {
  /** Nesting depth, so an inner transaction becomes a SAVEPOINT. */
  #depth = 0;

  // Defaulted rather than forwarded: node:sqlite rejects an explicit
  // `undefined` for `options` with "The options argument must be an object",
  // so `new MemeshDatabase(p)` would throw if the parameter were passed
  // straight through.
  constructor(path: string, options: OpenOptions = {}) {
    // Every open in the CLI, MCP server, HTTP server and hooks ends here, so
    // this is the one place the Node floor is enforced.
    assertNodeSupported();
    super(path, options);
    this.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  }

  /**
   * Run a PRAGMA. node:sqlite has no helper, and every memesh call site
   * (`journal_mode = WAL`, `foreign_keys = ON`) sets rather than reads, so this
   * discards the result. Reads go through `prepare('PRAGMA x').get()`, which
   * the migration code already uses.
   */
  pragma(statement: string): void {
    this.exec(`PRAGMA ${statement}`);
  }

  /**
   * better-sqlite3's `db.transaction()`, reproduced.
   *
   * Two behaviours are load-bearing and `tests/migration-atomicity.test.ts`
   * judges them:
   *
   *   - A throw inside the callback rolls back and re-throws. Returning
   *     normally commits.
   *   - A nested call becomes a SAVEPOINT, not a second BEGIN. SQLite rejects
   *     `BEGIN` inside a transaction outright ("cannot start a transaction
   *     within a transaction"), so a flat implementation would turn a nested
   *     write into a runtime error in a write path — the kind of failure that
   *     only appears under the exact call ordering that nests.
   *
   * The returned function is callable directly (deferred) or as
   * `.immediate()`. better-sqlite3 also offers `.deferred`/`.exclusive`;
   * nothing here uses them, so they are not implemented.
   */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): TransactionFunction<A, R> {
    const run = (mode: '' | ' IMMEDIATE', ...args: A): R => {
      const nested = this.#depth > 0;
      const savepoint = `memesh_sp_${this.#depth}`;
      this.exec(nested ? `SAVEPOINT ${savepoint}` : `BEGIN${mode}`);
      this.#depth++;
      try {
        const result = fn(...args);
        this.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
        return result;
      } catch (err) {
        // Unwinding must not mask the original error: if the connection is
        // already gone, or SQLite rolled the transaction back itself, the
        // rollback throws and the caller still needs to see `err`.
        try {
          this.exec(nested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK');
          if (nested) this.exec(`RELEASE ${savepoint}`);
        } catch { /* already unwound */ }
        throw err;
      } finally {
        this.#depth--;
      }
    };

    const callable = ((...args: A) => run('', ...args)) as TransactionFunction<A, R>;
    callable.immediate = (...args: A) => run(' IMMEDIATE', ...args);
    return callable;
  }
}
