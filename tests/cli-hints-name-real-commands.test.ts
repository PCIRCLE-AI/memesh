/**
 * Every `memesh <command>` a CLI message tells the user to run must be a
 * command the CLI registers, and must not be a retired one.
 *
 * A user-facing hint once named a retired command, and a first correction
 * named a command that never existed. Nothing compared hint text to the
 * command registry in either direction; this does.
 *
 * Same shape as http-clients-call-real-routes.test.ts: mentions are scanned
 * from source text, the registry they must exist in comes from the
 * `.command('name')` registrations in the same file.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = fs.readFileSync(path.join(repoRoot, 'src/transports/cli/cli.ts'), 'utf8');

/** Every name `.command('...')` registers, top-level and sub-command alike. */
const registeredNames = new Set(
  [...cli.matchAll(/\.command\((['"`])([A-Za-z][A-Za-z0-9-]*)/g)].map(m => m[2])
);

/**
 * Every backticked `memesh <word> [<word>]` in a user-facing string. The
 * enclosing LINE decides intent: a line that itself talks about retirement
 * (the stub's own message, this class of comment) may name the dead command;
 * any other line is a live recommendation and must point at something real.
 */
function hintMentions(): Array<{ line: string; tokens: string[] }> {
  const out: Array<{ line: string; tokens: string[] }> = [];
  for (const line of cli.split('\n')) {
    // Comments talk to maintainers, not users — and they legitimately name
    // dead or made-up commands ("`memesh nonexistent-cmd`") as examples.
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    for (const m of line.matchAll(/`memesh ([a-z][a-z0-9-]*)(?: ([a-z][a-z0-9-]*))?/g)) {
      out.push({
        line: line.trim(),
        tokens: [m[1], m[2]].filter((tok): tok is string => Boolean(tok)),
      });
    }
  }
  return out;
}

describe('CLI hints name real commands', () => {
  it('the command registry was actually extracted', () => {
    expect(registeredNames.size).toBeGreaterThan(15);
    expect(registeredNames.has('doctor')).toBe(true);
    expect(registeredNames.has('dream')).toBe(true);
    expect(registeredNames.has('feedback')).toBe(true);
    expect(registeredNames.has('consolidate')).toBe(false);
  });

  it('hints were actually found', () => {
    // The CLI's whole help style leans on `memesh <cmd>` mentions; zero
    // matches means the extraction rotted, not that the hints are gone.
    expect(hintMentions().length).toBeGreaterThan(3);
  });

  it('every recommended command exists and is not retired', () => {
    const bad: string[] = [];
    for (const { line, tokens } of hintMentions()) {
      // The first token is always the top-level command. A second token can
      // be either a subcommand or a positional argument, so it is not guessed.
      const [head] = tokens;
      if (!registeredNames.has(head)) bad.push(line);
    }
    expect(bad).toEqual([]);
  });
});
