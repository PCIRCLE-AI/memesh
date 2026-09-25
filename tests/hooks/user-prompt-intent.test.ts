import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

import {
  detectRememberIntent,
  buildHint,
  INTENT_PATTERNS,
} from '../../scripts/hooks/user-prompt-intent.js';

// Two test tiers:
// - Unit (in-process): exercises detectRememberIntent / buildHint / regex
//   matrix. Fast, no subprocess, no env overrides needed.
// - Integration (subprocess): exercises stdin/stdout/exit-code/env-flag
//   contract. Hermetic via HOME override into a tmp dir so tests do not
//   read the developer's real ~/.memesh/config.json
//   (consistent with tests/hooks/config-precedence.test.ts pattern).

const HOOK_PATH = path.resolve('scripts/hooks/user-prompt-intent.js');

describe('Feature: User Prompt Intent Hook', () => {
  describe('Unit — detectRememberIntent (regex matrix)', () => {
    describe('English imperative — sentence-initial', () => {
      it.each([
        'remember this',
        'Remember this preference',
        'Please remember this for later sessions',
        'memorize this preference',
        'Please memorize that detail',
      ])('detects: %s', (prompt) => {
        expect(detectRememberIntent(prompt)).toBe(true);
      });

      it.each([
        'Do you remember when we discussed this?',
        "I remember reading the docs but can't find it",
        'Do you remember the docs?',
        'do you remember the API key we used last week?',
        'You remember this from before',
        'Did you remember to commit?',
      ])('does NOT match conversational: %s', (prompt) => {
        expect(detectRememberIntent(prompt)).toBe(false);
      });
    });

    describe('Save/add/store/write — memesh-only policy', () => {
      it.each([
        'save this to memesh',
        'save it to memesh',
        'save this to memesh as a lesson',
        'add this to memesh please',
        'store this in memesh',
        'put it into memesh',
        'write this to memesh.',
        'save to memesh',
        'add to memesh as a fact',
        'Please store this in memesh',
      ])('detects: %s', (prompt) => {
        expect(detectRememberIntent(prompt)).toBe(true);
      });

      it.each([
        // Generic "memory" — intentionally excluded from save-class verbs
        // (collides with RAM/heap technical noun).
        'save this to memory',
        'save the buffer to memory then flush',
        'add to memory leak',
        'store this in memory cache',
        'put this into memory pool',
        'write to memory mapped IO',
        'How do I save this array to memory in Python?',
        'I want to write it into memory and benchmark',
        'We add it to memory at boot time',
        'Help me debug the memory leak in this code',
        // Unrelated verbs / save actions
        'save this file as JSON',
        'git stash save the work',
        // Interrogative — sentence-initial anchor blocks
        'What does save to memesh do?',
        'How does store this in memesh behave under conflict?',
      ])('does NOT match: %s', (prompt) => {
        expect(detectRememberIntent(prompt)).toBe(false);
      });
    });

    describe('CJK', () => {
      it.each([
        '把這個記下來',
        '記下來',
        '請記到 memesh',
        '存到 memesh',
        '寫進記憶',
        '存進記憶',
      ])('detects: %s', (prompt) => {
        expect(detectRememberIntent(prompt)).toBe(true);
      });

      it.each([
        '我記到他昨天說過這件事',           // narrative recall, not imperative
        '我記到 console',                    // log-to-console, different verb
        '他突然記憶起來那段往事',           // narrative (former 記憶起來 false positive)
      ])('does NOT match CJK narrative: %s', (prompt) => {
        expect(detectRememberIntent(prompt)).toBe(false);
      });
    });

    describe('Spanish', () => {
      it.each([
        'recordar esto',
        'Recordar eso para más tarde',
        'Por favor recordar esto',
        'memorizar eso',
        'guardar esto en memesh',
        'guardar en memesh',
        'añadir esto a memesh',
        'Por favor almacenar eso en memesh',
      ])('detects: %s', (prompt) => {
        expect(detectRememberIntent(prompt)).toBe(true);
      });

      it.each([
        '¿Recuerdas esto?',                  // interrogative
        'Yo recuerdo cuando discutimos eso', // narrative
        'guardar este archivo',              // generic save (no "memesh")
      ])('does NOT match: %s', (prompt) => {
        expect(detectRememberIntent(prompt)).toBe(false);
      });
    });

    describe('French', () => {
      it.each([
        'rappeler ceci',
        'Rappeler cela pour plus tard',
        "S'il vous plaît rappeler ça",
        'mémoriser ceci',
        'sauvegarder ceci dans memesh',
        'sauvegarder dans memesh',
        'enregistrer cela à memesh',
        "S'il vous plaît ajouter ça dans memesh",
      ])('detects: %s', (prompt) => {
        expect(detectRememberIntent(prompt)).toBe(true);
      });

      it.each([
        'Te rappelles-tu ceci?',             // interrogative
        'Je rappelle quand nous avons discuté', // narrative
        'sauvegarder ce fichier',            // generic save (no "memesh")
      ])('does NOT match: %s', (prompt) => {
        expect(detectRememberIntent(prompt)).toBe(false);
      });
    });

    describe('Portuguese', () => {
      it.each([
        'lembrar isto',
        'Lembrar isso para mais tarde',
        'Por favor lembrar isto',
        'memorizar isso',
        'salvar isto em memesh',
        'salvar em memesh',
        'guardar isso no memesh',
        'Por favor adicionar isto em memesh',
        'armazenar isso em memesh',
      ])('detects: %s', (prompt) => {
        expect(detectRememberIntent(prompt)).toBe(true);
      });

      it.each([
        'Você lembra disto?',                // interrogative
        'Eu lembro quando discutimos isso', // narrative
        'salvar este arquivo',               // generic save (no "memesh")
      ])('does NOT match: %s', (prompt) => {
        expect(detectRememberIntent(prompt)).toBe(false);
      });
    });

    describe('Multi-line / mid-prompt intent', () => {
      it('detects intent after multi-line content paste', () => {
        expect(
          detectRememberIntent('Here is my note:\n\nfoo bar baz.\n\nRemember this for me.'),
        ).toBe(true);
      });

      it('detects intent after newline boundary', () => {
        expect(detectRememberIntent('first line.\nRemember this.')).toBe(true);
      });
    });

    describe('Type robustness', () => {
      it.each([
        ['', false],
        [null, false],
        [undefined, false],
        [12345, false],
        [['array', 'remember this'], false],
        [{ nested: 'remember this' }, false],
        [true, false],
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
        expect(result).toBe(true);
        expect(elapsed).toBeLessThan(50);
      });

      it('completes within 50ms on adversarial CJK input', () => {
        const big = ('我記到他說過。'.repeat(2000)) + '把這個記下來';
        const start = Date.now();
        const result = detectRememberIntent(big);
        const elapsed = Date.now() - start;
        expect(result).toBe(true);
        expect(elapsed).toBeLessThan(50);
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

    describe('Wire-level intent detection', () => {
      it('emits hint on prompt field', () => {
        expectHint(runHook({ prompt: 'remember this preference' }));
      });

      it('emits hint on legacy user_prompt field', () => {
        expectHint(runHook({ user_prompt: 'remember this fact' }));
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
