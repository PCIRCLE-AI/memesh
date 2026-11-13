/**
 * Both session-start banners must handle every install channel.
 *
 * The defect this pins: `buildUpdateAvailableBanner` learned that a
 * plugin-marketplace install needs a plugin command (and later, that Codex
 * needs a different one from Claude Code) while `buildDeprecationBanner` never
 * got a `plugin-marketplace` branch at all. So plugin users fell to the generic
 * "fetch the latest from npm" line — and they fell to it in the ONE case that
 * matters most, because the deprecation banner fires on a maintainer security
 * advisory and takes precedence over the update-available one. The highest
 * stakes message carried the least actionable instruction, for both hosts.
 *
 * This is a structural assertion, and deliberately so. The behavioural path
 * needs the hook to resolve its own location inside a plugin cache, which means
 * copying the tree into `<tmp>/.claude/plugins/cache/.../scripts/hooks/` — a
 * lot of machinery to prove a branch exists. What actually went wrong was
 * coverage drift between two copies of one decision, and that is what this
 * reads. `tests/hooks/session-start.test.ts` already drives the real hook and
 * asserts a remediation line is emitted.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import { buildIsolatedSuiteEnv } from '../../scripts/lib/isolated-env.mjs';

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'session-start.js');
const CHANNEL_SRC = path.join(__dirname, '..', '..', 'src', 'core', 'install-channel.ts');

/** The channels `detectInstallChannel` can actually return, read from its type. */
function installChannels(): string[] {
  const src = fs.readFileSync(CHANNEL_SRC, 'utf8');
  const m = src.match(/export type InstallChannel =([^;]+);/);
  if (!m) throw new Error('InstallChannel type not found — this test stopped looking at anything');
  return [...m[1].matchAll(/'([a-z-]+)'/g)].map(g => g[1]);
}

/** The channel names a given banner function branches on. */
function channelsHandledBy(fnName: string): string[] {
  const src = fs.readFileSync(HOOK, 'utf8');
  const start = src.indexOf(`function ${fnName}(`);
  if (start === -1) throw new Error(`${fnName} not found in session-start.js`);
  // Each banner ends at the next top-level `function ` declaration.
  const next = src.indexOf('\nfunction ', start + 1);
  const body = src.slice(start, next === -1 ? undefined : next);
  return [...body.matchAll(/channel === '([a-z-]+)'/g)].map(g => g[1]);
}

describe('session-start banners cover every install channel', () => {
  const channels = installChannels();

  it('the channel list itself is non-empty and includes the plugin case', () => {
    // Guard the guard: a regex that silently matched nothing would make every
    // assertion below vacuously true.
    expect(channels.length).toBeGreaterThan(2);
    expect(channels).toContain('plugin-marketplace');
  });

  it.each(['buildDeprecationBanner', 'buildUpdateAvailableBanner'])(
    '%s handles plugin-marketplace explicitly, not via the generic fallback',
    (fn) => {
      expect(
        channelsHandledBy(fn),
        `${fn} has no plugin-marketplace branch, so plugin installs get generic npm advice`,
      ).toContain('plugin-marketplace');
    },
  );

  it('the two banners branch on the same set of channels', () => {
    // Drift between them is the defect, not the absolute coverage. `unknown`
    // is deliberately absent from both — it is the `else` fallback.
    const dep = [...channelsHandledBy('buildDeprecationBanner')].sort();
    const upd = [...channelsHandledBy('buildUpdateAvailableBanner')].sort();
    expect(dep, 'the deprecation and update banners disagree on which channels they handle').toEqual(upd);
  });

  it('both route the plugin case through ONE helper, not two copies', () => {
    // The drift happened because the decision was written down twice. A single
    // owner is what stops it recurring; two call sites of the same helper is
    // the shape that proves it.
    const src = fs.readFileSync(HOOK, 'utf8');
    const callSites = [...src.matchAll(/lines\.push\(pluginUpgradeLine\(/g)].length;
    expect(callSites, 'expected both banners to call pluginUpgradeLine').toBe(2);
  });

  it.each(['.codex', '.claude'])('the real %s hook hint reaches the supported manual runner without memesh on PATH', (host) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memesh hint ' "));
    try {
      const home = path.join(root, 'home'); const bin = path.join(root, 'bin');
      const plugin = path.join(home, host, 'plugins/cache/pcircle-memesh/memesh/4.13.0');
      const data = path.join(home, '.memesh');
      for (const dir of [plugin, bin, data]) fs.mkdirSync(dir, { recursive: true });
      fs.symlinkSync(process.execPath, path.join(bin, 'node'));
      for (const name of ['dist', 'scripts']) fs.cpSync(path.resolve(name), path.join(plugin, name), { recursive: true });
      fs.copyFileSync(path.resolve('package.json'), path.join(plugin, 'package.json'));
      fs.symlinkSync(path.resolve('node_modules'), path.join(plugin, 'node_modules'));
      fs.writeFileSync(path.join(data, 'config.json'), '{"autoUpdate":"off"}');
      const version = JSON.parse(fs.readFileSync(path.join(plugin, 'package.json'), 'utf8')).version;
      const cache = path.join(root, 'update-check.json');
      fs.writeFileSync(cache, JSON.stringify({ currentVersion: version, latestVersion: '99.0.0', lastAttemptAt: new Date().toISOString(), lastSuccessfulCheckAt: new Date().toISOString(), checkSucceeded: true, currentVersionDeprecation: 'synthetic plugin-only hint fixture' }));
      const deny = path.join(root, 'deny.mjs');
      fs.writeFileSync(deny, "import net from 'node:net'; net.Socket.prototype.connect = function(){throw Error('fixture network denied')}; globalThis.fetch=async()=>{throw Error('fixture network denied')};");
      const env = buildIsolatedSuiteEnv({ PATH: bin }, { runtimeHome: home });
      Object.assign(env, { MEMESH_SKIP_UPDATE_CHECK: '1', MEMESH_UPDATE_CHECK_PATH: cache, NODE_OPTIONS: `${env.NODE_OPTIONS} --import=${pathToFileURL(deny).href}` });
      const hook = spawnSync(process.execPath, [path.join(plugin, 'scripts/hooks/session-start.js')], { env, input: JSON.stringify({ cwd: root, session_id: 't5-hint' }), encoding: 'utf8', timeout: 20_000 });
      expect(hook.status, hook.stderr).toBe(0);
      const messages = hook.stdout.trim().split('\n').map((line) => JSON.parse(line).systemMessage ?? '').join('\n');
      const command = messages.match(/no memesh command on your PATH\? run (node .+ update)\)/)?.[1];
      expect(command, messages).toBeTruthy();
      expect(fs.readdirSync(bin)).toEqual(['node']);
      const invoked = spawnSync('/bin/sh', ['-c', command!], { env, encoding: 'utf8', timeout: 20_000 });
      expect(invoked.status, invoked.stderr).toBe(1);
      const state = JSON.parse(fs.readFileSync(path.join(data, 'auto-update-state.json'), 'utf8'));
      expect(state).toMatchObject({ channel: 'plugin-marketplace', outcome: 'failed', reason: 'could not start npm' });
      expect(invoked.stdout + invoked.stderr).toContain('could not start npm');
      expect(state.detail).toContain('ENOENT');
      expect(fs.existsSync(path.join(data, 'auto-update.lock'))).toBe(false);
      console.log(JSON.stringify({ host, command, invocationExit: invoked.status, outcome: state.outcome, reason: state.reason, detail: state.detail }));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  it("says so when it could not ask which host this is, rather than assuming Claude Code", () => {
    // `pluginHostOf` used to be `detectPluginHost?.(root) ?? null` inside a
    // bare `catch { return null }`. `null` is a legitimate answer — "this path
    // is not under any plugin cache" — so a module that failed to load, or a
    // detector that threw, produced the same value as a confident "not Codex"
    // and every Codex user silently got the Claude Code command. That is the
    // same wrong outcome as the mutation above, reachable in production with
    // no mutation at all.
    const src = fs.readFileSync(HOOK, 'utf8');
    const start = src.indexOf('function pluginHostOf(');
    expect(start, 'pluginHostOf not found').toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\nfunction ', start + 1));
    expect(body, 'a missing detector still collapses into a host answer').toMatch(/return 'unknown'/);
    expect(body, "a thrown detector still collapses into a host answer").toMatch(/catch\s*\{[^}]*'unknown'/);
    const line = src.slice(src.indexOf('function pluginUpgradeLine('));
    expect(line.slice(0, line.indexOf('\nfunction ', 1)), 'the unknown case is not handled separately')
      .toMatch(/'unknown'/);
  });
});
