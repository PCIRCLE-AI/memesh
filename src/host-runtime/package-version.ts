import { readFileSync } from 'node:fs';

/**
 * The MeMesh version installed beside this file. Both the router and the
 * hosts that connect to it live in `dist/host-runtime/`, unbundled, so the
 * package root is two levels up for each of them (#518).
 */
export function memeshPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error('The installed MeMesh package.json has no version.');
  }
  return pkg.version;
}
