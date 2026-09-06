/**
 * Build the environment a child process spawned by a release/packaging
 * script should run under: a test-owned HOME/USERPROFILE/MEMESH_DIR/
 * MEMESH_DB_PATH, with common credential variables stripped from what would
 * otherwise be a full `...baseEnv` spread.
 *
 * Originally written only for `scripts/dashboard-e2e-smoke.mjs` (GitHub
 * issue #271: the packaged Dashboard E2E gave the child runtime an isolated
 * MEMESH_DB_PATH but otherwise spread the maintainer's real process.env).
 * Moved here when `scripts/smoke-packed-
 * artifact.mjs` needed the identical isolation for the same reason: its
 * `nativeEnv` set MEMESH_DIR but left MEMESH_DB_PATH to leak through from
 * `...process.env`, so an ambient MEMESH_DB_PATH sent the installed
 * `memesh-router`'s data directory (`getMemeshDirFromDbPath()` follows
 * MEMESH_DB_PATH, not MEMESH_DIR) to the ambient location while the token
 * file path — built from the isolated MEMESH_DIR — still pointed at a
 * directory nothing had created, producing an ENOENT the smoke could not
 * explain from its own source. Two independent scripts hand-rolling the same
 * isolation is exactly how the second copy drifted; one owner fixes both.
 *
 * Pure and side-effect-free on purpose — `tests/release-scripts-safety.test.ts`
 * imports it directly and calls it with a deliberately polluted `baseEnv` to
 * pin this isolation as a regression test, without spawning `npm pack`,
 * installing a tarball, or launching a browser.
 *
 * Secret stripping is defensive test isolation; the product does not read or
 * manage these credentials.
 */
export function buildIsolatedRuntimeEnv(baseEnv, { runtimeHome, memeshDir, dbPath }) {
  const isolatedEnv = {
    ...baseEnv,
    HOME: runtimeHome,
    USERPROFILE: runtimeHome,
    MEMESH_DIR: memeshDir,
    MEMESH_DB_PATH: dbPath,
  };
  delete isolatedEnv.ANTHROPIC_API_KEY;
  delete isolatedEnv.OPENAI_API_KEY;
  delete isolatedEnv.OLLAMA_HOST;
  return isolatedEnv;
}

/**
 * The other half of the same question: an environment for a child that must
 * resolve its own `~/.memesh` FROM the throwaway HOME, rather than be pointed
 * at one path.
 *
 * `scripts/run-tests-isolated.mjs` explains why the suite must not be handed a
 * MEMESH_DB_PATH — several hook tests exercise the "no database yet" branches,
 * and pointing the variable at an existing file makes them unreachable. So the
 * paths are DELETED here, not set. Everything else is identical to
 * `buildIsolatedRuntimeEnv`, and that is the point: `run-tests-isolated.mjs`,
 * `audit/mutation-sample.mjs` and `audit/measure-injection-tokens.mjs` each
 * hand-rolled this, and two of the three had only pinned HOME — which is not
 * isolation, because `src/core/paths.ts` resolves MEMESH_DIR and
 * MEMESH_DB_PATH BEFORE falling back to HOME. An ambient MEMESH_DB_PATH in the
 * maintainer's shell (a normal state while debugging against a copy) therefore
 * sent a mutation run, or an injection measurement, at the real graph — while
 * each script's own comments promised isolation.
 *
 * It also strips the same common credential variables as the packaged runtime
 * so test children cannot inherit owner-controlled secrets by accident.
 */
export function buildIsolatedSuiteEnv(baseEnv, { runtimeHome }) {
  const isolatedEnv = {
    ...baseEnv,
    HOME: runtimeHome,
    USERPROFILE: runtimeHome,
  };
  delete isolatedEnv.MEMESH_DIR;
  delete isolatedEnv.MEMESH_DB_PATH;
  delete isolatedEnv.ANTHROPIC_API_KEY;
  delete isolatedEnv.OPENAI_API_KEY;
  delete isolatedEnv.OLLAMA_HOST;
  return isolatedEnv;
}
