export const BRIEFING_LEVELS = ['minimal', 'standard', 'full'];
export const DEFAULT_BRIEFING_LEVEL = 'minimal';
export function isBriefingLevel(value) {
    return typeof value === 'string' && BRIEFING_LEVELS.includes(value);
}
const INVALID_VALUE_SERIALIZED_MAX = 100;
const PRE_SLICE_RAW_MAX = 256;
function safeRawPreSlice(value, maxUnits) {
    if (value.length <= maxUnits)
        return value;
    let end = maxUnits;
    const lastKept = value.charCodeAt(end - 1);
    const nextUnit = value.charCodeAt(end);
    const lastKeptIsHighSurrogate = lastKept >= 0xd800 && lastKept <= 0xdbff;
    const nextUnitIsLowSurrogate = nextUnit >= 0xdc00 && nextUnit <= 0xdfff;
    if (lastKeptIsHighSurrogate && nextUnitIsLowSurrogate)
        end -= 1;
    return value.slice(0, end);
}
function truncateToSerializedBound(codePoints) {
    let kept = 0;
    for (; kept < codePoints.length; kept++) {
        const candidate = JSON.stringify(`${codePoints.slice(0, kept + 1).join('')}…`);
        if (candidate.length > INVALID_VALUE_SERIALIZED_MAX)
            break;
    }
    return JSON.stringify(`${codePoints.slice(0, kept).join('')}…`);
}
function describeInvalidValue(value) {
    if (typeof value === 'string') {
        if (value.length <= INVALID_VALUE_SERIALIZED_MAX) {
            const whole = JSON.stringify(value);
            if (whole.length <= INVALID_VALUE_SERIALIZED_MAX)
                return whole;
            return truncateToSerializedBound(Array.from(value));
        }
        return truncateToSerializedBound(Array.from(safeRawPreSlice(value, PRE_SLICE_RAW_MAX)));
    }
    if (Array.isArray(value))
        return '[array]';
    if (value !== null && typeof value === 'object')
        return '[object]';
    if (typeof value === 'bigint')
        return '[bigint]';
    if (typeof value === 'symbol')
        return '[symbol]';
    if (typeof value === 'function')
        return '[function]';
    return JSON.stringify(value) ?? String(value);
}
export function resolveBriefingLevel(envValue, configValue) {
    if (envValue !== undefined) {
        if (isBriefingLevel(envValue))
            return { level: envValue, invalid: null };
        return { level: DEFAULT_BRIEFING_LEVEL, invalid: { source: 'env', value: describeInvalidValue(envValue) } };
    }
    if (configValue !== undefined) {
        if (isBriefingLevel(configValue))
            return { level: configValue, invalid: null };
        return { level: DEFAULT_BRIEFING_LEVEL, invalid: { source: 'config', value: describeInvalidValue(configValue) } };
    }
    return { level: DEFAULT_BRIEFING_LEVEL, invalid: null };
}
const POLICIES = {
    minimal: { global: false, foreign: false, taskState: false, index: false, workPackageNotice: false },
    standard: { global: false, foreign: false, taskState: true, index: true, workPackageNotice: false },
    full: { global: true, foreign: true, taskState: true, index: true, workPackageNotice: true },
};
export function briefingLevelPolicy(level) {
    return POLICIES[level];
}
export function sessionStartAppendsWorkPackageNotice(level) {
    return briefingLevelPolicy(level).workPackageNotice;
}
//# sourceMappingURL=briefing-level.js.map