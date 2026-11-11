import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

import {
  detectRememberIntent,
  stripNonUserBlocks,
  buildHint,
  buildDoNotSaveHint,
  INTENT_PATTERNS,
  MAX_PROMPT_CHARS,
} from '../../scripts/hooks/user-prompt-intent.js';

// Two test tiers:
// - Unit (in-process): exercises detectRememberIntent / buildHint / regex
//   matrix. Fast, no subprocess, no env overrides needed.
// - Integration (subprocess): exercises stdin/stdout/exit-code/env-flag
//   contract. Hermetic via HOME override into a tmp dir so tests do not
//   read the developer's real ~/.memesh/config.json
//   (consistent with tests/hooks/config-precedence.test.ts pattern).

const HOOK_PATH = path.resolve('scripts/hooks/user-prompt-intent.js');

type Intent = 'save' | 'do-not-save' | 'none';
type CorpusRow = { text: string; intent: Intent; lang: string; category: string };
/** What the detector answers for an intent: 'none' is null. */
const answerFor = (intent: Intent) => (intent === 'none' ? null : intent);
const CORPUS: CorpusRow[] = JSON.parse(readFileSync(path.resolve('tests/fixtures/remember-intent-corpus.json'), 'utf8'));

// The host kills the hook at the timeout hooks/hooks.json gives it; a timing test leaves a third of it spare.
const hookEntry = JSON.parse(readFileSync(path.resolve('hooks/hooks.json'), 'utf8')).hooks.UserPromptSubmit
  .flatMap((group: { hooks: { command: string; timeout: number }[] }) => group.hooks)
  .find((hook: { command: string }) => hook.command.endsWith('/user-prompt-intent.js'));
const HOOK_TIMEOUT_MS = hookEntry.timeout * 1000;
const WITHIN_MS = (HOOK_TIMEOUT_MS * 2) / 3;

describe('Feature: User Prompt Intent Hook', () => {
  describe('Unit — detectRememberIntent (regex matrix)', () => {
    // Every sentence with a known answer lives in the corpus, labelled by meaning:
    // a request to save, a request not to save, or neither. A rule change is judged against all of it.
    describe('the labelled corpus', () => {
      it('holds every answer in Chinese and English, save and neither in every language, each sentence once', () => {
        expect(new Set(CORPUS.map((row) => row.text)).size).toBe(CORPUS.length);
        for (const lang of ['zh', 'en', 'es', 'fr', 'pt']) {
          for (const intent of ['save', 'none'] as const) expect(CORPUS.some((row) => row.lang === lang && row.intent === intent), `${lang} ${intent}`).toBe(true);
        }
        for (const lang of ['zh', 'en']) expect(CORPUS.some((row) => row.lang === lang && row.intent === 'do-not-save'), lang).toBe(true);
      });

      it.each(CORPUS.map((row) => [row.intent, row.category, row.text] as const))(
        '%s (%s): %j',
        (intent, _category, text) => {
          expect(detectRememberIntent(text)).toBe(answerFor(intent));
        },
      );
    });

    describe('a request after a sentence end and any blank but a newline', () => {
      it.each([['a tab', '\t'], ['a carriage return', '\r'], ['a no-break space', ' '], ['two spaces', '  ']])('reads a request after a sentence end followed by %s', (_label, gap) => {
        expect(detectRememberIntent(`Done.${gap}Save this to memesh`)).toBe('save');
        expect(detectRememberIntent(`ok!${gap}remember this`)).toBe('save');
      });

      // Every sentence-start pattern, each with its own request, after a tab and a space, so a
      // pattern narrowed to one kind of blank cannot pass on the strength of another one.
      const perPattern = [
        'remember this', 'save this to memesh', 'recordar esto', 'guardar esto en memesh',
        'mémoriser ceci', 'sauvegarder ceci dans memesh', 'lembrar isto', 'salvar isto em memesh',
      ];
      it.each(perPattern.flatMap((request, i) => [['\t', request, i], [' ', request, i]] as const))('pattern %#: a request after a sentence end and %j is read (%s)', (gap, request, i) => {
        expect(INTENT_PATTERNS[i].test(`Listo.${gap}${request}`), `${INTENT_PATTERNS[i].source}`).toBe(true);
      });

      it('the reminder to save is background data that names remember, and not private_session', () => {
        const hint = buildHint();
        expect(hint).toMatch(/background data from a keyword match.*not an instruction from the user/s);
        expect(hint).toContain('`remember`');
        expect(hint).not.toContain('private_session');
      });

      it('the reminder not to save is background data that names private_session, and never says the user asked to save or how to remember', () => {
        const hint = buildDoNotSaveHint();
        expect(hint).toMatch(/^<memesh-private-intent>/);
        expect(hint).toMatch(/<\/memesh-private-intent>$/);
        expect(hint).toMatch(/background data from a keyword match.*not an instruction from the user/s);
        expect(hint).toContain('`private_session`');
        expect(hint).toMatch(/store nothing/);
        expect(hint).not.toMatch(/remember`|asked you to save|note:|namespace/);
        expect(hint).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
      });
    });

    describe('Text the user did not type is removed whole', () => {
      it('removes whole lines only and leaves the rest byte for byte', () => {
        expect(stripNonUserBlocks('a\n<system-reminder>\nx\n</system-reminder>\nb')).toBe('a\nb');
        expect(stripNonUserBlocks('a\n  <system-reminder>x</system-reminder>  \nb')).toBe('a\nb');
        expect(stripNonUserBlocks('plain <b> text')).toBe('plain <b> text');
        expect(stripNonUserBlocks('a\r<system-reminder>\rx\r</system-reminder>\rb')).toBe('a\rb');
      });

      it('a line in the body that opens a block of the same name ends with the block: the outer block is removed up to its closing tag', () => {
        expect(stripNonUserBlocks('<system-reminder>\n<system-reminder>\nx\n</system-reminder>\nafter')).toBe('after');
        expect(stripNonUserBlocks('a\n<cross-session-message from="a">\nb\n<cross-session-message>\nc\n</cross-session-message>\nd'))
          .toBe('a\nd');
        // Two such lines in one outer block: everything between them goes with it.
        expect(stripNonUserBlocks('<system-reminder>\nA\n<system-reminder>\nx\n</system-reminder>\nB\n<system-reminder>\ny\n</system-reminder>\nC'))
          .toBe('C');
        // A same-name block that is properly nested is removed with its outer block, as before.
        expect(stripNonUserBlocks('<system-reminder>\na\n<system-reminder>\nb\n</system-reminder>\nc\n</system-reminder>\nd')).toBe('d');
      });
    });

    describe('the scan is linear in the prompt (a blank run after a sentence end excludes the newline: with `\\s*` the time grew with the square of the line breaks)', () => {
      it('no pattern puts `\\s*` right after a sentence boundary (the form whose time grows with the square of the line breaks)', () => {
        for (const re of INTENT_PATTERNS) expect(re.source).not.toMatch(/\[\.!\?\\n,\]\\s\*/);
      });

      it.each([
        ['64,000 newlines', '\n'.repeat(64_000)],
        ['64,000 blanks', ' '.repeat(64_000)],
        ['32,000 sentence ends', '. '.repeat(32_000)],
        ['newline and blank alternating', '\n \n '.repeat(16_000)],
        ['newlines with a request at the end', `${'\n'.repeat(64_000)}remember this`],
      ])('reads %s in under 100 ms', (_label, prompt) => {
        const started = performance.now();
        const found = detectRememberIntent(prompt);
        expect(performance.now() - started).toBeLessThan(100);
        expect(found).toBe(prompt.endsWith('remember this') ? 'save' : null);
      });

      it('each pattern matches exactly what its quadratic form matched, on random text built from its own pieces', () => {
        // The old form of each pattern: blanks after the boundary were `\s*`.
        const old = INTENT_PATTERNS.map((re) => new RegExp(re.source.replace('[^\\S\\n]*', '\\s*'), re.flags));
        expect(old.every((re, i) => re.source !== INTENT_PATTERNS[i].source), 'every old form differs from the new one').toBe(true);
        const pieces = ['remember this', 'save this to memesh', 'please ', 'Remember that', '\n', '\n\n', ' ', '  ', '.', '!', '?', ',', 'x', 'do you ', 'guardar en memesh', 'por favor ', '\t', 'rappeler ceci'];
        let seed = 12345;
        const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
        let matched = 0;
        for (let i = 0; i < 4000; i++) {
          const text = Array.from({ length: 1 + (next() % 8) }, () => pieces[next() % pieces.length]).join('');
          INTENT_PATTERNS.forEach((re, k) => {
            const expected = old[k].test(text);
            expect(re.test(text), `${k} ${JSON.stringify(text)}`).toBe(expected);
            if (expected) matched++;
          });
        }
        expect(matched, 'the random texts contain requests as well as non-requests').toBeGreaterThan(200);
      });
    });

    describe('Type robustness', () => {
      it.each([
        ['', null],
        [null, null],
        [undefined, null],
        [12345, null],
        [['array', 'remember this'], null],
        [{ nested: 'remember this' }, null],
        [true, null],
      ])('handles non-string prompt %p → %p', (input, expected) => {
        expect(detectRememberIntent(input as unknown as string)).toBe(expected);
      });
    });

    describe('ReDoS resistance', () => {
      it('completes within 50ms on a 10KB pathological input', () => {
        // Pathological: "aaaa..." with newline punctuation interspersed —
        // shape designed to maximise backtracking opportunities.
        const big = ('aaaa.\n'.repeat(2000)) + 'remember this';
        const start = Date.now();
        const result = detectRememberIntent(big);
        const elapsed = Date.now() - start;
        expect(result).toBe('save');
        expect(elapsed).toBeLessThan(50);
      });

      it('completes within 50ms on adversarial CJK input', () => {
        const big = ('我記到他說過。'.repeat(2000)) + '把這個記下來';
        const start = Date.now();
        const result = detectRememberIntent(big);
        const elapsed = Date.now() - start;
        expect(result).toBe('save');
        expect(elapsed).toBeLessThan(50);
      });
    });

    describe('Linear time on tag-shaped input', () => {
      // Relative thresholds: compare against the same machine's own time on a
      // plain string and against a smaller input, so a loaded CI runner does
      // not turn this red but a quadratic scan still does.
      const time = (fn: () => unknown) => {
        const runs: number[] = [];
        for (let i = 0; i < 3; i += 1) {
          const start = performance.now();
          fn();
          runs.push(performance.now() - start);
        }
        return Math.min(...runs);
      };

      it('1 MB of tag-dense text strips in at most 30 times the time of 1 MB of plain text, plus 100 ms', () => {
        const plain = 'abc def\n'.repeat(131072);
        const openers = '<system-reminder '.repeat(61681);
        const blocks = '<system-reminder>\nx\n</system-reminder>\n'.repeat(26214);
        const stacked = '<system-reminder>\n'.repeat(58254);
        const lts = '<'.repeat(1048576);
        const nested = `${'<system-reminder>\n'.repeat(29127)}${'</system-reminder>\n'.repeat(26000)}`;
        const base = time(() => stripNonUserBlocks(plain));
        for (const input of [openers, blocks, stacked, lts, nested]) {
          expect(input.length).toBeGreaterThanOrEqual(1000000);
          expect(time(() => stripNonUserBlocks(input))).toBeLessThan(100 + base * 30);
        }
      });

      it('time grows linearly with the number of unclosed tags', () => {
        const run = (n: number) => time(() => stripNonUserBlocks('<system-reminder '.repeat(n)));
        expect(run(80000)).toBeLessThan(run(20000) * 8 + 100);
      });

      // Each input makes every verb, or every match, be read and then turned
      // down, so a step that rescans the clause for each one shows up.
      it.each([
        ['statements', '我記下來了', ''],
        ['negations someone else said', '他不要記下來', ''],
        ['subjects of 把', '客戶把這個記下來', ''],
        ['relative clauses', '記下來的', ''],
        ['things done', '已記下', ''],
        ['objects after 把', '把他說的記下來了', ''],
        ['quote marks', '「', ''],
        ['double quotes', '"', ''],
        ['demonstratives', '這個', ''],
        ['English questions', 'remember this, ', '?'],
        ['English statements', 'save to memesh is slow, ', ''],
      ])('time grows linearly with the number of %s in one clause or sentence', (_label, unit, end) => {
        const run = (n: number) => time(() => expect(detectRememberIntent(`${unit.repeat(n)}${end}`)).toBe(null));
        expect(run(40000)).toBeLessThan(run(10000) * 8 + 50);
      });

      it('time grows linearly with the number of blank lines', () => {
        const run = (n: number) => time(() => detectRememberIntent('\n'.repeat(n)));
        expect(run(20000)).toBeLessThan(run(5000) * 8 + 50);
      });
    });

    describe('INTENT_PATTERNS export', () => {
      it('is an array of RegExp', () => {
        expect(Array.isArray(INTENT_PATTERNS)).toBe(true);
        expect(INTENT_PATTERNS.length).toBeGreaterThan(0);
        for (const re of INTENT_PATTERNS) {
          expect(re).toBeInstanceOf(RegExp);
        }
      });
    });
  });

  describe('Unit — buildHint structural assertions', () => {
    // Snapshot-style assertions that lock down behavior, not exact phrasing.
    // Rewording the hint text should not break these; structural changes (a
    // missing memesh tool call instruction, a missing scope decision tree) should.
    const hint = buildHint();

    it('names the memesh remember tool without a host-specific prefix (#442)', () => {
      // Under the Claude Code plugin the tool is mcp__plugin_memesh_memesh__remember;
      // a hard-coded mcp__memesh__ name is not in the agent's tool list.
      expect(hint).toMatch(/memesh `remember` tool/);
      expect(hint).not.toMatch(/mcp__memesh__/);
    });

    it('points project tags at the exact briefing project id, not a plain name (#408)', () => {
      expect(hint).toMatch(/memesh briefing --json/);
      expect(hint).not.toMatch(/tag:project:memesh/);
    });

    it('describes the scope decision tree (personal / project / global)', () => {
      expect(hint).toMatch(/namespace=personal/);
      expect(hint).toMatch(/project tag/i);
      expect(hint).toMatch(/namespace=global/);
    });

    it('instructs tool parameters (name, type, observations, tags, namespace)', () => {
      expect(hint).toMatch(/name:/);
      expect(hint).toMatch(/type:/);
      expect(hint).toMatch(/observations:/);
      expect(hint).toMatch(/tags:/);
      expect(hint).toMatch(/namespace:/);
    });

    it('says a decision needs why: (remember refuses one without it)', () => {
      expect(hint).toMatch(/A decision also needs why:/);
      expect(hint).toMatch(/what would make it stop holding/);
    });

    it('is wrapped in a recognisable tag pair', () => {
      expect(hint).toMatch(/^<memesh-remember-intent>/);
      expect(hint).toMatch(/<\/memesh-remember-intent>$/);
    });

    it('emits exactly one stdout-safe block (no embedded null/control bytes)', () => {
      // Stdout must be parsed as JSON downstream; control characters would corrupt it.
      expect(hint).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
    });
  });

  describe('Integration — subprocess (stdin/stdout/exit/env)', () => {
    let tmpHome: string;

    beforeEach(() => {
      // Hermetic HOME override — prevents tests from reading the developer's
      // real ~/.memesh/config.json (which could have autoCapture: false set).
      tmpHome = mkdtempSync(path.join(tmpdir(), 'memesh-uph-test-'));
      mkdirSync(path.join(tmpHome, '.memesh'), { recursive: true });
    });

    afterEach(() => {
      rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    function runHook(input: object | string, extraEnv: NodeJS.ProcessEnv = {}, hookPath: string = HOOK_PATH) {
      const stdinBody = typeof input === 'string' ? input : JSON.stringify(input);
      // Build a clean env: process.env minus MEMESH_* (so tests don't inherit
      // dev's local overrides), plus our isolated HOME and any test extras.
      const baseEnv = { ...process.env };
      for (const k of Object.keys(baseEnv)) {
        if (k.startsWith('MEMESH_')) delete baseEnv[k];
      }
      baseEnv.HOME = tmpHome;
      baseEnv.USERPROFILE = tmpHome; // Windows parity
      try {
        const stdout = execFileSync('node', [hookPath], {
          input: stdinBody,
          env: { ...baseEnv, ...extraEnv },
          encoding: 'utf8',
          timeout: 5000,
        });
        return { stdout: stdout.trim(), status: 0 as number | null };
      } catch (e: any) {
        return { stdout: (e.stdout ?? '').toString().trim(), status: (e.status ?? null) as number | null };
      }
    }

    function expectNoOp(result: { stdout: string; status: number | null }) {
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
    }

    function expectHint(result: { stdout: string; status: number | null }) {
      expect(result.status).toBe(0);
      expect(result.stdout).not.toBe('');
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
      expect(parsed.hookSpecificOutput?.additionalContext).toMatch(/memesh-remember-intent/);
      return parsed;
    }

    const recordedReasons = () => {
      const file = path.join(tmpHome, '.memesh', 'hook-outcomes.jsonl');
      return readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line).reason);
    };

    it('a prompt of 64,000 newlines is read in two thirds of the hook timeout and leaves a record', () => {
      expect(HOOK_TIMEOUT_MS).toBe(3000);
      const started = Date.now();
      const result = runHook({ session_id: 'perf', cwd: tmpHome, hook_event_name: 'UserPromptSubmit', prompt: '\n'.repeat(64_000) });
      expect(Date.now() - started).toBeLessThan(WITHIN_MS);
      expectNoOp(result);
      expect(recordedReasons()).toContain('the prompt carried no remember intent and no update decision');
    });

    it('reads a prompt of exactly 256 K characters and skips one character more (the documented limit)', () => {
      expect(MAX_PROMPT_CHARS).toBe(256 * 1024);
      const request = 'remember this';
      const pad = (length: number) => `${'x '.repeat(Math.ceil((length - request.length) / 2)).slice(0, length - request.length - 1)}\n${request}`;
      const atLimit = pad(MAX_PROMPT_CHARS);
      expect(atLimit.length).toBe(MAX_PROMPT_CHARS);
      const read = runHook({ session_id: 'at-limit', cwd: tmpHome, hook_event_name: 'UserPromptSubmit', prompt: atLimit });
      expect(read.stdout, 'a request at the limit is still found').toContain('remember');
      expect(recordedReasons()).not.toContain('the prompt is too large to scan for a remember intent');
      const over = pad(MAX_PROMPT_CHARS + 1);
      expect(over.length).toBe(MAX_PROMPT_CHARS + 1);
      const skipped = runHook({ session_id: 'over-limit', cwd: tmpHome, hook_event_name: 'UserPromptSubmit', prompt: over });
      expect(skipped.stdout).toBe('');
      expect(recordedReasons()).toContain('the prompt is too large to scan for a remember intent');
    });

    it('a prompt over the size the hook reads is skipped, and the run says so', () => {
      const result = runHook({ session_id: 'big', cwd: tmpHome, hook_event_name: 'UserPromptSubmit', prompt: `${'x '.repeat(MAX_PROMPT_CHARS)}\nremember this` });
      expectNoOp(result);
      expect(recordedReasons()).toContain('the prompt is too large to scan for a remember intent');
      expect(recordedReasons(), 'a prompt that was never scanned is not reported as having no intent').not.toContain('the prompt carried no remember intent and no update decision');
    });

    describe('Wire-level intent detection', () => {
      it('emits hint on prompt field', () => {
        expectHint(runHook({ prompt: 'remember this preference' }));
      });

      it('emits hint on legacy user_prompt field', () => {
        expectHint(runHook({ user_prompt: 'remember this fact' }));
      });

      it('emits no hint for a statement or a cross-session message, only for a request', () => {
        expectNoOp(runHook({ prompt: '這條已經記下來了，現在沒有動 repo' }));
        expectNoOp(runHook({
          prompt: '<cross-session-message from="a">我已經記下來了</cross-session-message>',
        }));
        expectHint(runHook({ prompt: '幫我記下來：部署前要先備份' }));
      });

      // The real hook on a sample of the corpus: one sentence of every language, category and answer.
      it('answers like the detector on one corpus sentence of every kind, each with its own reminder', () => {
        const sample = new Map<string, CorpusRow>();
        for (const row of CORPUS) {
          const key = `${row.lang} ${row.category} ${row.intent}`;
          if (!sample.has(key)) sample.set(key, row);
        }
        expect(sample.size).toBeGreaterThan(50);
        for (const row of sample.values()) {
          const result = runHook({ prompt: row.text });
          const label = JSON.stringify(row.text);
          expect(result.status, label).toBe(0);
          expect(result.stdout.includes('<memesh-remember-intent>'), label).toBe(row.intent === 'save');
          expect(result.stdout.includes('<memesh-private-intent>'), label).toBe(row.intent === 'do-not-save');
        }
      });

      it('a request not to save gets only the private-session reminder, and the record says which reminder it was', () => {
        const recorded = () => readFileSync(path.join(tmpHome, '.memesh', 'hook-outcomes.jsonl'), 'utf8')
          .trim().split('\n').map((line) => JSON.parse(line)).filter((r) => r.outcome === 'notified').map((r) => r.entity);
        const quiet = runHook({ prompt: '這次對話不要記下來' });
        expect(quiet.status).toBe(0);
        const context = JSON.parse(quiet.stdout).hookSpecificOutput.additionalContext;
        expect(context).toBe(buildDoNotSaveHint());
        expectHint(runHook({ prompt: '別忘了記下來' }));
        expect(recorded()).toEqual(['hint:do-not-save', 'hint:remember-intent']);
      });

      // runHook kills a run at 5 s; each run below must answer in two thirds of the host's timeout.
      const timed = (input: object) => {
        const start = Date.now();
        const result = runHook(input);
        return { ...result, elapsed: Date.now() - start };
      };

      it('answers 15,000 unclosed tags (the most that fits under MAX_PROMPT_CHARS) in two thirds of the hook timeout, and still sees the request after them', () => {
        const flood = timed({ prompt: `${'<system-reminder '.repeat(15000)}\n請記下來` });
        expectHint(flood);
        expect(flood.elapsed).toBeLessThan(WITHIN_MS);
        const plain = timed({ prompt: 'x '.repeat(125000) });
        expectNoOp(plain);
        expect(flood.elapsed).toBeLessThan(500 + plain.elapsed * 5);
      });

      it('answers 200 KB of blank lines in two thirds of the hook timeout, and still sees the request after them', () => {
        const blank = '\n'.repeat(200 * 1024);
        for (const [prompt, hint] of [[blank, false], [`${blank}remember this`, true]] as const) {
          const result = timed({ prompt });
          if (hint) expectHint(result);
          else expectNoOp(result);
          expect(result.elapsed).toBeLessThan(WITHIN_MS);
        }
      });

      // A run of sentence ends before a letter, with an update-check record in place: an older hook
      // read such a prompt for an answer to an update notice, in time that grew with its square.
      it('answers 200,000 full stops and a letter in two thirds of the hook timeout while an update record is present', () => {
        const version = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')).version;
        const now = new Date().toISOString();
        const record = JSON.stringify({ latestVersion: '99.0.0', lastAttemptAt: now, lastSuccessfulCheckAt: now });
        writeFileSync(path.join(tmpHome, '.memesh', `update-check.${version}.json`), record);
        const result = timed({ session_id: 'dots', cwd: tmpHome, hook_event_name: 'UserPromptSubmit', prompt: `${'.'.repeat(200_000)}a` });
        expectNoOp(result);
        expect(result.elapsed).toBeLessThan(WITHIN_MS);
        expect(recordedReasons()).toContain('the prompt carried no remember intent and no update decision');
      });

      // Each of these inputs is quadratic if a bound in the hook goes missing: a
      // verb whose clause is rescanned, or the lookup of the open tag a closing
      // tag belongs to.
      it('answers 1 MB of Chinese verbs and 120,000 unmatched tags in two thirds of the hook timeout', () => {
        for (const [prompt, hint] of [
          ['我記下來了'.repeat(200000), null],
          ['記下來'.repeat(300000), 'save'],
          [`${'<system-reminder>\n'.repeat(60000)}${'</task-notification>\n'.repeat(60000)}請記下來`, 'save'],
        ] as const) {
          // The detector itself answers each of them quickly and correctly...
          const start = Date.now();
          expect(detectRememberIntent(prompt)).toBe(hint);
          expect(Date.now() - start).toBeLessThan(WITHIN_MS);
          // ...and the hook, which does not scan a prompt over MAX_PROMPT_CHARS at all, answers without a hint.
          expect(prompt.length).toBeGreaterThan(MAX_PROMPT_CHARS);
          const result = timed({ prompt });
          expectNoOp(result);
          expect(result.elapsed).toBeLessThan(WITHIN_MS);
        }
      });

      it('does not emit hint on conversational prompt', () => {
        expectNoOp(runHook({ prompt: 'do you remember the docs?' }));
      });

      // A plugin cache or a global npm prefix is often reached through a
      // symlink. Node resolves `import.meta.url` to the real path and leaves
      // `process.argv[1]` as typed; a guard comparing the two unresolved made
      // this hook do nothing on every prompt and still report success, with
      // nothing to show for it in doctor.
      it('emits the hint when the hook is reached through a symlinked directory', (ctx) => {
        const linkParent = mkdtempSync(path.join(tmpdir(), 'memesh-uph-link-'));
        try {
          const hooksLink = path.join(linkParent, 'hooks-link');
          try {
            symlinkSync(path.dirname(HOOK_PATH), hooksLink, 'dir');
          } catch {
            console.warn('skipping the symlinked-hook test: symlinkSync is not permitted on this platform/user');
            ctx.skip();
            return;
          }
          const typed = path.join(hooksLink, 'user-prompt-intent.js');
          // Precondition: the typed path and its realpath really differ.
          expect(realpathSync(typed)).not.toBe(path.resolve(typed));
          expectHint(runHook({ prompt: 'remember this preference' }, {}, typed));
        } finally {
          rmSync(linkParent, { recursive: true, force: true });
        }
      });

      // Under `--preserve-symlinks-main`, Node leaves `import.meta.url`
      // UNRESOLVED for the main module, so a guard that only compares the
      // realpath'd typed path (never the unresolved one) goes silent through
      // the same symlinked directory as above.
      it('emits the hint through a symlinked directory under --preserve-symlinks-main', (ctx) => {
        const linkParent = mkdtempSync(path.join(tmpdir(), 'memesh-uph-link-psm-'));
        try {
          const hooksLink = path.join(linkParent, 'hooks-link');
          try {
            symlinkSync(path.dirname(HOOK_PATH), hooksLink, 'dir');
          } catch {
            console.warn('skipping the symlinked-hook --preserve-symlinks-main test: symlinkSync is not permitted on this platform/user');
            ctx.skip();
            return;
          }
          const typed = path.join(hooksLink, 'user-prompt-intent.js');
          expect(realpathSync(typed)).not.toBe(path.resolve(typed));
          expectHint(
            runHook(
              { prompt: 'remember this preference' },
              { NODE_OPTIONS: '--preserve-symlinks-main' },
              typed,
            ),
          );
        } finally {
          rmSync(linkParent, { recursive: true, force: true });
        }
      });
    });

    // Mirrors isMain()'s rule (scripts/lib/verify-core.mjs) for `node -`
    // (`argv[1]` is the literal `-`, no file to realpath) and `node -e`/`-p`
    // (the eval flag is in `process.execArgv`; `argv[1]` is just the
    // caller's first argument): importing the hook must not throw and must
    // emit nothing.
    describe('Entry-point guard: importing under `node -e` / `node -` does not throw', () => {
      it('importing the hook from `node -e` (its own path handed as an argument) does not throw and emits nothing, even with stdin that WOULD trigger a hint if the stdin pipeline incorrectly ran', () => {
        // argv[1] here is the hook's own path, the one handed to import(), so
        // without the eval-flag check the unresolved-path comparison matches
        // and treats this import as main. Matching stdin makes that
        // observable: it would emit the hint.
        const importIt = "import(require('node:url').pathToFileURL(process.argv[1]).href)";
        const result = spawnSync(process.execPath, ['-e', importIt, HOOK_PATH], {
          encoding: 'utf8',
          timeout: 5000,
          input: JSON.stringify({ prompt: 'remember this preference' }),
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe('');
      });

      // The guard's realpath fallback is left to throw: an entry file that
      // vanished before the import must fail loudly, not read "not main".
      it('importing the hook after its entry file vanished fails with ENOENT instead of reading "not main"', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'memesh-uph-vanished-'));
        try {
          const entry = path.join(dir, 'entry.mjs');
          writeFileSync(
            entry,
            "import { unlinkSync } from 'node:fs';\nimport { fileURLToPath } from 'node:url';\n" +
              `unlinkSync(fileURLToPath(import.meta.url));\nawait import(${JSON.stringify(pathToFileURL(HOOK_PATH).href)});\n`,
          );
          const result = spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 5000 });
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain('ENOENT');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it('importing the hook while the process itself was started via `node -` (stdin) does not throw and emits nothing', () => {
        const stdinScript = `import ${JSON.stringify(pathToFileURL(HOOK_PATH).href)};\n`;
        const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
          input: stdinScript,
          encoding: 'utf8',
          timeout: 5000,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe('');
      });
    });

    describe('Stdin handling', () => {
      it('handles empty stdin gracefully', () => {
        expectNoOp(runHook(''));
      });

      it('handles missing prompt field', () => {
        expectNoOp(runHook({}));
      });

      it('handles malformed JSON without blocking', () => {
        expectNoOp(runHook('not-json-at-all'));
      });

      it('produces a single stdout JSON object (no extra log noise)', () => {
        const r = runHook({ prompt: 'remember this' });
        expect(r.status).toBe(0);
        // Exactly parseable, no trailing content.
        expect(() => JSON.parse(r.stdout)).not.toThrow();
        expect(r.stdout.split('\n').filter((l: string) => l.length > 0).length).toBe(1);
      });
    });

    describe('Feature-flag precedence (env > config > default)', () => {
      it('default-on when env unset and no config file', () => {
        // No MEMESH_AUTO_CAPTURE in env, no ~/.memesh/config.json present.
        expectHint(runHook({ prompt: 'remember this fact' }));
      });

      it('default-on when env unset and config has autoCapture:true', () => {
        writeFileSync(
          path.join(tmpHome, '.memesh', 'config.json'),
          JSON.stringify({ autoCapture: true }),
        );
        expectHint(runHook({ prompt: 'remember this fact' }));
      });

      it('suppressed when env unset and config has autoCapture:false', () => {
        writeFileSync(
          path.join(tmpHome, '.memesh', 'config.json'),
          JSON.stringify({ autoCapture: false }),
        );
        expectNoOp(runHook({ prompt: 'remember this fact' }));
      });

      it('env=false wins over config:true', () => {
        writeFileSync(
          path.join(tmpHome, '.memesh', 'config.json'),
          JSON.stringify({ autoCapture: true }),
        );
        expectNoOp(
          runHook({ prompt: 'remember this fact' }, { MEMESH_AUTO_CAPTURE: 'false' }),
        );
      });

      it('env=true wins over config:false', () => {
        writeFileSync(
          path.join(tmpHome, '.memesh', 'config.json'),
          JSON.stringify({ autoCapture: false }),
        );
        expectHint(
          runHook({ prompt: 'remember this fact' }, { MEMESH_AUTO_CAPTURE: 'true' }),
        );
      });

      it('non-canonical env value falls through to config (e.g. "1" does NOT short-circuit)', () => {
        // _shared.js semantics: only literal "true"/"false" short-circuit;
        // anything else falls through to config. Pin this contract.
        writeFileSync(
          path.join(tmpHome, '.memesh', 'config.json'),
          JSON.stringify({ autoCapture: false }),
        );
        expectNoOp(
          runHook({ prompt: 'remember this fact' }, { MEMESH_AUTO_CAPTURE: '1' }),
        );
      });

      it('corrupt config falls back to default-on', () => {
        writeFileSync(path.join(tmpHome, '.memesh', 'config.json'), '{not valid json');
        expectHint(runHook({ prompt: 'remember this fact' }));
      });
    });
  });
});
