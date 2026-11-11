// The real command line, built from current source, under throwaway HOMEs.
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { action, assertPersonAtTerminal, promptForLink } from '../../src/network/command.js';
import { buildTree, makeHome, removeTree, writeTtyPreload, type Tree } from './helpers.js';

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

  describe('the no-echo prompt', () => {
    class FakeTerminal extends EventEmitter {
      raw: boolean[] = [];
      paused = false;
      setRawMode(on: boolean): this {
        this.raw.push(on);
        return this;
      }
      pause(): this {
        this.paused = true;
        return this;
      }
      resume(): this {
        return this;
      }
    }
    const prompt = (terminal: FakeTerminal): Promise<string> => {
      const quiet = new EventEmitter() as unknown as NodeJS.WritableStream;
      (quiet as unknown as { write: () => boolean }).write = () => true;
      return promptForLink(terminal as unknown as NodeJS.ReadStream, quiet);
    };
    const finished = (terminal: FakeTerminal): void => {
      expect(terminal.raw).toEqual([true, false]);
      expect(terminal.paused).toBe(true);
      expect(terminal.listenerCount('data')).toBe(0);
      expect(terminal.listenerCount('end')).toBe(0);
    };

    it.each([['Ctrl-C', '\u0003'], ['Ctrl-D', '\u0004']])('%s cancels, even mid-paste, and restores the terminal', async (_name, key) => {
      const terminal = new FakeTerminal();
      const answer = prompt(terminal);
      terminal.emit('data', `memesh://join/abc${key}more`);
      await expect(answer).rejects.toMatchObject({ code: 'needs_person', message: expect.stringMatching(/Cancelled/) });
      finished(terminal);
    });

    it('turns echo off before the prompt appears, so an instant paste is never shown', async () => {
      const terminal = new FakeTerminal();
      let rawWhenPrompted: boolean[] | null = null;
      const stderr = new EventEmitter() as unknown as NodeJS.WritableStream;
      (stderr as unknown as { write: () => boolean }).write = () => {
        rawWhenPrompted ??= [...terminal.raw];
        return true;
      };
      const answer = promptForLink(terminal as unknown as NodeJS.ReadStream, stderr);
      expect(rawWhenPrompted).toEqual([true]);
      terminal.emit('data', 'abc\r');
      await answer;
    });

    it('trims what was pasted, ignores a leading newline, and handles backspace', async () => {
      const terminal = new FakeTerminal();
      const answer = prompt(terminal);
      terminal.emit('data', '\r\n');
      terminal.emit('data', '  abcX\u007fd  \r');
      expect(await answer).toBe('abcd');
      finished(terminal);
    });

    it.each([
      ['both wrappers', '\u001b[200~memesh://join/abc\u001b[201~\r'],
      ['the opening wrapper', '\u001b[200~memesh://join/abc\r'],
      ['the closing wrapper', 'memesh://join/abc\u001b[201~\r'],
      ['wrappers split across chunks', ['\u001b[20', '0~memesh://join/', 'abc\u001b[2', '01~', '\r']],
    ])('strips a bracketed paste: %s', async (_name, input) => {
      const terminal = new FakeTerminal();
      const answer = prompt(terminal);
      for (const chunk of Array.isArray(input) ? input : [input]) terminal.emit('data', chunk);
      expect(await answer).toBe('memesh://join/abc');
      finished(terminal);
    });

    it('stops at 16K', async () => {
      const terminal = new FakeTerminal();
      const answer = prompt(terminal);
      terminal.emit('data', `${'a'.repeat(30_000)}\n`);
      expect((await answer).length).toBe(16 * 1024);
      finished(terminal);
    });

    it('end of input without a newline takes what came', async () => {
      const terminal = new FakeTerminal();
      const answer = prompt(terminal);
      terminal.emit('data', 'abc');
      terminal.emit('end');
      expect(await answer).toBe('abc');
      finished(terminal);
    });

    it('the real CLI cancels at Ctrl-C with nothing created', () => {
      const preload = writeTtyPreload(tree.root);
      const home = makeHome();
      homes.push(home);
      const { MEMESH_DIR: _dir, MEMESH_DB_PATH: _db, ...env } = process.env;
      const result = spawnSync(process.execPath, [`--import=${preload}`, tree.cli, 'network', 'join', '--name', 'mac', '--person', 'kt'], {
        encoding: 'utf8', env: { ...env, HOME: home, USERPROFILE: home }, input: 'memesh://join/abc\u0003', timeout: 60_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/Cancelled/);
      expect(result.stderr.indexOf('RAW:false')).toBeGreaterThan(result.stderr.indexOf('RAW:true'));
      expect(result.stderr).not.toContain('memesh://join/abc');
      expect(fs.existsSync(path.join(home, '.memesh'))).toBe(false);
    });
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
