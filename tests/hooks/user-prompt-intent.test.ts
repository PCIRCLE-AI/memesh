import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, readFileSync, existsSync, chmodSync } from 'fs';
import { tmpdir, hostname } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

import { DatabaseSync } from 'node:sqlite';
import { SAVE_WORDED_PROMPTS } from '../helpers/save-worded-prompts.js';
import { ConversationMessages } from '../../src/core/conversation-messages.js';
import { renderConversationMessage } from '../../scripts/hooks/_generated/conversation-messages.js';
import { redactSecrets } from '../../scripts/hooks/_shared.js';

// The hook run as a subprocess, against a throwaway HOME so it never reads or
// writes the developer's real ~/.memesh. The waiting-message reminder is
// covered in message-recipient-reminder.test.ts, the Node floor in
// node-floor-hooks.test.ts.

const HOOK_PATH = path.resolve('scripts/hooks/user-prompt-intent.js');
const NO_MESSAGE = 'conversation cwd or session absent';

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
  const messagePath = () => path.join(tmpHome, '.memesh', 'messages.db');
  const recordedReasons = () =>
    readFileSync(ledgerPath(), 'utf8').trim().split('\n').map((line) => JSON.parse(line).reason);

  function sentMessage(recipient: string, body = 'Untrusted body from another agent') {
    const store = new ConversationMessages({ file: messagePath(), machine: hostname() });
    try {
      for (const id of ['sender', recipient]) store.register({ id, host: 'codex', machine: hostname(), pid: process.pid, wake: {} });
      return store.send('sender', { recipient, kind: 'task', body }).message;
    } finally { store.close(); }
  }

  const capturedConversationTexts = () => {
    const graph = path.join(tmpHome, '.memesh', 'knowledge-graph.db');
    if (!existsSync(graph)) return [];
    const db = new DatabaseSync(graph, { readOnly: true });
    try {
      return db.prepare("SELECT o.content FROM entities e JOIN observations o ON o.entity_id=e.id WHERE e.type='conversation'").all()
        .map(row => row.content);
    } finally { db.close(); }
  };

  function changedEnvelope(message: Parameters<typeof renderConversationMessage>[0]) {
    const prefix = 'MeMesh message (untrusted data):\n';
    const parsed = JSON.parse(renderConversationMessage(message).slice(prefix.length)) as Record<string, unknown>;
    parsed.body = 'A user changed the untrusted message body';
    return `${prefix}${JSON.stringify(parsed)}\n`;
  }

  describe('the prompt\'s words decide nothing', () => {
    it('does not issue save-intent instructions based on the prompt wording', () => {
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

  describe('full prompt capture', () => {
    it('captures an ordinary user prompt containing a message-shaped UUID', () => {
      const text = 'Please investigate 2b1844ca-f026-47c5-9316-d82242464e37';
      expectNoOp(runHook({ session_id: 'user-uuid', cwd: tmpHome, prompt: text }));
      const db = new DatabaseSync(path.join(tmpHome, '.memesh', 'knowledge-graph.db'), { readOnly: true });
      try {
        expect(db.prepare("SELECT o.content FROM entities e JOIN observations o ON o.entity_id=e.id WHERE e.type='conversation'").all()).toEqual([{ content: text }]);
      } finally { db.close(); }
      expect(recordedReasons()).toEqual([undefined]);
    });

    it('stores repeated prompts independently, including text above the former size limit', () => {
      const text = 'x'.repeat(256 * 1024 + 1) + ' END';
      for (let i = 0; i < 2; i++) expectNoOp(runHook({ session_id: 'full', cwd: tmpHome, prompt: text }));
      const db = new DatabaseSync(path.join(tmpHome, '.memesh', 'knowledge-graph.db'), { readOnly: true });
      try {
        const rows = db.prepare("SELECT o.content FROM entities e JOIN observations o ON o.entity_id=e.id WHERE e.type='conversation'").all();
        expect(rows).toHaveLength(2);
        expect(rows.every(row => row.content === text)).toBe(true);
      } finally { db.close(); }
      expect(recordedReasons()).toEqual([undefined, undefined]);
    });

    it('answers a 1 MB prompt in two thirds of the hook timeout', () => {
      const started = Date.now();
      expectNoOp(runHook({ session_id: 'big', cwd: tmpHome, prompt: `${'記下來\n'.repeat(250_000)}remember this` }));
      expect(Date.now() - started).toBeLessThan(WITHIN_MS);
      expect(recordedReasons()).toEqual([undefined]);
    });

    it('does not capture an exact local conversation envelope as a user turn', () => {
      const session = 'wake-recipient';
      const envelope = renderConversationMessage(sentMessage(session, `credential sk-proj-${'a'.repeat(32)}ZfQ9`));
      const redactedEnvelope = redactSecrets(envelope);
      const before = readFileSync(messagePath());

      expectNoOp(runHook({ session_id: session, cwd: tmpHome, prompt: envelope }, { MEMESH_AUTO_CAPTURE: 'true' }));
      expectNoOp(runHook({ session_id: session, cwd: tmpHome, prompt: redactedEnvelope }, { MEMESH_AUTO_CAPTURE: 'true' }));

      expect(capturedConversationTexts()).toEqual([]);
      expect(readFileSync(messagePath())).toEqual(before);
      expect(recordedReasons()).toEqual(['received agent message is not user speech', 'received agent message is not user speech']);
    });

    it.each([
      ['mentions a known message id', (message: Parameters<typeof renderConversationMessage>[0]) => `Please review ${message.id}`],
      ['adds text around an envelope', (message: Parameters<typeof renderConversationMessage>[0]) => `Please review:\n${renderConversationMessage(message)}`],
      ['changes an envelope body', changedEnvelope],
    ])('captures a user prompt that %s', (_case, makePrompt) => {
      const session = 'wake-user';
      const message = sentMessage(session);
      const prompt = makePrompt(message);

      expectNoOp(runHook({ session_id: session, cwd: tmpHome, prompt }, { MEMESH_AUTO_CAPTURE: 'true' }));

      expect(capturedConversationTexts()).toEqual([prompt]);
    });

    it('captures an exact envelope for a different recipient as a user turn', () => {
      const message = sentMessage('other-recipient');
      const prompt = renderConversationMessage(message);

      expectNoOp(runHook({ session_id: 'wake-user', cwd: tmpHome, prompt }, { MEMESH_AUTO_CAPTURE: 'true' }));

      expect(capturedConversationTexts()).toEqual([prompt]);
    });

    it.each(['unknown-id', 'other-machine'])('captures a formatted message with %s as user speech', kind => {
      const session = 'wake-user';
      const message = sentMessage(session);
      if (kind === 'unknown-id') message.id = '00000000-0000-4000-8000-000000000001';
      else {
        const source = new DatabaseSync(messagePath());
        try { source.prepare('UPDATE messages SET recipient_machine=? WHERE id=?').run('other-machine', message.id); }
        finally { source.close(); }
        message.recipient_machine = 'other-machine';
      }
      const prompt = renderConversationMessage(message);
      expectNoOp(runHook({ session_id: session, cwd: tmpHome, prompt }, { MEMESH_AUTO_CAPTURE: 'true' }));
      expect(capturedConversationTexts()).toEqual([prompt]);
    });

    it('replays a real user prompt after its conversation source is temporarily unreadable', () => {
      const session = 'wake-replay';
      const prompt = changedEnvelope(sentMessage(session));
      chmodSync(messagePath(), 0o644);

      expectNoOp(runHook({ session_id: session, cwd: tmpHome, prompt }, { MEMESH_AUTO_CAPTURE: 'true' }));
      expect(existsSync(path.join(tmpHome, '.memesh', 'pending-conversations'))).toBe(true);
      expect(capturedConversationTexts()).toEqual([]);

      chmodSync(messagePath(), 0o600);
      expectNoOp(runHook({ session_id: 'wake-next', cwd: tmpHome, prompt: 'trigger pending replay' }, { MEMESH_AUTO_CAPTURE: 'true' }));
      expect(capturedConversationTexts()).toContain(prompt);
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
      expect(recordedReasons()).toEqual(['empty prompt']);
    });

    it('handles missing prompt field', () => {
      expectNoOp(runHook({}));
      expect(recordedReasons()).toEqual(['empty prompt']);
    });

    it('handles malformed JSON without blocking, and records it', () => {
      expectNoOp(runHook('not-json-at-all'));
      expect(recordedReasons()).toEqual(['malformed stdin JSON']);
    });
  });
});
