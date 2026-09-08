export interface ParsedSemVer {
  core: [bigint, bigint, bigint];
  prerelease: string[] | null;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NUMERIC_IDENTIFIER = /^\d+$/;

export function parseSemVer(version: string): ParsedSemVer | null {
  const match = SEMVER.exec(version);
  if (!match) return null;
  const prerelease = match[4]?.split('.') ?? null;
  if (prerelease?.some((identifier) => (
    NUMERIC_IDENTIFIER.test(identifier) && identifier.length > 1 && identifier.startsWith('0')
  ))) return null;
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease,
  };
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = NUMERIC_IDENTIFIER.test(a);
  const bNumeric = NUMERIC_IDENTIFIER.test(b);
  if (aNumeric && bNumeric) return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Compare SemVer precedence only: build metadata has no effect. */
export function compareSemVerPrecedence(a: ParsedSemVer, b: ParsedSemVer): number {
  for (let index = 0; index < a.core.length; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (a.prerelease === null || b.prerelease === null) {
    if (a.prerelease !== b.prerelease) return a.prerelease === null ? 1 : -1;
    return 0;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const aIdentifier = a.prerelease[index];
    const bIdentifier = b.prerelease[index];
    if (aIdentifier === undefined || bIdentifier === undefined) {
      if (aIdentifier !== bIdentifier) return aIdentifier === undefined ? -1 : 1;
      break;
    }
    const compared = compareIdentifiers(aIdentifier, bIdentifier);
    if (compared !== 0) return compared;
  }
  return 0;
}
