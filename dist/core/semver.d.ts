export interface ParsedSemVer {
    core: [bigint, bigint, bigint];
    prerelease: string[] | null;
}
export declare function parseSemVer(version: string): ParsedSemVer | null;
export declare function compareSemVerPrecedence(a: ParsedSemVer, b: ParsedSemVer): number;
//# sourceMappingURL=semver.d.ts.map