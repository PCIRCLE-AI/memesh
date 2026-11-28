import type { TaskState } from './task-state.js';
interface Operation {
    since: number;
    session: string;
    revision: string | null;
    task?: string;
    returned?: number;
}
export declare function continuationTaskKey(state: TaskState): string | undefined;
export declare function continuationWrite(project: string, cwd: string, session: string, turn: string, invocation: string, returned: boolean, task?: string, now?: number): {
    directory: string;
    file: string;
    record: Operation;
} | null;
export declare function pruneContinuation(directory: string, keptFile: string, keptSince: number, now?: number): void;
export declare function continuationLines(project: string, cwd?: string, currentSession?: string, task?: string, now?: number): string[];
export {};
//# sourceMappingURL=continuation.d.ts.map