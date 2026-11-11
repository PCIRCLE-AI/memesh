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

  it('hands the CLI a PATH on which the fake agents sitting next to node are gone: doctor sees no host', () => {
    const { root, bin } = sharedBin();
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const r = spawnSync(process.execPath, [cli, 'doctor', '--json'], {
      env: { HOME: home, USERPROFILE: home, PATH: pathWithout(['claude', 'codex', 'gemini'], bin) },
      cwd: root,
      encoding: 'utf8',
      timeout: 90_000,
    });
    const report = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))) as { checks: Array<{ id: string; code?: string }> };
    // The fake agents are in the directory and the empty HOME has none: the verdict is "no host".
    expect(report.checks.find((c) => c.id === 'hook-wiring')?.code).toBe('hook-wiring.no-host');
  });
});
