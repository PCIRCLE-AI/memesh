export function currentLibc() {
    if (process.platform !== 'linux')
        return null;
    process.report.excludeNetwork = true;
    const header = process.report.getReport();
    return header.header?.glibcVersionRuntime ? 'glibc' : 'musl';
}
export function platformPackages(lockText, platform, arch, libc) {
    const { packages } = JSON.parse(lockText);
    return Object.entries(packages)
        .filter(([, entry]) => entry.os?.includes(platform)
        && entry.cpu?.includes(arch)
        && (entry.libc === undefined || libc === null || entry.libc.includes(libc)))
        .map(([key]) => key.replace(/^node_modules\//, ''));
}
//# sourceMappingURL=runtime-platform.js.map