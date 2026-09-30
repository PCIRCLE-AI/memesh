import { readFileSync } from 'node:fs';
export function memeshPackageVersion() {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
        throw new Error('The installed MeMesh package.json has no version.');
    }
    return pkg.version;
}
//# sourceMappingURL=package-version.js.map