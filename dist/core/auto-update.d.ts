import { spawn } from 'child_process';
import { type InstallChannel } from './install-channel.js';
import { type InstallResult } from './hermes-provider.js';
import { type AutoUpdatePolicy } from './updater.js';
export declare const DEFAULT_AUTO_UPDATE_POLICY: AutoUpdatePolicy;
export declare const PACKAGE_NAME = "@pcircle/memesh";
export declare const EXPECTED_SOURCE: {
    readonly repository: "https://github.com/PCIRCLE-AI/memesh";
    readonly workflowPath: ".github/workflows/publish-npm.yml";
};
export declare const STATE_FILE = "auto-update-state.json";
export declare const LOG_FILE = "auto-update.log";
export declare const LIVE_HOSTS_DIR = "live-hosts";
export declare const WAIT_FILE = "auto-update-wait.json";
export declare const ATTEMPT_FILE = "auto-update-attempt";
export declare const DISPATCH_CLAIM = "auto-update-dispatch.claim";
export declare const INSTALLING_FILE = "auto-update-installing.json";
export declare const CODEX_RESTORE_FILE = "auto-update-codex-restore.json";
export declare const BACKUPS_KEPT = 3;
export declare const ATTEMPT_INTERVAL_MS: number;
export declare const LIVE_WAIT_POLL_MS: number;
export declare const LIVE_WAIT_MAX_MS: number;
export declare const CODEX_MARKETPLACE = "pcircle-memesh";
export declare const CODEX_PLUGIN = "memesh@pcircle-memesh";
export declare const CODEX_MARKETPLACE_SOURCE = "PCIRCLE-AI/memesh";
export declare function ownerOnly(target: string): void;
export declare function ensureOwnerDir(dir: string): void;
export declare const AUTO_UPDATE_REASONS: {
    readonly policyOff: "policy is off";
    readonly policyOffUnreadableConfig: "policy is off: a config file could not be read, so an explicit off cannot be ruled out";
    readonly policyOffInvalidValue: "policy is off: a setting held a value that is not off, patch, minor or major";
    readonly policyOffUpdateCheck: "policy is off: update checks were turned off (updateCheck=false)";
    readonly policyOffCi: "no update: this run is inside CI or a container and the setting was not given explicitly";
    readonly policyOffNoAccountHome: "no update: the account's home directory cannot be determined (no passwd entry) and the setting was not given explicitly";
    readonly policyOffForeignHome: "no update: this run uses a data directory that is not the account's own ~/.memesh and the setting was not given explicitly";
    readonly channelUnsupported: "no update: this install channel cannot update itself (source checkout, project-local or unknown)";
    readonly registryUnreachable: "no update: the npm registry did not answer";
    readonly upToDate: "already on the newest version for this channel";
    readonly bumpNotPermitted: "no update: the policy does not permit this kind of version bump";
    readonly sourceNotVerified: "not installed: the package source could not be verified";
    readonly tarballMismatch: "not installed: the downloaded package does not match the verified one";
    readonly dependencyPinFailed: "install ran but its dependencies could not be set to the versions the release pins; the previous version was put back";
    readonly installNotUndone: "an install ran, its dependencies could not be set to the versions the release pins, AND the previous version could not be put back: run `memesh update --reinstall` to finish it (until then MeMesh may not start)";
    readonly dependenciesNotFetched: "not installed: the release's pinned dependencies could not be fetched and checked (network, registry or a hash that did not match), so the installed version was not touched";
    readonly globalDirUnknown: "not installed: the directory npm keeps global packages in could not be found, so a failed install could not be undone";
    readonly rollbackUnavailable: "not installed: a copy of the installed version could not be made, so a failed install could not be undone";
    readonly commitNotOnMain: "not installed: the release was not built from a commit on the main branch of the official repository";
    readonly commitUnconfirmed: "not installed: it could not be confirmed that the release commit is on the main branch of the official repository (GitHub did not answer); a later run tries again";
    readonly dependenciesNotPinned: "not installed: the package does not pin its dependencies (no complete npm-shrinkwrap.json), so what would be installed could not be checked";
    readonly codexMarketplaceUnreadable: "not installed: the Codex config.toml could not be read, so it is not known whether the pcircle-memesh marketplace is the official one";
    readonly codexHomeUnknown: "not installed: the Codex directory this plugin lives in could not be worked out from where it is installed, so the Codex plugin was left alone";
    readonly codexMarketplaceMissing: "not installed: the Codex marketplace pcircle-memesh is not in config.toml and MeMesh did not remove it, so it was taken as removed on purpose and not added back; `memesh update --reinstall` adds it back (pinned to this release) and installs the plugin";
    readonly codexMarketplaceForeign: "not installed: the Codex marketplace named pcircle-memesh does not come from the official repository, so it was left alone";
    readonly codexInstallFailed: "Codex plugin install failed; the marketplace was put back to its unpinned state";
    readonly codexRestoreFailed: "Codex plugin install failed AND MeMesh could not put the marketplace it had removed back (the pcircle-memesh marketplace is now missing because of this update, not because you removed it): the next run puts it back if config.toml is still as this run left it, or run `codex plugin marketplace add PCIRCLE-AI/memesh` yourself";
    readonly codexRemoveFailed: "Codex plugin not updated: the marketplace could not be removed, so nothing was changed";
    readonly codexReadbackFailed: "Codex plugin install ran but did not install the target version";
    readonly claudeReadbackFailed: "Claude Code plugin install ran but the plugin registry does not record the target commit";
    readonly backupFailed: "not installed: the database backup failed";
    readonly waitingForHosts: "waiting: a session is still running; the update is applied after it ends";
    readonly installedAfterWait: "installed after waiting 3 days: sessions were still running, so they may use the new files before they restart";
    readonly hostsUnreadable: "running sessions cannot be listed (the live-hosts directory is unreadable or cannot be written to, so sessions could not register), so they are assumed to be running";
    readonly installFailed: "install failed";
    readonly tarballChanged: "not installed: the verified tarball changed on disk between the check and the install";
    readonly readbackFailed: "install ran but the installed version is not the target";
    readonly lockLost: "not installed: this runner no longer holds the update lock (another update took it over), so it stopped";
    readonly installed: "installed";
};
export type AutoUpdateOutcome = 'installed' | 'skipped' | 'failed' | 'waiting';
export interface AutoUpdateState {
    at: string;
    outcome: AutoUpdateOutcome;
    reason: string;
    from: string | null;
    to: string | null;
    channel: InstallChannel | null;
    backup: string | null;
    waitingSince: string | null;
    hermes: InstallResult[] | null;
    notice?: string | null;
    detail?: string | null;
}
export interface PolicyDecision {
    policy: AutoUpdatePolicy;
    source: 'env' | 'config' | 'account-config' | 'default' | 'none';
    reason: string | null;
    detail?: string;
}
export interface PolicyInput {
    env: NodeJS.ProcessEnv;
    activeDir: string;
    accountHome: string | null;
    extraConfigDirs?: string[];
}
export declare function isCi(env: NodeJS.ProcessEnv): boolean;
export declare function safeAccountHome(): string | null;
export declare function resolveUpdatePolicy(input: PolicyInput): PolicyDecision;
export declare function accountMemeshDir(): string | null;
export declare function propagateOff(activeConfigDir: string, accountDir: string | null): {
    path: string | null;
    error: string | null;
};
export declare function accountConfigHolding(activeConfigDir: string, accountDir: string | null): {
    path: string;
    kind: 'off' | 'unreadable';
    why: string | null;
} | null;
export declare function currentPolicy(env?: NodeJS.ProcessEnv): PolicyDecision;
export interface DistTags {
    latest?: string;
    next?: string;
}
export declare function chooseTarget(current: string, tags: DistTags): {
    stream: 'latest' | 'next';
    target: string | null;
};
export declare function bumpKind(from: string, to: string): 'patch' | 'minor' | 'major';
export declare function policyPermits(policy: AutoUpdatePolicy, bump: 'patch' | 'minor' | 'major'): boolean;
export type SourceVerdict = {
    ok: true;
    gitCommit: string;
} | {
    ok: false;
    reason: string;
};
export declare function signerIdentity(element: unknown): string | null;
export interface JudgeOptions {
    tarballSha512Hex: string;
    signerOf?: (bundle: unknown) => string | null;
}
export declare function judgeAuditSignatures(json: string, name: string, version: string, options: JudgeOptions): SourceVerdict;
export declare const COMPARE_SCRIPT = "fetch(process.argv[1],{headers:{accept:'application/vnd.github+json','user-agent':'memesh-auto-update'},signal:AbortSignal.timeout(20000)}).then(async(r)=>{process.stdout.write(r.status+'\\n'+await r.text())}).catch((e)=>{process.stderr.write(String(e));process.exit(1)})";
export declare function compareUrl(commit: string): string;
export declare function proxyConfigured(env: NodeJS.ProcessEnv): boolean;
export declare function nodeUsesEnvProxy(version?: string): boolean;
export declare function compareEnv(env: NodeJS.ProcessEnv, version?: string): NodeJS.ProcessEnv;
export type MainVerdict = {
    ok: true;
} | {
    ok: false;
    code: 'notOnMain' | 'unconfirmed';
    detail: string;
};
export declare function judgeCommitOnMain(result: {
    status: number | null;
    stdout: string;
    stderr: string;
}, commit: string, proxyIgnored?: boolean): MainVerdict;
export declare function judgeShrinkwrap(text: string, version: string): {
    ok: true;
} | {
    ok: false;
    detail: string;
};
export declare function sha512Integrity(file: string): string;
export declare function registerLiveHost(dir: string, pid?: number, logDir?: string): void;
export declare function liveHostPids(dir: string): number[] | null;
export declare function backupDatabase(dbPath: string, backupDir: string, tag: string, now?: Date): string | null;
export type StateRead = {
    kind: 'absent';
} | {
    kind: 'unreadable';
    detail: string;
} | {
    kind: 'ok';
    state: AutoUpdateState;
};
export declare function inspectAutoUpdateState(dir: string): StateRead;
export declare function readAutoUpdateState(dir: string): AutoUpdateState | null;
export interface InstallingMarker {
    at: string;
    from: string;
    to: string;
    pid: number;
    started: string | null;
}
export declare function readInstalling(dir: string): {
    marker: InstallingMarker;
    running: boolean;
} | null;
export declare function logAutoUpdateLine(dir: string, line: string): void;
type Exec = (cmd: string, args: string[], opts?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
}) => {
    status: number | null;
    stdout: string;
    stderr: string;
};
export interface AutoUpdateDeps {
    env: NodeJS.ProcessEnv;
    accountHome: string | null;
    dir: string;
    liveHostsDir?: string;
    configDir: string;
    signerOf?: (bundle: unknown) => string | null;
    beforeInstall?: (tarball: string) => void;
    heartbeat?: () => boolean | void;
    notice?: string | null;
    manual?: boolean;
    reinstall?: boolean;
    claudeRegistryPath?: string;
    dbPath: string;
    packageRoot: string;
    currentVersion: string;
    channel: InstallChannel;
    pluginHost: 'claude-code' | 'codex' | null;
    codexHome: string | null;
    exec: Exec;
    readTags: () => DistTags | null;
    tmpRoot: string;
    sleep: (ms: number) => Promise<void>;
    now: () => Date;
    readInstalledVersion: () => string | null;
}
export declare function readRegistryTags(exec?: Exec): DistTags | null;
export declare function sweepWorkDirs(root: string, nowMs?: number): string[];
export declare function stripMultilineStrings(toml: string): string;
export declare function codexMarketplaceState(codexHome: string): 'official' | 'foreign' | 'missing' | 'unreadable';
export declare function codexHomeFor(packageRoot: string): string | null;
export declare function unsafeTarEntries(verbose: string, names: string[]): string[];
export declare function refreshHermes(deps: AutoUpdateDeps, tarball: string, version: string, expectedIntegrity: string): InstallResult[] | null;
export declare function runAutoUpdate(deps: AutoUpdateDeps): Promise<{
    outcome: AutoUpdateOutcome;
    reason: string;
}>;
export declare function dispatchAutoUpdate(pluginRoot: string, nowMs?: number, options?: {
    canSelfUpdate?: (root: string) => {
        ok: boolean;
        label: string;
    };
    spawnImpl?: typeof spawn;
}): Promise<{
    state: 'dispatched' | 'throttled' | 'failed' | 'unsupported';
}>;
export declare function describeLockHolder(dir: string): {
    label: string;
    pid: number;
    startedAt: string;
    running: boolean;
} | null;
export declare function runManualUpdate(pluginRoot: string, dir?: string, options?: {
    reinstall?: boolean;
}): {
    code: number;
    lines: string[];
};
export declare function startReinstall(pluginRoot: string, dir?: string): {
    started: boolean;
    message: string;
};
export declare function productionDeps(packageRoot: string, currentVersion: string): AutoUpdateDeps;
export {};
//# sourceMappingURL=auto-update.d.ts.map