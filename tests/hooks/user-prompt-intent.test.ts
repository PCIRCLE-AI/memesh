import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

import { MAX_PROMPT_CHARS } from '../../scripts/hooks/user-prompt-intent.js';
import { SAVE_WORDED_PROMPTS } from '../helpers/save-worded-prompts.js';

// The hook run as a subprocess, against a throwaway HOME so it never reads or
// writes the developer's real ~/.memesh. The waiting-message reminder is
// covered in message-recipient-reminder.test.ts, the Node floor in
// node-floor-hooks.test.ts.

const HOOK_PATH = path.resolve('scripts/hooks/user-prompt-intent.js');
const NO_MESSAGE = 'no message was waiting for this session';
const TOO_LARGE = 'the prompt is larger than the hook accepts';

// The host kills the hook at the timeout hooks/hooks.json gives it; a timing test leaves a third of it spare.
const hookEntry = JSON.parse(readFileSync(path.resolve('hooks/hooks.json'), 'utf8')).hooks.UserPromptSubmit
  .flatMap((group: { hooks: { command: string; timeout: number }[] }) => group.hooks)
  .find((hook: { command: string }) => hook.command.endsWith('/user-prompt-intent.js'));
const HOOK_TIMEOUT_MS = hookEntry.timeout * 1000;
const WITHIN_MS = (HOOK_TIMEOUT_MS * 2) / 3;

describe('Feature: User Prompt Intent Hook', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(tmpdir(), 'memesh-uph-test-'));
    mkdirSync(path.join(tmpHome, '.memesh'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** The hook's environment: no inherited MEMESH_* override, the throwaway HOME. */
  function hookEnv(extraEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const baseEnv = { ...process.env };
    for (const k of Object.keys(baseEnv)) {
      if (k.startsWith('MEMESH_')) delete baseEnv[k];
    }
    return { ...baseEnv, HOME: tmpHome, USERPROFILE: tmpHome, ...extraEnv };
  }

  function runHook(input: object | string, extraEnv: NodeJS.ProcessEnv = {}, hookPath: string = HOOK_PATH) {
    const stdinBody = typeof input === 'string' ? input : JSON.stringify(input);
    try {
      const stdout = execFileSync('node', [hookPath], { input: stdinBody, env: hookEnv(extraEnv), encoding: 'utf8', timeout: 5000 });
      return { stdout: stdout.trim(), status: 0 as number | null };
    } catch (e: any) {
      return { stdout: (e.stdout ?? '').toString().trim(), status: (e.status ?? null) as number | null };
    }
  }

  function expectNoOp(result: { stdout: string; status: number | null }) {
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  }

  const ledgerPath = () => path.join(tmpHome, '.memesh', 'hook-outcomes.jsonl');
  const recordedReasons = () =>
    readFileSync(ledgerPath(), 'utf8').trim().split('\n').map((line) => JSON.parse(line).reason);

  describe('the prompt\'s words decide nothing', () => {
    it('says nothing about saving, whatever the prompt says, and records only that no message was waiting', () => {
      expect(SAVE_WORDED_PROMPTS.length).toBeGreaterThan(5);
      for (const prompt of ['hello there', ...SAVE_WORDED_PROMPTS]) {
        for (const input of [{ prompt }, { user_prompt: prompt }]) {
          const result = runHook(input);
          expectNoOp(result);
        }
      }
      const reasons = recordedReasons();
      expect(reasons).toHaveLength((SAVE_WORDED_PROMPTS.length + 1) * 2);
      expect(new Set(reasons)).toEqual(new Set([NO_MESSAGE]));
    });
  });

  describe('a prompt over the size the hook accepts', () => {
    it('accepts exactly 256 K characters and records one character more as skipped (the documented limit)', () => {
      expect(MAX_PROMPT_CHARS).toBe(256 * 1024);
      expectNoOp(runHook({ session_id: 'at-limit', cwd: tmpHome, prompt: 'x'.repeat(MAX_PROMPT_CHARS) }));
      expect(recordedReasons()).toEqual([NO_MESSAGE]);
      expectNoOp(runHook({ session_id: 'over-limit', cwd: tmpHome, prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) }));
      // The oversized prompt has its own record, not a second "no message" one.
      expect(recordedReasons()).toEqual([NO_MESSAGE, TOO_LARGE]);
    });

    it('answers a 1 MB prompt in two thirds of the hook timeout', () => {
      const started = Date.now();
      expectNoOp(runHook({ session_id: 'big', cwd: tmpHome, prompt: `${'記下來\n'.repeat(250_000)}remember this` }));
      expect(Date.now() - started).toBeLessThan(WITHIN_MS);
      expect(recordedReasons()).toEqual([TOO_LARGE]);
    });
  });

  // A plugin cache or a global npm prefix is often reached through a
  // symlink. Node resolves `import.meta.url` to the real path and leaves
  // `process.argv[1]` as typed; a guard comparing the two unresolved made
  // this hook do nothing on every prompt and still report success, with
  // nothing to show for it in doctor. The record is what shows it ran.
  describe('Entry point reached through a symlinked directory', () => {
    for (const [label, extraEnv] of [
      ['plain', {}],
      // Under `--preserve-symlinks-main`, Node leaves `import.meta.url`
      // UNRESOLVED for the main module, so a guard that only compares the
      // realpath'd typed path (never the unresolved one) goes silent.
      ['--preserve-symlinks-main', { NODE_OPTIONS: '--preserve-symlinks-main' }],
    ] as const) {
      it(`runs and leaves its record (${label})`, (ctx) => {
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
          expectNoOp(runHook({ prompt: 'hello there' }, extraEnv, typed));
          expect(recordedReasons()).toEqual([NO_MESSAGE]);
        } finally {
          rmSync(linkParent, { recursive: true, force: true });
        }
      });
    }
  });

  // Mirrors isMain()'s rule (scripts/lib/verify-core.mjs) for `node -`
  // (`argv[1]` is the literal `-`, no file to realpath) and `node -e`/`-p`
  // (the eval flag is in `process.execArgv`; `argv[1]` is just the
  // caller's first argument): importing the hook must not throw and must
  // not run the stdin pipeline, which would leave a record.
  describe('Entry-point guard: importing under `node -e` / `node -` does not throw', () => {
    it('importing the hook from `node -e` (its own path handed as an argument) does not throw and does not run the pipeline', () => {
      // argv[1] here is the hook's own path, the one handed to import(), so
      // without the eval-flag check the unresolved-path comparison matches
      // and treats this import as main; the record would show it.
      const importIt = "import(require('node:url').pathToFileURL(process.argv[1]).href)";
      const result = spawnSync(process.execPath, ['-e', importIt, HOOK_PATH], {
        encoding: 'utf8', timeout: 5000, env: hookEnv(), input: JSON.stringify({ prompt: 'hello there' }),
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('');
      expect(existsSync(ledgerPath())).toBe(false);
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
        const result = spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 5000, env: hookEnv() });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('ENOENT');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('importing the hook while the process itself was started via `node -` (stdin) does not throw and does not run the pipeline', () => {
      const stdinScript = `import ${JSON.stringify(pathToFileURL(HOOK_PATH).href)};\n`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
        input: stdinScript, encoding: 'utf8', timeout: 5000, env: hookEnv(),
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('');
      expect(existsSync(ledgerPath())).toBe(false);
    });
  });

  describe('Stdin handling', () => {
    it('handles empty stdin gracefully', () => {
      expectNoOp(runHook(''));
      expect(recordedReasons()).toEqual([NO_MESSAGE]);
    });

    it('handles missing prompt field', () => {
      expectNoOp(runHook({}));
      expect(recordedReasons()).toEqual([NO_MESSAGE]);
    });

    it('handles malformed JSON without blocking, and records it', () => {
      expectNoOp(runHook('not-json-at-all'));
      expect(recordedReasons()).toEqual(['malformed stdin JSON']);
    });
  });
});
