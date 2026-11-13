export declare function npmInvocation(args: string[], platform?: NodeJS.Platform, execPath?: string, exists?: (file: string) => boolean): {
    command: string;
    args: string[];
} | null;
export declare class NpmStartError extends Error {
}
export declare function requireNpmInvocation(args: string[]): {
    command: string;
    args: string[];
};
//# sourceMappingURL=npm-launch.d.ts.map