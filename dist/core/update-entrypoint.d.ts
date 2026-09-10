import { type UpdateNotice } from './update-notice.js';
export declare const RECENT_HOOK_NOTICE_MS: number;
export declare const CLI_NOTICE_THROTTLE_MS: number;
export declare const FRESH_CHECK_THROTTLE_MS: number;
export type EntryPoint = 'mcp' | 'cli';
export declare function formatUpdateNoticeLine(notice: UpdateNotice): string | null;
export declare function recentHookNoticeExists(dir: string, currentVersion: string, latestVersion: string | null, now?: Date): boolean;
export interface EntryPointNoticeInput {
    currentVersion: string;
    entryPoint: EntryPoint;
    dir?: string;
    now?: Date;
    processOnce?: Set<string>;
    updateCheckEnabled?: boolean;
    refresh?: (dir: string, currentVersion: string, now: Date) => boolean;
}
export declare const MCP_PENDING_RETRY_MS: number;
export declare function updateNoticeForEntryPoint(input: EntryPointNoticeInput): string | null;
//# sourceMappingURL=update-entrypoint.d.ts.map