import { describe, it, expect } from 'vitest';
import {
  cleanHandoffText,
  HANDOFF_MAX_CHARS,
  lastAssistantText,
  SESSION_HANDOFF_TYPE,
  sessionHandoffName,
} from '../../src/core/session-handoff.js';
import { groupTopology } from '../../src/core/work-topology.js';
import { NOISE_TYPES } from '../../src/core/analytics.js';

const line = (entry: object) => JSON.stringify(entry);
const asst = (content: unknown, extra: object = {}) =>
  line({ type: 'assistant', message: { role: 'assistant', content }, ...extra });
const text = (t: string) => [{ type: 'text', text: t }];

describe('cleanHandoffText', () => {
  it('drops fenced code and keeps the prose around it', () => {
    const out = cleanHandoffText('Fixed the parser.\n\n```ts\nconst secretLooking = 1;\n```\n\nNext: run the suite.');
    expect(out).toBe('Fixed the parser.\n\nNext: run the suite.');
  });

  it('drops a fence that was never closed, to the end of the message', () => {
    expect(cleanHandoffText('Done with the change.\n```bash\nrm -rf build')).toBe('Done with the change.');
  });

  it('does not mistake a ``` in the middle of a sentence for a fence', () => {
    const inline = 'Fixed the markdown renderer so a line that starts with ``` is no longer treated as a fence by mistake. Next: rebase and open the PR.';
    expect(cleanHandoffText(inline)).toBe(inline);
    // A single line that opens AND closes with backticks is a code span, not a fence.
    expect(cleanHandoffText('```one-liner``` was the old spelling.\nNext: rebase and open the PR.')).toContain('Next: rebase and open the PR.');
  });

  it('keeps prose after a closed fence and drops only the fenced lines', () => {
    const out = cleanHandoffText('Before.\n```\nfirst block\n```\nBetween.\n```py\nsecond block\n```\nAfter.');
    expect(out).toBe('Before.\nBetween.\nAfter.');
  });

  it('recognises the fence shapes markdown allows: tildes, list indentation, a longer closer, text after the closer', () => {
    const next = 'Next: rebase and open the PR.';
    expect(cleanHandoffText(`Intro.\n~~~\nsecret-looking code\n~~~\n${next}`)).toBe(`Intro.\n${next}`);
    expect(cleanHandoffText(`Steps:\n10. Build it:\n    \`\`\`bash\n    npm run build\n    \`\`\`\n${next}`)).toBe(`Steps:\n10. Build it:\n${next}`);
    expect(cleanHandoffText(`Intro.\n\`\`\`\ncode\n\`\`\`\`\n${next}`)).toBe(`Intro.\n${next}`);
    expect(cleanHandoffText(`Intro.\n\`\`\`\ncode\n\`\`\` done with that\n${next}`)).toBe(`Intro.\n${next}`);
    // A shorter or different run inside the block does not close it.
    expect(cleanHandoffText(`Intro.\n\`\`\`\`\n\`\`\`\n~~~\nstill code\n\`\`\`\`\n${next}`)).toBe(`Intro.\n${next}`);
    expect(cleanHandoffText(`Intro.\n\`\`\`\n~~~~\nstill code\n\`\`\`\n${next}`)).toBe(`Intro.\n${next}`);
  });

  it('stays linear on many fence openers that never close', () => {
    const started = Date.now();
    const out = cleanHandoffText(`Intro.\n${'```js\n'.repeat(40_000)}`);
    expect(out).toBe('Intro.');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('collapses runs of blank lines and trailing spaces', () => {
    expect(cleanHandoffText('one  \n\n\n\n\ntwo\t')).toBe('one\n\ntwo');
  });

  it('keeps the END of a long message, so the next step survives', () => {
    const long = `${'background sentence. '.repeat(200)}\nNEXT STEP: rebase and open the PR.`;
    const out = cleanHandoffText(long);
    expect(out.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS);
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('NEXT STEP: rebase and open the PR.')).toBe(true);
  });

  it('starts on a line break when one is near, not mid-sentence', () => {
    // The cut lands inside the run of x's; the first line break after it is
    // 178 characters in, so the fragment is dropped and the kept text starts
    // on a whole line.
    const body = `${'x'.repeat(300)}\nWhole line one kept.\n${'filler line\n'.repeat(50)}`;
    const out = cleanHandoffText(body);
    expect(out.startsWith('…Whole line one kept.')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS);
  });

  it('never starts on half of a surrogate pair', () => {
    // 1001 UTF-16 units; the last 799 (the ellipsis takes the 800th) begin
    // exactly on the LOW half of an emoji, which the cut has to step over.
    const out = cleanHandoffText(`x${'😀'.repeat(500)}`);
    const body = out.slice(1);
    expect(out.startsWith('…')).toBe(true);
    const first = body.charCodeAt(0);
    expect(first >= 0xdc00 && first <= 0xdfff, 'the kept text starts on a lone low surrogate').toBe(false);
  });

  it('handles a very long run of spaces inside a line in linear time', () => {
    // The Stop hook has a 10 s budget. A trailing-space pattern that retries
    // from every position of a run FOLLOWED BY TEXT takes ~4 s at 80,000 spaces
    // and ~15 s at 160,000; this run is 200,000 and must still be instant.
    const line = `first${' '.repeat(200_000)}last`;
    const started = Date.now();
    const out = cleanHandoffText(`${line}\nsecond line   `);
    const elapsed = Date.now() - started;
    // Far longer than the bound, so only the end survives.
    expect(out).toBe('…last\nsecond line');
    expect(elapsed).toBeLessThan(2_000);
  });

  it('returns an empty string when only code is left', () => {
    expect(cleanHandoffText('```js\nconsole.log(1)\n```')).toBe('');
    expect(cleanHandoffText('')).toBe('');
  });
});

describe('lastAssistantText', () => {
  it('walks back past tool-only lines to the newest line with text', () => {
    const jsonl = [
      asst(text('An older message that is not the last one.')),
      asst([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
      asst(text('The final words.')),
      asst([{ type: 'tool_use', id: 't2', name: 'Read', input: {} }]),
    ].join('\n');
    expect(lastAssistantText(jsonl)).toBe('The final words.');
  });

  it('joins the text blocks of one line and ignores non-text blocks', () => {
    const jsonl = asst([{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }]);
    expect(lastAssistantText(jsonl)).toBe('part one\npart two');
  });

  it('accepts string content', () => {
    expect(lastAssistantText(asst('plain string content'))).toBe('plain string content');
  });

  it('skips sub-agent lines', () => {
    const jsonl = [asst(text('the main agent said this')), asst(text('a sub-agent said this'), { isSidechain: true })].join('\n');
    expect(lastAssistantText(jsonl)).toBe('the main agent said this');
  });

  it('skips the synthetic lines Claude Code writes for API errors', () => {
    const jsonl = [
      asst(text('the real last message')),
      line({ type: 'assistant', isApiErrorMessage: true, message: { content: text('API Error: 529 overloaded') } }),
      line({ type: 'assistant', message: { model: '<synthetic>', content: text('No response requested.') } }),
    ].join('\n');
    expect(lastAssistantText(jsonl)).toBe('the real last message');
  });

  it('ignores user lines and torn lines, and returns null when there is nothing', () => {
    expect(lastAssistantText([line({ type: 'user', message: { content: 'hi' } }), '{"type":"assis'].join('\n'))).toBeNull();
    expect(lastAssistantText('')).toBeNull();
    expect(lastAssistantText(asst(text('   \n  ')))).toBeNull();
  });
});

describe('the handoff is one entity per project and nobody else lists it', () => {
  it('is named per project', () => {
    expect(sessionHandoffName('acme')).toBe(`${SESSION_HANDOFF_TYPE}:acme`);
  });

  it('groupTopology drops it, in the project pool and as a foreign one', () => {
    const sections = groupTopology([
      { name: 'session-handoff:acme', type: SESSION_HANDOFF_TYPE, title: 'Where the last session left off' },
      { name: 'session-handoff:other', type: SESSION_HANDOFF_TYPE, title: 'Where the last session left off', foreign: true },
      { name: 'decision-1', type: 'decision', title: 'use sqlite' },
    ], 'acme');
    const listed = sections.flatMap((s) => s.entities.map((e) => e.name));
    expect(listed).toEqual(['decision-1']);
  });

  it('is kept out of the knowledge radar', () => {
    expect(NOISE_TYPES.has(SESSION_HANDOFF_TYPE)).toBe(true);
  });
});
