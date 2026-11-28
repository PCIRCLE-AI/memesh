/**
 * The Hermes provider copy under stress: what an interrupted refresh leaves, two refreshes at once, an unreadable list of
 * copies, no home directory, backups that are never rotated.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import {
  HERMES_REASONS,
  REGISTRY_FILE,
  candidateInstalls,
  defaultInstallTarget,
  installProvider,
  refreshInstalls,
  registerInstall,
  registryProblemResult,
} from '../../src/core/hermes-provider.js';
import { removeTempDir } from '../helpers/temp-dir.js';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-hermes-rec-')));
  dirs.push(d);
  return d;
}
afterEach(() => { removeTempDir(...dirs.splice(0)); });

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
  return { root, memeshDir, hermes, env, target: defaultInstallTarget(env), backupRoot: path.join(memeshDir, 'backups') };
}
type World = ReturnType<typeof world>;

const install = (w: World, sourceDir: string, version: string, force = false, target = w.target) =>
  installProvider({ sourceDir, target, version, force, backupRoot: w.backupRoot, now: NOW });
const refresh = (w: World, sourceDir: string, version: string) =>
  refreshInstalls({ sourceDir, version, memeshDir: w.memeshDir, env: w.env, now: NOW });

/** A pid that belongs to no running process: a child that has already exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}

/** The aside copy of an interrupted refresh: `.memesh-old-<base>-<pid>-<tag>/copy`. */
function leaveOld(target: string, owner: string, init: string): string {
  const root = path.join(path.dirname(target), `.memesh-old-${path.basename(target)}-${owner}`);
  fs.mkdirSync(path.join(root, 'copy'), { recursive: true });
  fs.writeFileSync(path.join(root, 'copy', '__init__.py'), init);
  return root;
}

describe('leftovers of an interrupted refresh belong to ONE copy, and to a dead owner', () => {
  it('a sibling whose name starts with this one (memesh-dev beside memesh) is neither restored from nor deleted', () => {
    const w = world();
    install(w, source('# v1\n'), '4.13.0');
    const sibling = path.join(path.dirname(w.target), 'memesh-dev');
    const theirs = leaveOld(sibling, `${deadPid()}-x`, '# the sibling copy\n');
    fs.rmSync(w.target, { recursive: true }); // ours is lost; the only aside copy there is the sibling's
    refresh(w, source('# v2\n'), '4.14.0');
    expect(fs.existsSync(w.target)).toBe(false);
    expect(fs.existsSync(path.join(theirs, 'copy', '__init__.py'))).toBe(true);
  });

  it('our leftover is not taken for the sibling\'s either: a sibling that is not registered is nobody\'s business here', () => {
    const w = world();
    const sibling = path.join(path.dirname(w.target), 'memesh-dev');
    install(w, source('# v1\n'), '4.13.0', false, sibling);
    const ours = leaveOld(w.target, `${deadPid()}-x`, '# ours\n');
    // our own leftover is restored (we have no copy and a dead owner's aside copy), the sibling is not touched
    refresh(w, source('# v2\n'), '4.14.0');
    expect(fs.readFileSync(path.join(w.target, '__init__.py'), 'utf8')).toBe('# ours\n');
    expect(fs.existsSync(ours)).toBe(false);
    expect(fs.readFileSync(path.join(sibling, '__init__.py'), 'utf8')).toBe('# v1\n');
  });

  it('a live owner keeps its directory; once it is dead the copy is put back and the directory removed', () => {
    const w = world();
    install(w, source('# v1\n'), '4.13.0');
    fs.rmSync(w.target, { recursive: true });
    const live = leaveOld(w.target, `${process.pid}-x`, '# live owner\n'); // this very process: alive
    refresh(w, source('# v2\n'), '4.14.0');
    expect(fs.existsSync(w.target)).toBe(false);
    expect(fs.existsSync(path.join(live, 'copy'))).toBe(true);
    fs.rmSync(live, { recursive: true });
    const gone = leaveOld(w.target, `${deadPid()}-x`, '# dead owner\n');
    const results = refresh(w, source('# v2\n'), '4.14.0');
    expect(fs.readFileSync(path.join(w.target, '__init__.py'), 'utf8')).toBe('# dead owner\n');
    expect(fs.existsSync(gone)).toBe(false);
    expect(results).toHaveLength(1); // the restored copy has no marker: reported (restored), not overwritten
    expect(results[0].outcome).toBe('skipped');
    expect(results[0].reason).toContain(HERMES_REASONS.restored);
  });

  it('a restored MeMesh copy is refreshed and the result says it was restored', () => {
    const w = world();
    install(w, source('# v1\n'), '4.13.0');
    const aside = path.join(path.dirname(w.target), `.memesh-old-memesh-${deadPid()}-x`);
    fs.mkdirSync(aside);
    fs.renameSync(w.target, path.join(aside, 'copy'));
    const results = refresh(w, source('# v2\n'), '4.14.0');
    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe('refreshed');
    expect(results[0].reason).toContain(HERMES_REASONS.restored);
    expect(fs.existsSync(aside)).toBe(false);
    expect(fs.readFileSync(path.join(w.target, '__init__.py'), 'utf8')).toBe('# v2\n');
  });

  it('an install (not a refresh) next to a live owner\'s aside copy neither restores from it nor removes it', () => {
    const w = world();
    const live = leaveOld(w.target, `${process.pid}-x`, '# live owner\n'); // this process: alive
    const r = install(w, source('# v2\n'), '4.14.0');
    expect(r.outcome).toBe('installed'); // nothing to put back: a running refresh may still be about to
    expect(fs.readFileSync(path.join(w.target, '__init__.py'), 'utf8')).toBe('# v2\n');
    expect(fs.existsSync(path.join(live, 'copy', '__init__.py'))).toBe(true);
  });

  it('a restored copy that is already the verified version is reported as restored, and as nothing else', () => {
    const w = world();
    const src = source('# v1\n');
    install(w, src, '4.13.0');
    const aside = path.join(path.dirname(w.target), `.memesh-old-memesh-${deadPid()}-x`);
    fs.mkdirSync(aside);
    fs.renameSync(w.target, path.join(aside, 'copy'));
    const results = refresh(w, src, '4.13.0');
    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe('unchanged');
    expect(results[0].reason).toBe(HERMES_REASONS.restored);
  });

  it('a name that merely looks like a leftover (wrong shape) is left alone', () => {
    const w = world();
    install(w, source('# v1\n'), '4.13.0');
    const odd = path.join(path.dirname(w.target), '.memesh-old-memesh-abc-x');
    fs.mkdirSync(odd);
    refresh(w, source('# v2\n'), '4.14.0');
    expect(fs.existsSync(odd)).toBe(true);
  });

  it('a target that is a dangling symbolic link counts as there (lstat): nothing is put over it', () => {
    const w = world();
    fs.mkdirSync(path.dirname(w.target), { recursive: true });
    fs.symlinkSync(path.join(w.root, 'nowhere'), w.target);
    leaveOld(w.target, `${deadPid()}-x`, '# old\n');
    const results = refresh(w, source('# v2\n'), '4.14.0');
    expect(fs.lstatSync(w.target).isSymbolicLink()).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe('skipped'); // left alone as a link, not "failed to clean up" after trying to move a copy over it
    expect(results[0].reason).toContain('symbolic link');
  });
});

describe('no home directory', () => {
  it('does not throw: only registered copies are looked at, and the log says why there is no default', () => {
    const root = tmp();
    const memeshDir = path.join(root, 'memesh');
    fs.mkdirSync(memeshDir);
    const lines: string[] = [];
    const env = {} as NodeJS.ProcessEnv;
    const results = refreshInstalls({ sourceDir: source('# v2\n'), version: '4.14.0', memeshDir, env, accountHome: null, now: NOW, log: (l) => lines.push(l) });
    expect(results).toEqual([]);
    expect(lines.join('\n')).toContain('no home directory');
    expect(candidateInstalls(memeshDir, env, null)).toEqual([]);
    const checkout = path.join(root, 'checkout', 'memesh');
    installProvider({ sourceDir: source('# v1\n'), target: checkout, version: '4.13.0', force: false, backupRoot: path.join(memeshDir, 'backups'), now: NOW });
    registerInstall(memeshDir, checkout);
    const again = refreshInstalls({ sourceDir: source('# v2\n'), version: '4.14.0', memeshDir, env, accountHome: null, now: NOW });
    expect(again).toHaveLength(1);
    expect(again[0].outcome).toBe('refreshed');
  });
});

describe('a list of registered copies that cannot be read', () => {
  it('is a failed result of its own, with or without a copy to refresh, and the list is never rewritten', () => {
    const w = world();
    fs.writeFileSync(path.join(w.memeshDir, REGISTRY_FILE), '{broken');
    const problem = registryProblemResult(w.memeshDir);
    expect(problem?.outcome).toBe('failed');
    expect(problem?.path).toBe(path.join(w.memeshDir, REGISTRY_FILE));
    expect(problem?.reason).toContain('cannot be read');
    const alone = refresh(w, source('# v2\n'), '4.14.0');
    expect(alone.map((r) => r.outcome)).toEqual(['failed']);
    install(w, source('# v1\n'), '4.13.0');
    const withCopy = refresh(w, source('# v2\n'), '4.14.0');
    expect(withCopy.map((r) => r.outcome).sort()).toEqual(['failed', 'refreshed']);
    expect(fs.readFileSync(path.join(w.memeshDir, REGISTRY_FILE), 'utf8')).toBe('{broken');
    expect(registryProblemResult(tmp())).toBeNull();
  });
});

describe('two refreshes of one copy do not run at once', () => {
  const lockOf = (w: World) => path.join(path.dirname(w.target), '.memesh-lock-memesh');

  it('a lock held by a running owner makes the second one skip with the busy reason; a dead owner\'s lock is taken over', () => {
    const w = world();
    install(w, source('# v1\n'), '4.13.0');
    const lock = lockOf(w);
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, tag: 'x' }));
    const busy = install(w, source('# v2\n'), '4.14.0');
    expect(busy.outcome).toBe('skipped');
    expect(busy.reason).toBe(HERMES_REASONS.busy);
    expect(fs.readFileSync(path.join(w.target, '__init__.py'), 'utf8')).toBe('# v1\n');
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: deadPid(), tag: 'x' }));
    expect(install(w, source('# v2\n'), '4.14.0').outcome).toBe('refreshed');
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('a lock with no owner record is respected while young and taken over when old', () => {
    const w = world();
    install(w, source('# v1\n'), '4.13.0');
    const lock = lockOf(w);
    fs.mkdirSync(lock);
    expect(install(w, source('# v2\n'), '4.14.0').reason).toBe(HERMES_REASONS.busy);
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lock, old, old);
    expect(install(w, source('# v2\n'), '4.14.0').outcome).toBe('refreshed');
  });

  it('the automatic refresh reports the busy copy too', () => {
    const w = world();
    install(w, source('# v1\n'), '4.13.0');
    const lock = lockOf(w);
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, tag: 'x' }));
    const results = refresh(w, source('# v2\n'), '4.14.0');
    expect(results).toHaveLength(1);
    expect(results[0].reason).toBe(HERMES_REASONS.busy);
  });
});

describe('backups are never rotated, and a half-made one is not kept', () => {
  it('four --force runs over foreign copies leave four backups, the earliest included', () => {
    const w = world();
    const made: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      fs.rmSync(w.target, { recursive: true, force: true });
      fs.mkdirSync(w.target, { recursive: true });
      fs.writeFileSync(path.join(w.target, '__init__.py'), `# hand copy ${i}\n`);
      const r = install(w, source(`# v${i}\n`), '4.14.0', true);
      expect(r.backup).not.toBeNull();
      made.push(r.backup as string);
    }
    expect(new Set(made).size).toBe(4);
    expect(fs.readFileSync(path.join(made[0], '__init__.py'), 'utf8')).toBe('# hand copy 0\n');
    expect(fs.readdirSync(w.backupRoot)).toHaveLength(4);
  });

  it('two different copies saved in the same second do not share a backup name (each target has its own id), and the same copy twice gets -2', () => {
    const w = world();
    const other = path.join(w.root, 'other', 'plugins', 'memory', 'memesh');
    const mk = (target: string, text: string) => {
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, '__init__.py'), text);
    };
    mk(w.target, '# one\n');
    mk(other, '# two\n');
    const a = install(w, source('# v\n'), '4.14.0', true).backup as string;
    const b = install(w, source('# v\n'), '4.14.0', true, other).backup as string;
    expect(a).not.toBe(b);
    expect(path.basename(a).replace(/-[0-9a-f]{8}$/, '')).toBe(path.basename(b).replace(/-[0-9a-f]{8}$/, '')); // same second, different id
    expect(fs.readFileSync(path.join(a, '__init__.py'), 'utf8')).toBe('# one\n');
    expect(fs.readFileSync(path.join(b, '__init__.py'), 'utf8')).toBe('# two\n');
    mk(w.target, '# three\n');
    const again = install(w, source('# v\n'), '4.14.0', true).backup as string;
    expect(path.basename(again)).toBe(`${path.basename(a)}-2`); // the same copy in the same second: a counter, never an overwrite
    expect(fs.readFileSync(path.join(a, '__init__.py'), 'utf8')).toBe('# one\n');
  });

  it('a copy that failed half way is removed, and a dead writer\'s .partial directory is swept at the next backup', () => {
    const w = world();
    fs.mkdirSync(w.target, { recursive: true });
    fs.writeFileSync(path.join(w.target, '__init__.py'), '# hand\n');
    fs.mkdirSync(w.backupRoot, { recursive: true });
    fs.mkdirSync(path.join(w.backupRoot, `hermes-provider-old.partial-${deadPid()}`));
    const real = fs.cpSync;
    const spy = vi.spyOn(fs, 'cpSync').mockImplementation((from, to, opts) => {
      if (String(to).includes('.partial-')) { real(from, to, opts); throw new Error('simulated disk full'); }
      return real(from, to, opts);
    });
    try {
      expect(install(w, source('# v2\n'), '4.14.0', true).outcome).toBe('failed');
    } finally { spy.mockRestore(); }
    expect(fs.readdirSync(w.backupRoot).filter((n) => n.includes('.partial-'))).toEqual([]);
    expect(fs.readFileSync(path.join(w.target, '__init__.py'), 'utf8')).toBe('# hand\n');
  });
});

describe('a symbolic link at the target is never written through or over, with or without --force', () => {
  it('skips with the linked reason, even forced, and writes nothing into what it points to', () => {
    const w = world();
    const real = path.join(w.root, 'elsewhere');
    fs.mkdirSync(real);
    fs.mkdirSync(path.dirname(w.target), { recursive: true });
    fs.symlinkSync(real, w.target);
    const r = install(w, source('# v2\n'), '4.14.0', true);
    expect(r.outcome).toBe('skipped');
    expect(r.reason).toContain('symbolic link');
    expect(fs.readdirSync(real)).toEqual([]);
    expect(HERMES_REASONS.linkedHint).toContain('--force');
  });
});

describe('a refresh that is really killed half way (SIGKILL), and what a refresh shows to Hermes while it runs', () => {
  it.skipIf(process.platform === 'win32')('the copy moved aside by a killed process is put back by the next refresh, which names the leftover', () => {
    const w = world();
    install(w, source('# v1\n'), '4.13.0');
    const script = path.join(tmp(), 'killed-refresh.mjs');
    // The child replaces its renameSync: right after the old copy is moved aside it kills itself, as a power cut or the OOM killer would.
    fs.writeFileSync(script, [
      "import fs from 'node:fs';",
      "const real = fs.renameSync;",
      "fs.renameSync = (a, b) => { real(a, b); if (String(b).includes('.memesh-old-')) process.kill(process.pid, 'SIGKILL'); };",
      `const { installProvider } = await import(${JSON.stringify(pathToFileURL(path.resolve('dist/core/hermes-provider.js')).href)});`,
      `installProvider({ sourceDir: ${JSON.stringify(source('# v2\n'))}, target: ${JSON.stringify(w.target)}, version: '4.14.0', force: false, backupRoot: ${JSON.stringify(w.backupRoot)}, now: new Date() });`,
    ].join('\n'));
    const child = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 30_000 });
    expect(child.signal).toBe('SIGKILL');
    expect(fs.existsSync(w.target)).toBe(false);                       // the old copy is aside, the new one never came
    const aside = fs.readdirSync(path.dirname(w.target)).filter((n) => n.startsWith('.memesh-old-memesh-'));
    expect(aside).toHaveLength(1);
    expect(aside[0]).toMatch(new RegExp(`^\\.memesh-old-memesh-${child.pid}-([0-9a-f]{10}|x)$`)); // the name carries the dead writer's pid
    const lines: string[] = [];
    const results = refreshInstalls({ sourceDir: source('# v2\n'), version: '4.14.0', memeshDir: w.memeshDir, env: w.env, now: NOW, log: (l) => lines.push(l) });
    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe('refreshed');
    expect(results[0].reason).toContain(HERMES_REASONS.restored);
    expect(fs.readFileSync(path.join(w.target, '__init__.py'), 'utf8')).toBe('# v2\n');
    expect(fs.readdirSync(path.dirname(w.target)).filter((n) => n.startsWith('.memesh-'))).toEqual([]);
  });

  it('while the new copy is being copied, no directory next to the target holds a plugin.yaml of its own (Hermes would take it for a second provider)', () => {
    const w = world();
    install(w, source('# v1\n'), '4.13.0');
    const dir = path.dirname(w.target);
    const seen: string[] = [];
    const real = fs.cpSync;
    const spy = vi.spyOn(fs, 'cpSync').mockImplementation((from, to, opts) => {
      real(from, to, opts);
      if (String(to).includes('.memesh-new-')) {
        for (const name of fs.readdirSync(dir)) {
          if (name === 'memesh') continue; // the real copy is supposed to have one
          if (fs.existsSync(path.join(dir, name, 'plugin.yaml'))) seen.push(name);
        }
        seen.push(`listed:${fs.readdirSync(dir).filter((n) => n.startsWith('.memesh-new-')).length}`);
      }
    });
    try { install(w, source('# v2\n'), '4.14.0'); } finally { spy.mockRestore(); }
    expect(seen).toEqual(['listed:1']); // the staging directory was there during the copy, and nothing in it looked like a provider
  });
});
