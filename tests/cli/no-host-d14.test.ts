/**
 * A machine with no agent host (#528, D14), through the real built CLI.
 *
 * `setup`, `doctor` and `doctor --fix` used to contradict each other there:
 * setup said "Nothing to do", doctor told the person to connect Claude Code,
 * and `doctor --fix` created `~/.claude/settings.json` and ten hooks for a
 * program that is not installed, then reported the row as fixed.
 *
 * The environment is exactly `HOME` and `PATH` (the throwaway directory holds
 * a fake `claude`, `codex` or `gemini` only where the case says so), and the run's
 * working directory is its own empty folder, so a stray project-scope write
 * would show up as well.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDatabase, openDatabase } from '../../src/db.js';
import { PLUGIN_REFRESH_COMMANDS } from '../../src/core/install-channel.js';
import { removeTempDir } from '../helpers/temp-dir.js';

const cli = path.resolve('dist/transports/cli/cli.js');
const dirs: string[] = [];
afterEach(() => { removeTempDir(...dirs.splice(0)); });

function machine(opts: { claudeOnPath?: boolean; codexOnPath?: boolean; geminiOnPath?: boolean } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-no-host-')));
  dirs.push(root);
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'cwd');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  // The CLI itself needs node, so the PATH holds a link to it and nothing else.
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  for (const [name, on] of [['claude', opts.claudeOnPath], ['codex', opts.codexOnPath], ['gemini', opts.geminiOnPath]] as const) {
    if (!on) continue;
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, PATH: bin };
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { env, cwd, encoding: 'utf8', timeout: 90_000 });
  const homeListing = () => fs.readdirSync(home).sort();
  const wiring = () => {
    const r = run(['doctor', '--json']);
    const report = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))) as {
      checks: Array<{ id: string; status: string; summary: string; fix?: string; code?: string; fixId?: string }>;
    };
    return report.checks.find((c) => c.id === 'hook-wiring')!;
  };
  return { run, home, cwd, homeListing, wiring };
}

describe.skipIf(process.platform === 'win32')('no agent host on the machine (#528 D14)', () => {
  it('setup --yes says no host was found, names what it looked for, and exits 1 without touching HOME', () => {
    const m = machine();
    const r = m.run(['setup', '--yes']);
    const text = `${r.stdout}${r.stderr}`;
    expect(r.status).toBe(1);
    expect(text).toContain('No supported agent host was found');
    expect(text).toContain('Claude Code: claude on PATH, or');
    expect(text).toContain('Codex CLI: codex on PATH, or');
    expect(text).toContain('Gemini CLI: gemini on PATH');
    expect(text).toContain('run `memesh setup` again');
    expect(text).not.toContain('Nothing to do');
    expect(text).not.toContain('Everything present is wired');
    expect(m.homeListing()).toEqual([]);
  });

  it('setup --check says the same and exits 1', () => {
    const m = machine();
    const r = m.run(['setup', '--check']);
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain('No supported agent host was found');
    expect(m.homeListing()).toEqual([]);
  });

  it('setup --check sees Claude Code by its command alone, before it has made ~/.claude', () => {
    const m = machine({ claudeOnPath: true });
    const r = m.run(['setup', '--check']);
    const text = `${r.stdout}${r.stderr}`;
    expect(text).not.toContain('No supported agent host');
    expect(text).not.toContain('Claude Code: not found');
    expect(text).toContain('hooks NOT wired');
    expect(r.status).toBe(1);
    expect(m.homeListing()).not.toContain('.claude');
  });

  it('setup --check sees Codex by its configuration directory alone, and says it cannot probe without the command', () => {
    const m = machine();
    fs.mkdirSync(path.join(m.home, '.codex'));
    const r = m.run(['setup', '--check']);
    const text = `${r.stdout}${r.stderr}`;
    expect(text).not.toContain('No supported agent host');
    expect(text).not.toContain('Codex CLI: not found');
    expect(text).toContain('config directory exists but the codex command is not on PATH');
    // Seen but not verified: not a pass.
    expect(r.status).toBe(1);
    const row = m.wiring();
    expect(row).toMatchObject({ status: 'pass', code: 'hook-wiring.no-claude-code' });
    // Codex-only: no fix, and no fixId for `doctor --fix` to act on.
    expect(row.fix).toBeUndefined();
    expect(row.fixId).toBeUndefined();
  });

  it('doctor reports no agent host and does not send the person to install-hooks', () => {
    const m = machine();
    const row = m.wiring();
    expect(row).toMatchObject({ status: 'warn', code: 'hook-wiring.no-host' });
    expect(row.summary).toContain('No agent host was found');
    // Three hosts, the same three `memesh setup` looks for.
    expect(row.summary).toContain('Claude Code, Codex and Gemini CLI');
    expect(row.fix).toContain('Install Claude Code or Codex (or Gemini CLI)');
    expect(row.fix).toContain('memesh setup');
    expect(`${row.summary} ${row.fix}`).not.toContain('install-hooks');
    expect(row.fixId).toBeUndefined();
  });

  it('doctor --fix --yes creates no ~/.claude, writes no settings, installs no hook, and the row stays a warning', () => {
    const m = machine();
    const r = m.run(['doctor', '--fix', '--yes']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Skipped: hook wiring. No agent host was found');
    // ...and the same line says what to do next.
    expect(r.stdout).toMatch(/Skipped: hook wiring\..*memesh setup/);
    expect(r.stdout).not.toContain('hooks: added');
    expect(r.stdout).not.toContain('warn → pass');
    expect(r.stdout).toMatch(/\[WARN\] Hooks wired into Claude Code\n\s+No agent host was found/);
    // `doctor` creates no database on a machine that has none, and nothing of any agent host's may appear.
    // The empty listing only means something if doctor really ran and reported.
    expect(r.stdout.length).toBeGreaterThan(0);
    expect(m.homeListing()).toEqual([]);
    expect(fs.readdirSync(m.cwd)).toEqual([]);
  });

  /**
   * Age the machine's database so the capture rows have something to judge:
   * tracking began 30 days ago, and the given hooks last ran `ranHoursAgo` hours
   * ago. `doctor` creates no database, so the test creates (and migrates) it; the seed then edits it.
   */
  function ageDatabase(m: ReturnType<typeof machine>, ranHoursAgo: number | null) {
    fs.mkdirSync(path.join(m.home, '.memesh'), { recursive: true });
    openDatabase(path.join(m.home, '.memesh', 'knowledge-graph.db'));
    closeDatabase();
    const ts = (h: number) => new Date(Date.now() - h * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
    const db = new DatabaseSync(path.join(m.home, '.memesh', 'knowledge-graph.db'));
    try {
      db.prepare('DELETE FROM hook_runs').run();
      if (ranHoursAgo !== null) {
        for (const hook of ['session-summary', 'post-commit']) {
          db.prepare('INSERT INTO hook_runs (hook, last_run_at, run_count) VALUES (?, ?, 1)').run(hook, ts(ranHoursAgo));
        }
      }
      db.prepare("INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES ('hook_runs_since', ?)").run(ts(720));
    } finally {
      db.close();
    }
  }
  const rows = (m: ReturnType<typeof machine>) => {
    const r = m.run(['doctor', '--json']);
    const report = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))) as {
      checks: Array<{ id: string; status: string; fix?: string; code?: string }>;
    };
    return {
      activity: report.checks.find((c) => c.id === 'hook-activity')!,
      liveness: report.checks.find((c) => c.id === 'capture-liveness')!,
    };
  };

  it('Hook activity and Capture liveness do not send a no-host machine to install-hooks either (hooks that stopped running)', () => {
    const m = machine();
    ageDatabase(m, 100);
    const { activity, liveness } = rows(m);
    expect(activity).toMatchObject({ status: 'warn', code: 'hook-activity.stale-unconfirmed' });
    expect(liveness).toMatchObject({ status: 'warn', code: 'capture-liveness.no-records' });
    for (const row of [activity, liveness]) {
      expect(row.fix).toContain('memesh setup');
      expect(row.fix).not.toContain('install-hooks');
    }
  });

  it('Hook activity does not send a no-host machine to install-hooks (hooks that never ran)', () => {
    const m = machine();
    ageDatabase(m, null);
    const { activity } = rows(m);
    expect(activity).toMatchObject({ status: 'warn', code: 'hook-activity.not-wired' });
    expect(activity.fix).toContain('memesh setup');
    expect(activity.fix).not.toContain('install-hooks');
  });

  it('Hook activity and Capture liveness name the Codex refresh command on a Codex-only machine, never install-hooks (hooks that stopped running)', () => {
    const m = machine({ codexOnPath: true });
    ageDatabase(m, 100);
    const { activity, liveness } = rows(m);
    expect(m.wiring()).toMatchObject({ status: 'pass', code: 'hook-wiring.no-claude-code' });
    expect(activity).toMatchObject({ status: 'warn', code: 'hook-activity.stale-unconfirmed' });
    expect(liveness).toMatchObject({ status: 'warn', code: 'capture-liveness.no-records' });
    for (const row of [activity, liveness]) {
      expect(row.fix).toContain(PLUGIN_REFRESH_COMMANDS.codex);
      expect(row.fix).not.toContain('install-hooks');
    }
  });

  it('Hook activity names the Codex refresh command on a Codex-only machine (hooks that never ran)', () => {
    const m = machine({ codexOnPath: true });
    ageDatabase(m, null);
    const { activity } = rows(m);
    expect(activity).toMatchObject({ status: 'warn', code: 'hook-activity.not-wired' });
    expect(activity.fix).toContain(PLUGIN_REFRESH_COMMANDS.codex);
    expect(activity.fix).not.toContain('install-hooks');
  });

  it('a Gemini-only machine is a host: doctor does not say "no agent host", and neither the rows nor --fix reach for Claude Code', () => {
    const m = machine({ geminiOnPath: true });
    const row = m.wiring();
    expect(row).toMatchObject({ status: 'pass', code: 'hook-wiring.no-claude-code' });
    expect(row.summary).not.toContain('No agent host was found');
    expect(row.fix).toBeUndefined();
    expect(row.fixId).toBeUndefined();
    ageDatabase(m, 100);
    const { activity, liveness } = rows(m);
    for (const r of [activity, liveness]) {
      expect(r.fix).toContain('MCP server only');
      expect(r.fix).not.toContain('install-hooks');
      expect(r.fix).not.toContain('codex plugin add');
    }
    m.run(['doctor', '--fix', '--yes']);
    expect(m.homeListing()).toEqual(['.memesh']);
    expect(fs.readdirSync(m.cwd)).toEqual([]);
  });

  it('doctor --fix --yes on an aged no-host machine still creates nothing for those rows', () => {
    const m = machine();
    ageDatabase(m, 100);
    const r = m.run(['doctor', '--fix', '--yes']);
    expect(r.stdout).toContain('Nothing on the --fix whitelist to apply.');
    expect(r.stdout).not.toContain('hooks: added');
    expect(m.homeListing()).toEqual(['.memesh']);
    expect(fs.readdirSync(m.cwd)).toEqual([]);
  });

  it('control, Claude Code present: the same aged database keeps the install-hooks advice on both rows', () => {
    const m = machine({ claudeOnPath: true });
    ageDatabase(m, 100);
    const { activity, liveness } = rows(m);
    expect(activity.fix).toContain('install-hooks');
    expect(liveness.fix).toContain('install-hooks');
  });

  it('control, Codex only: setup wires Codex, doctor keeps the honest Claude-Code-not-found line, --fix creates no ~/.claude', () => {
    const m = machine({ codexOnPath: true });
    const s = m.run(['setup', '--yes']);
    expect(s.status).toBe(0);
    expect(s.stdout).toContain('Codex CLI: codex mcp get memesh');
    expect(`${s.stdout}${s.stderr}`).not.toContain('No supported agent host');
    expect(m.wiring()).toMatchObject({ status: 'pass', code: 'hook-wiring.no-claude-code' });
    m.run(['doctor', '--fix', '--yes']);
    expect(m.homeListing()).toEqual(['.memesh']);
    expect(fs.readdirSync(m.cwd)).toEqual([]);
  });

  it('control, Claude Code only (command on PATH, no ~/.claude yet): doctor asks for install-hooks and --fix really wires it', () => {
    const m = machine({ claudeOnPath: true });
    expect(m.wiring()).toMatchObject({ status: 'warn', code: 'hook-wiring.no-marker', fixId: 'install-hooks' });
    const r = m.run(['doctor', '--fix', '--yes']);
    expect(r.stdout).toContain('hooks: added');
    expect(r.stdout).toContain('Hooks wired into Claude Code: warn → pass');
    expect(fs.existsSync(path.join(m.home, '.claude', 'settings.json'))).toBe(true);
    expect(fs.readdirSync(m.cwd)).toEqual([]);
  });
});
