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
