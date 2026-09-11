export type HookOutcome = 'wrote' | 'skipped' | 'error';
export type HookHost = 'claude-code' | 'codex' | 'unknown';
export interface HookOutcomeRecord {
    hook: string;
    at: string;
    host: HookHost;
    outcome: HookOutcome;
    reason?: string;
    entity?: string;
}
export interface HookOutcomeFile {
    hooks: Record<string, HookOutcomeRecord[]>;
}
export declare const HOOK_OUTCOMES_FILENAME = "hook-outcomes.jsonl";
export declare const HOOK_OUTCOMES_PER_HOOK = 20;
export declare const HOOK_OUTCOMES_NOT_TRIGGERED_PER_HOOK = 5;
export declare function isTriggeredRecord(record: Pick<HookOutcomeRecord, 'hook' | 'outcome' | 'reason'>): boolean;
export declare const HOOK_OUTCOMES_ROTATE_BYTES: number;
export declare function serializeHookOutcome(record: HookOutcomeRecord): string;
export declare function trimHookOutcomeLines(raw: string, max?: number, maxBytes?: number): string;
export declare const SILENT_HOOK_MIN_RUNS = 5;
export declare const CAPTURE_HOOKS: readonly ["post-commit", "session-summary", "pre-compact", "pre-edit-recall", "user-prompt-intent", "decision-nudge", "guard-check", "session-start"];
export declare const FAIL_ELIGIBLE_HOOKS: readonly ["session-summary"];
export declare const SILENT_ELIGIBLE_HOOKS: readonly ["post-commit", "session-summary", "pre-compact"];
export declare const SKIP_REASONS: {
    readonly notBash: "not a Bash tool call";
    readonly notGitCommit: "not a git commit command";
    readonly commitLineMissing: "a git commit ran but printed no commit line";
    readonly alreadyCaptured: "this session was already captured";
};
export declare const NOT_TRIGGERED_SKIP_REASONS: Readonly<Record<string, readonly string[]>>;
export declare const NEVER_RAN_GRACE_HOURS = 72;
export declare function parseHookOutcomes(raw: string | null | undefined, limit?: number): HookOutcomeFile;
export declare function parseHookOutcomeLine(line: string): HookOutcomeRecord | null;
export declare const RECORD_TEXT_MAX = 200;
export declare function sanitizeRecordText(text: string): string;
export interface HookLivenessSummary {
    hook: string;
    runs: number;
    triggeredRuns: number;
    writes: number;
    skips: number;
    errors: number;
    lastRunAt: string | null;
    firstTriggeredAt: string | null;
    lastWriteAt: string | null;
    lastEntity: string | null;
    lastSkipReason: string | null;
    dominantSkipReason: string | null;
    dominantSkipCount: number;
    hosts: HookHost[];
    silent: boolean;
}
export declare function summarizeHookOutcomes(file: HookOutcomeFile): HookLivenessSummary[];
export interface TypeTrend {
    type: string;
    last7: number;
    prev7: number;
    stopped: boolean;
}
export declare function summarizeTypeTrends(rows: Array<{
    type: string;
    last7: number;
    prev7: number;
}>): TypeTrend[];
export type CaptureLivenessStatus = 'PASS' | 'PASS_WITH_CONCERNS' | 'FAIL';
export interface CaptureLivenessInput {
    hooks: HookLivenessSummary[];
    types: TypeTrend[];
    neverRanHooks?: string[];
    measuringHours?: number | null;
}
export interface CaptureLivenessVerdict {
    status: CaptureLivenessStatus;
    silentHook: HookLivenessSummary | null;
    stoppedTypes: TypeTrend[];
    deadHooks: string[];
}
export declare function captureLivenessVerdict(input: CaptureLivenessInput): CaptureLivenessVerdict;
export declare function captureLivenessNotice(verdict: CaptureLivenessVerdict): string | null;
export declare const GRACE_SESSIONS = 3;
export declare const GRACE_HOURS = 24;
export interface CaptureGraceState {
    version: string;
    firstSeenAt: string;
    sessions: number;
}
export declare function parseGraceState(raw: string | null | undefined): CaptureGraceState | null;
export declare function advanceGraceState(previous: CaptureGraceState | null, version: string, nowMs: number): CaptureGraceState;
export declare function graceInEffect(state: CaptureGraceState, nowMs: number): boolean;
export declare function detectHookHost(payload: Record<string, unknown> | null | undefined, env?: Record<string, string | undefined>): HookHost;
//# sourceMappingURL=capture-liveness.d.ts.map