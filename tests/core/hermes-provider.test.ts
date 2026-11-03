/**
 * The Hermes memory provider copy: installed by MeMesh, recognised by its
 * marker, refreshed only when it is untouched, backed up before it is replaced.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  HERMES_REASONS,
  MARKER_FILE,
  candidateInstalls,
  defaultInstallTarget,
  inspectInstall,
  installProvider,
  refreshInstalls,
  registerInstall,
  staleInstalls,
} from '../../src/core/hermes-provider.js';
import { removeTempDir } from '../helpers/temp-dir.js';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-hermes-')));
  dirs.push(d);
  return d;
}
afterEach(() => { removeTempDir(...dirs.splice(0)); });

/** A provider source directory with the given __init__.py text. */
function source(init: string): string {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '__init__.py'), init);
  fs.writeFileSync(path.join(dir, 'plugin.yaml'), 'name: memesh\n');
  return dir;
}

const NOW = new Date('2026-11-07T00:00:00Z');

function world() {
  const root = tmp();
  const memeshDir = path.join(root, 'memesh');
  const hermes = path.join(root, 'hermes-home');
  fs.mkdirSync(memeshDir);
  fs.mkdirSync(hermes);
  const env = { HERMES_HOME: hermes } as NodeJS.ProcessEnv;
  const target = defaultInstallTarget(env);
  return { root, memeshDir, hermes, env, target, backupRoot: path.join(memeshDir, 'backups') };
}

const install = (w: ReturnType<typeof world>, sourceDir: string, version: string, force = false, target = w.target) =>
  installProvider({ sourceDir, target, version, force, backupRoot: w.backupRoot, now: NOW });

describe('install', () => {
  it('puts the provider where Hermes discovers user plugins and records what it wrote', () => {
    const w = world();
    expect(w.target).toBe(path.join(w.hermes, 'plugins', 'memesh'));
    const result = install(w, source('# v1\n'), '4.13.0');
    expect(result).toMatchObject({ outcome: 'installed', reason: HERMES_REASONS.installed, backup: null });
    expect(fs.readFileSync(path.join(w.target, '__init__.py'), 'utf8')).toBe('# v1\n');
    const marker = JSON.parse(fs.readFileSync(path.join(w.target, MARKER_FILE), 'utf8'));
    expect(marker).toMatchObject({ source: 'memesh', version: '4.13.0' });
    expect(Object.keys(marker.files).sort()).toEqual(['__init__.py', 'plugin.yaml']);
    expect(inspectInstall(w.target)).toMatchObject({ state: 'managed', modified: false });
  });

  it('is a no-op when the copy is already the same version and content', () => {
    const w = world();
    const src = source('# v1\n');
    install(w, src, '4.13.0');
    const second = install(w, src, '4.13.0');
    expect(second).toMatchObject({ outcome: 'unchanged', backup: null });
    expect(fs.existsSync(w.backupRoot)).toBe(false);
  });

  it('refreshes an untouched copy to a newer version; MeMesh\'s own old files are in the package they came from, so nothing is saved', () => {
    const w = world();
    install(w, source('# v1\n'), '4.13.0');
    const result = install(w, source('# v2\n'), '4.14.0');
    expect(result).toMatchObject({ outcome: 'refreshed', reason: HERMES_REASONS.refreshed });
    expect(fs.readFileSync(path.join(w.target, '__init__.py'), 'utf8')).toBe('# v2\n');
    expect(JSON.parse(fs.readFileSync(path.join(w.target, MARKER_FILE), 'utf8')).version).toBe('4.14.0');
    expect(result.backup).toBeNull();
    expect(fs.readdirSync(path.dirname(w.target)).sort()).toEqual(['memesh']); // no staging directory left behind
  });

  it('ignores Python bytecode when judging whether a copy was edited', () => {
    const w = world();
    install(w, source('# v1\n'), '4.13.0');
    fs.mkdirSync(path.join(w.target, '__pycache__'));
    fs.writeFileSync(path.join(w.target, '__pycache__', 'x.cpython-312.pyc'), 'bytes');
    expect(inspectInstall(w.target)).toMatchObject({ state: 'managed', modified: false });
  });
});

describe('what counts as a file of the copy', () => {
  it('a Python bytecode file at the top, and a non-bytecode file inside __pycache__, are each ignored on their own', () => {
    const w = world();
    install(w, source('# v1\n'), '4.13.0');
    fs.writeFileSync(path.join(w.target, 'x.pyc'), 'bytes'); // a .pyc outside any __pycache__
    expect(inspectInstall(w.target)).toMatchObject({ state: 'managed', modified: false });
    fs.rmSync(path.join(w.target, 'x.pyc'));
    fs.mkdirSync(path.join(w.target, '__pycache__'));
    fs.writeFileSync(path.join(w.target, '__pycache__', 'notes.txt'), 'not bytecode, but in __pycache__'); // a non-.pyc file inside it
    expect(inspectInstall(w.target)).toMatchObject({ state: 'managed', modified: false });
  });

  it('what is copied leaves out the same files: a source with bytecode and a __pycache__ gives a copy without them', () => {
    const w = world();
    const src = source('# v1\n');
    fs.writeFileSync(path.join(src, 'x.pyc'), 'bytes');
    fs.mkdirSync(path.join(src, '__pycache__'));
    fs.writeFileSync(path.join(src, '__pycache__', 'y.cpython-312.pyc'), 'bytes');
    install(w, src, '4.13.0');
    expect(fs.readdirSync(w.target).sort()).toEqual(['.memesh-install.json', '__init__.py', 'plugin.yaml']);
  });
});

describe('a refresh that fails half way leaves the old copy and no mess', () => {
  it('when the move of the new copy into place fails, the old copy is put back and nothing is left beside it', () => {
    const w = world();
    install(w, source('# v1\n'), '4.13.0');
    const real = fs.renameSync;
    const realTarget = fs.realpathSync(w.target); // read before the spy: the target is moved aside later
    let toTarget = 0;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === realTarget || String(to) === w.target) { toTarget += 1; if (toTarget === 1) throw new Error('simulated rename failure'); }
      return real(from, to);
    });
    try {
      const result = install(w, source('# v2\n'), '4.14.0');
      expect(result).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('simulated rename failure') });
    } finally { spy.mockRestore(); }
    expect(fs.readFileSync(path.join(w.target, '__init__.py'), 'utf8')).toBe('# v1\n');
    expect(fs.readdirSync(path.dirname(w.target))).toEqual(['memesh']);
  });

  it('when copying the new files fails, the staging directory is removed and the old copy is untouched', () => {
    const w = world();
    install(w, source('# v1\n'), '4.13.0');
    const spy = vi.spyOn(fs, 'cpSync').mockImplementation(() => { throw new Error('simulated copy failure'); });
    try {
      expect(install(w, source('# v2\n'), '4.14.0')).toMatchObject({ outcome: 'failed' });
    } finally { spy.mockRestore(); }
    expect(fs.readFileSync(path.join(w.target, '__init__.py'), 'utf8')).toBe('# v1\n');
    expect(fs.readdirSync(path.dirname(w.target))).toEqual(['memesh']);
  });
});

describe('what is left alone', () => {
  it('a directory MeMesh did not install (no marker) is not touched, unless --force, which saves it first', () => {
    const w = world();
    fs.mkdirSync(w.target, { recursive: true });
    fs.writeFileSync(path.join(w.target, '__init__.py'), '# copied by hand\n');
    const refused = install(w, source('# v2\n'), '4.14.0');
    expect(refused).toMatchObject({ outcome: 'skipped', reason: HERMES_REASONS.notOurs });
    expect(fs.readFileSync(path.join(w.target, '__init__.py'), 'utf8')).toBe('# copied by hand\n');
    const forced = install(w, source('# v2\n'), '4.14.0', true);
    expect(forced.outcome).toBe('refreshed');
    expect(fs.readFileSync(path.join(forced.backup!, '__init__.py'), 'utf8')).toBe('# copied by hand\n');
    expect(fs.readFileSync(path.join(w.target, '__init__.py'), 'utf8')).toBe('# v2\n');
  });

  it('a copy its owner edited is recognised and left alone, unless --force', () => {
    const w = world();
    install(w, source('# v1\n'), '4.13.0');
    fs.appendFileSync(path.join(w.target, '__init__.py'), '# my own change\n');
    expect(inspectInstall(w.target)).toMatchObject({ state: 'managed', modified: true });
    const refused = install(w, source('# v2\n'), '4.14.0');
    expect(refused).toMatchObject({ outcome: 'skipped', reason: HERMES_REASONS.modified });
    expect(fs.readFileSync(path.join(w.target, '__init__.py'), 'utf8')).toContain('my own change');
    // A file added to the copy counts as an edit too.
    install(w, source('# v2\n'), '4.14.0', true);
    fs.writeFileSync(path.join(w.target, 'extra.py'), 'x = 1\n');
    expect(inspectInstall(w.target)).toMatchObject({ state: 'managed', modified: true });
  });

  it('an unreadable marker is not treated as ownership', () => {
    const w = world();
    install(w, source('# v1\n'), '4.13.0');
    fs.writeFileSync(path.join(w.target, MARKER_FILE), '{not json');
    expect(inspectInstall(w.target)).toEqual({ state: 'marker-unreadable' });
    expect(install(w, source('# v2\n'), '4.14.0')).toMatchObject({ outcome: 'skipped', reason: HERMES_REASONS.markerUnreadable });
  });

  it('refuses a source that holds a symlink and leaves the existing copy as it was', () => {
    const w = world();
    install(w, source('# v1\n'), '4.13.0');
    const evil = source('# v2\n');
    fs.symlinkSync('/etc/hosts', path.join(evil, 'hosts-link'));
    const result = install(w, evil, '4.14.0');
    expect(result).toMatchObject({ outcome: 'failed' });
    expect(result.reason).toContain(HERMES_REASONS.unsafeSource);
    expect(fs.readFileSync(path.join(w.target, '__init__.py'), 'utf8')).toBe('# v1\n');
  });
});

describe('refresh (what the automatic updater calls)', () => {
  const refresh = (w: ReturnType<typeof world>, sourceDir: string, version: string) =>
    refreshInstalls({ sourceDir, version, memeshDir: w.memeshDir, env: w.env, now: NOW });

  it('refreshes the default location and every registered one, and says nothing about a location with nothing in it', () => {
    const w = world();
    const checkout = path.join(w.root, 'hermes-agent', 'plugins', 'memory', 'memesh');
    install(w, source('# v1\n'), '4.13.0');
    install(w, source('# v1\n'), '4.13.0', false, checkout);
    registerInstall(w.memeshDir, checkout);
    expect(candidateInstalls(w.memeshDir, w.env).sort()).toEqual([checkout, w.target].sort());
    expect(staleInstalls(w.memeshDir, w.env, '4.13.0')).toEqual([]);
    expect(staleInstalls(w.memeshDir, w.env, '4.14.0').sort()).toEqual([checkout, w.target].sort());

    const results = refresh(w, source('# v2\n'), '4.14.0');
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.outcome)).toEqual(['refreshed', 'refreshed']);
    for (const p of [w.target, checkout]) expect(fs.readFileSync(path.join(p, '__init__.py'), 'utf8')).toBe('# v2\n');
    expect(staleInstalls(w.memeshDir, w.env, '4.14.0')).toEqual([]);

    const empty = world();
    expect(refresh(empty, source('# v2\n'), '4.14.0')).toEqual([]);
  });

  it('reports a registered copy that is not MeMesh\'s, stays silent about an unregistered foreign one at the default location', () => {
    const w = world();
    fs.mkdirSync(w.target, { recursive: true });
    fs.writeFileSync(path.join(w.target, '__init__.py'), '# someone else\n');
    expect(refresh(w, source('# v2\n'), '4.14.0')).toEqual([]);
    registerInstall(w.memeshDir, w.target);
    expect(refresh(w, source('# v2\n'), '4.14.0')).toMatchObject([{ outcome: 'skipped', reason: HERMES_REASONS.notOurs }]);
    expect(fs.readFileSync(path.join(w.target, '__init__.py'), 'utf8')).toBe('# someone else\n');
  });

  it('leaves an edited copy alone and says so', () => {
    const w = world();
    install(w, source('# v1\n'), '4.13.0');
    fs.appendFileSync(path.join(w.target, '__init__.py'), '# mine\n');
    const results = refresh(w, source('# v2\n'), '4.14.0');
    expect(results).toMatchObject([{ outcome: 'skipped', reason: HERMES_REASONS.modified }]);
    expect(fs.readFileSync(path.join(w.target, '__init__.py'), 'utf8')).toContain('# mine');
  });
});
