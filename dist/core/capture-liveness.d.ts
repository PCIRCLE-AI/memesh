export type HookOutcome = 'wrote' | 'skipped' | 'notified' | 'error';
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
export declare const CAPTURE_HOOKS: readonly ["post-commit", "session-summary", "pre-compact", "pre-edit-recall", "user-prompt-intent", "decision-nudge", "guard-check", "session-start", "note-ingest", "remember-nudge"];
export declare const FAIL_ELIGIBLE_HOOKS: readonly ["session-summary"];
export declare const SILENT_ELIGIBLE_HOOKS: readonly ["post-commit", "session-summary", "pre-compact"];
export declare const SKIP_REASONS: {
    readonly notBash: "not a Bash tool call";
    readonly notGitCommit: "not a git commit command";
    readonly commitLineMissing: "a git commit ran but printed no commit line";
    readonly alreadyCaptured: "this session was already captured";
    readonly payloadTooLarge: "payload exceeded the stdin byte cap";
    readonly toolNameAbsent: "tool_name absent in payload";
    readonly notDecisionTool: "not a decision-shaped tool call";
    readonly noSessionId: "no usable session_id in the payload";
    readonly alreadyNudged: "already nudged for this tool in this session";
    readonly noBashCommand: "no Bash command in the payload";
    readonly noDatabaseForGuards: "no database yet — nothing to guard against";
    readonly noGuardMatched: "no active guard matched this command";
    readonly autoCaptureOff: "auto-capture is turned off";
    readonly commitCwdAbsent: "data.cwd absent — cannot resolve project or repo";
    readonly hashNotACommit: "the hash is not a commit in this repository";
    readonly noSessionOrTranscript: "neither session_id nor transcript_path in the payload";
    readonly emptyStdin: "empty stdin";
    readonly cwdAbsent: "cwd absent in payload — cannot resolve project";
    readonly notAgenticLoop: "not an agentic loop";
    readonly transcriptPathAbsent: "transcript_path absent";
    readonly transcriptGone: "the transcript file named by the payload is gone";
    readonly tooLittleActivity: "too little activity in the session to be worth saving";
    readonly noRuleMatched: "no rule matched (no edited file and fewer than 20 tool calls)";
    readonly allMatchedEntitiesArchived: "every rule that matched targeted an entity the user forget-archived";
    readonly toolInputAbsent: "tool_input absent in payload";
    readonly noFilePath: "no file_path in the tool input";
    readonly noDatabaseForRecall: "no database yet — nothing to recall";
    readonly nothingToRecall: "no guard matched and nothing to recall for this file";
    readonly noPromptIntent: "the prompt carried no remember intent and no update decision";
    readonly noMemoryDir: "no Claude Code memory directory for this project";
    readonly noNoteChanged: "no note file changed since the last ingestion";
    readonly noteIngesterNotBuilt: "the note ingester is not built (dist/core/note-ingest.js is missing)";
    readonly noteNothingNew: "note files were read and nothing new needed storing";
    readonly noteFilesRefused: "note files were refused and nothing was stored";
    readonly noTranscript: "no transcript to read";
    readonly trivialTurn: "trivial turn — too few tool calls since the last Stop";
    readonly noDecisionMove: "no decision-shaped move since the last Stop";
    readonly memoryWritten: "a memory was written since the last Stop";
    readonly noteFileChanged: "a note file changed since the last Stop";
};
export declare const UNRECOGNISED_REASON = "unrecognised reason";
export declare function renderableSkipReason(reason: string | undefined): string;
export declare function isGitCommitCommand(command: string): boolean;
export declare const NOT_TRIGGERED_SKIP_REASONS: Readonly<Record<string, readonly string[]>>;
export declare const UNCLASSIFIED_SKIP_HOOKS: readonly ["pre-compact", "pre-edit-recall", "user-prompt-intent", "decision-nudge", "guard-check", "session-start"];
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
    notifies: number;
    lastNotifiedAt: string | null;
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