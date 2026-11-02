// The real command line, built from current source, under throwaway HOMEs.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertPersonAtTerminal } from '../../src/network/command.js';
import { buildTree, makeHome, removeTree, type Tree } from './helpers.js';

describe('memesh network, as a person or script runs it', () => {
  let tree: Tree;
  const homes: string[] = [];

  beforeAll(async () => { tree = await buildTree({ cli: true }); });
  afterAll(() => {
    removeTree(tree.root);
    homes.forEach(removeTree);
  });

  const cli = (...args: string[]) => {
    const home = makeHome();
    homes.push(home);
    const { MEMESH_DIR: _dir, MEMESH_DB_PATH: _db, ...env } = process.env;
    const result = spawnSync(process.execPath, [tree.cli, 'network', ...args], {
      encoding: 'utf8', env: { ...env, HOME: home, USERPROFILE: home }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ...result, networkDirExists: fs.existsSync(path.join(home, '.memesh', 'network')) };
  };

  it('the CLI bundle does not carry the native package', () => {
    const bundle = fs.readFileSync(tree.cli, 'utf8');
    expect(bundle.length).toBeGreaterThan(100_000);
    expect(bundle).not.toContain('@number0/iroh');
  });

  it.each([
    ['link', []],
    ['join', ['memesh://join/abc', '--name', 'mac', '--person', 'kt']],
  ] as Array<[string, string[]]>)('%s refuses without a terminal, saying a person must run it', (command, args) => {
    const result = cli(command, ...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/needs a person/);
    expect(result.stderr).not.toContain('memesh://join/abc');
    expect(result.networkDirExists).toBe(false);
  });

  it('needs both stdin and stdout to be a terminal', () => {
    const tty = { isTTY: true };
    const pipe = { isTTY: false };
    expect(() => assertPersonAtTerminal('link', tty, tty)).not.toThrow();
    expect(() => assertPersonAtTerminal('link', pipe, tty)).toThrowError(/needs a person/);
    expect(() => assertPersonAtTerminal('join', tty, pipe)).toThrowError(/needs a person/);
    expect(() => assertPersonAtTerminal('join', {}, {})).toThrowError(/needs a person/);
  });

  it('status for someone who never joined says so and creates nothing', () => {
    const plain = cli('status');
    expect(plain.status).toBe(0);
    expect(plain.stdout).toMatch(/not in a network/);
    expect(plain.networkDirExists).toBe(false);
    const json = cli('status', '--json');
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({ joined: false });
    expect(json.networkDirExists).toBe(false);
  });

  it('up and down for someone who never joined start nothing', () => {
    const up = cli('up');
    expect(up.status).toBe(1);
    expect(up.stderr).toMatch(/not in a network yet/);
    expect(up.networkDirExists).toBe(false);
    const down = cli('down');
    expect(down.status).toBe(0);
    expect(down.stdout).toMatch(/not running/);
    expect(down.networkDirExists).toBe(false);
  });

  it('create refuses a name that would break addresses, before installing anything', () => {
    for (const name of ['a@b', 'a/b']) {
      const result = cli('create', '--name', name, '--person', 'kt');
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/machine name must start/);
      expect(result.networkDirExists).toBe(false);
    }
    expect(cli('create', '--name', 'mac', '--person', 'k@t').stderr).toMatch(/person must start/);
    expect(cli('create', '--name', 'mac', '--person', 'kt', '--relay', 'ftp://x/').stderr).toMatch(/--relay must be/);
  });

  it('other commands do not create any network state', () => {
    const home = makeHome();
    homes.push(home);
    const { MEMESH_DIR: _dir, MEMESH_DB_PATH: _db, ...env } = process.env;
    const result = spawnSync(process.execPath, [tree.cli, 'recall', 'probe'], {
      encoding: 'utf8', env: { ...env, HOME: home, USERPROFILE: home },
    });
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(home, '.memesh', 'network'))).toBe(false);
  });
});
