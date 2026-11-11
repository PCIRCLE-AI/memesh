import fs from 'fs';
import { getConfigPath } from './config.js';
import { openDatabase, closeDatabase, isDatabaseOpen } from '../db.js';
import { getUpdateCheck } from './version-check.js';
import { getCurrentInstallChannel, getInstallChannelSupport } from './install-channel.js';
import { type CaptureLivenessStatus, type HookLivenessSummary, type TypeTrend } from './capture-liveness.js';
export type DoctorCheckStatus = 'pass' | 'warn' | 'fail';
export type DoctorOverallStatus = 'PASS' | 'PASS_WITH_CONCERNS' | 'FAIL';
export interface DoctorCheck {
    id: string;
    label: string;
    status: DoctorCheckStatus;
    summary: string;
    fix?: string;
    fixId?: 'install-hooks' | 'fts-rebuild' | 'config-retired-settings' | 'plugin-cache-refresh';
    informational?: boolean;
    code?: string;
    params?: Record<string, string | number>;
}
export interface DoctorResult {
    status: DoctorOverallStatus;
    checks: DoctorCheck[];
    capture?: CaptureLivenessReport;
}
export interface CaptureLivenessReport {
    status: CaptureLivenessStatus;
    hooks: HookLivenessSummary[];
    types: TypeTrend[];
    neverRan: string[];
}
interface DoctorOptions {
    packageRoot: string;
    packageVersion: string;
    probeHttp?: boolean;
    httpBaseUrl?: string;
    platform?: NodeJS.Platform;
    openDatabaseImpl?: typeof openDatabase;
    closeDatabaseImpl?: typeof closeDatabase;
    isDatabaseOpenImpl?: typeof isDatabaseOpen;
    getConfigPathImpl?: typeof getConfigPath;
    getUpdateCheckImpl?: typeof getUpdateCheck;
    getCurrentInstallChannelImpl?: typeof getCurrentInstallChannel;
    installedPluginsPathImpl?: string;
    marketplaceHeadShaImpl?: (host: import('./install-channel.js').PluginHost) => string | null;
    pluginCacheDiscoveryImpl?: () => PluginCacheDiscovery[];
    getInstallChannelSupportImpl?: typeof getInstallChannelSupport;
    existsSyncImpl?: typeof fs.existsSync;
    readFileSyncImpl?: typeof fs.readFileSync;
    statSyncImpl?: typeof fs.statSync;
    envImpl?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    agentMessageStoragePolicy?: {
        storage_quota_bytes?: number;
    };
    nativeBindingProbeImpl?: (packageRoot: string) => NativeBindingProbeResult;
    resolveShellMemeshImpl?: () => string | null;
    probeMessageCapability?: boolean;
    messageCapabilityProbeImpl?: (packageRoot: string) => {
        ok: true;
    } | {
        ok: false;
        message: string;
    };
    probeMessageRouterStatus?: boolean;
    messageRouterStatusProbeImpl?: () => Promise<MessageRouterStatusProbe>;
}
interface PluginCacheDiscovery {
    host: import('./install-channel.js').PluginHost;
    packageRoot: string;
    installedPluginsPath?: string;
    unverifiableReason?: string;
}
type MessageRouterStatusProbe = {
    socket_path: string;
    socket: 'reachable' | 'missing' | 'insecure' | 'unreachable' | 'path-too-long';
    active_registrations?: number;
    detail?: string;
};
export declare class NoDatabaseYetError extends Error {
    readonly databasePath: string;
    constructor(databasePath: string);
}
export interface HostsHere {
    claude: boolean;
    codex: boolean;
    codexCommand: boolean;
    gemini: boolean;
}
export type HostFixState = 'claude' | 'no-host' | 'codex' | 'codex-no-command' | 'gemini';
export declare function hostFixState(hosts: HostsHere): HostFixState;
export declare function withHostFix(check: DoctorCheck, state: HostFixState): DoctorCheck;
export declare function hoursSince(sqliteTimestamp: string): number | null;
type NativeBindingProbeResult = {
    ok: true;
} | {
    ok: false;
    message: string;
    fix?: string;
};
export declare function satisfiesMinimumNodeRange(version: string, range: string): boolean | null;
export declare function inspectNodeRuntime(packageRoot: string, existsSyncImpl: typeof fs.existsSync, readFileSyncImpl: typeof fs.readFileSync, nodeVersion?: string, moduleAbi?: string, hasNodeSqliteImpl?: () => boolean): DoctorCheck;
export declare function hasBuiltInSqlite(): boolean;
export declare function runDoctor(options: DoctorOptions): Promise<DoctorResult>;
export declare function formatDoctorReport(result: DoctorResult, packageVersion: string): string[];
export {};
//# sourceMappingURL=doctor.d.ts.map