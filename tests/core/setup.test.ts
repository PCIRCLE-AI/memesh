/**
 * Machine-level wiring inspection — the question doctor structurally cannot
 * answer (doctor scopes every check to the invoked COPY; setup reads the
 * hosts' own state). Each test pins one detection branch against fixture
 * files and fake seams, because the expensive failures here are the quiet
 * ones: reporting "wired" for a host that is not, or prescribing an action
 * that would double-wire a plugin-managed machine.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { inspectHosts, setupVerdict, type HostStatus, type SetupSeams, type RunResult } from '../../src/core/setup.js';

let home: string;
const savedEnv: Record<string, string | undefined> = {};
const PINNED_ENV = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR'] as const;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-setup-'));
  // setup asks the process environment where Codex's (and, with no seam, Claude Code's)
  // configuration lives. Point both at folders that do not exist, so a machine
  // that has Codex running this suite (CODEX_HOME set) cannot change a result.
  for (const name of PINNED_ENV) {
    savedEnv[name] = process.env[name];
    process.env[name] = path.join(home, `no-such-${name.toLowerCase()}`);
  }
});

afterEach(() => {
  for (const name of PINNED_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name]; else process.env[name] = savedEnv[name];
  }
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const seams = (over: Partial<SetupSeams> = {}): SetupSeams => ({
  home: () => home,
  claudeConfigDir: () => undefined,
  isOnPath: () => false,
  run: () => ({ status: 1, stderr: '' }),
  ...over,
});

const byHost = (statuses: ReturnType<typeof inspectHosts>) =>
  Object.fromEntries(statuses.map((s) => [s.host, s]));

describe('inspectHosts', () => {
  it('looks where install-hooks writes when CLAUDE_CONFIG_DIR relocates Claude Code (#528)', () => {
    // Claude Code lives in a relocated directory and ~/.claude does not exist:
    // reporting "not found" here contradicted install-hooks and doctor.
    const relocated = path.join(home, 'relocated-claude');
    fs.mkdirSync(relocated, { recursive: true });
    fs.writeFileSync(path.join(relocated, 'settings.json'), JSON.stringify({
      hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'x', _memesh: true }] }] },
    }));
    const st = byHost(inspectHosts(seams({ claudeConfigDir: () => relocated })))['claude-code'];
    expect(st.present).toBe(true);
    expect(st.presenceDetail).toBe(relocated);
    expect(st.wiredDetail).toContain('hooks wired');
    // And without the relocation the same machine has no Claude Code at all.
    expect(byHost(inspectHosts(seams()))['claude-code'].present).toBe(false);
  });

  it('Claude Code is present when its command is on PATH even before it has made its directory, the way doctor judges it (#528)', () => {
    const none = byHost(inspectHosts(seams()))['claude-code'];
    expect(none.present).toBe(false);
    const byCommand = byHost(inspectHosts(seams({ isOnPath: (b) => b === 'claude', run: () => ({ status: 0, stderr: '' }) })))['claude-code'];
    expect(byCommand.present).toBe(true);
    expect(byCommand.presenceDetail).toBe('claude on PATH');
    expect(byCommand.actions.some((a) => a.kind === 'install-hooks')).toBe(true);
  });

  it('reads CLAUDE_CONFIG_DIR from the environment when no seam is given (#528)', () => {
    const relocated = path.join(home, 'env-relocated-claude');
    fs.mkdirSync(relocated, { recursive: true });
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = relocated;
    try {
      const { claudeConfigDir: _omitted, ...withoutSeam } = seams();
      void _omitted;
      const st = byHost(inspectHosts(withoutSeam as SetupSeams))['claude-code'];
      expect(st.present).toBe(true);
      expect(st.presenceDetail).toBe(relocated);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });

  it('the action that wires the hooks names the settings file it will really write (#528)', () => {
    const relocated = path.join(home, 'reloc-claude');
    fs.mkdirSync(relocated, { recursive: true });
    const st = byHost(inspectHosts(seams({ claudeConfigDir: () => relocated })))['claude-code'];
    const wire = st.actions.find((a) => a.kind === 'install-hooks');
    expect(wire?.label).toContain(path.join(relocated, 'settings.json'));
    expect(wire?.label).not.toContain('~/.claude');
    const plain = path.join(home, '.claude');
    fs.mkdirSync(plain, { recursive: true });
    const def = byHost(inspectHosts(seams()))['claude-code'].actions.find((a) => a.kind === 'install-hooks');
    expect(def?.label).toContain(path.join(plain, 'settings.json'));
  });

  it('Codex is present when its command is on PATH or its config directory exists, the way doctor judges it (#528)', () => {
    const saved = process.env.CODEX_HOME;
    const codexDir = path.join(home, 'codex-home');
    process.env.CODEX_HOME = codexDir;
    try {
      expect(byHost(inspectHosts(seams()))['codex'].present).toBe(false);
      const onPath = byHost(inspectHosts(seams({ isOnPath: (b) => b === 'codex', run: () => ({ status: 0, stderr: '' }) })))['codex'];
      expect(onPath.present).toBe(true);
      expect(onPath.presenceDetail).toBe('codex on PATH');
      fs.mkdirSync(codexDir, { recursive: true });
      const dirOnly = byHost(inspectHosts(seams()))['codex'];
      expect(dirOnly.present).toBe(true);
      expect(dirOnly.presenceDetail).toBe(codexDir);
      expect(dirOnly.wired).toBeNull();
      expect(dirOnly.wiredDetail).toContain('not on PATH');
      expect(dirOnly.actions).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved;
    }
  });

  it('reports absent hosts as absent, and absent is not a failure', () => {
    // A machine without Codex is not misconfigured — --check must not fail it.
    const statuses = inspectHosts(seams());
    for (const st of statuses) expect(st.present).toBe(false);
    expect(setupVerdict(statuses).exitCode).toBe(1); // nothing found is not "everything wired"
  });

  it('a plugin-managed Claude Code is fully wired, with NO actions', () => {
    // installHooks' own guard refuses to double-wire a plugin machine; setup
    // prescribing install-hooks here would fight that guard.
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const registry = path.join(home, 'installed_plugins.json');
    fs.writeFileSync(registry, JSON.stringify({
      plugins: { 'memesh@pcircle-memesh': [{ installPath: '/x', version: '4.6.0', scope: 'user' }] },
    }));

    const st = byHost(inspectHosts(seams({ installedPluginsPath: registry })))['claude-code'];
    expect(st.wired).toBe(true);
    expect(st.actions).toEqual([]);
    expect(st.wiredDetail).toContain('plugin v4.6.0');
  });

  it('a bare Claude Code dir gets BOTH actions: hooks and MCP registration', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const st = byHost(inspectHosts(seams({
      isOnPath: (bin) => bin === 'claude',
      run: () => ({ status: 1, stderr: '' }), // mcp get memesh → not registered
    })))['claude-code'];

    expect(st.wired).toBe(false);
    expect(st.actions.map((a) => a.kind)).toEqual(['install-hooks', 'run']);
    // The MCP action MUST be user-scoped: `claude mcp add` defaults to
    // LOCAL, which wires only the directory setup happens to run in — the
    // exact trap the engineering review caught in the design.
    const mcp = st.actions.find((a) => a.kind === 'run')!;
    expect(mcp.args).toEqual(['mcp', 'add', '-s', 'user', 'memesh', 'memesh-mcp']);
  });

  it('recognises the _memesh hook marker install-hooks stamps', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node x.js', _memesh: true }] }] },
    }));
    const st = byHost(inspectHosts(seams({
      isOnPath: (bin) => bin === 'claude',
      run: () => ({ status: 0, stderr: '' }), // mcp registered
    })))['claude-code'];

    expect(st.wired).toBe(true);
    expect(st.actions).toEqual([]);
  });

  it('non-memesh hooks do not count as wiring', () => {
    // The user's own hooks must never satisfy the check — that would report
    // a machine as capturing when memesh writes nothing.
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node their-hook.js' }] }] },
    }));
    const st = byHost(inspectHosts(seams()))['claude-code'];
    expect(st.wired).toBe(false);
    expect(st.actions.some((a) => a.kind === 'install-hooks')).toBe(true);
  });

  it('probes Codex through its own CLI, and trusts the exit code', () => {
    const calls: string[][] = [];
    const st = byHost(inspectHosts(seams({
      isOnPath: (bin) => bin === 'codex',
      run: (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stderr: '' }; },
    })))['codex'];

    expect(calls).toContainEqual(['codex', 'mcp', 'get', 'memesh']);
    expect(st.wired).toBe(true);
    expect(st.actions).toEqual([]);
  });

  it('an unregistered Codex gets the exact add command', () => {
    const st = byHost(inspectHosts(seams({
      isOnPath: (bin) => bin === 'codex',
      run: () => ({ status: 1, stderr: '' }),
    })))['codex'];
    expect(st.wired).toBe(false);
    expect(st.actions[0].args).toEqual(['mcp', 'add', 'memesh', '--', 'memesh-mcp']);
  });

  it('a failed Codex probe is UNKNOWN, never "wired"', () => {
    // status null = the probe could not run. Reporting wired=true on that
    // would be absence-as-evidence — the failure mode this repo audits for.
    const st = byHost(inspectHosts(seams({
      isOnPath: (bin) => bin === 'codex',
      run: () => ({ status: null, stderr: 'spawn failed' }),
    })))['codex'];
    expect(st.wired).toBeNull();
    expect(st.wiredDetail).toContain('could not determine');
  });

  it('reads Gemini from its settings file, because gemini has no `mcp get`', () => {
    // Verified against the real CLI: gemini mcp offers add/remove/list/
    // enable/disable only. The file check is the honest probe there.
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify({
      mcpServers: { memesh: { command: 'memesh-mcp', args: [] } },
    }));
    const st = byHost(inspectHosts(seams({ isOnPath: (bin) => bin === 'gemini' })))['gemini'];
    expect(st.wired).toBe(true);
    expect(st.actions).toEqual([]);
  });

  it('an unwired Gemini gets the user-scoped add command', () => {
    // -s user matters: gemini mcp add defaults to PROJECT scope, which
    // writes ./.gemini/settings.json in whatever directory setup ran.
    const st = byHost(inspectHosts(seams({ isOnPath: (bin) => bin === 'gemini' })))['gemini'];
    expect(st.wired).toBe(false);
    expect(st.actions[0].args).toEqual(['mcp', 'add', '-s', 'user', 'memesh', 'memesh-mcp']);
  });
});

describe('setupVerdict: one rule for the closing sentence and the exit code', () => {
  const host = (over: Partial<HostStatus> & Pick<HostStatus, 'host'>): HostStatus => ({
    title: { 'claude-code': 'Claude Code', codex: 'Codex CLI', gemini: 'Gemini CLI' }[over.host], present: true, presenceDetail: 'x',
    wired: true, wiredDetail: 'wired', actions: [], ...over,
  });
  const absent = (h: HostStatus['host']) => host({ host: h, present: false, wired: null, wiredDetail: 'not on this machine — nothing to wire' });
  const claudeWired = host({ host: 'claude-code' });
  const claudeHooksOnly = host({ host: 'claude-code', wired: null, unchecked: 'claude CLI not on PATH — cannot probe MCP registration' });
  const claudeUnwired = host({ host: 'claude-code', wired: false, actions: [{ kind: 'install-hooks', label: 'wire' }] });
  const codexWired = host({ host: 'codex' });
  const codexUnregistered = host({ host: 'codex', wired: false, actions: [{ kind: 'run', label: 'add', cmd: 'codex', args: [] }] });
  const codexFolderOnly = host({ host: 'codex', wired: null, unprobed: true, unchecked: 'the codex command is not on PATH — cannot probe MCP registration' });
  const codexProbeFailed = host({ host: 'codex', wired: null, unprobed: true, unchecked: 'codex mcp get failed to run — could not determine' });
  const geminiWired = host({ host: 'gemini' });

  // [machine, exit code, words the closing sentence must contain (null = no closing sentence)]
  const MACHINES: Array<[string, HostStatus[], 0 | 1, string[] | null]> = [
    ['no host at all', [absent('claude-code'), absent('codex'), absent('gemini')], 1, ['No supported agent host was found', 'Looked for']],
    ['everything present is wired', [claudeWired, codexWired, absent('gemini')], 0, ['Everything present is wired. Nothing to do.']],
    ['Claude Code hooks wired, no claude command', [claudeHooksOnly, absent('codex'), absent('gemini')], 0, ['Everything that could be checked is wired.', 'Not checked: Claude Code (claude CLI not on PATH', '`memesh setup --check`']],
    ['Claude Code not wired', [claudeUnwired, absent('codex'), absent('gemini')], 1, null],
    ['Codex registered and Claude Code not wired', [claudeUnwired, codexWired, absent('gemini')], 1, null],
    ['Codex not registered', [absent('claude-code'), codexUnregistered, absent('gemini')], 1, null],
    ['only a Codex folder, no codex command', [absent('claude-code'), codexFolderOnly, absent('gemini')], 1, ['Nothing to wire automatically — see the lines above.', 'Nothing could be confirmed wired', 'Not checked: Codex CLI (the codex command is not on PATH', '`memesh setup --check`']],
    ['codex mcp get failed to run', [absent('claude-code'), codexProbeFailed, absent('gemini')], 1, ['Nothing could be confirmed wired', 'codex mcp get failed to run']],
    ['Claude Code wired, a Codex folder with no command', [claudeWired, codexFolderOnly, absent('gemini')], 0, ['Everything that could be checked is wired.', 'Not checked: Codex CLI']],
    ['Claude Code hooks only, a Codex folder with no command', [claudeHooksOnly, codexFolderOnly, absent('gemini')], 0, ['Not checked: Claude Code (', ' and Codex CLI (']],
    ['Claude Code not wired, a Codex folder with no command', [claudeUnwired, codexFolderOnly, absent('gemini')], 1, null],
    ['Gemini wired, a Codex folder with no command', [absent('claude-code'), codexFolderOnly, geminiWired], 0, ['Not checked: Codex CLI']],
    ['Gemini wired alone', [absent('claude-code'), absent('codex'), geminiWired], 0, ['Everything present is wired. Nothing to do.']],
  ];

  it.each(MACHINES)('%s', (_name, statuses, exitCode, closing) => {
    const verdict = setupVerdict(statuses);
    expect(verdict.exitCode).toBe(exitCode);
    if (closing === null) expect(verdict.closing).toBeNull();
    else for (const words of closing) expect(verdict.closing).toContain(words);
  });

  it('never calls "could not look" a yes: a machine that only has unchecked hosts does not say Everything present is wired', () => {
    expect(setupVerdict([absent('claude-code'), codexFolderOnly, absent('gemini')]).closing).not.toContain('Everything present is wired');
  });

  it('on a real fixture machine: the Codex folder alone is exit 1, and with Claude Code wired beside it exit 0', () => {
    fs.mkdirSync(process.env.CODEX_HOME as string, { recursive: true });
    expect(setupVerdict(inspectHosts(seams())).exitCode).toBe(1);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'x', _memesh: true }] }] },
    }));
    const both = inspectHosts(seams({ isOnPath: (b) => b === 'claude', run: () => ({ status: 0, stderr: '' }) }));
    const verdict = setupVerdict(both);
    expect(verdict.exitCode).toBe(0);
    expect(verdict.closing).toContain('Not checked: Codex CLI');
  });

  it('a Codex whose probe failed to run is unchecked with its reason, not wired', () => {
    const st = byHost(inspectHosts(seams({ isOnPath: (bin) => bin === 'codex', run: () => ({ status: null, stderr: 'x' } as RunResult) })))['codex'];
    expect([st.wired, st.unprobed, st.unchecked]).toEqual([null, true, 'codex mcp get failed to run — could not determine']);
  });

  it('Claude Code with hooks wired and no claude command: unchecked in part, not unprobed (the hooks were verified)', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'x', _memesh: true }] }] },
    }));
    const st = byHost(inspectHosts(seams()))['claude-code'];
    expect([st.wired, st.unprobed, st.unchecked]).toEqual([null, undefined, 'claude CLI not on PATH — cannot probe MCP registration']);
  });

  it('a CLAUDE_CONFIG_DIR that names a file is not a Claude Code folder', () => {
    const file = path.join(home, 'a-file');
    fs.writeFileSync(file, 'x');
    const st = byHost(inspectHosts(seams({ claudeConfigDir: () => file })))['claude-code'];
    expect(st.present).toBe(false);
    expect(st.presenceDetail).toBe(`claude on PATH, or ${file}`);
  });
});
