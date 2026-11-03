export declare const UP_TO_DATE_REFRESH_MS: number;
export declare const UPGRADE_AVAILABLE_REFRESH_MS: number;
export declare const ANSWER_VALID_MS: number;
export interface UpdateCheckCacheLike {
    currentVersion?: string | null;
    latestVersion?: string | null;
    lastSuccessfulCheckAt?: string | null;
    lastAttemptAt?: string | null;
    checkSucceeded?: boolean;
    lastError?: string | null;
}
export type UpdateNotice = {
    kind: 'DISABLED';
    currentVersion: string;
} | {
    kind: 'JUST_UPGRADED';
    currentVersion: string;
    from: string;
    to: string;
} | {
    kind: 'CHECK_FAILED';
    currentVersion: string;
    reason: string;
    attempted: boolean;
} | {
    kind: 'UPGRADE_AVAILABLE';
    currentVersion: string;
    latestVersion: string;
} | {
    kind: 'UP_TO_DATE';
    currentVersion: string;
    latestVersion: string;
};
export interface JustUpgradedMarker {
    from: string;
    to: string;
    at: string;
}
export declare function staleRunningProcessNotice(runningVersion: string, packageJsonPath: string | URL): string | null;
export declare function isStrictlyOlder(a: string, b: string): boolean;
export declare function readJustUpgradedMarker(dir: string): JustUpgradedMarker | null;
export declare function writeJustUpgradedMarker(dir: string, from: string, to: string, now?: Date): void;
export declare function clearJustUpgradedMarker(dir: string): void;
export declare function claimJustUpgradedMarker(dir: string): JustUpgradedMarker | null;
export declare function shouldRefreshUpdateCache(currentVersion: string, cache: UpdateCheckCacheLike | null | undefined, now?: Date): boolean;
export interface ResolveUpdateNoticeInput {
    dir: string;
    currentVersion: string;
    cache: UpdateCheckCacheLike | null | undefined;
    now?: Date;
    updateCheckEnabled?: boolean;
}
export declare function resolveUpdateNotice(input: ResolveUpdateNoticeInput): UpdateNotice;
//# sourceMappingURL=update-notice.d.ts.map