import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { npmInvocation, requireNpmInvocation } from '../../src/core/npm-launch.js';
import { defaultExec, readRegistryTags } from '../../src/core/auto-update.js';

const roots: string[] = [];
function temporaryHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-npm-launch-'));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('the shared npm launcher', () => {
  it('uses Node directly on simulated Windows, and refuses a missing CLI', () => {
    const node = 'C:\\Program Files\\nodejs\\node.exe';
    const cli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
    expect(npmInvocation(['--version'], 'win32', node, (file) => file === cli)).toEqual({ command: node, args: [cli, '--version'] });
    expect(npmInvocation(['--version'], 'win32', node, () => false)).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('reports actual npm startup failure through readRegistryTags with an empty PATH', () => {
    const home = temporaryHome();
    expect(() => readRegistryTags((command, args, opts) => defaultExec(command, args, { ...opts, env: { HOME: home, PATH: home } })))
      .toThrow(/could not start npm:.*ENOENT/);
  });

  it('distinguishes a real timeout from a child that never started', () => {
    const result = defaultExec(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 20 });
    expect(result.status).toBeNull();
    expect(result.timedOut).toBe(true);
    expect(result.startupError).toBeUndefined();
  });

  it('runs npm --version through the shared launcher with a private home and cache', () => {
    const home = temporaryHome();
    const npm = requireNpmInvocation(['--version']);
    const result = spawnSync(npm.command, npm.args, { encoding: 'utf8', timeout: 15000, env: {
      ...process.env, HOME: home, USERPROFILE: home, npm_config_cache: path.join(home, 'cache'),
      npm_config_userconfig: path.join(home, 'npmrc'), npm_config_globalconfig: path.join(home, 'global-npmrc'),
      npm_config_offline: 'true', npm_config_update_notifier: 'false',
    } });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
