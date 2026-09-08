export interface RetiredConfigCleanupResult {
    changed: boolean;
    removed: string[];
    backupPath: string | null;
    configPath: string;
}
export declare function removeRetiredConfigKeys(): RetiredConfigCleanupResult;
export interface PluginRefreshResult {
    host: 'claude-code' | 'codex';
    command: string;
    exitCode: number;
    output: string;
    restartRequired: true;
}
export declare function pluginHostFromDoctorCheck(check: {
    params?: Record<string, string | number>;
}): 'claude-code' | 'codex';
export declare function refreshPluginCache(packageRoot: string, host: 'claude-code' | 'codex'): PluginRefreshResult;
//# sourceMappingURL=doctor-fixes.d.ts.map