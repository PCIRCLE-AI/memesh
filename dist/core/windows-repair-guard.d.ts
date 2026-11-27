interface WindowsRepairGuard {
    replace(from: string, to: string): Promise<void>;
    release(): Promise<void>;
}
export declare class WindowsReplacementUncertainError extends Error {
}
export declare function acquireWindowsRepairGuard(paths: string[], probe?: {
    from: string;
    to: string;
}): Promise<WindowsRepairGuard>;
export {};
//# sourceMappingURL=windows-repair-guard.d.ts.map