/**
 * `memesh install-hooks` / `uninstall-hooks` that cannot write something fail in one plain sentence
 * and leave the machine exactly as it was (#528, second round of review).
 *
 * Each case builds a throwaway machine, breaks one thing (a read-only file, a read-only folder, a link to
 * nowhere, ...), runs the real built CLI and compares a byte-exact picture of HOME and the working
 * folder before and after: paths, inode, mtime, permissions, size, sha256. A leftover backup, a rule
 * file written before the failure, a folder created on the way, or a settings file rewritten and then
 * reported as failed all show up as a difference.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { canDenyReads } from '../helpers/permissions.js';
import { makeMachine, type Machine } from '../helpers/cli-machine.js';

const machines: Machine[] = [];
afterEach(() => { for (const m of machines.splice(0)) m.cleanup(); });

const ENV = { MEMESH_SKIP_POST_INSTALL_JOURNEY: '1' };
const RAW_ERRNO = /\b(EACCES|ENOENT|ENOTDIR|EISDIR|EPERM|EROFS)\b/;
const USER_HOOK = { type: 'command', command: 'echo mine' };
const USER_SETTINGS = JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [USER_HOOK] }] } }, null, 2);

type Kind = 'install' | 'uninstall';

interface Case {
  name: string;
  kinds: Kind[];
  /** Breaks the machine. For `uninstall` the hooks have already been installed through the CLI. */
  break: (m: Machine, kind: Kind) => void;
  /** Words the one-sentence error must contain, besides "nothing was changed". */
  says: (m: Machine) => string[];
  env?: (m: Machine) => NodeJS.ProcessEnv;
}

const claude = (m: Machine, ...rest: string[]) => path.join(m.home, '.claude', ...rest);
const memesh = (m: Machine, ...rest: string[]) => path.join(m.home, '.memesh', ...rest);

const CASES: Case[] = [
  {
    name: 'a read-only settings.json',
    kinds: ['install', 'uninstall'],
    break: (m, kind) => { if (kind === 'install') { fs.mkdirSync(claude(m)); fs.writeFileSync(claude(m, 'settings.json'), USER_SETTINGS); } fs.chmodSync(claude(m, 'settings.json'), 0o444); },
    says: (m) => [claude(m, 'settings.json'), 'cannot be written'],
  },
  {
    name: 'a read-only .claude folder',
    kinds: ['install', 'uninstall'],
    break: (m, kind) => { if (kind === 'install') { fs.mkdirSync(claude(m)); fs.writeFileSync(claude(m, 'settings.json'), USER_SETTINGS); } fs.chmodSync(claude(m), 0o555); },
    says: (m) => [claude(m), 'cannot be written'],
  },
  {
    name: 'a read-only ~/.memesh folder',
    kinds: ['install', 'uninstall'],
    break: (m, kind) => { if (kind === 'install') fs.mkdirSync(memesh(m)); fs.chmodSync(memesh(m), 0o555); },
    says: (m) => [memesh(m), 'cannot be written'],
  },
  {
    name: 'an install marker that is a folder',
    kinds: ['install', 'uninstall'],
    break: (m, kind) => { if (kind === 'uninstall') fs.rmSync(memesh(m, 'install-hooks.json')); fs.mkdirSync(memesh(m, 'install-hooks.json'), { recursive: true }); },
    says: (m) => [memesh(m, 'install-hooks.json'), 'is a folder'],
  },
  {
    name: 'a rule file that is a folder',
    kinds: ['install', 'uninstall'],
    break: (m, kind) => { if (kind === 'uninstall') fs.rmSync(claude(m, 'rules', 'memesh-citations.md')); fs.mkdirSync(claude(m, 'rules', 'memesh-citations.md'), { recursive: true }); },
    says: (m) => [claude(m, 'rules', 'memesh-citations.md'), 'cannot be read', 'folder'],
  },
  {
    name: 'a read-only .claude folder whose rules folder is writable',
    kinds: ['install', 'uninstall'],
    break: (m, kind) => {
      if (kind === 'install') { fs.mkdirSync(claude(m, 'rules'), { recursive: true }); fs.writeFileSync(claude(m, 'settings.json'), USER_SETTINGS); }
      fs.chmodSync(claude(m), 0o555);
    },
    says: (m) => [claude(m), 'cannot be written'],
  },
  {
    name: 'a ~/.memesh that is a file',
    kinds: ['install'],
    break: (m) => { fs.writeFileSync(memesh(m), 'not a folder'); },
    says: (m) => [memesh(m), 'is not a folder'],
  },
  {
    name: 'a read-only rules folder',
    kinds: ['install', 'uninstall'],
    break: (m, kind) => { if (kind === 'install') fs.mkdirSync(claude(m, 'rules'), { recursive: true }); fs.chmodSync(claude(m, 'rules'), 0o555); },
    says: (m) => [claude(m, 'rules'), 'cannot be written'],
  },
  {
    name: 'a settings.json that is a link to a file that does not exist',
    kinds: ['install'],
    break: (m) => { fs.mkdirSync(claude(m)); fs.symlinkSync(path.join(m.root, 'nowhere', 'settings.json'), claude(m, 'settings.json')); },
    says: (m) => [claude(m, 'settings.json'), 'does not exist'],
  },
  {
    name: 'a settings.json that is a folder',
    kinds: ['install', 'uninstall'],
    break: (m, kind) => { if (kind === 'uninstall') fs.rmSync(claude(m, 'settings.json')); fs.mkdirSync(claude(m, 'settings.json'), { recursive: true }); },
    says: (m) => [claude(m, 'settings.json'), 'cannot be read', 'folder'],
  },
  {
    name: 'a settings.json nobody may read',
    kinds: ['install', 'uninstall'],
    break: (m, kind) => { if (kind === 'install') { fs.mkdirSync(claude(m)); fs.writeFileSync(claude(m, 'settings.json'), USER_SETTINGS); } fs.chmodSync(claude(m, 'settings.json'), 0o000); },
    says: (m) => [claude(m, 'settings.json'), 'cannot be read', 'permission denied'],
  },
  {
    name: 'CLAUDE_CONFIG_DIR that is a file',
    kinds: ['install', 'uninstall'],
    break: (m, kind) => { if (kind === 'uninstall') fs.rmSync(path.join(m.root, 'cfg'), { recursive: true, force: true }); fs.writeFileSync(path.join(m.root, 'cfg'), 'not a folder'); },
    says: (m) => [path.join(m.root, 'cfg'), 'a folder on its path is a file'],
    env: (m) => ({ CLAUDE_CONFIG_DIR: path.join(m.root, 'cfg') }),
  },
  {
    name: 'CLAUDE_CONFIG_DIR that is a link to nowhere',
    kinds: ['install'],
    break: (m) => { fs.symlinkSync(path.join(m.root, 'nowhere'), path.join(m.root, 'cfg')); },
    says: (m) => [path.join(m.root, 'cfg'), 'does not exist'],
    env: (m) => ({ CLAUDE_CONFIG_DIR: path.join(m.root, 'cfg') }),
  },
];

describe.skipIf(!canDenyReads)('install-hooks / uninstall-hooks that cannot write leave nothing behind (#528)', () => {
  for (const c of CASES) {
    for (const kind of c.kinds) {
      it(`${kind} with ${c.name}: one plain sentence, exit 1, and not one byte of HOME changed`, () => {
        const m = makeMachine(ENV);
        machines.push(m);
        const env = c.env?.(m) ?? {};
        if (kind === 'uninstall') {
          // The hooks, marker and citation contract are installed for real first; then the machine is broken.
          const first = m.run(['install-hooks'], { env });
          expect(first.status, `fixture: the first install failed: ${first.text}`).toBe(0);
        }
        c.break(m, kind);
        const { result, changed } = m.runAndDiff([kind === 'install' ? 'install-hooks' : 'uninstall-hooks'], { env });

        expect(result.status, result.text).toBe(1);
        const message = result.stderr.trim();
        expect(message.split('\n'), `not one sentence: ${message}`).toHaveLength(1);
        expect(message).toMatch(/^(install|uninstall)-hooks failed: /);
        expect(message, 'a raw system error code reached the person').not.toMatch(RAW_ERRNO);
        expect(message).toContain('nothing was changed');
        for (const word of c.says(m)) expect(message).toContain(word);
        expect(message, 'a file that could not be read was called invalid').not.toContain('not valid JSON');
        expect(changed, `the failed ${kind} changed the machine:\n${changed.join('\n')}`).toEqual([]);
      });
    }
  }
});
