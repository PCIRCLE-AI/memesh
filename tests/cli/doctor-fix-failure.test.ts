/**
 * A Claude Code configuration folder that cannot be used (`CLAUDE_CONFIG_DIR` naming a file, or a link to nowhere):
 * `setup`, `doctor` and `doctor --fix` say so in one plain sentence instead of printing a raw system error,
 * and a `--fix` step that failed (a ❌ line) is a failed run, not exit 0 (#528).
 *
 * A fake `claude` command is on the PATH, so Claude Code counts as being on the machine and hook wiring is
 * something doctor prescribes and setup offers.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { makeMachine, type Machine } from '../helpers/cli-machine.js';

const machines: Machine[] = [];
afterEach(() => { for (const m of machines.splice(0)) m.cleanup(); });

const RAW_ERRNO = /\b(EACCES|ENOENT|ENOTDIR|EISDIR|EPERM|EROFS)\b/;

function brokenConfigMachine(kind: 'file' | 'dangling-link') {
  const m = makeMachine({ MEMESH_SKIP_POST_INSTALL_JOURNEY: '1' });
  machines.push(m);
  m.fake('claude', 'exit 1');
  const cfg = path.join(m.root, 'cfg');
  if (kind === 'file') fs.writeFileSync(cfg, 'not a folder');
  else fs.symlinkSync(path.join(m.root, 'nowhere'), cfg);
  return { m, cfg, env: { CLAUDE_CONFIG_DIR: cfg } };
}

const describeHere = process.platform === 'win32' ? describe.skip : describe;
describeHere.each([
  ['file', 'a folder on its path is a file'],
  ['dangling-link', 'does not exist'],
] as const)('CLAUDE_CONFIG_DIR is a %s (#528)', (kind, words) => {
  it('doctor --fix --yes: the failed step is one plain sentence, nothing is written, and the run exits 1', () => {
    const { m, cfg, env } = brokenConfigMachine(kind);
    const before = m.snapshot();
    const r = m.run(['doctor', '--fix', '--yes'], { env });
    expect(r.status, r.text).toBe(1);
    expect(r.stderr).toMatch(/❌ .*cfg.*memesh-citations\.md|❌ .*cfg/);
    expect(r.stderr).toContain(cfg);
    expect(r.stderr).toContain(words);
    expect(r.text, 'a raw system error code reached the person').not.toMatch(RAW_ERRNO);
    const after = m.snapshot();
    expect(Object.keys(after.cwd)).toEqual(Object.keys(before.cwd));
    expect(fs.lstatSync(cfg).isSymbolicLink() || fs.lstatSync(cfg).isFile()).toBe(true);
  });

  it('doctor on its own prints no raw system error', () => {
    const { m, env } = brokenConfigMachine(kind);
    const r = m.run(['doctor'], { env });
    expect(r.text).not.toMatch(RAW_ERRNO);
    expect(r.text).not.toContain('TypeError');
  });

  it('setup --yes: the refused hook wiring is one plain sentence, the MCP step still runs, and the run exits 1', () => {
    const { m, cfg, env } = brokenConfigMachine(kind);
    const r = m.run(['setup', '--yes'], { env });
    expect(r.status, r.text).toBe(1);
    expect(r.stderr).toContain(cfg);
    expect(r.stderr).toContain(words);
    expect(r.text).not.toMatch(RAW_ERRNO);
    expect(m.calls(), 'the MCP registration was never attempted').toContain('claude mcp add -s user memesh memesh-mcp');
  });
});
