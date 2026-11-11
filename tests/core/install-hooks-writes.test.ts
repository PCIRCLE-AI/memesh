/**
 * What `installHooks` / `uninstallHooks` do when something goes wrong while writing, and when memesh's
 * own hooks file is damaged (#528, second round of review). The real-CLI cases (read-only files and folders,
 * links to nowhere, ...) are in tests/cli/install-hooks-failure.test.ts; these are the ones that need
 * to fail a write in the middle of a run, or freeze the clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { diffSnapshots, snapshotTree } from '../helpers/fs-snapshot.js';
import { canDenyReads } from '../helpers/permissions.js';
import { removeTempDir } from '../helpers/temp-dir.js';

const GOOD_MANIFEST = {
  hooks: {
    SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-start.js' }] }],
    Stop: [{ matcher: '*', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-summary.js' }] }],
  },
};

describe('install-hooks writes (#528)', () => {
  let tmpDir: string;
  let pluginDir: string;
  let home: string;
  let settingsPath: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-ih-writes-')));
    pluginDir = path.join(tmpDir, 'plugin');
    home = path.join(tmpDir, 'home');
    fs.mkdirSync(path.join(pluginDir, 'hooks'), { recursive: true });
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(pluginDir, 'hooks', 'hooks.json'), JSON.stringify(GOOD_MANIFEST));
    for (const key of ['MEMESH_DIR', 'HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR']) saved[key] = process.env[key];
    process.env.MEMESH_DIR = path.join(home, '.memesh');
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.CLAUDE_CONFIG_DIR;
    settingsPath = path.join(home, '.claude', 'settings.json');
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    removeTempDir(tmpDir);
  });

  const freshModule = () => import('../../src/core/install-hooks.js');
  const install = async (extra: Record<string, unknown> = {}) => (await freshModule()).installHooks({ pluginRoot: pluginDir, pluginVersion: '4.1.4', scope: 'user', ...extra });
  const uninstall = async () => (await freshModule()).uninstallHooks({ scope: 'user' });
  const picture = () => snapshotTree(home, { contentOnly: true });
  const backups = () => (fs.existsSync(path.dirname(settingsPath)) ? fs.readdirSync(path.dirname(settingsPath)).filter((f) => f.includes('.bak-pre-memesh-')).sort() : []);

  describe("memesh's own hooks file", () => {
    // [what is wrong, the file, what the sentence says is wrong with it]
    const BROKEN: Array<[string, string, string]> = [
      ['{"hooks":[]}', '{"hooks":[]}', '"hooks" is not an object'],
      ['{"hooks":{}}', '{"hooks":{}}', 'it declares no hooks'],
      ['an event with no entries only', '{"hooks":{"Stop":[]}}', 'it declares no hooks'],
      ['{"hooks":null}', '{"hooks":null}', '"hooks" is not an object'],
      ['null', 'null', 'it is not a JSON object'],
      ['a list', '[]', 'it is not a JSON object'],
      ['a string', '"hooks"', 'it is not a JSON object'],
      ['not JSON', '{not json', 'it is not valid JSON'],
      ['an event that is an object', '{"hooks":{"Stop":{}}}', 'hooks.Stop is not a list'],
      ['an event that is a string', '{"hooks":{"Stop":"x"}}', 'hooks.Stop is not a list'],
      ['a null entry', '{"hooks":{"Stop":[null]}}', 'hooks.Stop[0] is not an object'],
      ['an entry whose hooks is null', '{"hooks":{"Stop":[{"hooks":null}]}}', 'hooks.Stop[0].hooks is not a list'],
      ['an entry without hooks', '{"hooks":{"Stop":[{"matcher":"*"}]}}', 'hooks.Stop[0].hooks is not a list'],
      ['a null command object', '{"hooks":{"Stop":[{"hooks":[null]}]}}', 'hooks.Stop[0].hooks[0] is not an object'],
      ['a command object without a command', '{"hooks":{"Stop":[{"hooks":[{"type":"command"}]}]}}', 'hooks.Stop[].hooks[0].command is not a string'],
      ['a command that is a number', '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":5}]}]}}', 'hooks.Stop[].hooks[0].command is not a string'],
    ];

    it.each(BROKEN)('%s is refused in one plain sentence, and a machine that already has the hooks keeps all of them', async (_label, body, why) => {
      await install();
      const installed = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks;
      expect(Object.keys(installed), 'fixture: nothing was installed').toEqual(['SessionStart', 'Stop']);
      const manifestPath = path.join(pluginDir, 'hooks', 'hooks.json');
      fs.writeFileSync(manifestPath, body);
      const before = snapshotTree(home);

      let message = '';
      try { await install(); } catch (err) { message = (err as Error).message; }
      expect(message, 'the install did not refuse').not.toBe('');
      expect(message).toContain(`memesh's own hooks file at ${manifestPath} is damaged (${why}) and cannot be used`);
      expect(message).toContain('nothing was changed');
      expect(message, 'a raw TypeError reached the person').not.toMatch(/Cannot read|is not a function|undefined|TypeError/);
      expect(diffSnapshots(before, snapshotTree(home))).toEqual([]);
    });

    it('on a machine with nothing installed, a damaged file leaves HOME empty', async () => {
      fs.writeFileSync(path.join(pluginDir, 'hooks', 'hooks.json'), '{"hooks":[]}');
      await expect(install()).rejects.toThrow(/is damaged/);
      expect(fs.readdirSync(home)).toEqual([]);
    });
  });

  describe('a failure in the middle of a write', () => {
    /** Make the next write to `target` fail, as a full disk would. */
    const failWriteTo = (target: string) => {
      const real = fs.writeFileSync.bind(fs);
      return vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (file === target) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        return (real as (...a: unknown[]) => void)(file, ...rest);
      }) as typeof fs.writeFileSync);
    };

    it('a rule file that cannot be written puts back the settings, the marker, the folders and removes the backup', async () => {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({ model: 'x' }));
      const before = picture();
      failWriteTo(path.join(home, '.claude', 'rules', 'memesh-citations.md'));
      await expect(install()).rejects.toThrow(/ENOSPC/);
      vi.restoreAllMocks();
      expect(diffSnapshots(before, picture())).toEqual([]);
    });

    it('on a machine with no settings yet, the folders this run created are removed again', async () => {
      failWriteTo(path.join(home, '.claude', 'rules', 'memesh-citations.md'));
      await expect(install()).rejects.toThrow(/ENOSPC/);
      vi.restoreAllMocks();
      expect(fs.readdirSync(home)).toEqual([]);
    });

    it('a marker that cannot be written puts the settings back', async () => {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({ model: 'x' }));
      const before = picture();
      failWriteTo(path.join(home, '.memesh', 'install-hooks.json'));
      await expect(install()).rejects.toThrow(/ENOSPC/);
      vi.restoreAllMocks();
      expect(diffSnapshots(before, picture())).toEqual([]);
    });

    it('a citation rule that cannot be removed by uninstall puts the marker and the settings back', async () => {
      await install();
      const before = picture();
      const rule = path.join(home, '.claude', 'rules', 'memesh-citations.md');
      const real = fs.rmSync.bind(fs);
      vi.spyOn(fs, 'rmSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
        if (target === rule) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
        return (real as (...a: unknown[]) => void)(target, ...rest);
      }) as typeof fs.rmSync);
      await expect(uninstall()).rejects.toThrow(/EBUSY/);
      vi.restoreAllMocks();
      expect(diffSnapshots(before, picture())).toEqual([]);
      expect(fs.existsSync(path.join(home, '.memesh', 'install-hooks.json')), 'the marker stayed deleted').toBe(true);
    });

    it('a marker that cannot be removed by uninstall is reported, and the settings are put back, not left rewritten', async () => {
      await install();
      const before = picture();
      const marker = path.join(home, '.memesh', 'install-hooks.json');
      const real = fs.rmSync.bind(fs);
      vi.spyOn(fs, 'rmSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
        if (target === marker) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
        return (real as (...a: unknown[]) => void)(target, ...rest);
      }) as typeof fs.rmSync);
      await expect(uninstall()).rejects.toThrow(/EBUSY/);
      vi.restoreAllMocks();
      expect(diffSnapshots(before, picture())).toEqual([]);
      expect(fs.readFileSync(settingsPath, 'utf8')).toContain('_memesh');
    });
  });

  describe('the order of writes', () => {
    it('uninstall removes the citation rule only after the settings were written back', async () => {
      await install();
      const rulePath = path.join(home, '.claude', 'rules', 'memesh-citations.md');
      expect(fs.existsSync(rulePath), 'fixture: no rule file').toBe(true);
      const order: string[] = [];
      const realWrite = fs.writeFileSync.bind(fs);
      const realRm = fs.rmSync.bind(fs);
      vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (file === settingsPath) order.push('settings');
        return (realWrite as (...a: unknown[]) => void)(file, ...rest);
      }) as typeof fs.writeFileSync);
      vi.spyOn(fs, 'rmSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
        if (target === rulePath) order.push('rule');
        return (realRm as (...a: unknown[]) => void)(target, ...rest);
      }) as typeof fs.rmSync);
      await uninstall();
      expect(order).toEqual(['settings', 'rule']);
    });

    it('install writes the citation rule after the settings and the marker', async () => {
      const rulePath = path.join(home, '.claude', 'rules', 'memesh-citations.md');
      const marker = path.join(home, '.memesh', 'install-hooks.json');
      const order: string[] = [];
      const real = fs.writeFileSync.bind(fs);
      vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (file === settingsPath) order.push('settings');
        if (file === marker) order.push('marker');
        if (file === rulePath) order.push('rule');
        return (real as (...a: unknown[]) => void)(file, ...rest);
      }) as typeof fs.writeFileSync);
      await install();
      expect(order).toEqual(['settings', 'marker', 'rule']);
    });
  });

  describe('backups', () => {
    it('two backups made in the same millisecond do not overwrite each other: the original settings survive', async () => {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const original = JSON.stringify({ model: 'original' }, null, 2);
      fs.writeFileSync(settingsPath, original);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-11T10:42:29.727Z'));
      const first = await install();
      const second = await uninstall();
      const third = await install();
      const paths = [first.backupPath, second.backupPath, third.backupPath];
      expect(paths.every((p) => p !== null)).toBe(true);
      expect(new Set(paths).size, `the three backups share a name: ${paths.join(', ')}`).toBe(3);
      expect(backups()).toHaveLength(3);
      expect(fs.readFileSync(first.backupPath!, 'utf8'), 'the original settings were overwritten').toBe(original);
    });
  });

  describe('a run that has nothing to write is not stopped by files it would not have written', () => {
    it.skipIf(!canDenyReads)('everything already installed: read-only settings, folders and marker are fine', async () => {
      await install();
      fs.chmodSync(settingsPath, 0o444);
      fs.chmodSync(path.dirname(settingsPath), 0o555);
      fs.chmodSync(path.join(home, '.memesh'), 0o555);
      try {
        const again = await install();
        expect([again.settingsWritten, again.markerWritten, again.citationRule.action]).toEqual([false, false, 'unchanged']);
      } finally {
        fs.chmodSync(path.dirname(settingsPath), 0o755);
        fs.chmodSync(path.join(home, '.memesh'), 0o755);
      }
    });
  });

  describe('the install marker', () => {
    it('is refreshed when only the plugin root it names has changed', async () => {
      // Commands with no ${CLAUDE_PLUGIN_ROOT} in them: moving the plugin changes nothing in settings.json.
      fs.writeFileSync(path.join(pluginDir, 'hooks', 'hooks.json'), JSON.stringify({
        hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: '/abs/session-summary.js' }] }] },
      }));
      const { readInstallMarker } = await freshModule();
      await install();
      const movedRoot = path.join(tmpDir, 'moved');
      fs.cpSync(pluginDir, movedRoot, { recursive: true });
      const moved = await install({ pluginRoot: movedRoot });
      expect([moved.settingsWritten, moved.markerWritten]).toEqual([false, true]);
      expect(readInstallMarker()?.plugin_root).toBe(movedRoot);
    });
  });
});
