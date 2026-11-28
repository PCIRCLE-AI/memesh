/**
 * `memesh setup` through the real binary — the machine-level wiring check
 * against fixture HOMEs. The unit tests in tests/core/setup.test.ts pin the
 * detection branches; these pin what a user actually runs: exit codes, the
 * no-write guarantee of --check and of non-interactive runs, and that --yes
 * really wires hooks into a fixture settings.json.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CLI = path.resolve('dist/transports/cli/cli.js');

let home: string;
let bin: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-setup-cli-'));
  // The PATH of every run below: a folder of its own that holds a link to node and nothing else.
  // The folder node lives in is not used: on a machine that installed claude or codex next to node
  // (nvm, `npm -g`), it would put them on the PATH of a test that means "no agent".
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-setup-cli-bin-'));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.rmSync(bin, { recursive: true, force: true });
});

// A PATH that carries node (so the CLI itself runs) but none of the host
// CLIs — claude/codex/gemini all read as absent. CODEX_HOME and
// CLAUDE_CONFIG_DIR relocate the hosts' config directories and would make a
// host "present" on a machine that has them set (Codex sets CODEX_HOME for
// everything it runs), so they are removed rather than inherited.
const bareEnv = () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: bin,
  };
  delete env.CODEX_HOME;
  delete env.CLAUDE_CONFIG_DIR;
  return env;
};

const run = (args: string[], env = bareEnv(), cwd?: string) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, cwd });

describe('memesh setup --check', () => {
  it('exits 1 on a machine with no hosts at all, and says no host was found (#528)', () => {
    const r = run(['setup', '--check']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('not found');
    expect(r.stderr).toContain('No supported agent host was found');
  });

  it('exits 1 when Claude Code exists but nothing is wired, and writes NOTHING', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const before = fs.readdirSync(path.join(home, '.claude'));

    const r = run(['setup', '--check']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('hooks NOT wired');

    // --check is read-only by contract.
    expect(fs.readdirSync(path.join(home, '.claude'))).toEqual(before);
  });

  it('exits 0 when the plugin manages Claude Code', () => {
    const pluginsDir = path.join(home, '.claude', 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'installed_plugins.json'), JSON.stringify({
      plugins: { 'memesh@pcircle-memesh': [{ installPath: '/x', version: '9.9.9', scope: 'user' }] },
    }));

    const r = run(['setup', '--check']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('plugin v9.9.9');
  });
});

describe('memesh setup --check follows CLAUDE_CONFIG_DIR (#528)', () => {
  const check = (claudeConfigDir: string | undefined, cwd?: string) => run(['setup', '--check'], { ...bareEnv(), ...(claudeConfigDir === undefined ? {} : { CLAUDE_CONFIG_DIR: claudeConfigDir }) }, cwd);

  it('a folder that exists is Claude Code, wherever it is', () => {
    const relocated = path.join(home, 'relocated');
    fs.mkdirSync(relocated);
    const r = check(relocated);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Claude Code: hooks NOT wired');
    expect(r.stderr).not.toContain('No supported agent host');
  });

  it('a folder that does not exist is no Claude Code, and the message names the folder it looked in', () => {
    const missing = path.join(home, 'nope');
    const r = check(missing);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('No supported agent host was found');
    expect(r.stdout).toContain(`claude on PATH, or ${missing}`);
  });

  it('an empty value is no value: Claude Code is looked for in ~/.claude', () => {
    expect(check('').stderr).toContain(`claude on PATH, or ${path.join(home, '.claude')}`);
    fs.mkdirSync(path.join(home, '.claude'));
    const r = check('');
    expect(r.stdout).toContain('Claude Code: hooks NOT wired');
  });

  it('a relative value is read from the folder setup runs in', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-setup-cwd-'));
    try {
      fs.mkdirSync(path.join(cwd, 'rel-claude'));
      const found = check('rel-claude', cwd);
      expect(found.stdout).toContain('Claude Code: hooks NOT wired');
      const missing = check('./nothere', fs.realpathSync(cwd));
      expect(missing.stdout).toContain(`claude on PATH, or ${path.join(fs.realpathSync(cwd), 'nothere')}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a value that names a file is not a Claude Code folder', () => {
    const file = path.join(home, 'a-file');
    fs.writeFileSync(file, 'x');
    const r = check(file);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('No supported agent host was found');
  });
});

describe('memesh setup (wiring)', () => {
  it('Codex config directory but no codex command: does not claim everything is wired, and exits 1 (#528)', () => {
    // Present but impossible to probe: nothing was wired and nothing was verified.
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const r = run(['setup']);
    expect(r.stdout).toContain('cannot probe MCP registration');
    expect(r.stdout).toContain('Nothing to wire automatically — see the lines above.');
    expect(r.stdout).not.toContain('Everything present is wired');
    expect(r.status).toBe(1);
    expect(fs.readdirSync(path.join(home, '.codex'))).toEqual([]);

    // --check gives the same verdict: unknown is not "wired".
    const check = run(['setup', '--check']);
    expect(check.status).toBe(1);
    expect(check.stdout).toContain('cannot probe MCP registration');
  });

  it('hooks wired but the claude command not on PATH: the closing line says what was NOT checked and how to check it, never "Everything present is wired" (exit 0)', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    expect(run(['setup', '--yes']).status).toBe(0); // wires the hooks
    const again = run(['setup', '--yes']);          // nothing left to wire, one part unknown
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('❓ Claude Code');
    expect(again.stdout).toContain('Everything that could be checked is wired. Not checked: Claude Code (claude CLI not on PATH — cannot probe MCP registration).');
    expect(again.stdout).toContain('put the command on PATH and run `memesh setup --check` again');
    expect(again.stdout).not.toContain('Everything present is wired');

    // --check says the same, and also exits 0
    const check = run(['setup', '--check']);
    expect(check.status).toBe(0);
    expect(check.stdout).toContain('Everything that could be checked is wired. Not checked: Claude Code');
    expect(check.stdout).not.toContain('Everything present is wired');
  });

  it('non-interactive without --yes: prints the plan, changes nothing, exits 1', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const r = run(['setup']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Planned actions');
    expect(r.stderr).toContain('--yes');
    expect(fs.existsSync(path.join(home, '.claude', 'settings.json'))).toBe(false);
  });

  it('--yes wires the hooks into the fixture settings.json and verifies after', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const r = run(['setup', '--yes']);

    const settings = JSON.parse(
      fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks?: Record<string, Array<{ hooks: Array<{ _memesh?: boolean }> }>> };
    const markers = Object.values(settings.hooks ?? {})
      .flat().flatMap((e) => e.hooks).filter((h) => h._memesh === true);
    expect(markers.length).toBeGreaterThan(0);

    // The final verdict re-reads the hosts: hooks are wired now, but the
    // claude CLI is not on the bare PATH so MCP registration is
    // undeterminable-with-no-action — which must not fail the run.
    expect(r.stdout).toContain('After wiring');
    expect(r.status).toBe(0);
  });

  // POSIX-only: the shim is a #!/bin/sh script, and on win32 `where` would
  // not resolve an extensionless file anyway — same skip the
  // upgrade-plugin tests use for their bash-only legs.
  it.skipIf(process.platform === 'win32')('runs a host CLI add through a PATH shim, and reports its failure honestly', () => {
    // A codex shim that answers `mcp get` with "not registered" and FAILS
    // the `mcp add` — setup must exit 1 and show the stderr, never claim
    // success it did not observe.
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-shim-'));
    const shim = path.join(shimDir, 'codex');
    fs.writeFileSync(shim, '#!/bin/sh\nif [ "$1" = "mcp" ] && [ "$2" = "get" ]; then exit 1; fi\nif [ "$1" = "mcp" ] && [ "$2" = "add" ]; then echo "boom" >&2; exit 3; fi\nexit 0\n');
    fs.chmodSync(shim, 0o755);

    const env = { ...bareEnv(), PATH: `${shimDir}${path.delimiter}${bin}` };
    try {
      const r = spawnSync(process.execPath, [CLI, 'setup', '--yes'], { encoding: 'utf8', env });
      expect(r.stdout + r.stderr).toContain('codex');
      expect(r.stderr).toContain('boom');
      expect(r.status).toBe(1);
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });
});
