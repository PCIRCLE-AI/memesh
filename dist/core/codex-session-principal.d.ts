export declare function isValidCodexThreadId(value: unknown): value is string;
export interface CodexSessionPrincipalSession {
    threadId: string;
    workspace: string;
}
export interface CodexSessionPrincipalConfig {
    principal_id: unknown;
    workspace: unknown;
}
export type CodexSessionPrincipalResolution = {
    source: 'automatic';
    principalId: string;
} | {
    source: 'configured';
    principalId: unknown;
};
export declare function automaticCodexSessionPrincipal(session: CodexSessionPrincipalSession): string;
export declare function resolveCodexSessionPrincipal(config: CodexSessionPrincipalConfig | undefined, session: CodexSessionPrincipalSession, realpath?: (path: string) => string): CodexSessionPrincipalResolution;
//# sourceMappingURL=codex-session-principal.d.ts.map