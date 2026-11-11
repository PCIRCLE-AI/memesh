import { execFileSync } from 'child_process';

type ExecFileSyncLike = typeof execFileSync;

interface ReadbackOptions {
  execFileSyncImpl?: ExecFileSyncLike;
  readbackTimeoutMs?: number;
}

const DEFAULT_READBACK_TIMEOUT_MS = 30 * 1000;

interface InstalledPackageTree {
  dependencies?: Record<string, { version?: string }>;
}

/**
 * Auto-update policy: the largest bump the automatic updater may apply
 * (see core/auto-update.ts, which owns the decision). Default is `'major'`
 * for the account's own data directory; an explicit `'off'` always wins.
 * Registry metadata never overrides it.
 *
 *   off    — never auto-update (manual `memesh update` only)
 *   patch  — auto-apply X.Y.Z -> X.Y.Z+N
 *   minor  — auto-apply patch + X.Y.Z -> X.Y+1.0
 *   major  — auto-apply any bump (patch + minor + major)
 */
export type AutoUpdatePolicy = 'off' | 'patch' | 'minor' | 'major';

interface SemverParts {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(version: string): SemverParts | null {
  // Strict-enough x.y.z[-prerelease][+build] parser. Only the major /
  // minor / patch numbers participate in the auto-update decision; the
  // prerelease/build tail is preserved by npm itself when installing.
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].+)?$/.exec(version.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

/**
 * Compute the largest bump kind between `from` and `to`. Returns
 * `null` when either string isn't valid semver, or when `to` is not
 * strictly newer than `from`. The string ordering is enough — we
 * never auto-downgrade, even if the registry briefly serves an older
 * "latest".
 */
export function classifyBump(from: string, to: string): 'patch' | 'minor' | 'major' | null {
  const a = parseSemver(from);
  const b = parseSemver(to);
  if (!a || !b) return null;
  if (b.major > a.major) return 'major';
  if (b.major < a.major) return null;
  if (b.minor > a.minor) return 'minor';
  if (b.minor < a.minor) return null;
  if (b.patch > a.patch) return 'patch';
  return null;
}

function parseInstalledGlobalVersion(raw: string): string | null {
  const parsed = JSON.parse(raw) as InstalledPackageTree;
  return parsed.dependencies?.['@pcircle/memesh']?.version ?? null;
}

export function getInstalledGlobalVersion(
  options: ReadbackOptions = {},
): string | null {
  const {
    execFileSyncImpl = execFileSync,
    readbackTimeoutMs = DEFAULT_READBACK_TIMEOUT_MS,
  } = options;

  try {
    const raw = execFileSyncImpl(
      'npm',
      ['ls', '-g', '@pcircle/memesh', '--json', '--depth=0'],
      { encoding: 'utf8', timeout: readbackTimeoutMs },
    );
    return parseInstalledGlobalVersion(raw);
  } catch {
    return null;
  }
}
