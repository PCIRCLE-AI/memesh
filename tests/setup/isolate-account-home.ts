/**
 * Tests must never read the maintainer's real files. `os.userInfo().homedir`
 * comes from the passwd database, not from HOME, so the throwaway HOME that
 * `scripts/run-tests-isolated.mjs` sets does not reach it: code that asks "who
 * is the account, where is its home" (the auto-update policy reads the
 * account's own ~/.memesh/config.json) would read the real one.
 *
 * Here that answer follows HOME, in every test process. A child process a test
 * spawns still asks the system, so such a test must pass its settings
 * explicitly (MEMESH_AUTO_UPDATE, MEMESH_DIR) instead of relying on the account.
 */
import os from 'os';
import { syncBuiltinESMExports } from 'module';

const realUserInfo = os.userInfo;

os.userInfo = ((options?: { encoding?: BufferEncoding }) => {
  const info = realUserInfo.call(os, options as never);
  const home = process.env.HOME;
  return home ? { ...info, homedir: home } : info;
}) as typeof os.userInfo;
// A named import (`import { userInfo } from 'os'`) is its own binding: it follows the replacement only once the exports are synced.
syncBuiltinESMExports();
