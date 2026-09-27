import { type ExecFileOptions } from 'node:child_process';
import type { AgentHostAdapter, AgentHostDispatchInput, AgentHostRegistration } from '../core/agent-router.js';
import type { MemeshDatabase } from '../storage/sqlite.js';
import { type CodexQueueRelease } from './codex-queue-release.js';
export interface CodexCliQueueResult {
    status: number | null;
    stdout: string;
    stderr: string;
    error_code?: string;
}
export type RunCodexCliQueue = (command: string, args: string[], options: ExecFileOptions) => Promise<CodexCliQueueResult>;
export interface CodexCliQueueAdapterOptions {
    authenticate(registration: AgentHostRegistration): boolean | Promise<boolean>;
    codex_command?: string;
    timeout_ms?: number;
    run?: RunCodexCliQueue;
    release_watch?: CodexQueueReleaseWatch;
}
export interface CodexQueueReleaseWatch {
    db: MemeshDatabase;
    interval_ms?: number;
    checks?: number;
    release?: (threadId: string, queuedSubmissionId: string) => Promise<CodexQueueRelease>;
}
export declare function createCodexCliQueueAdapter(options: CodexCliQueueAdapterOptions): AgentHostAdapter;
export declare function watchCodexQueueRelease(watch: CodexQueueReleaseWatch, input: AgentHostDispatchInput, queuedSubmissionId: string | null): Promise<void>;
//# sourceMappingURL=codex-cli-queue.d.ts.map