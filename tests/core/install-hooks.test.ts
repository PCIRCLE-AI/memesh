// install-hooks core — locks down the contract for `memesh install-hooks`:
//   1. existing user hooks coexist (we never overwrite them)
//   2. idempotent (re-running doesn't duplicate)
//   3. dry-run is a true no-op (no FS writes)
//   4. uninstall removes only memesh entries
//   5. version upgrade refreshes paths in place
//   6. malformed settings.json is refused, not silently overwritten

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

describe('install-hooks', () => {
  let tmpDir: string;
  let pluginDir: string;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-installhooks-'));
    pluginDir = path.join(tmpDir, 'plugin');
    fs.mkdirSync(path.join(pluginDir, 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-start.js' }] }],
          PreToolUse: [
            { matcher: 'Edit|Write', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/pre-edit-recall.js', timeout: 5 }] },
          ],
          Stop: [{ matcher: '*', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-summary.js' }] }],
        },
      }),
    );

    originalEnv.MEMESH_DIR = process.env.MEMESH_DIR;
    originalEnv.HOME = process.env.HOME;
    originalEnv.USERPROFILE = process.env.USERPROFILE;
    originalEnv.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
    process.env.MEMESH_DIR = path.join(tmpDir, 'memesh-state');
    process.env.HOME = path.join(tmpDir, 'home');
    // Windows parity: os.homedir() consults USERPROFILE first on Windows
    // and HOMEDRIVE+HOMEPATH next; HOME is not checked. Without this
    // override, install-hooks writes to the real user dir and the test's
    // assertion (read from process.env.HOME path) sees an absent file.
    process.env.USERPROFILE = path.join(tmpDir, 'home');
    delete process.env.CLAUDE_CONFIG_DIR;
    fs.mkdirSync(process.env.HOME, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv.MEMESH_DIR === undefined) delete process.env.MEMESH_DIR;
    else process.env.MEMESH_DIR = originalEnv.MEMESH_DIR;
    if (originalEnv.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = originalEnv.HOME;
    if (originalEnv.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalEnv.USERPROFILE;
    if (originalEnv.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalEnv.CLAUDE_CONFIG_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function freshModule() {
    return import('../../src/core/install-hooks.js');
  }

  it('writes 3 memesh hook entries on a fresh user-scope install', async () => {
    const { installHooks } = await freshModule();
    const result = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' });
    // Manifest has 3 entries: SessionStart×1 + PreToolUse×1 + Stop×1
    expect(result.added).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.conflicts).toEqual([]);
    expect(result.backupPath).toBeNull(); // no prior settings to back up
    expect(fs.existsSync(result.settingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain(pluginDir);
    expect(settings.hooks.SessionStart[0].hooks[0]._memesh).toBe(true);
  });

  it('absolute-substitutes ${CLAUDE_PLUGIN_ROOT} on every hook command', async () => {
    const { installHooks } = await freshModule();
    installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' });
    const settings = JSON.parse(fs.readFileSync(path.join(process.env.HOME!, '.claude', 'settings.json'), 'utf8'));
    const allCommands: string[] = [];
    for (const entries of Object.values(settings.hooks) as any[]) {
      for (const entry of entries) {
        for (const h of entry.hooks) allCommands.push(h.command);
      }
    }
    expect(allCommands.length).toBe(3);
    for (const cmd of allCommands) {
      expect(cmd).not.toContain('${CLAUDE_PLUGIN_ROOT}');
      expect(cmd.startsWith(pluginDir)).toBe(true);
    }
  });

  it('is idempotent: re-running adds 0, skips all', async () => {
    const { installHooks } = await freshModule();
    installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' });
    const second = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' });
    expect(second.added).toBe(0);
    expect(second.skipped).toBe(3);
  });

  it('preserves existing non-memesh user hooks on the same matcher', async () => {
    // User already has ~/.claude/hooks/stop.js wired (the real-world
    // case we hit on the maintainer's machine).
    const settingsPath = path.join(process.env.HOME!, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        Stop: [{ matcher: '*', hooks: [{ type: 'command', command: '~/.claude/hooks/stop.js' }] }],
      },
    }));

    const { installHooks } = await freshModule();
    const result = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' });
    expect(result.added).toBe(3);
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0].event).toBe('Stop');

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    // Both entries present on Stop, user's first
    expect(settings.hooks.Stop.length).toBe(2);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe('~/.claude/hooks/stop.js');
    expect(settings.hooks.Stop[1].hooks[0]._memesh).toBe(true);
  });

  it('writes a backup before modifying an existing settings file', async () => {
    const settingsPath = path.join(process.env.HOME!, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ existing: 'config' }));

    const { installHooks } = await freshModule();
    const result = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' });
    expect(result.backupPath).not.toBeNull();
    expect(fs.existsSync(result.backupPath!)).toBe(true);
    const backup = JSON.parse(fs.readFileSync(result.backupPath!, 'utf8'));
    expect(backup.existing).toBe('config');
  });

  it('--dry-run touches no files', async () => {
    const settingsPath = path.join(process.env.HOME!, '.claude', 'settings.json');
    const { installHooks } = await freshModule();
    const result = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user', dryRun: true });
    expect(result.added).toBe(3);
    expect(fs.existsSync(settingsPath)).toBe(false);
    expect(fs.existsSync(result.markerPath)).toBe(false);
  });

  it('writes a marker JSON that records version + scope + paths', async () => {
    const { installHooks, readInstallMarker } = await freshModule();
    installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' });
    const marker = readInstallMarker();
    expect(marker).not.toBeNull();
    expect(marker!.version).toBe('4.1.4');
    expect(marker!.scope).toBe('user');
    expect(marker!.plugin_root).toBe(pluginDir);
    expect(marker!.installed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('refuses to modify a malformed settings.json', async () => {
    const settingsPath = path.join(process.env.HOME!, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, 'not json at all');
    const { installHooks } = await freshModule();
    expect(() => installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' })).toThrow(/not valid JSON/);
    // settings file is left untouched — no destructive overwrite
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('not json at all');
  });

  it('an install that changes nothing writes nothing: no new backup, no rewritten settings, no new marker (#528)', async () => {
    const { installHooks } = await freshModule();
    const first = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' });
    expect(first.settingsWritten).toBe(true);
    expect(first.markerWritten).toBe(true);
    const settingsBefore = fs.readFileSync(first.settingsPath, 'utf8');
    const markerBefore = fs.readFileSync(first.markerPath, 'utf8');
    const markerMtime = fs.statSync(first.markerPath).mtimeMs;
    const backupsBefore = fs.readdirSync(path.dirname(first.settingsPath)).filter((f) => f.includes('.bak-pre-memesh-')).length;

    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' });
    expect(second.added).toBe(0);
    expect(second.skipped).toBe(3);
    expect(second.settingsWritten).toBe(false);
    expect(second.markerWritten).toBe(false);
    expect(second.backupPath).toBeNull();
    expect(fs.readFileSync(first.settingsPath, 'utf8')).toBe(settingsBefore);
    expect(fs.readFileSync(first.markerPath, 'utf8')).toBe(markerBefore);
    expect(fs.statSync(first.markerPath).mtimeMs).toBe(markerMtime);
    const backupsAfter = fs.readdirSync(path.dirname(first.settingsPath)).filter((f) => f.includes('.bak-pre-memesh-')).length;
    expect(backupsAfter).toBe(backupsBefore);
  });

  it('refreshes the marker, and only the marker, when it describes a different install (#528)', async () => {
    const { installHooks } = await freshModule();
    const first = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' });
    fs.rmSync(first.markerPath);
    const again = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' });
    expect(again.settingsWritten).toBe(false);
    expect(again.markerWritten).toBe(true);
    expect(fs.existsSync(again.markerPath)).toBe(true);
  });

  it('the marker is rewritten when only its version differs, and settings.json is left alone (#528)', async () => {
    const { installHooks, readInstallMarker } = await freshModule();
    installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' });
    const again = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.5', scope: 'user' });
    expect(again.settingsWritten).toBe(false);
    expect(again.markerWritten).toBe(true);
    expect(readInstallMarker()!.version).toBe('4.1.5');
  });

  it('the marker is rewritten when only its scope differs, and settings.json is left alone (#528)', async () => {
    const { installHooks, readInstallMarker } = await freshModule();
    installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' });
    // With cwd = HOME, the project settings file IS the user settings file: only the recorded scope differs.
    const again = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'project', cwd: process.env.HOME! });
    expect(again.settingsWritten).toBe(false);
    expect(again.markerWritten).toBe(true);
    expect(readInstallMarker()!.scope).toBe('project');
  });

  it('a refused install leaves the citation rule unwritten too (#528)', async () => {
    const settingsPath = path.join(process.env.HOME!, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{not json');
    const { installHooks } = await freshModule();
    expect(() => installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' })).toThrow(/not valid JSON/);
    const rules = path.join(process.env.HOME!, '.claude', 'rules');
    expect(fs.existsSync(rules) ? fs.readdirSync(rules) : []).toEqual([]);
  });

  it('refuses a settings file whose hooks.<event> is not a list, with a sentence, for install and uninstall (#528)', async () => {
    const settingsPath = path.join(process.env.HOME!, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const content = JSON.stringify({ hooks: { Stop: 'oops' } });
    fs.writeFileSync(settingsPath, content);
    const { installHooks, uninstallHooks } = await freshModule();
    expect(() => installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' })).toThrow(/hooks\.Stop is not a list; refusing to modify/);
    expect(() => uninstallHooks({ scope: 'user' })).toThrow(/hooks\.Stop is not a list; refusing to modify/);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(content);
    const rules = path.join(process.env.HOME!, '.claude', 'rules');
    expect(fs.existsSync(rules) ? fs.readdirSync(rules) : []).toEqual([]);
  });

  it.each([
    ['[]', /is not a JSON object; refusing to modify/],
    ['"text"', /is not a JSON object; refusing to modify/],
    ['null', /is not a JSON object; refusing to modify/],
    ['{"hooks":[]}', /"hooks" is not an object; refusing to modify/],
    ['{"hooks":"x"}', /"hooks" is not an object; refusing to modify/],
    ['{"hooks":null}', /"hooks" is not an object; refusing to modify/],
  ])('refuses %s with its own sentence, for install and uninstall (#528)', async (body, message) => {
    const settingsPath = path.join(process.env.HOME!, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, body);
    const { installHooks, uninstallHooks } = await freshModule();
    expect(() => installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' })).toThrow(message);
    expect(() => uninstallHooks({ scope: 'user' })).toThrow(message);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(body);
  });

  it.each([
    ['a null entry', '{"hooks":{"Stop":[null]}}', /hooks\.Stop\[0\] is not an object/],
    ['an entry without a hooks list', '{"hooks":{"Stop":[{"matcher":"*"}]}}', /hooks\.Stop\[0\]\.hooks is not a list/],
    ['a string entry', '{"hooks":{"Stop":["x"]}}', /hooks\.Stop\[0\] is not an object/],
    ['an array entry', '{"hooks":{"Stop":[[]]}}', /hooks\.Stop\[0\] is not an object/],
    ['a null hook command', '{"hooks":{"Stop":[{"matcher":"*","hooks":[null]}]}}', /hooks\.Stop\[0\]\.hooks\[0\] is not an object; refusing to modify/],
    ['a string hook command', '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"a","_memesh":true},"x"]}]}}', /hooks\.Stop\[0\]\.hooks\[1\] is not an object; refusing to modify/],
  ])('refuses %s with a sentence and writes nothing, the citation rule included (#528)', async (_label, body, message) => {
    const settingsPath = path.join(process.env.HOME!, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, body);
    const { installHooks, uninstallHooks } = await freshModule();
    expect(() => installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' })).toThrow(message);
    expect(() => uninstallHooks({ scope: 'user' })).toThrow(message);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(body);
    const rules = path.join(process.env.HOME!, '.claude', 'rules');
    expect(fs.existsSync(rules) ? fs.readdirSync(rules) : []).toEqual([]);
    expect(fs.readdirSync(path.dirname(settingsPath)).filter((f) => f.includes('.bak-pre-memesh-'))).toEqual([]);

    // The rule file above was absent, so the uninstall half proved nothing about it. Put a real one in place
    // (a good install writes it), swap the settings for the bad body, and require the refused uninstall to leave it.
    fs.writeFileSync(settingsPath, '{}');
    installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' });
    expect(fs.readdirSync(rules)).toEqual(['memesh-citations.md']);
    fs.writeFileSync(settingsPath, body);
    expect(() => uninstallHooks({ scope: 'user' })).toThrow(message);
    expect(fs.readdirSync(rules)).toEqual(['memesh-citations.md']);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(body);
  });

  it.each([
    ['is not JSON', 'not json at all'],
    ['has no "hooks" object', '{}'],
  ])("memesh's own hooks file that %s is refused in one plain sentence and nothing is written (#528)", async (_label, manifest) => {
    const manifestPath = path.join(pluginDir, 'hooks', 'hooks.json');
    fs.writeFileSync(manifestPath, manifest);
    const { installHooks } = await freshModule();
    expect(() => installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' })).toThrow(
      `memesh's own hooks file at ${manifestPath} is damaged and cannot be read; reinstall memesh and run install-hooks again`,
    );
    expect(fs.existsSync(path.join(process.env.HOME!, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(process.env.MEMESH_DIR!, 'install-hooks.json'))).toBe(false);
  });

  it('a re-install that only has something to prune still writes the file back, with a backup (#528)', async () => {
    const { installHooks } = await freshModule();
    const first = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' });
    const settings = JSON.parse(fs.readFileSync(first.settingsPath, 'utf8'));
    settings.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: '/gone/pre-bash.js', _memesh: true }] });
    fs.writeFileSync(first.settingsPath, JSON.stringify(settings));
    const again = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' });
    expect(again.added).toBe(0);
    expect(again.pruned).toBe(1);
    expect(again.settingsWritten).toBe(true);
    expect(again.backupPath).not.toBeNull();
    const after = JSON.parse(fs.readFileSync(first.settingsPath, 'utf8'));
    expect((after.hooks.PreToolUse as Array<{ matcher: string }>).some((e) => e.matcher === 'Bash')).toBe(false);
  });

  it('the marker is rewritten when only the settings file it names has changed (#528)', async () => {
    const { installHooks } = await freshModule();
    const first = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' });
    // The same hooks already sit in a relocated Claude directory; the marker still names the old one.
    const relocated = path.join(tmpDir, 'relocated-claude');
    fs.mkdirSync(relocated, { recursive: true });
    fs.copyFileSync(first.settingsPath, path.join(relocated, 'settings.json'));
    process.env.CLAUDE_CONFIG_DIR = relocated;
    const again = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' });
    expect(again.settingsWritten).toBe(false);
    expect(again.markerWritten).toBe(true);
    expect(JSON.parse(fs.readFileSync(again.markerPath, 'utf8')).settings_path).toBe(path.join(relocated, 'settings.json'));
  });

  it('install-hooks and uninstall-hooks refuse an unknown --scope and touch nothing (#528)', () => {
    const cli = path.resolve('dist', 'transports', 'cli', 'cli.js');
    const env = { ...process.env, HOME: process.env.HOME, USERPROFILE: process.env.HOME, CLAUDE_CONFIG_DIR: path.join(tmpDir, 'claude-cfg'), MEMESH_DIR: process.env.MEMESH_DIR };
    for (const command of ['install-hooks', 'uninstall-hooks']) {
      let status: number | null = 0;
      let stderr = '';
      try {
        execFileSync('node', [cli, command, '--scope', 'bogus'], { env, encoding: 'utf8', stdio: 'pipe' });
      } catch (err) {
        status = (err as { status: number | null }).status;
        stderr = String((err as { stderr?: unknown }).stderr ?? '');
      }
      expect(status, command).toBe(1);
      // A missing or broken CLI also exits 1; only the CLI's own sentence proves the scope check ran.
      expect(stderr, command).toContain('Error: --scope "bogus" is not valid. Use one of: user, project.');
    }
    expect(fs.existsSync(path.join(tmpDir, 'claude-cfg'))).toBe(false);
  });

  it('upgrade in place: re-installing with a different pluginRoot replaces stale memesh entries', async () => {
    const { installHooks } = await freshModule();
    const oldRoot = pluginDir;
    installHooks({ pluginRoot: oldRoot, pluginVersion: '4.1.4', scope: 'user' });

    // Simulate memesh moved to a new location (e.g., npm-global path
    // changed after a Node.js upgrade). Use a name that's NOT a
    // suffix-extension of `plugin/` so substring checks below are
    // unambiguous.
    const newRoot = path.join(tmpDir, 'memesh-v2');
    fs.mkdirSync(path.join(newRoot, 'hooks'), { recursive: true });
    fs.copyFileSync(path.join(oldRoot, 'hooks', 'hooks.json'), path.join(newRoot, 'hooks', 'hooks.json'));
    const second = installHooks({ pluginRoot: newRoot, pluginVersion: '4.1.15', scope: 'user' });
    expect(second.added).toBe(3);
    expect(second.skipped).toBe(0); // OLD entries are stale → replaced

    const settings = JSON.parse(fs.readFileSync(path.join(process.env.HOME!, '.claude', 'settings.json'), 'utf8'));
    // No remaining references to the old plugin root
    const allCmds: string[] = [];
    for (const entries of Object.values(settings.hooks) as any[]) {
      for (const e of entries) for (const h of e.hooks) allCmds.push(h.command);
    }
    expect(allCmds.some(c => c.includes(oldRoot))).toBe(false);
    expect(allCmds.every(c => c.startsWith(newRoot))).toBe(true);
  });

  it('upgrade prunes memesh entries the new manifest no longer declares — and never touches user hooks', async () => {
    // The exact residue the agentic-orchestration removal left behind: a
    // <=4.4.x install wrote a PreToolUse/Bash entry into settings.json; the
    // upgrade deleted the script from the package, and the merge loop —
    // which iterates only DESIRED events/matchers — never removed the stale
    // entry. Claude Code then invoked a nonexistent file on every Bash
    // call, and `memesh install-hooks` (the documented remedy for wiring
    // problems) could not heal it. Start from the OLD manifest shape and
    // prove the new install sweeps it.
    const { installHooks } = await freshModule();

    // Old-version manifest: includes a PreToolUse/Bash hook that the
    // current manifest (fixture in beforeEach) no longer declares.
    const oldRoot = path.join(tmpDir, 'memesh-old');
    fs.mkdirSync(path.join(oldRoot, 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(oldRoot, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-start.js' }] }],
          PreToolUse: [
            { matcher: 'Edit|Write', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/pre-edit-recall.js', timeout: 5 }] },
            { matcher: 'Bash', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/pre-bash-orchestration-nudge.js', timeout: 3 }] },
          ],
          Stop: [{ matcher: '*', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-summary.js' }] }],
        },
      }),
    );
    installHooks({ pluginRoot: oldRoot, pluginVersion: '4.4.0', scope: 'user' });

    // A user hook on the SAME retired matcher must survive the sweep.
    const settingsPath = path.join(process.env.HOME!, '.claude', 'settings.json');
    const before = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    before.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: '~/.claude/hooks/my-bash-guard.js' }] });
    fs.writeFileSync(settingsPath, JSON.stringify(before));

    const result = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.6.0', scope: 'user' });
    expect(result.pruned, 'the retired Bash nudge entry must be swept').toBe(1);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const bashEntries = (settings.hooks.PreToolUse as any[]).filter((e) => e.matcher === 'Bash');
    expect(bashEntries, 'only the USER Bash hook may remain').toHaveLength(1);
    expect(bashEntries[0].hooks[0].command).toBe('~/.claude/hooks/my-bash-guard.js');
    const allCmds: string[] = [];
    for (const entries of Object.values(settings.hooks) as any[]) {
      for (const e of entries) for (const h of e.hooks) allCmds.push(h.command);
    }
    expect(allCmds.some((c) => c.includes('pre-bash-orchestration-nudge')), 'no command may still point at the deleted script').toBe(false);
  });

  it('a fresh install with nothing to prune reports pruned: 0', async () => {
    const { installHooks } = await freshModule();
    const result = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.6.0', scope: 'user' });
    expect(result.pruned).toBe(0);
  });

  it('uninstall removes only memesh entries, leaves user hooks alone', async () => {
    const settingsPath = path.join(process.env.HOME!, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        Stop: [{ matcher: '*', hooks: [{ type: 'command', command: '~/.claude/hooks/stop.js' }] }],
      },
    }));

    const { installHooks, uninstallHooks } = await freshModule();
    installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user' });

    const result = uninstallHooks({ scope: 'user' });
    expect(result.removed).toBe(3); // the 3 memesh hook commands
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    // User's stop.js remains
    expect(settings.hooks.Stop.length).toBe(1);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe('~/.claude/hooks/stop.js');
    // Events that had only memesh entries are pruned entirely
    expect(settings.hooks.SessionStart).toBeUndefined();
  });

  it('project scope writes to ./.claude/settings.json relative to cwd', async () => {
    const projectDir = path.join(tmpDir, 'fake-project');
    fs.mkdirSync(projectDir, { recursive: true });
    const { installHooks } = await freshModule();
    const result = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'project', cwd: projectDir });
    expect(result.settingsPath).toBe(path.join(projectDir, '.claude', 'settings.json'));
    expect(fs.existsSync(result.settingsPath)).toBe(true);
  });

  // ── v4.2.7 plugin-runtime detection ─────────────────────────────────
  // Prevents the double-firing failure mode: when Claude Code's
  // `/plugin install memesh@pcircle-memesh` is already wiring memesh's
  // hooks, also writing them into ~/.claude/settings.json would fire
  // every hook script twice per event.

  it('refuses to write when Claude Code plugin install is already active', async () => {
    // Stub a plugin-install record pointing at any path (just needs to
    // exist with a memesh@pcircle-memesh entry).
    const installedPluginsPath = path.join(tmpDir, 'fake-installed_plugins.json');
    fs.writeFileSync(installedPluginsPath, JSON.stringify({
      plugins: {
        'memesh@pcircle-memesh': [{
          installPath: '/Users/test/.claude/plugins/cache/pcircle-memesh/memesh/4.2.7',
          version: '4.2.7',
        }],
      },
    }));

    const { installHooks } = await freshModule();
    const result = installHooks({
      pluginRoot: pluginDir,
      pluginVersion: '4.2.7',
      scope: 'user',
      installedPluginsPathImpl: installedPluginsPath,
    });

    // No writes — the plugin runtime already covers it.
    expect(result.added).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.pluginRuntimeDetected).not.toBeNull();
    expect(result.pluginRuntimeDetected?.version).toBe('4.2.7');
    expect(result.pluginRuntimeDetected?.installPath).toContain('/plugins/cache/pcircle-memesh/');

    // Settings file should NOT have been created.
    const settingsPath = path.join(process.env.HOME!, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(false);
  });

  it.each(['first', 'last'] as const)(
    'finds the active plugin row when it appears %s among mixed registry entries',
    async (position) => {
      const installedPluginsPath = path.join(tmpDir, `mixed-installed-plugins-${position}.json`);
      const active = {
        installPath: '/Users/test/.claude/plugins/cache/pcircle-memesh/memesh/4.8.2',
        version: '4.8.2',
      };
      const invalid = { version: 'legacy-row-without-an-install-path' };
      fs.writeFileSync(installedPluginsPath, JSON.stringify({
        plugins: {
          'memesh@pcircle-memesh': position === 'first' ? [active, invalid] : [invalid, active],
        },
      }));

      const { installHooks } = await freshModule();
      const result = installHooks({
        pluginRoot: pluginDir,
        pluginVersion: '4.8.2',
        scope: 'user',
        installedPluginsPathImpl: installedPluginsPath,
      });

      expect(result.pluginRuntimeDetected).toEqual(active);
      expect(result.added).toBe(0);
      expect(fs.existsSync(result.settingsPath)).toBe(false);
    },
  );

  it('uses CLAUDE_CONFIG_DIR for default plugin detection and user settings', async () => {
    const configRoot = path.join(tmpDir, 'relocated-claude');
    process.env.CLAUDE_CONFIG_DIR = configRoot;
    const installedPluginsPath = path.join(configRoot, 'plugins', 'installed_plugins.json');
    fs.mkdirSync(path.dirname(installedPluginsPath), { recursive: true });
    fs.writeFileSync(installedPluginsPath, JSON.stringify({
      plugins: {
        'memesh@pcircle-memesh': [{ installPath: path.join(configRoot, 'plugins', 'cache', 'pcircle-memesh', 'memesh', '4.8.2'), version: '4.8.2' }],
      },
    }));

    const { installHooks } = await freshModule();
    const guarded = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.8.2', scope: 'user' });
    expect(guarded.pluginRuntimeDetected?.version).toBe('4.8.2');
    expect(guarded.citationRule.path).toBe(path.join(configRoot, 'rules', 'memesh-citations.md'));
    expect(fs.existsSync(guarded.citationRule.path)).toBe(true);
    expect(fs.existsSync(path.join(process.env.HOME!, '.claude', 'rules', 'memesh-citations.md'))).toBe(false);
    expect(fs.existsSync(path.join(process.env.HOME!, '.claude', 'settings.json'))).toBe(false);

    const forced = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.8.2', scope: 'user', forceOverPlugin: true });
    expect(forced.settingsPath).toBe(path.join(configRoot, 'settings.json'));
    expect(forced.citationRule.path).toBe(path.join(configRoot, 'rules', 'memesh-citations.md'));
    expect(fs.existsSync(forced.settingsPath)).toBe(true);
  });

  it('forceOverPlugin escape hatch writes anyway with the same plugin record present', async () => {
    const installedPluginsPath = path.join(tmpDir, 'fake-installed_plugins.json');
    fs.writeFileSync(installedPluginsPath, JSON.stringify({
      plugins: {
        'memesh@pcircle-memesh': [{
          installPath: '/Users/test/.claude/plugins/cache/pcircle-memesh/memesh/4.2.7',
          version: '4.2.7',
        }],
      },
    }));

    const { installHooks } = await freshModule();
    const result = installHooks({
      pluginRoot: pluginDir,
      pluginVersion: '4.2.7',
      scope: 'user',
      installedPluginsPathImpl: installedPluginsPath,
      forceOverPlugin: true,
    });

    expect(result.added).toBeGreaterThan(0);
    expect(result.pluginRuntimeDetected).toBeUndefined();
  });

  it('proceeds normally when installed_plugins.json exists but has no memesh entry', async () => {
    const installedPluginsPath = path.join(tmpDir, 'fake-installed_plugins.json');
    fs.writeFileSync(installedPluginsPath, JSON.stringify({
      plugins: {
        'some-other-plugin@vendor': [{ installPath: '/tmp/x', version: '1.0.0' }],
      },
    }));

    const { installHooks } = await freshModule();
    const result = installHooks({
      pluginRoot: pluginDir,
      pluginVersion: '4.2.7',
      scope: 'user',
      installedPluginsPathImpl: installedPluginsPath,
    });

    // Plugin runtime not detected for memesh specifically — installs.
    expect(result.added).toBeGreaterThan(0);
    expect(result.pluginRuntimeDetected).toBeUndefined();
  });
});

describe('memesh install-hooks (CLI output) — M-11', () => {
  // `installHooks()` writes ~/.memesh/install-hooks.json in the same branch
  // as the settings.json backup (see the marker-writing block above this
  // describe block's sibling tests), and the CLI already reports the
  // settings path and the backup path — but not this one, so a user reading
  // the command's own output had no idea it wrote a second file at all.
  const cliPath = path.resolve('dist', 'transports', 'cli', 'cli.js');
  let cwd: string;
  let memeshDir: string;

  beforeEach(() => {
    // realpathSync: macOS resolves `/var` -> `/private/var`, and the
    // marker path the CLI reports is realpath-resolved (via memeshDir's
    // own path.join chain) while a bare mkdtempSync result on this
    // platform is not — an unresolved comparison here would fail on
    // every macOS run for a reason that has nothing to do with M-11.
    cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-installhooks-cli-')));
    memeshDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-installhooks-cli-home-')));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(memeshDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('names the marker path it just wrote', () => {
    // --scope project keeps the settings write inside `cwd` — no touching
    // the real ~/.claude/settings.json from a test.
    const out = execFileSync('node', [cliPath, 'install-hooks', '--scope', 'project'], {
      cwd,
      env: {
        ...process.env,
        HOME: cwd,
        USERPROFILE: cwd,
        CLAUDE_CONFIG_DIR: path.join(cwd, 'claude-config'),
        MEMESH_DIR: memeshDir,
      },
      encoding: 'utf8',
    });
    const markerPath = path.join(memeshDir, 'install-hooks.json');
    expect(fs.existsSync(markerPath), 'fixture: the marker was not actually written').toBe(true);
    expect(out).toContain(`Marker: ${markerPath}`);
  });

  it('a re-run that changes nothing says so, and does not tell the user to restart; one that only recreates the citation rule does not claim nothing was written (#528)', () => {
    const run = () => execFileSync('node', [cliPath, 'install-hooks', '--scope', 'project'], {
      cwd,
      env: { ...process.env, HOME: cwd, USERPROFILE: cwd, CLAUDE_CONFIG_DIR: path.join(cwd, 'claude-config'), MEMESH_DIR: memeshDir },
      encoding: 'utf8',
    });
    const first = run();
    expect(first).toContain('Restart Claude Code');
    const rulePath = /Citation contract created: (.+)/.exec(first)?.[1]?.trim();
    expect(rulePath, 'fixture: the first run did not report creating the citation rule').toBeTruthy();

    const second = run();
    expect(second).toContain('Nothing needed to change');
    expect(second).not.toContain('Restart Claude Code');
    expect(second).toContain('Nothing to restart');
    expect(second).not.toContain('Citation contract');
    expect(second).not.toContain('Marker:');

    // Only the rule file is rewritten: settings.json did not change, so no restart; a new session is enough.
    fs.rmSync(rulePath as string);
    const third = run();
    expect(third).toContain('Citation contract created');
    expect(third).not.toContain('Nothing needed to change');
    expect(third).not.toContain('Restart Claude Code');
    expect(third).not.toContain('Nothing to restart');
    expect(third).toContain('Open a new Claude Code session for the citation contract');

    // Only the marker is rewritten: still "something was written", and the Marker line names the file.
    fs.rmSync(path.join(memeshDir, 'install-hooks.json'));
    const fourth = run();
    expect(fourth).toContain(`Marker: ${path.join(memeshDir, 'install-hooks.json')}`);
    expect(fourth).not.toContain('Nothing needed to change');
  });
});
