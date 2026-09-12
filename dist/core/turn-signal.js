import { createHash } from 'crypto';
import { redactSecrets } from './paths.js';
import { remember } from './operations.js';
const DECISION_CUES = [
    /\b(?:we|i)(?:'ve| have|'ll| will)?\s+(?:decided|settled on|opted)\b/gi,
    /\bdecision\s*:/gi,
    /\blet'?s\s+(?:go with|use|switch to|stick with)\b/gi,
    /\bi(?:'ll| will)\s+go with\b/gi,
    /\bwe(?:'re| are|'ll| will)\s+(?:going to\s+)?(?:use|go with|switch to|stick with)\b/gi,
    /(?:^|[.!?;]\s+)use\s+[^.!?\n]{1,40}?\binstead of\b/gi,
    /(?:^|[.!?;]\s+)switching to\b/gi,
    /^\s*agreed\s*[:,—-]/gim,
    /\bfrom now on\b/gi,
    /決定(?:用|採用|不用|不要|改成|換成)|改用|就用|拍板/g,
];
const LESSON_CUES = [
    /\blessons? learned\b|\blesson\s*:/gi,
    /\blearned the hard way\b/gi,
    /\broot cause\b/gi,
    /\bthe (?:fix|problem|bug) was\b/gi,
    /\b(?:gotcha|pitfall)\b/gi,
    /教訓|根因|原來是|踩到|下次要/g,
];
const NEGATION = /\b(?:not|no|never|haven'?t|hasn'?t|didn'?t|won'?t)\b|還沒|尚未|沒有/i;
const NEGATION_WINDOW = 20;
const CLAUSE_BREAK = /[.!?;:—,，。；：]/g;
function sameClause(before) {
    let cut = 0;
    for (const m of before.matchAll(CLAUSE_BREAK))
        cut = (m.index ?? 0) + m[0].length;
    return before.slice(cut);
}
function stripShownText(text) {
    return text
        .replace(/```[\s\S]*?(?:```|$)/g, ' ')
        .replace(/`[^`\s](?:[^`\n]{0,78}[^`\s])?`/g, ' ')
        .replace(/"[^"\n]*"|“[^”\n]*”|「[^」\n]*」|『[^』\n]*』/g, ' ');
}
function stripRecallBlock(text) {
    return text.replace(/^\s*\[MeMesh recall\][\s\S]*?(?:\n\s*\n|$)/, '');
}
function firstUnnegated(re, text) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
        const before = sameClause(text.slice(Math.max(0, m.index - NEGATION_WINDOW), m.index));
        const rest = text.slice(m.index + m[0].length);
        const end = /[.!?。！？\n]/.exec(rest);
        const isQuestion = end !== null && (end[0] === '?' || end[0] === '？');
        if (!NEGATION.test(before) && !isQuestion)
            return m[0].trim();
        if (m[0] === '')
            re.lastIndex++;
    }
    return null;
}
export function classifyTurn(_userText, assistantText) {
    const text = stripShownText(stripRecallBlock(assistantText));
    for (const [kind, cues] of [['decision', DECISION_CUES], ['lesson', LESSON_CUES]]) {
        for (const re of cues) {
            const cue = firstUnnegated(re, text);
            if (cue !== null)
                return { kind, cue };
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