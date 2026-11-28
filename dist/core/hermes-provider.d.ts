export declare const MARKER_FILE = ".memesh-install.json";
export declare const REGISTRY_FILE = "hermes-installs.json";
export declare const HERMES_REASONS: {
    readonly installed: "installed";
    readonly refreshed: "refreshed to the verified version";
    readonly unchanged: "already the verified version";
    readonly notOurs: "left alone: this directory was not installed by MeMesh (it has no install marker)";
    readonly modified: "left alone: files in this copy were changed after MeMesh installed it";
    readonly markerUnreadable: "left alone: the install marker could not be read";
    readonly unsafeSource: "not installed: the provider source holds something other than plain files";
    readonly failed: "failed";
    readonly linked: "left alone: it is a symbolic link, somebody pointed it somewhere on purpose, and MeMesh writes neither through it nor over it";
    readonly unreadable: "left alone: something in this directory cannot be read, so it cannot be told whether it is MeMesh's copy or whether it was edited";
    readonly gone: "a copy MeMesh installed here is no longer there; run `memesh hermes install` (add --path for a copy outside the default place) to put it back";
    readonly restored: "the copy had been lost to an update that was interrupted; it was put back first";
    readonly busy: "left alone: another refresh of this copy is running (the next run tries again)";
    readonly linkedHint: "MeMesh never changes a symbolic link, with or without --force: point --path at a real directory, or remove the link yourself";
};
export interface InstallMarker {
    source: 'memesh';
    version: string;
    installedAt: string;
    files: Record<string, string>;
}
export type InstallState = {
    state: 'absent';
} | {
    state: 'foreign';
} | {
    state: 'marker-unreadable';
} | {
    state: 'linked';
    to: string;
} | {
    state: 'unreadable';
    why: string;
} | {
    state: 'managed';
    marker: InstallMarker;
    modified: boolean;
};
export interface InstallResult {
    path: string;
    outcome: 'installed' | 'refreshed' | 'unchanged' | 'skipped' | 'failed';
    reason: string;
    backup: string | null;
}
export declare function hermesHome(env: NodeJS.ProcessEnv, accountHome?: string | null): string;
export declare function defaultInstallTargetOrNull(env: NodeJS.ProcessEnv, accountHome?: string | null): string | null;
export declare function defaultInstallTarget(env: NodeJS.ProcessEnv, accountHome?: string | null): string;
export declare function inspectInstall(target: string): InstallState;
interface WriteInput {
    sourceDir: string;
    target: string;
    version: string;
    backupRoot: string;
    now: Date;
    log?: (line: string) => void;
}
export interface InstallProviderInput extends WriteInput {
    force: boolean;
}
export declare function installProvider(input: InstallProviderInput): InstallResult;
export declare function registryProblem(memeshDir: string): string | null;
export declare function registryProblemResult(memeshDir: string): InstallResult | null;
export declare function registerInstall(memeshDir: string, target: string): void;
export declare function candidateInstalls(memeshDir: string, env: NodeJS.ProcessEnv, accountHome?: string | null): string[];
export interface RefreshInput {
    log?: (line: string) => void;
    sourceDir: string;
    version: string;
    memeshDir: string;
    env: NodeJS.ProcessEnv;
    accountHome?: string | null;
    now: Date;
}
export declare function refreshTargets(memeshDir: string, env: NodeJS.ProcessEnv, accountHome?: string | null): string[];
export declare function refreshInstalls(input: RefreshInput): InstallResult[];
export declare function staleInstalls(memeshDir: string, env: NodeJS.ProcessEnv, version: string, accountHome?: string | null): string[];
export {};
//# sourceMappingURL=hermes-provider.d.ts.map