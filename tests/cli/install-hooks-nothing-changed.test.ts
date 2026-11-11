/**
 * `memesh install-hooks` says "Nothing needed to change — no file was written" only when
 * neither settings.json, the install marker nor the citation rule file was written (#528).
 * A run that rewrote just the marker, or just the rule, did write a file, and must not
 * claim otherwise.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { removeTempDir } from '../helpers/temp-dir.js';
import { makeMachine, type Machine } from '../helpers/cli-machine.js';

const cli = path.resolve('dist/transports/cli/cli.js');
let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-ih-nothing-')));
});
afterEach(() => { removeTempDir(root); });

function installHooks(): string {
  const r = spawnSync(process.execPath, [cli, 'install-hooks', '--scope', 'project'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 90_000,
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'),
      MEMESH_DIR: path.join(root, 'memesh-state'),
    },
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  return r.stdout;
}

describe('install-hooks: "no file was written" is only said when that is true (#528)', () => {
  it('a marker-only write reports the marker and asks for no restart', () => {
    const first = installHooks();
    expect(first.length, 'fixture: the first run printed nothing, so every absence check below is vacuous').toBeGreaterThan(0);
    const markerPath = /Marker: (.+)/.exec(first)?.[1]?.trim();
    expect(markerPath, 'fixture: the first run did not report writing the marker').toBeTruthy();
    fs.rmSync(markerPath as string);

    const again = installHooks();
    expect(again).toContain(`Marker: ${markerPath}`);
    expect(again).not.toContain('Nothing needed to change');
    expect(again).not.toContain('Restart Claude Code');
    expect(again).toContain('Nothing to restart');
  });

  it('a rule-only write does not claim that no file was written', () => {
    const first = installHooks();
    const rulePath = /Citation contract created: (.+)/.exec(first)?.[1]?.trim();
    expect(rulePath, 'fixture: the first run did not report creating the citation rule').toBeTruthy();
    fs.rmSync(rulePath as string);

    const again = installHooks();
    expect(again).toContain('Citation contract created');
    expect(again).not.toContain('Nothing needed to change');
  });
});

/** The same promise on the file system itself, through the real CLI: not only what is printed, but every inode and mtime. */
describe.skipIf(process.platform === 'win32')('install-hooks: what it says matches what is on disk (#528)', () => {
  const machines: Machine[] = [];
  afterEach(() => { for (const m of machines.splice(0)) m.cleanup(); });
  const fresh = () => {
    const m = makeMachine({ MEMESH_SKIP_POST_INSTALL_JOURNEY: '1' });
    machines.push(m);
    return m;
  };

  it('a re-run that changes nothing leaves every path, inode and mtime as it was, and says so', async () => {
    const m = fresh();
    expect(m.run(['install-hooks']).status).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { result, changed } = m.runAndDiff(['install-hooks']);
    expect(result.status, result.text).toBe(0);
    expect(result.stdout).toContain('Nothing needed to change — no file was written.');
    expect(result.stdout).toContain('Nothing to restart.');
    expect(changed, changed.join('\n')).toEqual([]);
  });

  it('--dry-run writes nothing and does not say that nothing needed to change or that nothing needs a restart', () => {
    const m = fresh();
    const dry = m.runAndDiff(['install-hooks', '--dry-run']);
    expect(dry.result.status, dry.result.text).toBe(0);
    expect(dry.result.stdout).toContain('Would add');
    expect(dry.result.stdout).not.toContain('Nothing needed to change');
    expect(dry.result.stdout).not.toContain('Nothing to restart');
    expect(dry.changed, dry.changed.join('\n')).toEqual([]);

    expect(m.run(['install-hooks']).status).toBe(0);
    const again = m.runAndDiff(['install-hooks', '--dry-run']);
    expect(again.result.stdout).not.toContain('Nothing needed to change');
    expect(again.result.stdout).not.toContain('Nothing to restart');
    expect(again.changed, again.changed.join('\n')).toEqual([]);
  });

  it("a rule file that is the user's own is left alone, reported as a warning, and is not a \"file was written\"", () => {
    const m = fresh();
    expect(m.run(['install-hooks']).status).toBe(0);
    const rule = path.join(m.home, '.claude', 'rules', 'memesh-citations.md');
    fs.writeFileSync(rule, 'my own rules\n');
    const { result, changed } = m.runAndDiff(['install-hooks']);
    expect(result.status, result.text).toBe(0);
    expect(result.stdout).toContain('WARNING: the citation contract was NOT installed');
    expect(result.stdout).toContain('Nothing needed to change — no file was written.');
    expect(fs.readFileSync(rule, 'utf8')).toBe('my own rules\n');
    expect(changed, changed.join('\n')).toEqual([]);
  });
});
