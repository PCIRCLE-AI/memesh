/**
 * A throwaway "machine" for running the built memesh CLI: its own HOME, its own working folder and a
 * PATH that holds a link to node and nothing else. A fake `claude` / `codex` / `gemini` is on the
 * machine only where a test puts one (`fake`), and every call to a fake is logged to `calls.log`.
 * Nothing of the real HOME, the real PATH or the real `CLAUDE_CONFIG_DIR` / `CODEX_HOME` is inherited.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { diffSnapshots, snapshotTree } from './fs-snapshot.js';
import { removeTempDir } from './temp-dir.js';

const cli = path.resolve('dist/transports/cli/cli.js');

export interface RunResult { status: number | null; stdout: string; stderr: string; text: string }

export function makeMachine(extraEnv: NodeJS.ProcessEnv = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-machine-')));
  if (!root || !fs.statSync(root).isDirectory()) throw new Error('the throwaway machine was not created');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'cwd');
  const bin = path.join(root, 'bin');
  for (const dir of [home, cwd, bin]) fs.mkdirSync(dir);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const callsLog = path.join(root, 'calls.log');
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, PATH: bin, ...extraEnv };

  /** A fake agent command: logs its arguments, then runs `body` (a sh snippet; default: exit 0). */
  const fake = (name: string, body = 'exit 0'): void => {
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${callsLog}"\n${body}\n`);
    fs.chmodSync(file, 0o755);
  };
  const run = (args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}, cliPath: string = cli): RunResult => {
    const r = spawnSync(process.execPath, [cliPath, ...args], {
      env: { ...env, ...opts.env }, cwd: opts.cwd ?? cwd, encoding: 'utf8', timeout: 90_000,
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, text: `${r.stdout}${r.stderr}` };
  };
  const calls = (): string[] => (fs.existsSync(callsLog) ? fs.readFileSync(callsLog, 'utf8').split('\n').filter(Boolean) : []);
  /** Everything a run could touch: HOME and the working folder. */
  const snapshot = () => ({ home: snapshotTree(home), cwd: snapshotTree(cwd) });
  /** Run and report every difference in HOME / the working folder it made (empty = nothing was changed). */
  const runAndDiff = (args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}, cliPath: string = cli) => {
    const before = snapshot();
    const result = run(args, opts, cliPath);
    const after = snapshot();
    return { result, changed: [...diffSnapshots(before.home, after.home), ...diffSnapshots(before.cwd, after.cwd)] };
  };
  const cleanup = (): void => {
    // A test that made something unreadable or read-only must not leave a directory nobody can delete.
    const open = (dir: string): void => {
      let entries: string[];
      try { fs.chmodSync(dir, 0o755); entries = fs.readdirSync(dir); } catch { return; }
      for (const name of entries) {
        const full = path.join(dir, name);
        try {
          if (fs.lstatSync(full).isDirectory()) open(full);
          else if (!fs.lstatSync(full).isSymbolicLink()) fs.chmodSync(full, 0o644);
        } catch { /* gone already */ }
      }
    };
    open(root);
    removeTempDir(root);
  };
  return { root, home, cwd, bin, env, fake, run, calls, snapshot, runAndDiff, cleanup };
}

export type Machine = ReturnType<typeof makeMachine>;
