// Which native package the pinned lock names for a computer. Pure data lookup: it
// never loads anything, so the CLI and the bridge can both use it.

interface LockEntry {
  os?: string[];
  cpu?: string[];
  libc?: string[];
}

export function currentLibc(): string | null {
  if (process.platform !== 'linux') return null;
  // Without this the report does a reverse DNS lookup of every open socket.
  (process.report as { excludeNetwork?: boolean }).excludeNetwork = true;
  const header = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
  return header.header?.glibcVersionRuntime ? 'glibc' : 'musl';
}

/** The lock's package names for this computer. Empty means unsupported. */
export function platformPackages(lockText: string, platform: string, arch: string, libc: string | null): string[] {
  const { packages } = JSON.parse(lockText) as { packages: Record<string, LockEntry> };
  return Object.entries(packages)
    .filter(([, entry]) => entry.os?.includes(platform)
      && entry.cpu?.includes(arch)
      && (entry.libc === undefined || libc === null || entry.libc.includes(libc)))
    .map(([key]) => key.replace(/^node_modules\//, ''));
}

/** The one to load. Two 32-bit ARM packages name no libc in the lock, so the name decides between them. */
export function platformPackage(lockText: string, platform: string, arch: string, libc: string | null): string | null {
  const names = platformPackages(lockText, platform, arch, libc);
  return names.find((name) => name.includes('musl') === (libc === 'musl')) ?? names[0] ?? null;
}
