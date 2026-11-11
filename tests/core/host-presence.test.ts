/**
 * "Is this agent on this machine?" — the one definition `memesh setup` and
 * `memesh doctor` share. isOnPath reads the process PATH, so each test points
 * PATH at a throwaway directory it filled itself: the machine running the
 * test (which may well have `claude` or `codex` installed) never decides.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { claudeCodePresent, codexPresent, folderHere, geminiPresent, isOnPath } from '../../src/core/host-presence.js';

let root: string;
let savedPath: string | undefined;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-host-presence-')));
  savedPath = process.env.PATH;
});

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const bin = () => {
  const dir = path.join(root, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const exe = (dir: string, name: string, mode = 0o755) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(file, mode);
  return file;
};

describe.skipIf(process.platform === 'win32')('isOnPath', () => {
  it('finds an executable file on PATH, and not one that is missing', () => {
    const dir = bin();
    exe(dir, 'claude');
    process.env.PATH = dir;
    expect(isOnPath('claude')).toBe(true);
    expect(isOnPath('codex')).toBe(false);
  });

  it('does not count a file without the execute bit', () => {
    const dir = bin();
    exe(dir, 'claude', 0o644);
    process.env.PATH = dir;
    expect(isOnPath('claude')).toBe(false);
  });

  it('does not count a DIRECTORY that happens to be named like the command', () => {
    // X_OK succeeds on a directory; a shell running `command -v` would not call it a command.
    const dir = bin();
    fs.mkdirSync(path.join(dir, 'claude'));
    process.env.PATH = dir;
    expect(isOnPath('claude')).toBe(false);
  });

  it('follows a working symlink and ignores a broken one', () => {
    const dir = bin();
    const target = exe(root, 'real-claude');
    fs.symlinkSync(target, path.join(dir, 'claude'));
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(dir, 'codex'));
    process.env.PATH = dir;
    expect(isOnPath('claude')).toBe(true);
    expect(isOnPath('codex')).toBe(false);
  });

  it('skips empty PATH entries and finds the command in a later directory', () => {
    const dir = bin();
    exe(dir, 'claude');
    process.env.PATH = ['', path.join(root, 'missing'), dir].join(path.delimiter);
    expect(isOnPath('claude')).toBe(true);
  });

  it('an empty PATH entry is not the current directory, even when that holds the command', () => {
    // path.join('', 'claude') is the relative path `claude`: without the empty-entry skip, an
    // executable `claude` in the working directory would be found through PATH='' or PATH=':'.
    const cwd = process.cwd();
    const here = fs.mkdtempSync(path.join(root, 'cwd-'));
    exe(here, 'claude');
    process.chdir(here);
    try {
      expect(fs.existsSync('claude'), 'setup: the fixture has no claude in the cwd').toBe(true);
      for (const value of ['', path.delimiter, `${path.delimiter}${path.delimiter}`]) {
        process.env.PATH = value;
        expect(isOnPath('claude'), `PATH=${JSON.stringify(value)} found ./claude`).toBe(false);
      }
    } finally {
      process.chdir(cwd);
    }
  });

  it('a PATH folder whose name has a space is searched as one folder, not split at the space', () => {
    const dir = path.join(root, 'folder with spaces');
    fs.mkdirSync(dir);
    exe(dir, 'claude');
    process.env.PATH = [path.join(root, 'missing'), dir].join(path.delimiter);
    expect(isOnPath('claude')).toBe(true);
  });

  it('an empty or unset PATH finds nothing', () => {
    process.env.PATH = '';
    expect(isOnPath('claude')).toBe(false);
    delete process.env.PATH;
    expect(isOnPath('claude')).toBe(false);
  });
});

describe('claudeCodePresent / codexPresent / geminiPresent', () => {
  const none = () => false;
  const only = (tool: string) => (t: string) => t === tool;

  it('a folder named by a file is not an agent folder; one that is missing is not either; a real one is', () => {
    const file = path.join(root, 'a-file');
    fs.writeFileSync(file, 'x');
    const folder = path.join(root, 'a-folder');
    fs.mkdirSync(folder);
    expect(folderHere(fs.existsSync, file)).toBe(false);
    expect(folderHere(fs.existsSync, path.join(root, 'missing'))).toBe(false);
    expect(folderHere(fs.existsSync, folder)).toBe(true);
    expect(claudeCodePresent(fs.existsSync, none, file)).toBe(false);
    expect(claudeCodePresent(fs.existsSync, none, folder)).toBe(true);
  });

  it('with no arguments they ask the real machine: the folder CLAUDE_CONFIG_DIR / CODEX_HOME names, and the real PATH', () => {
    const saved = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME, path: process.env.PATH };
    try {
      const claudeDir = path.join(root, 'claude-dir');
      const codexDir = path.join(root, 'codex-dir');
      fs.mkdirSync(claudeDir);
      fs.mkdirSync(codexDir);
      process.env.PATH = '';
      process.env.CLAUDE_CONFIG_DIR = path.join(root, 'no-claude');
      process.env.CODEX_HOME = path.join(root, 'no-codex');
      expect([claudeCodePresent(), codexPresent()]).toEqual([false, false]);
      process.env.CLAUDE_CONFIG_DIR = claudeDir;
      process.env.CODEX_HOME = codexDir;
      expect([claudeCodePresent(), codexPresent()]).toEqual([true, true]);
      process.env.CLAUDE_CONFIG_DIR = path.join(root, 'no-claude');
      process.env.CODEX_HOME = path.join(root, 'no-codex');
      if (process.platform !== 'win32') {
        const dir = bin();
        exe(dir, 'claude');
        exe(dir, 'codex');
        process.env.PATH = dir;
        expect([claudeCodePresent(), codexPresent()]).toEqual([true, true]);
      }
    } finally {
      for (const [key, value] of [['CLAUDE_CONFIG_DIR', saved.claude], ['CODEX_HOME', saved.codex], ['PATH', saved.path]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  it('Claude Code: the config directory alone, the command alone, or neither', () => {
    expect(claudeCodePresent(() => true, none, '/x/.claude')).toBe(true);
    expect(claudeCodePresent(none, only('claude'), '/x/.claude')).toBe(true);
    expect(claudeCodePresent(none, none, '/x/.claude')).toBe(false);
    // Another agent's command does not make Claude Code present.
    expect(claudeCodePresent(none, only('codex'), '/x/.claude')).toBe(false);
  });

  it('Claude Code asks about the directory it was given, not some other one', () => {
    const asked: string[] = [];
    claudeCodePresent((p) => { asked.push(p); return false; }, none, '/relocated');
    expect(asked).toEqual(['/relocated']);
  });

  it('Codex: the config directory alone, the command alone, or neither', () => {
    expect(codexPresent(() => true, none)).toBe(true);
    expect(codexPresent(none, only('codex'))).toBe(true);
    expect(codexPresent(none, none)).toBe(false);
    expect(codexPresent(none, only('claude'))).toBe(false);
  });

  it('Gemini CLI: present when its command is on PATH, and no other agent\'s command counts', () => {
    expect(geminiPresent(only('gemini'))).toBe(true);
    expect(geminiPresent(none)).toBe(false);
    expect(geminiPresent(only('claude'))).toBe(false);
    expect(geminiPresent(only('codex'))).toBe(false);
  });

  it('Gemini CLI asks about its own command and defaults to the real PATH', () => {
    const asked: string[] = [];
    geminiPresent((t) => { asked.push(t); return false; });
    expect(asked).toEqual(['gemini']);
    // The default is isOnPath, not a constant: a PATH holding an executable gemini finds it.
    if (process.platform === 'win32') return;
    const saved = process.env.PATH;
    try {
      const dir = bin();
      exe(dir, 'gemini');
      process.env.PATH = dir;
      expect(geminiPresent()).toBe(true);
      process.env.PATH = '';
      expect(geminiPresent()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.PATH; else process.env.PATH = saved;
    }
  });
});
