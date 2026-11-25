import { randomUUID } from 'crypto';
import { redactSecrets } from './paths.js';
import { remember } from './operations.js';
import { MEMORY_DATA_NOTICE } from './work-topology.js';
import { AGENT_TEXT_OMITTED, omitAgentMessageText } from './session-handoff.js';
const RECALL_BLOCK = /^\s*\[MeMesh recall\][\s\S]*?(?:\n\s*\n|$)/;
function withoutRecall(text) {
    if (!text.startsWith(`${MEMORY_DATA_NOTICE}\n`))
        return text.replace(RECALL_BLOCK, '');
    const start = MEMORY_DATA_NOTICE.length + 1;
    const lineEnd = text.indexOf('\n', start);
    const fence = /^(`{3,})text$/.exec(text.slice(start, lineEnd))?.[1];
    if (!fence)
        return text;
    const close = text.indexOf(`\n${fence}`, lineEnd);
    if (close < 0)
        return text;
    const rest = text.slice(close + fence.length + 1);
    return rest === '' || rest.startsWith('\n\n') ? rest.trimStart() : text;
}
function withoutReceivedMessages(text, envelopes) {
    let rest = text;
    while (true) {
        const envelope = envelopes.find(candidate => candidate !== '' && rest.startsWith(candidate));
        if (!envelope)
            return rest;
        rest = rest.slice(envelope.length);
    }
}
const TITLE_MAX_CHARS = 120;
export function captureChatTurn(input) {
    const turnId = randomUUID();
    const received = input.receivedMessages ?? [];
    const envelopes = received.flatMap(message => [message.envelope, redactSecrets(message.envelope)]);
    const bodies = received.flatMap(message => [message.body, redactSecrets(message.body)]);
    const assistant = omitAgentMessageText(redactSecrets(input.assistantText), bodies);
    const onlyOmissions = assistant.omitted > 0
        && assistant.text.replaceAll(AGENT_TEXT_OMITTED, '').trim() === '';
    const sides = [
        ['user', withoutReceivedMessages(withoutRecall(input.userText), envelopes)],
        ['assistant', onlyOmissions ? '' : assistant.text],
    ];
    const names = [];
    for (const [role, said] of sides) {
        if (said.trim() === '')
            continue;
        const text = redactSecrets(said);
        const name = `${input.namePrefix}-${input.sessionId}-${turnId}-${role}`;
        remember({
            name,
            type: 'conversation',
            title: text.split('\n').find((line) => line.trim() !== '').trim().slice(0, TITLE_MAX_CHARS),
            observations: [text],
            tags: [...input.baseTags, `session:${input.sessionId}`, `role:${role}`],
            sourceHost: input.sourceHost,
        });
        names.push(name);
    }
    return names.length > 0 ? { outcome: 'wrote', names } : { outcome: 'skipped', reason: 'the turn has no text' };
}
//# sourceMappingURL=chat-turn.js.map