export declare const SESSION_LIMIT_MIN = 1;
export declare const SESSION_LIMIT_MAX = 100;
export declare const SESSION_LIMIT_DEFAULT = 10;
export declare function isSessionLimitInRange(n: number): boolean;
export type SessionLimitSource = 'env' | 'config';
export interface SessionLimitAdjustment {
    source: SessionLimitSource;
    raw: string;
    displayValue: string;
    cause: string;
    shortCause: string;
}
export interface SessionLimitResolution {
    value: number;
    effectiveSource: SessionLimitSource | 'default';
    adjustments: SessionLimitAdjustment[];
}
export declare function resolveSessionLimit(envRaw: string | undefined, configValue: unknown): SessionLimitResolution;
//# sourceMappingURL=session-limit.d.ts.map