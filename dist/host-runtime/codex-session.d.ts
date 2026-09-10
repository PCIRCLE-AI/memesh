#!/usr/bin/env node
import fs from 'node:fs';
import { connectRouterHost, type RouterHostConnection } from './router-client.js';
export interface CodexSessionHostConfig extends Record<string, unknown> {
    router_socket: unknown;
    token_file: unknown;
    project: unknown;
    principal_id: unknown;
    workspace: unknown;
    model?: unknown;
    work_summary?: unknown;
}
export interface CodexSessionStartInput {
    hook_event_name?: unknown;
    session_id?: unknown;
    cwd?: unknown;
    source?: unknown;
}
interface CodexCompanionState {
    version: 1;
    pid: number;
    thread_id: string;
    workspace: string;
    token: string;
    control_socket: string;
}
export interface CodexSessionCompanionDependencies {
    connect?: typeof connectRouterHost;
    realpath?: typeof fs.realpathSync;
}
export declare function codexCompanionStatePath(dataDir: string, threadId: string): string;
export declare function codexCompanionControlSocketPath(dataDir: string, threadId: string): string;
export declare function requestExactCompanionControl(state: CodexCompanionState, action: 'terminate' | 'retire'): Promise<boolean>;
export declare function supersedeCodexSessionCompanion(dataDir: string, hookInput: CodexSessionStartInput, environment: {
    PLUGIN_ROOT?: string;
}, realpath?: typeof fs.realpathSync): Promise<boolean>;
export declare function startCodexSessionCompanion(config: CodexSessionHostConfig | undefined, hookInput: CodexSessionStartInput, environment: {
    PLUGIN_ROOT?: string;
}, dependencies?: CodexSessionCompanionDependencies): Promise<RouterHostConnection | null>;
export declare function endCodexSessionCompanion(dataDir: string, hookInput: CodexSessionStartInput, environment: {
    PLUGIN_ROOT?: string;
}, realpath?: typeof fs.realpathSync): Promise<boolean>;
export {};
//# sourceMappingURL=codex-session.d.ts.map