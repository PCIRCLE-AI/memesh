export declare const DELEGATION_TYPE = "delegation";
export declare const DELEGATION_SOURCE = "deepseek-worker";
export declare const DELEGATION_VERDICTS: readonly ["unreviewed", "accepted", "rejected"];
export type DelegationVerdict = typeof DELEGATION_VERDICTS[number];
export type DelegationTrust = 'untrusted-until-verified' | 'verified' | 'rejected';
export declare const ENVELOPE_MAX_BYTES: number;
declare const USAGE_KEYS: readonly ["prompt_tokens", "completion_tokens", "total_tokens"];
export declare class DelegationInputError extends Error {
}
export interface EnvelopeSummary {
    ok: boolean;
    mode: 'direct' | 'harness';
    model: string | null;
    finishReason: string | null;
    allowedTools: string[] | null;
    usage: Partial<Record<typeof USAGE_KEYS[number], number>>;
}
export declare function summarizeEnvelope(raw: unknown): EnvelopeSummary;
export interface RecordDelegationInput {
    envelopeText: string;
    promptSha256: string;
    verdict?: DelegationVerdict;
    followUp?: string;
    grantedTools?: string[];
    project: string;
}
export interface RecordDelegationResult {
    stored: boolean;
    name: string;
    verdict: DelegationVerdict;
    trust: DelegationTrust;
    summary: EnvelopeSummary;
}
export declare function recordDelegation(input: RecordDelegationInput): RecordDelegationResult;
export interface SetVerdictResult {
    name: string;
    previousVerdict: string | null;
    verdict: Exclude<DelegationVerdict, 'unreviewed'>;
    trust: DelegationTrust;
}
export declare function setDelegationVerdict(input: {
    name: string;
    verdict: Exclude<DelegationVerdict, 'unreviewed'>;
    note?: string;
}): SetVerdictResult;
export {};
//# sourceMappingURL=delegation.d.ts.map