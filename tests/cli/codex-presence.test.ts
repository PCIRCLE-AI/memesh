/**
 * `memesh setup` and `memesh doctor` must judge "is Codex on this machine" the
 * same way, and it must not depend on whether the machine running the test
 * has Codex installed. The real built CLI runs here with a PATH that is a
 * throwaway directory: it holds a fake `codex` executable, or nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { removeTempDir } from '../helpers/temp-dir.js';

const cli = path.resolve('dist/transports/cli/cli.js');
const dirs: string[] = [];
afterEach(() => { removeTempDir(...dirs.splice(0)); });

function machine(opts: {
  fakeCodexOnPath: boolean;
  codexDir: boolean;
  fakeClaudeOnPath?: boolean;
  /** Claude Code's configuration directory exists (no `claude` command). */
  claudeDir?: boolean;
  /** What the fake `codex` does and is. Default: an executable that exits 0. */
  codexShim?: 'ok' | 'not-executable' | 'unregistered';
}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-codex-presence-')));
  dirs.push(root);
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  if (opts.fakeCodexOnPath) {
    const shim = opts.codexShim ?? 'ok';
    fs.writeFileSync(path.join(bin, 'codex'), shim === 'unregistered' ? '#!/bin/sh\nexit 1\n' : '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(bin, 'codex'), shim === 'not-executable' ? 0o644 : 0o755);
  }
  if (opts.fakeClaudeOnPath) {
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(bin, 'claude'), 0o755);
  }
  const codexHome = path.join(root, 'codex-home');
  if (opts.codexDir) fs.mkdirSync(codexHome);
  const claudeDir = path.join(root, opts.claudeDir ? 'claude-dir' : 'no-claude');
  if (opts.claudeDir) fs.mkdirSync(claudeDir);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: claudeDir,
    CODEX_HOME: codexHome,
    MEMESH_DIR: path.join(home, '.memesh'),
    PATH: bin, // nothing else: the machine's own PATH never reaches the CLI
  };
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 90_000 });
  const setupRun = (args: string[] = ['setup', '--check']) => run(args);
  const setupText = () => { const r = setupRun(); return `${r.stdout}${r.stderr}`; };
  const wiring = () => {
    const r = run(['doctor', '--json']);
    const report = JSON.parse(r.stdout) as { checks: Array<{ id: string; status: string; code?: string; fixId?: string }> };
    return report.checks.find((c) => c.id === 'hook-wiring');
  };
  return { setupText, setupRun, wiring };
}

describe.skipIf(process.platform === 'win32')('Codex presence, as the real CLI judges it (#528)', () => {
  it('command on PATH, no config directory: both commands see Codex', () => {
    const m = machine({ fakeCodexOnPath: true, codexDir: false });
    expect(m.setupText()).toContain('Codex CLI: codex mcp get memesh → registered');
    expect(m.wiring()).toMatchObject({ status: 'pass', code: 'hook-wiring.no-claude-code' });
  });

  it('config directory, no command: both commands see Codex, and setup says it cannot probe', () => {
    const m = machine({ fakeCodexOnPath: false, codexDir: true });
    const text = m.setupText();
    expect(text).toContain('Codex CLI');
    expect(text).toContain('not on PATH');
    expect(text).not.toContain('Codex CLI: not found');
    expect(m.wiring()).toMatchObject({ status: 'pass', code: 'hook-wiring.no-claude-code' });
    // Seen, not verified: setup must neither claim it is wired nor exit 0 (#528).
    const full = m.setupRun(['setup']);
    expect(full.stdout).not.toContain('Everything present is wired');
    expect(full.stdout).toContain('Nothing to wire automatically');
    expect(full.status).toBe(1);
    expect(m.setupRun().status).toBe(1);
  });

  it('a freshly installed Claude Code (command on PATH, no ~/.claude yet) next to Codex: both commands see Claude Code, and doctor asks for install-hooks', () => {
    const m = machine({ fakeCodexOnPath: true, codexDir: false, fakeClaudeOnPath: true });
    expect(m.setupText()).toMatch(/Claude Code: .*(registered|not registered)/);
    expect(m.setupText()).not.toContain('Claude Code: not found');
    expect(m.wiring()).toMatchObject({ status: 'warn', code: 'hook-wiring.no-marker' });
  });

  it('neither: both commands see no Codex', () => {
    const m = machine({ fakeCodexOnPath: false, codexDir: false });
    expect(m.setupText()).toContain('Codex CLI: not found (looked for codex on PATH, or');
    const row = m.wiring();
    expect(row).toMatchObject({ status: 'warn', code: 'hook-wiring.no-host' });
    expect(row?.fixId).toBeUndefined();
    expect(m.setupRun().status).toBe(1);
  });

  it('Claude Code configuration directory, no command: setup and doctor both see Claude Code', () => {
    const m = machine({ fakeCodexOnPath: false, codexDir: false, claudeDir: true });
    expect(m.setupText()).not.toContain('Claude Code: not found');
    expect(m.setupText()).toContain('hooks NOT wired');
    expect(m.wiring()).toMatchObject({ status: 'warn', code: 'hook-wiring.no-marker', fixId: 'install-hooks' });
  });

  it('a file named codex without the execute bit is not the command', () => {
    const m = machine({ fakeCodexOnPath: true, codexDir: false, codexShim: 'not-executable' });
    expect(m.setupText()).toContain('Codex CLI: not found');
    expect(m.wiring()).toMatchObject({ status: 'warn', code: 'hook-wiring.no-host' });
  });

  it('the exit code of `codex mcp get memesh` decides, and a failing probe is reported as not registered', () => {
    const m = machine({ fakeCodexOnPath: true, codexDir: false, codexShim: 'unregistered' });
    expect(m.setupText()).toContain('codex mcp get memesh → not registered');
    expect(m.setupRun().status).toBe(1);
  });
});
