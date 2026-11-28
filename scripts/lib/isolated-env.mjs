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
// A file: URL, which is what `--import` takes (no path is derived from a URL's `pathname`: that breaks on Windows and on encoded characters).
const ACCOUNT_HOME_PRELOAD = new URL('./account-home-preload.mjs', import.meta.url).href;

/**
 * NODE_OPTIONS that makes every node process started under it answer `os.userInfo().homedir` with HOME (see
 * account-home-preload.mjs). Isolating HOME alone does not isolate the account: a child that asks the system for the
 * account's home would read the maintainer's real files.
 */
export function withAccountHomePreload(env) {
  const existing = env.NODE_OPTIONS ?? '';
  if (existing.includes(ACCOUNT_HOME_PRELOAD)) return env;
  return { ...env, NODE_OPTIONS: `${existing} --import=${ACCOUNT_HOME_PRELOAD}`.trim() };
}

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
  // The briefing level decides what a session is told and the default is what
  // the tests and smokes assume, so an ambient MEMESH_BRIEFING must not move it.
  delete isolatedEnv.MEMESH_BRIEFING;
  return withAccountHomePreload(isolatedEnv);
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
  // An allow-list, not "everything except what we remembered to delete": the
  // deletions this function used to carry grew one variable per incident (the
  // data paths, the session ids, the host config folders...) and still passed
  // the Claude Code messaging socket and token, the account and organization
  // ids, and every variable that moves where a program reads or writes.
  // Names are matched case-insensitively (Windows spells `Path`).
  const wanted = new Set(SUITE_ENV_ALLOWED.map((name) => name.toUpperCase()));
  const isolatedEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined && wanted.has(key.toUpperCase())) isolatedEnv[key] = value;
  }
  isolatedEnv.HOME = runtimeHome;
  isolatedEnv.USERPROFILE = runtimeHome;
  return withAccountHomePreload(envWithNpmCache(path.join(runtimeHome, 'npm-cache'), isolatedEnv));
}

/**
 * What a test run may inherit: process plumbing and display settings. Nothing
 * that names a folder or a socket, identifies an account or a session, or holds
 * a credential. A test that needs one of those sets it itself.
 */
const SUITE_ENV_ALLOWED = [
  'PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'ALLUSERSPROFILE',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
  'TMPDIR', 'TEMP', 'TMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'CI',
  'SHELL', 'USER', 'LOGNAME', 'USERNAME',
];

import path from 'node:path';
import { envWithNpmCache } from './npm-bin.mjs';
/**
 * Keep only process-launch plumbing needed by local release children.  The
 * caller supplies all product and npm paths explicitly; credentials, proxies,
 * agents, user config and model/provider settings do not cross this boundary.
 */
export function buildCredentialFreeBaseEnv(baseEnv) {
  const allowed = new Set([
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC',
    'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  ]);
  return Object.fromEntries(Object.entries(baseEnv).filter(([key]) => allowed.has(key)));
}
