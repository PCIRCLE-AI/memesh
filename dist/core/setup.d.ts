export type HostId = 'claude-code' | 'codex' | 'gemini';
export interface RunResult {
    status: number | null;
    stderr: string;
}
export interface SetupSeams {
    home: () => string;
    isOnPath: (bin: string) => boolean;
    run: (cmd: string, args: string[]) => RunResult;
    installedPluginsPath?: string;
    claudeConfigDir?: () => string | undefined;
}
export interface WireAction {
    kind: 'run' | 'install-hooks';
    label: string;
    cmd?: string;
    args?: string[];
}
export interface HostStatus {
    host: HostId;
    title: string;
    present: boolean;
    presenceDetail: string;
    wired: boolean | null;
    unprobed?: boolean;
    wiredDetail: string;
    actions: WireAction[];
}
export declare function inspectHosts(seams: SetupSeams): HostStatus[];
export declare function unverifiedHosts(statuses: HostStatus[]): HostStatus[];
export declare function wiredClosing(statuses: HostStatus[]): string;
export declare function allWired(statuses: HostStatus[]): boolean;
export declare function noHostMessage(statuses: HostStatus[]): string | null;
//# sourceMappingURL=setup.d.ts.map