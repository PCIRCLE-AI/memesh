/**
 * `pathWithout` (tests/helpers/path-without.ts) builds the PATH the doctor CLI tests run on, so
 * that "a machine with no agent host" is true on a developer box that has one. It used to drop
 * every directory that held a tool, `node` and all, when the agent was installed next to node
 * (nvm, `npm -g`): the spawned CLI then could not even start.
 *
 * Both halves are measured here on a fixture the test builds itself, so the result does not
 * depend on what the machine running the suite has installed.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathWithout, removePathMirrors } from '../helpers/path-without.js';
import { canDenyReads } from '../helpers/permissions.js';
import { removeTempDir } from '../helpers/temp-dir.js';

const cli = path.resolve('dist/transports/cli/cli.js');
const dirs: string[] = [];
afterEach(() => { removeTempDir(...dirs.splice(0)); });
afterAll(removePathMirrors);

/** A directory shaped like an nvm / `npm -g` bin: node, an unrelated command, and the agents, side by side. */
function sharedBin() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-pathwithout-case-')));
  dirs.push(root);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  for (const name of ['claude', 'codex', 'gemini', 'unrelated']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  return { root, bin };
}

const found = (tool: string, searchPath: string) =>
  searchPath.split(path.delimiter).some((dir) => fs.existsSync(path.join(dir, tool)));

describe.skipIf(process.platform === 'win32')('pathWithout', () => {
  it('removes the tools it was given and nothing else, even from a directory that also holds node', () => {
    const { bin } = sharedBin();
    const result = pathWithout(['claude', 'codex', 'gemini'], bin);
    for (const tool of ['claude', 'codex', 'gemini']) expect(found(tool, result), `${tool} is still on the PATH`).toBe(false);
    for (const kept of ['node', 'unrelated']) expect(found(kept, result), `${kept} went with the tools`).toBe(true);
    // The tools are really there in the original: this is not a vacuous removal.
    expect(found('claude', bin)).toBe(true);
  });

  it('leaves a directory that holds none of the tools exactly as it was', () => {
    const { bin } = sharedBin();
    expect(pathWithout(['no-such-tool'], bin)).toBe(bin);
  });

  it('hands a shell a PATH on which the fake agents are gone and node, found by NAME on that PATH, still runs: doctor sees no host', () => {
    const { root, bin } = sharedBin();
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    // `exec node` makes the shell look node up on the PATH the helper built. A helper that drops the
    // whole folder (the old behaviour: node lives in it) leaves "node: not found", exit 127.
    const r = spawnSync('/bin/sh', ['-c', 'exec node "$0" doctor --json', cli], {
      env: { HOME: home, USERPROFILE: home, PATH: pathWithout(['claude', 'codex', 'gemini'], bin) },
      cwd: root,
      encoding: 'utf8',
      timeout: 90_000,
    });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    const report = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))) as { checks: Array<{ id: string; code?: string }> };
    // The fake agents are in the directory and the empty HOME has none: the verdict is "no host".
    expect(report.checks.length, 'doctor reported nothing').toBeGreaterThan(0);
    expect(report.checks.find((c) => c.id === 'hook-wiring')?.code).toBe('hook-wiring.no-host');
  });

  it('keeps a relative PATH entry working from the folder it was given in: links and result are absolute', () => {
    const { root, bin } = sharedBin();
    // The entry is relative, so it is resolved against the process folder: run from the fixture's.
    const cwd = process.cwd();
    process.chdir(root);
    let relative: string;
    try { relative = pathWithout(['claude'], 'bin'); } finally { process.chdir(cwd); }
    expect(path.isAbsolute(relative)).toBe(true);
    for (const kept of ['node', 'unrelated']) {
      expect(fs.existsSync(path.join(relative, kept)), `${kept} is a broken link in ${relative} (bin was ${bin})`).toBe(true);
    }
    expect(fs.existsSync(path.join(relative, 'claude'))).toBe(false);
  });

  it.skipIf(process.platform !== 'darwin' && process.platform !== 'win32')('on a file system that ignores case, Claude is the tool claude', () => {
    const { root } = sharedBin();
    const bin = path.join(root, 'caps');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'Claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'keepme'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(found('claude', bin), 'fixture: this file system tells Claude from claude').toBe(true);
    const result = pathWithout(['claude'], bin);
    expect(found('claude', result), 'the tool is still found under its capitalised name').toBe(false);
    expect(found('keepme', result)).toBe(true);
  });

  it.skipIf(!canDenyReads)('a folder that can be searched but not listed and holds a tool is an error, not a quiet loss of what else is in it', () => {
    const { root } = sharedBin();
    const bin = path.join(root, 'searchable');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'keepme'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.chmodSync(bin, 0o111);
    try {
      expect(() => pathWithout(['claude'], bin)).toThrow(/cannot be listed and holds one of claude/);
      // The same folder without a tool in it is kept as it is.
      expect(pathWithout(['no-such-tool'], bin)).toBe(bin);
    } finally {
      fs.chmodSync(bin, 0o755);
    }
  });
});
