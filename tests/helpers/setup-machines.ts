/**
 * Machines for `memesh setup` (#528): what is installed and what is wired, and what each way of running
 * `setup` must answer. The table is data so the same rows drive the test and the report of the rule.
 */
import fs from 'fs';
import path from 'path';
import type { Machine } from './cli-machine.js';

export interface SetupMachine {
  claudeDir?: boolean;
  /**
   * The `claude` command exists; its `mcp get` answers registered / not registered / is killed. `add-ignored`
   * answers "not registered" and, asked to register, exits 0 and registers nothing.
   */
  claudeCommand?: 'registered' | 'unregistered' | 'killed' | 'add-ignored';
  claudeHooks?: boolean;
  codexDir?: boolean;
  codexCommand?: 'registered' | 'unregistered' | 'killed' | 'add-ignored';
  geminiCommand?: 'wired' | 'unwired';
}

/** [exit code, words in the output (stdout and stderr together)]. */
export type Expectation = [number, string[]];

export interface SetupRow {
  name: string;
  machine: SetupMachine;
  check: Expectation;
  /** `memesh setup` with no flag, not on a terminal. */
  plain: Expectation;
  yes: Expectation;
}

const NOT_CHECKED_CODEX = 'Not checked: Codex CLI (the codex command is not on PATH';
const NOTHING_CONFIRMED = ['Nothing to wire automatically — see the lines above.', 'Nothing could be confirmed wired', NOT_CHECKED_CODEX, 'run `memesh setup --check` again'];
const WIRED = ['Everything present is wired. Nothing to do.'];
const NOT_A_TERMINAL = ['Not a terminal and --yes not given — nothing was changed'];

export const SETUP_ROWS: SetupRow[] = [
  { name: 'no host at all', machine: {},
    check: [1, ['No supported agent host was found']], plain: [1, ['No supported agent host was found']], yes: [1, ['No supported agent host was found']] },
  { name: 'Claude Code with hooks and MCP wired',
    machine: { claudeDir: true, claudeCommand: 'registered', claudeHooks: true },
    check: [0, WIRED], plain: [0, WIRED], yes: [0, WIRED] },
  { name: 'Claude Code hooks wired, no claude command',
    machine: { claudeDir: true, claudeHooks: true },
    check: [0, ['Everything that could be checked is wired.', 'Not checked: Claude Code (claude CLI not on PATH']],
    plain: [0, ['Everything that could be checked is wired.', 'Not checked: Claude Code']],
    yes: [0, ['Everything that could be checked is wired.', 'Not checked: Claude Code']] },
  { name: 'Claude Code present, nothing wired',
    machine: { claudeDir: true, claudeCommand: 'unregistered' },
    check: [1, ['❌ Claude Code: hooks NOT wired']], plain: [1, NOT_A_TERMINAL],
    yes: [0, ['After wiring:', '✅ Claude Code: hooks wired', WIRED[0]]] },
  { name: 'Claude Code hooks wired, and `claude mcp add` succeeds without registering anything',
    machine: { claudeDir: true, claudeHooks: true, claudeCommand: 'add-ignored' },
    check: [1, ['❌ Claude Code']], plain: [1, NOT_A_TERMINAL], yes: [1, ['After wiring:', '❌ Claude Code']] },
  { name: 'Codex registered',
    machine: { codexCommand: 'registered' },
    check: [0, WIRED], plain: [0, WIRED], yes: [0, WIRED] },
  { name: 'Codex present, not registered',
    machine: { codexCommand: 'unregistered' },
    check: [1, ['❌ Codex CLI']], plain: [1, NOT_A_TERMINAL], yes: [0, ['After wiring:', WIRED[0]]] },
  { name: 'only a Codex folder, no codex command',
    machine: { codexDir: true },
    check: [1, NOTHING_CONFIRMED], plain: [1, NOTHING_CONFIRMED], yes: [1, NOTHING_CONFIRMED] },
  { name: 'codex mcp get is killed',
    machine: { codexCommand: 'killed' },
    check: [1, ['Nothing could be confirmed wired', 'codex mcp get failed to run']],
    plain: [1, ['Nothing could be confirmed wired']], yes: [1, ['Nothing could be confirmed wired']] },
  { name: 'Claude Code wired, and a Codex folder with no command',
    machine: { claudeDir: true, claudeCommand: 'registered', claudeHooks: true, codexDir: true },
    check: [0, ['Everything that could be checked is wired.', NOT_CHECKED_CODEX, 'run `memesh setup --check` again']],
    plain: [0, [NOT_CHECKED_CODEX]], yes: [0, [NOT_CHECKED_CODEX]] },
  { name: 'Claude Code hooks wired without its command, and a Codex folder with no command',
    machine: { claudeDir: true, claudeHooks: true, codexDir: true },
    check: [0, ['Not checked: Claude Code (', ' and Codex CLI (']],
    plain: [0, ['Not checked: Claude Code (', ' and Codex CLI (']], yes: [0, ['Not checked: Claude Code (', ' and Codex CLI (']] },
  { name: 'Claude Code not wired, and a Codex folder with no command',
    machine: { claudeDir: true, claudeCommand: 'registered', codexDir: true },
    check: [1, ['❌ Claude Code: hooks NOT wired']], plain: [1, NOT_A_TERMINAL],
    yes: [0, ['✅ Claude Code: hooks wired', 'Everything that could be checked is wired.', NOT_CHECKED_CODEX]] },
  { name: 'Gemini wired alone',
    machine: { geminiCommand: 'wired' },
    check: [0, WIRED], plain: [0, WIRED], yes: [0, WIRED] },
  { name: 'Gemini not wired',
    machine: { geminiCommand: 'unwired' },
    check: [1, ['❌ Gemini CLI']], plain: [1, NOT_A_TERMINAL], yes: [0, ['After wiring:', WIRED[0]]] },
  { name: 'Gemini wired, and a Codex folder with no command',
    machine: { geminiCommand: 'wired', codexDir: true },
    check: [0, [NOT_CHECKED_CODEX]], plain: [0, [NOT_CHECKED_CODEX]], yes: [0, [NOT_CHECKED_CODEX]] },
];

/** Builds the machine in a throwaway HOME. A fake agent command that is asked to register becomes registered. */
export function buildSetupMachine(m: Machine, spec: SetupMachine): void {
  const claudeDir = path.join(m.home, '.claude');
  if (spec.claudeDir) fs.mkdirSync(claudeDir, { recursive: true });
  if (spec.claudeHooks) {
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
      hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'x', _memesh: true }] }] },
    }));
  }
  if (spec.codexDir) fs.mkdirSync(path.join(m.home, '.codex'), { recursive: true });
  const agent = (name: string, mode: NonNullable<SetupMachine['claudeCommand']>) => {
    const state = path.join(m.root, `${name}-registered`);
    if (mode === 'killed') return m.fake(name, 'kill -9 $$');
    m.fake(name, [
      `if [ "$1" = mcp ] && [ "$2" = get ]; then [ -f "${state}" ] && exit 0; exit ${mode === 'registered' ? 0 : 1}; fi`,
      `if [ "$1" = mcp ] && [ "$2" = add ]; then ${mode === 'add-ignored' ? ':' : `: > "${state}"`}; exit 0; fi`,
      'exit 0',
    ].join('\n'));
  };
  if (spec.claudeCommand) agent('claude', spec.claudeCommand);
  if (spec.codexCommand) agent('codex', spec.codexCommand);
  if (spec.geminiCommand) {
    const settings = path.join(m.home, '.gemini', 'settings.json');
    if (spec.geminiCommand === 'wired') {
      fs.mkdirSync(path.dirname(settings), { recursive: true });
      fs.writeFileSync(settings, JSON.stringify({ mcpServers: { memesh: { command: 'memesh-mcp' } } }));
    }
    m.fake('gemini', `if [ "$1" = mcp ] && [ "$2" = add ]; then /bin/mkdir -p "${path.dirname(settings)}"; echo '{"mcpServers":{"memesh":{}}}' > "${settings}"; fi\nexit 0`);
  }
}
