import fs from 'node:fs';

/**
 * Remove the throwaway HOME a test run used.
 *
 * A hook under test starts a detached `memesh status` that can still be
 * writing into HOME when vitest has finished (tests/helpers/temp-dir.ts
 * documents the same race), so the removal can lose with ENOTEMPTY, EBUSY or
 * EPERM. Losing it leaks a temporary folder; it must not turn a green run
 * into exit 1. The leak is said out loud, with the path, so a folder left
 * behind can be found and removed. Any other error still throws.
 *
 * @param {string} dir
 * @param {{ rm?: typeof fs.rmSync, warn?: (line: string) => void }} [seams] test seams
 * @returns {boolean} true when the folder was removed
 */
export function removeTempHome(dir, { rm = fs.rmSync, warn = (line) => console.error(line) } = {}) {
  try {
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return true;
  } catch (err) {
    if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(err?.code)) throw err;
    warn(`[run-tests-isolated] left the temporary HOME ${dir} in place (${err.code}: a background process may still have been writing, or something under it could not be removed: ${err.message}). Check it, then delete it.`);
    return false;
  }
}
