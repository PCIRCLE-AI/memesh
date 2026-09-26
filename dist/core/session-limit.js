export const SESSION_LIMIT_MIN = 1;
export const SESSION_LIMIT_MAX = 100;
export const SESSION_LIMIT_DEFAULT = 10;
export function isSessionLimitInRange(n) {
    return Number.isInteger(n) && n >= SESSION_LIMIT_MIN && n <= SESSION_LIMIT_MAX;
}
function classify(n) {
    if (!Number.isInteger(n))
        return 'invalid';
    if (isSessionLimitInRange(n))
        return 'valid';
    return n > SESSION_LIMIT_MAX ? 'above' : 'below';
}
function causeText(kind) {
    if (kind === 'above')
        return `above max ${SESSION_LIMIT_MAX}`;
    if (kind === 'below')
        return `below min ${SESSION_LIMIT_MIN}`;
    return 'not a whole number';
}
function shortCauseText(kind) {
    if (kind === 'above')
        return `above ${SESSION_LIMIT_MAX}`;
    if (kind === 'below')
        return `below ${SESSION_LIMIT_MIN}`;
    return 'not a whole number';
}
function envDisplayValue(envRaw, parsed) {
    return Number.isNaN(parsed) ? envRaw : String(parsed);
}
export function resolveSessionLimit(envRaw, configValue) {
    const adjustments = [];
    if (envRaw !== undefined) {
        const n = Number(envRaw);
        const kind = classify(n);
        if (kind === 'valid')
            return { value: n, effectiveSource: 'env', adjustments: [] };
        adjustments.push({
            source: 'env',
            raw: JSON.stringify(envRaw),
            displayValue: envDisplayValue(envRaw, n),
            cause: causeText(kind),
            shortCause: shortCauseText(kind),
        });
        if (kind === 'above')
            return { value: SESSION_LIMIT_MAX, effectiveSource: 'env', adjustments };
    }
    if (typeof configValue === 'number') {
        const kind = classify(configValue);
        if (kind === 'valid')
            return { value: configValue, effectiveSource: 'config', adjustments };
        adjustments.push({
            source: 'config',
            raw: String(configValue),
            displayValue: String(configValue),
            cause: causeText(kind),
            shortCause: shortCauseText(kind),
        });
        if (kind === 'above')
            return { value: SESSION_LIMIT_MAX, effectiveSource: 'config', adjustments };
    }
    return { value: SESSION_LIMIT_DEFAULT, effectiveSource: 'default', adjustments };
}
//# sourceMappingURL=session-limit.js.map