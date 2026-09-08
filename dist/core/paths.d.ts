export declare const AGENT_ROUTER_SOCKET_FILENAME = "agent-router-v2.sock";
export declare function homeDir(): string;
export declare function memeshDir(): string;
export declare function getDbPath(): string;
export declare function getMemeshDirFromDbPath(): string;
export declare function getAgentRouterSocketPath(): string;
export declare function normalizeAgentRouterSocketPath(socketPath: string): string;
export declare function getProjectName(cwdInput?: string | null): string;
export declare function canonicalRemoteLocator(remote: string): string | null;
export declare function _clearProjectNameCache(): void;
export declare const SECRET_PATTERN_SOURCES: readonly string[];
export declare function redactSecrets(input: string): string;
export declare function redactUserPaths(text: string): string;
//# sourceMappingURL=paths.d.ts.map