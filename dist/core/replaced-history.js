export const REPLACED_HISTORY_MAX = 20;
export const REPLACED_HISTORY_MAX_BYTES = 64 * 1024;
const jsonBytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');
export function boundReplacedHistory(history) {
    let out = history.slice(-REPLACED_HISTORY_MAX);
    while (out.length > 1 && jsonBytes(out) > REPLACED_HISTORY_MAX_BYTES)
        out = out.slice(1);
    if (out.length === 1 && jsonBytes(out) > REPLACED_HISTORY_MAX_BYTES) {
        const only = out[0];
        let kept = { ...only, observations: [], tags: [], truncated: true };
        const fits = (v) => jsonBytes([v]) <= REPLACED_HISTORY_MAX_BYTES;
        for (const obs of only.observations) {
            const next = { ...kept, observations: [...kept.observations, obs] };
            if (!fits(next))
                break;
            kept = next;
        }
        for (const tag of only.tags) {
            const next = { ...kept, tags: [...kept.tags, tag] };
            if (!fits(next))
                break;
            kept = next;
        }
        out = [kept];
    }
    return out;
}
//# sourceMappingURL=replaced-history.js.map