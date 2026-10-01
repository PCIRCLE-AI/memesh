export declare const AGENT_ROUTER_SOCKET_FILENAME = "agent-router-v2.sock";
export declare function homeDir(): string;
export declare function memeshDir(): string;
export declare function getDbPath(): string;
export declare function getMemeshDirFromDbPath(): string;
export declare function getAgentRouterSocketPath(): string;
export declare function normalizeAgentRouterSocketPath(socketPath: string): string;
export declare function getProjectName(cwdInput?: string | null): string;
export declare function gitRepoRoot(cwdInput?: string | null): string | null;
export declare function canonicalRemoteLocator(remote: string): string | null;
export declare function _clearProjectNameCache(): void;
export declare const SECRET_PATTERN_SOURCES: readonly string[];
export declare function redactSecretList(items: readonly string[]): string[];
export declare function redactTitleAndObservations(title: string | undefined, observations: readonly string[] | undefined): {
    title?: string;
    observations?: string[];
};
export declare function holdsSecret(items: readonly string[]): boolean;
export declare function redactSecrets(input: string): string;
export declare function redactUserPaths(text: string): string;
export declare function redactMemoryText(text: string): string;
export declare function redactTextValues(value: unknown, skipKeys?: ReadonlySet<string>): unknown;
export declare function redactVersionText(entry: unknown): unknown;
export declare function textsIn(value: unknown): Set<string>;
export declare function metadataRefusal(value: unknown, known: ReadonlySet<string>, beside?: Iterable<string>): string | undefined;
export declare function besideRefusal(addsText: boolean, beside: Iterable<string>): string | undefined;
export declare function addsNewText(value: unknown, known: ReadonlySet<string>): boolean;
export declare function clearPartsOfKey(metadata: Record<string, unknown>): Record<string, unknown>;
//# sourceMappingURL=paths.d.ts.map