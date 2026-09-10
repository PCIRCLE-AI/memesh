import { type UpdateNotice } from './update-notice.js';
export declare const RECENT_HOOK_NOTICE_MS: number;
export declare const CLI_NOTICE_THROTTLE_MS: number;
export type EntryPoint = 'mcp' | 'cli';
export declare function formatUpdateNoticeLine(notice: UpdateNotice): string | null;
export declare function recentHookNoticeExists(dir: string, currentVersion: string, latestVersion: string, now?: Date): boolean;
export interface EntryPointNoticeInput {
    currentVersion: string;
    entryPoint: EntryPoint;
    dir?: string;
    now?: Date;
    processOnce?: Set<string>;
    updateCheckEnabled?: boolean;
}
export declare function updateNoticeForEntryPoint(input: EntryPointNoticeInput): string | null;
//# sourceMappingURL=update-entrypoint.d.ts.map