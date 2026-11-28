/**
 * `memesh hermes install`, the real built CLI: what it puts where, what it refuses, what it records so that automatic
 * updates find the copy later, and what it says when it could not record it. Everything runs under a throwaway HOME,
 * Hermes home and data directory.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

function world(setting: string = 'major') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-hermes-cli-'));
  dirs.push(root);
  const home = path.join(root, 'home');
  const hermes = path.join(root, 'hermes');
  const data = path.join(root, 'data');
  for (const d of [home, hermes, data]) fs.mkdirSync(d);
  const env = { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, HERMES_HOME: hermes, MEMESH_DIR: data, MEMESH_DB_PATH: path.join(data, 'knowledge-graph.db'), MEMESH_AUTO_UPDATE: setting };
  const target = path.join(hermes, 'plugins', 'memesh');
  const run = (...args: string[]) => spawnSync(process.execPath, [path.resolve('dist/transports/cli/cli.js'), 'hermes', 'install', ...args], { env, encoding: 'utf8', timeout: 60_000 });
  const registry = path.join(data, 'hermes-installs.json');
  return { root, data, target, run, registry };
}

describe.skipIf(process.platform === 'win32')('memesh hermes install (the built CLI)', () => {
  it('installs the provider with its marker, and records the copy so automatic updates will refresh it', () => {
    const w = world();
    const r = w.run();
    expect(r.status === 0, r.stderr).toBe(true);
    expect(r.stdout).toContain('installed at');
    expect(fs.existsSync(path.join(w.target, '__init__.py'))).toBe(true);
    expect(fs.existsSync(path.join(w.target, '.memesh-install.json'))).toBe(true);
    // the record that makes it refreshable: without it the copy is never brought up to date
    expect(JSON.parse(fs.readFileSync(w.registry, 'utf8'))).toEqual({ installs: [w.target] });
  });

  it('a second run on its own unmodified copy changes nothing and says so', () => {
    const w = world();
    expect(w.run().status === 0).toBe(true);
    const again = w.run();
    expect(again.status === 0).toBe(true);
    expect(again.stdout).toContain('unchanged');
    expect(fs.existsSync(path.join(w.data, 'backups'))).toBe(false);
  });

  it('a directory MeMesh did not create is refused (exit 1, says how to replace it), left as it was, and not recorded', () => {
    const w = world();
    fs.mkdirSync(w.target, { recursive: true });
    fs.writeFileSync(path.join(w.target, 'mine.txt'), 'not MeMesh\'s');
    const r = w.run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not installed');
    expect(r.stderr).toContain('--force');
    expect(fs.readFileSync(path.join(w.target, 'mine.txt'), 'utf8')).toBe('not MeMesh\'s');
    expect(fs.existsSync(w.registry)).toBe(false);
  });

  it('--force replaces it after saving it under the data directory, and says where the old copy is', () => {
    const w = world();
    fs.mkdirSync(w.target, { recursive: true });
    fs.writeFileSync(path.join(w.target, 'mine.txt'), 'not MeMesh\'s');
    const r = w.run('--force');
    expect(r.status === 0, r.stderr).toBe(true);
    const saved = /Previous copy saved at (.+)/.exec(r.stdout)?.[1];
    expect(saved).toBeDefined();
    expect(saved!.startsWith(path.join(w.data, 'backups'))).toBe(true);
    expect(fs.readFileSync(path.join(saved!, 'mine.txt'), 'utf8')).toBe('not MeMesh\'s');
    expect(fs.existsSync(path.join(w.target, 'mine.txt'))).toBe(false);
    expect(fs.existsSync(path.join(w.target, '.memesh-install.json'))).toBe(true);
  });

  it('a copy its owner edited is refused, and --force saves it first', () => {
    const w = world();
    expect(w.run().status === 0).toBe(true);
    fs.appendFileSync(path.join(w.target, '__init__.py'), '\n# my own change\n');
    const refused = w.run();
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('--force');
    expect(fs.readFileSync(path.join(w.target, '__init__.py'), 'utf8')).toContain('my own change');
    const forced = w.run('--force');
    expect(forced.status === 0, forced.stderr).toBe(true);
    const saved = /Previous copy saved at (.+)/.exec(forced.stdout)?.[1];
    expect(fs.readFileSync(path.join(saved!, '__init__.py'), 'utf8')).toContain('my own change');
  });

  it('--path puts it where asked, and records that place', () => {
    const w = world();
    const elsewhere = path.join(w.root, 'checkout', 'plugins', 'memory', 'memesh');
    const r = w.run('--path', elsewhere);
    expect(r.status === 0, r.stderr).toBe(true);
    expect(JSON.parse(fs.readFileSync(w.registry, 'utf8')).installs).toEqual([elsewhere]);
  });

  it('when the record of installs cannot be written the copy is in place, and the command says it will not be refreshed, and exits 1', () => {
    const w = world();
    fs.mkdirSync(w.registry); // a directory where the list belongs
    const r = w.run();
    expect(r.status).toBe(1);
    expect(fs.existsSync(path.join(w.target, '__init__.py'))).toBe(true);
    expect(r.stderr).toContain('could not record it for automatic updates');
    expect(r.stderr).toContain('will not be refreshed with MeMesh');
  });

  it('a target that is a symbolic link is refused even with --force, nothing is written through it, and the message says what to do', () => {
    const w = world();
    const real = path.join(w.root, 'elsewhere');
    fs.mkdirSync(real);
    fs.mkdirSync(path.dirname(w.target), { recursive: true });
    fs.symlinkSync(real, w.target);
    const r = w.run('--force');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('symbolic link');
    expect(r.stderr).toContain('point --path at a real directory');
    expect(fs.readdirSync(path.dirname(w.target)).length).toBeGreaterThan(0); // the link is there: the emptiness below is of what it points to
    expect(fs.readdirSync(real)).toEqual([]);
    expect(fs.existsSync(w.registry)).toBe(false);
  });

  it('with no HERMES_HOME and no home directory it exits 1 with a plain message asking for --path, not a stack trace', () => {
    const w = world();
    const env = { PATH: process.env.PATH ?? '', MEMESH_DIR: w.data, MEMESH_DB_PATH: path.join(w.data, 'knowledge-graph.db'), MEMESH_AUTO_UPDATE: 'major' };
    const r = spawnSync(process.execPath, [path.resolve('dist/transports/cli/cli.js'), 'hermes', 'install'], { env, encoding: 'utf8', timeout: 60_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--path');
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  it('says that automatic updates keep the copy current only when they are on', () => {
    const on = world('major').run();
    expect(on.stdout).toContain('Automatic MeMesh updates keep this copy current.');
    const off = world('off').run();
    expect(off.status === 0).toBe(true);
    expect(off.stdout).toContain('Automatic updates are off, so this copy stays at this version');
    expect(off.stdout).not.toContain('keep this copy current');
  });
});
