import { createHash } from 'crypto';
import { redactSecrets } from './paths.js';
import { remember } from './operations.js';
const DECISION_CUES = [
    /\b(?:we|i)(?:'ve| have|'ll| will)?\s+(?:decided|chosen|chose|settled on|opted)\b/i,
    /\b(?:decided|decision)\s*(?:is|was|:)\s*/i,
    /\blet'?s\s+(?:go with|use|switch to|stick with|keep)\b/i,
    /\b(?:going|go) with\b.{0,60}\binstead\b/i,
    /\bfrom now on\b/i,
    /決定|改用|就用|選擇了|拍板/,
];
const LESSON_CUES = [
    /\blesson(?:s)? learned\b|\blesson:\s*/i,
    /\broot cause\b/i,
    /\bturn(?:s|ed) out\b/i,
    /\bthe (?:fix|problem|bug|issue) (?:was|is)\b/i,
    /\b(?:gotcha|pitfall)\b/i,
    /\bnext time\b/i,
    /教訓|根因|原來是|踩到|下次要/,
];
export function classifyTurn(userText, assistantText) {
    const text = `${userText}\n${assistantText}`;
    for (const [kind, cues] of [['decision', DECISION_CUES], ['lesson', LESSON_CUES]]) {
        for (const re of cues) {
            const m = re.exec(text);
            if (m)
                return { kind, cue: m[0].trim() };
        }
    }
    return null;
}
export const TURN_TEXT_CAP = 2000;
export function captureChatTurn(input) {
    const signal = classifyTurn(input.userText, input.assistantText);
    if (!signal)
        return { outcome: 'skipped', reason: 'no decision- or lesson-shaped move in this turn' };
    const digest = createHash('sha256')
        .update(input.userText).update('\0').update(input.assistantText)
        .digest('hex').slice(0, 12);
    const name = `${input.namePrefix}-${input.sessionId}-${digest}`;
    remember({
        name,
        type: 'conversation',
        observations: [
            ['User', input.userText],
            ['Assistant', input.assistantText],
        ].filter(([, t]) => t.trim() !== '').map(([who, t]) => `${who}: ${redactSecrets(t).slice(0, TURN_TEXT_CAP)}`),
        tags: [...input.baseTags, `session:${input.sessionId}`, `signal:${signal.kind}`],
        sourceHost: input.sourceHost,
    });
    return { outcome: 'wrote', name, kind: signal.kind };
}
//# sourceMappingURL=turn-signal.js.map