import fs from 'fs';
import { expect } from 'vitest';

export function expectPrivateDir(dirPath: string): void {
  const stats = fs.statSync(dirPath);
  expect(stats.isDirectory()).toBe(true);

  if (process.platform === 'win32') {
    // Windows ACLs do not round-trip through POSIX mode bits in Node's stat output.
    // The production code still attempts hardening, but exact 0o700 is not portable here.
    expect(stats.mode & 0o777).toBeGreaterThan(0);
    return;
  }

  expect(stats.mode & 0o777).toBe(0o700);
}

export function expectPrivateFile(filePath: string): void {
  const stats = fs.statSync(filePath);
  expect(stats.isFile()).toBe(true);

  if (process.platform === 'win32') {
    // Windows ACLs do not round-trip through POSIX mode bits in Node's stat output.
    // The production code still attempts hardening, but exact 0o600 is not portable here.
    expect(stats.mode & 0o777).toBeGreaterThan(0);
    return;
  }

  expect(stats.mode & 0o777).toBe(0o600);
}

/**
 * Whether this environment can actually make a path unreadable.
 *
 * A test that needs a real EACCES has to ask, because two common environments
 * cannot produce one however the mode bits are set: root ignores them, and
 * Windows does not model POSIX read or traversal permission at all — a
 * `chmod` there leaves the directory readable, so the code under test takes
 * its success path and the assertion fails on a platform difference rather
 * than on the behaviour it was written to pin.
 *
 * Measured: `tests/hooks/stop-notes.test.ts` guarded only the root half, and
 * both windows-latest legs of the #333 matrix failed with `expected 'wrote'
 * to be 'error'` — the hook had read the directory the test believed it had
 * locked. Every other leg passed.
 *
 * Skip on this rather than weaken the assertion: the branch stays genuinely
 * covered where an EACCES is real, instead of everywhere and vacuously.
 */
export const canDenyReads = process.platform !== 'win32' && (process.getuid?.() ?? 0) !== 0;
