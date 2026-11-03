/**
 * `memesh config set|unset autoUpdate` says what it did not do: another config (the account's own ~/.memesh) may still say
 * off, or be unreadable (which counts as off). The real built CLI runs with a throwaway HOME that the account lookup follows
 * (the preload), so nothing here touches the maintainer's real files.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withAccountHomePreload } from '../../scripts/lib/isolated-env.mjs';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

function world() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cfg-')));
  dirs.push(root);
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const account = path.join(home, '.memesh');
  for (const d of [home, data, account]) fs.mkdirSync(d);
  const env = withAccountHomePreload({ PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, MEMESH_DIR: data, MEMESH_DB_PATH: path.join(data, 'knowledge-graph.db') });
  const run = (...args: string[]) => spawnSync(process.execPath, [path.resolve('dist/transports/cli/cli.js'), 'config', ...args], { env, encoding: 'utf8', timeout: 60_000 });
  return { root, home, data, account, run };
}

describe.skipIf(process.platform === 'win32')('config set / unset autoUpdate: what is still holding automatic updates off', () => {
  it('set to major while the account config says off: it says that one still wins, and how to change it', () => {
    const w = world();
    fs.writeFileSync(path.join(w.account, 'config.json'), '{"autoUpdate":"off"}');
    const r = w.run('set', 'autoUpdate', 'major');
    expect(r.status === 0, r.stderr).toBe(true);
    expect(r.stdout).toContain('Set autoUpdate = major');
    expect(r.stdout).toContain(`Automatic updates are still off: ${path.join(w.account, 'config.json')} says off`);
    expect(r.stdout).toContain(`MEMESH_DIR=${w.account} memesh config set autoUpdate major`);
    expect(fs.readFileSync(path.join(w.account, 'config.json'), 'utf8')).toBe('{"autoUpdate":"off"}'); // not touched
  });

  it('set to major while the account config cannot be parsed: unreadable counts as off, and it says to repair the file', () => {
    const w = world();
    fs.writeFileSync(path.join(w.account, 'config.json'), '{ not json');
    const r = w.run('set', 'autoUpdate', 'major');
    expect(r.status === 0, r.stderr).toBe(true);
    expect(r.stdout).toContain('cannot be read (not valid JSON)');
    expect(r.stdout).toContain('counts as off');
    expect(r.stdout).toContain('Repair or delete that file');
    expect(fs.readFileSync(path.join(w.account, 'config.json'), 'utf8')).toBe('{ not json');
  });

  it('set to major with nothing holding it back says nothing more', () => {
    const w = world();
    const r = w.run('set', 'autoUpdate', 'major');
    expect(r.status === 0, r.stderr).toBe(true);
    expect(r.stdout).not.toContain('still off');
  });

  it('unset while the account config says off, or cannot be read, says so; with nothing holding it, it does not', () => {
    const w = world();
    w.run('set', 'autoUpdate', 'minor');
    fs.writeFileSync(path.join(w.account, 'config.json'), '{"autoUpdate":"off"}');
    expect(w.run('unset', 'autoUpdate').stdout).toContain('says off. Remove it there too');
    w.run('set', 'autoUpdate', 'minor');
    fs.writeFileSync(path.join(w.account, 'config.json'), '[1]');
    expect(w.run('unset', 'autoUpdate').stdout).toContain('cannot be read (not a JSON object)');
    w.run('set', 'autoUpdate', 'minor');
    fs.rmSync(path.join(w.account, 'config.json'));
    expect(w.run('unset', 'autoUpdate').stdout).not.toContain('still off');
  });
});

describe('the account-home preload', () => {
  it('answers os.userInfo().homedir with HOME, also for code that imported userInfo by name, and for a path with spaces and a percent sign', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh pre%25 load-')));
    dirs.push(root);
    const lib = path.join(root, 'lib');
    fs.mkdirSync(lib);
    for (const f of fs.readdirSync(path.resolve('scripts/lib')).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))) fs.copyFileSync(path.resolve('scripts/lib', f), path.join(lib, f));
    const home = path.join(root, 'fake-home');
    fs.mkdirSync(home);
    const probe = path.join(root, 'probe.mjs');
    // a named import taken BEFORE anything else could patch the default object: it only follows if the exports are synced
    fs.writeFileSync(probe, "import { userInfo } from 'node:os'; import os from 'node:os'; console.log(JSON.stringify([userInfo().homedir, os.userInfo().homedir]));\n");
    return import(pathToFileURL(path.join(lib, 'isolated-env.mjs')).href).then((mod: { withAccountHomePreload: (e: NodeJS.ProcessEnv) => NodeJS.ProcessEnv }) => {
      const env = mod.withAccountHomePreload({ PATH: process.env.PATH ?? '', HOME: home });
      const r = spawnSync(process.execPath, [probe], { env, encoding: 'utf8' });
      expect(r.status === 0, r.stderr).toBe(true);
      expect(JSON.parse(r.stdout)).toEqual([home, home]);
    });
  });
});
