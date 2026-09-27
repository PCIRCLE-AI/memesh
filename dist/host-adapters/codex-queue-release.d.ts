import { type ChildProcess, type SpawnOptions } from 'node:child_process';
export type CodexQueueRelease = {
    status: 'started' | 'empty' | 'busy' | 'other_input';
} | {
    status: 'unavailable';
    reason: 'no_daemon' | 'timeout' | 'rejected' | 'failed';
};
export type SpawnCodexProxy = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
export interface ReleaseCodexQueueOptions {
    timeout_ms?: number;
    spawn?: SpawnCodexProxy;
}
export declare function releaseCodexQueue(threadId: string, queuedSubmissionId: string, options?: ReleaseCodexQueueOptions): Promise<CodexQueueRelease>;
//# sourceMappingURL=codex-queue-release.d.ts.map