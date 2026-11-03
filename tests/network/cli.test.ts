// The real command line, built from current source, under throwaway HOMEs.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { action, assertPersonAtTerminal } from '../../src/network/command.js';
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
    return { ...result, dataDirExists: fs.existsSync(path.join(home, '.memesh')) };
  };

  it('the CLI bundle does not carry the native package', () => {
    const bundle = fs.readFileSync(tree.cli, 'utf8');
    expect(bundle.length).toBeGreaterThan(100_000);
    expect(bundle).not.toContain('@number0');
  });

  it.each([
    ['link', []],
    ['join', ['--name', 'mac', '--person', 'kt']],
  ] as Array<[string, string[]]>)('%s refuses without a terminal, saying it is meant for a person', (command, args) => {
    const result = cli(command, ...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/meant for a person/);
    expect(result.dataDirExists).toBe(false);
  });

  it('a link on the command line is refused with a sentence and never echoed', () => {
    const result = cli('join', 'memesh://join/abcdefghijkl', '--name', 'mac', '--person', 'kt');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Do not put the invite link on the command line/);
    expect(result.stderr).not.toContain('abcdefghijkl');
    expect(result.dataDirExists).toBe(false);
  });

  it('every error is printed without control characters', async () => {
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(((text: string) => {
      written.push(text);
      return true;
    }) as typeof process.stderr.write);
    const before = process.exitCode;
    try {
      await action(() => { throw new Error('bad\u001b]0;PWNED\u0007 thing'); })();
      expect(process.exitCode).toBe(1);
    } finally {
      stderr.mockRestore();
      process.exitCode = before;
    }
    expect(written.join('')).toBe('Error: bad ]0;PWNED  thing\n');
  });

  it('needs both stdin and stdout to be a terminal', () => {
    const tty = { isTTY: true };
    const pipe = { isTTY: false };
    expect(() => assertPersonAtTerminal('link', tty, tty)).not.toThrow();
    expect(() => assertPersonAtTerminal('link', pipe, tty)).toThrowError(/meant for a person/);
    expect(() => assertPersonAtTerminal('join', tty, pipe)).toThrowError(/meant for a person/);
    expect(() => assertPersonAtTerminal('join', {}, {})).toThrowError(/meant for a person/);
  });

  it('status for someone who never joined says so and creates nothing', () => {
    const plain = cli('status');
    expect(plain.status).toBe(0);
    expect(plain.stdout).toMatch(/not in a network/);
    expect(plain.dataDirExists).toBe(false);
    const json = cli('status', '--json');
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({ joined: false });
    expect(json.dataDirExists).toBe(false);
  });

  it('up and down for someone who never joined start and create nothing', () => {
    const up = cli('up');
    expect(up.status).toBe(1);
    expect(up.stderr).toMatch(/not in a network yet/);
    expect(up.dataDirExists).toBe(false);
    const down = cli('down');
    expect(down.status).toBe(0);
    expect(down.stdout).toMatch(/not running/);
    expect(down.dataDirExists).toBe(false);
  });

  it('create refuses a name that would break addresses, before installing anything', () => {
    for (const name of ['a@b', 'a/b']) {
      const result = cli('create', '--name', name, '--person', 'kt');
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/machine name must start/);
      expect(result.dataDirExists).toBe(false);
    }
    const badPerson = cli('create', '--name', 'mac', '--person', 'k@t');
    expect(badPerson.status).toBe(1);
    expect(badPerson.stderr).toMatch(/person must start/);
    expect(badPerson.dataDirExists).toBe(false);
    for (const relay of ['ftp://x/', 'http://relay.example/', 'https://user:pass@relay.example/']) {
      const badRelay = cli('create', '--name', 'mac', '--person', 'kt', '--relay', relay);
      expect(badRelay.status).toBe(1);
      expect(badRelay.stderr).toMatch(/--relay must be/);
      expect(badRelay.stderr).not.toContain('pass@');
      expect(badRelay.dataDirExists).toBe(false);
    }
  });

  it('link for someone who never joined creates nothing, with a terminal too', () => {
    const preload = path.join(tree.root, 'tty.mjs');
    fs.writeFileSync(preload, 'process.stdin.isTTY = true; process.stdout.isTTY = true;\n');
    const home = makeHome();
    homes.push(home);
    const { MEMESH_DIR: _dir, MEMESH_DB_PATH: _db, ...env } = process.env;
    const result = spawnSync(process.execPath, [`--import=${preload}`, tree.cli, 'network', 'link'], {
      encoding: 'utf8', env: { ...env, HOME: home, USERPROFILE: home }, timeout: 60_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not in a network yet/);
    expect(fs.existsSync(path.join(home, '.memesh'))).toBe(false);
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
