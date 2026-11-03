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
import { inspectHosts, allWired, type SetupSeams, type RunResult } from '../../src/core/setup.js';

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
    expect(allWired(statuses)).toBe(true);
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

describe('allWired', () => {
  it('fails a present host with pending actions, passes an absent one', () => {
    const statuses = inspectHosts(seams({ isOnPath: (bin) => bin === 'gemini' }));
    expect(allWired(statuses)).toBe(false); // gemini present, unwired
  });

  it('an undeterminable host is NOT wired: "could not look" is not "all good" (#528)', () => {
    // Present, nothing probeable, nothing to prescribe. --check and setup used to
    // count this as wired and print "Everything present is wired".
    const runFails: SetupSeams['run'] = () => ({ status: null, stderr: 'x' } as RunResult);
    const failedProbe = inspectHosts(seams({ isOnPath: (bin) => bin === 'codex', run: runFails }));
    expect(byHost(failedProbe)['codex'].actions).toEqual([]);
    expect(allWired(failedProbe)).toBe(false);

    // Codex's config directory without the codex command: same answer.
    fs.mkdirSync(process.env.CODEX_HOME as string, { recursive: true });
    const dirOnly = inspectHosts(seams());
    expect(byHost(dirOnly)['codex'].present).toBe(true);
    expect(allWired(dirOnly)).toBe(false);
  });

  it('Claude Code with its hooks wired but no claude command is still wired: the part that can be checked was', () => {
    // Hooks verified, MCP registration unprobeable, nothing to prescribe. Failing
    // this machine forever would make `setup --yes` exit 1 right after it succeeded.
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'x', _memesh: true }] }] },
    }));
    const statuses = inspectHosts(seams());
    expect(byHost(statuses)['claude-code'].wired).toBeNull();
    expect(allWired(statuses)).toBe(true);
  });
});
