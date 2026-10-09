export const TITLE_MAX_LENGTH = 200;
export function truncateTitle(text) {
    if (!text)
        return text;
    const trimmed = text.trim();
    if (trimmed.length <= TITLE_MAX_LENGTH)
        return trimmed;
    let end = TITLE_MAX_LENGTH - 1;
    const last = trimmed.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff)
        end--;
    return trimmed.slice(0, end).trimEnd() + '…';
}
export const BOILERPLATE_OBSERVATION_PATTERN = /^(Steps|Commits|Branch|Diff stats|Compaction reason|Tool calls|Plan ".+" completed)[:\s]/;
export function isBoilerplateObservation(text) {
    return BOILERPLATE_OBSERVATION_PATTERN.test(text.trim());
}
//# sourceMappingURL=title.js.map