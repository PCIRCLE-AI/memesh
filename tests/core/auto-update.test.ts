/**
 * The automatic-update entry: on by default, an explicit `off` never
 * overridden (from any place it can be written), the source verified before
 * install, a backup first, and nothing replaced while a session runs.
 */
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'crypto';
import {
  AUTO_UPDATE_REASONS,
  backupDatabase,
  chooseTarget,
  codexMarketplaceState,
  CODEX_RESTORE_FILE,
  DISPATCH_CLAIM,
  isCi,
  safeAccountHome,
  dispatchAutoUpdate,
  ownerOnly,
  ensureOwnerDir,
  codexHomeFor,
  productionDeps,
  propagateOff,
  accountConfigHolding,
  runManualUpdate,
  logAutoUpdateLine,
  refreshHermes,
  unsafeTarEntries,
  signerIdentity,
  BACKUPS_KEPT,
  judgeAuditSignatures,
  judgeCommitOnMain,
  judgeShrinkwrap,
  compareUrl,
  compareEnv,
  nodeUsesEnvProxy,
  COMPARE_SCRIPT,
  liveHostPids,
  readAutoUpdateState,
  readInstalling,
  inspectAutoUpdateState,
  registerLiveHost,
  resolveUpdatePolicy,
  runAutoUpdate,
  sha512Integrity,
  stripMultilineStrings,
  sweepWorkDirs,
  type AutoUpdateDeps,
} from '../../src/core/auto-update.js';
import { installProvider, inspectInstall, registryProblem, defaultInstallTarget, refreshInstalls, refreshTargets, registerInstall, staleInstalls, HERMES_REASONS, MARKER_FILE } from '../../src/core/hermes-provider.js';
import { processStartTag } from '../../src/core/process-identity.js';
import { removeTempDir } from '../helpers/temp-dir.js';

// A test that writes into the current directory (the repository) leaves files that get committed by accident: the
// listing of the working directory must be the same after this file as before it.
const cwdListing = fs.readdirSync(process.cwd()).sort();
afterAll(() => {
  expect(fs.readdirSync(process.cwd()).sort()).toEqual(cwdListing);
});

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-au-'));
  dirs.push(d);
  return d;
}
afterEach(() => { removeTempDir(...dirs.splice(0)); });

/** An account home whose own .memesh holds the given config (or none). */
function account(config?: unknown): { home: string; dir: string } {
  const home = tmp();
  const dir = path.join(home, '.memesh');
  fs.mkdirSync(dir, { recursive: true });
  if (config !== undefined) fs.writeFileSync(path.join(dir, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return { home, dir };
}

describe('the policy', () => {
  it('is on (any bump) for the account\'s own ~/.memesh when nothing was set', () => {
    const a = account();
    expect(resolveUpdatePolicy({ env: {}, activeDir: a.dir, accountHome: a.home })).toMatchObject({ policy: 'major', source: 'default' });
  });

  it.each([
    ['config', (a: { dir: string }) => fs.writeFileSync(path.join(a.dir, 'config.json'), '{"autoUpdate":"off"}'), {}],
    ['env', () => undefined, { MEMESH_AUTO_UPDATE: 'off' }],
    ['updateCheck=false', (a: { dir: string }) => fs.writeFileSync(path.join(a.dir, 'config.json'), '{"updateCheck":false}'), {}],
    ['an unreadable config', (a: { dir: string }) => fs.writeFileSync(path.join(a.dir, 'config.json'), '{not json'), {}],
    ['a value that is not one of the four', (a: { dir: string }) => fs.writeFileSync(path.join(a.dir, 'config.json'), '{"autoUpdate":"yes"}'), {}],
    ['an env value that is not one of the four', () => undefined, { MEMESH_AUTO_UPDATE: 'banana' }],
  ])('stays off for %s', (_label, setup, env) => {
    const a = account();
    setup(a);
    const decision = resolveUpdatePolicy({ env, activeDir: a.dir, accountHome: a.home });
    expect(decision.policy).toBe('off');
  });

  it('cannot be bypassed by starting with another HOME or data directory', () => {
    // The account said off in its own ~/.memesh; this run uses a fresh directory with no config.
    const a = account({ autoUpdate: 'off' });
    const foreign = tmp();
    const viaDir = resolveUpdatePolicy({ env: {}, activeDir: foreign, accountHome: a.home });
    expect(viaDir.policy).toBe('off');
    expect(viaDir.source).toBe('account-config');
    // Even an env that says "major" does not beat an off in the account's config.
    expect(resolveUpdatePolicy({ env: { MEMESH_AUTO_UPDATE: 'major' }, activeDir: foreign, accountHome: a.home }).policy).toBe('off');
  });

  it('does not apply the default to a data directory that is not the account\'s own', () => {
    const a = account();
    const foreign = tmp();
    expect(resolveUpdatePolicy({ env: {}, activeDir: foreign, accountHome: a.home })).toMatchObject({ policy: 'off', reason: AUTO_UPDATE_REASONS.policyOffForeignHome });
    expect(resolveUpdatePolicy({ env: { MEMESH_DB_PATH: path.join(foreign, 'x.db') }, activeDir: a.dir, accountHome: a.home }).policy).toBe('off');
  });

  it.each([
    ['an empty value', ''],
    ['spaces', ' '],
    ['a word that is not a setting', 'garbage'],
    ['a number', '0'],
    ['"false"', 'false'],
    ['"none"', 'none'],
    ['a setting with spaces round it', ' major '],
  ])('an environment setting that is %s is off, not the default (it does not guess)', (_label, value) => {
    const a = account();
    expect(resolveUpdatePolicy({ env: { MEMESH_AUTO_UPDATE: value }, activeDir: a.dir, accountHome: a.home })).toMatchObject({ policy: 'off', source: 'env', reason: AUTO_UPDATE_REASONS.policyOffInvalidValue });
  });

  it.each(['OFF', 'Off', 'MAJOR', 'Minor'])('and one in another case (%s) is the setting it spells', (value) => {
    const a = account();
    const lowered = value.toLowerCase();
    expect(resolveUpdatePolicy({ env: { MEMESH_AUTO_UPDATE: value }, activeDir: a.dir, accountHome: a.home }).policy).toBe(lowered);
  });

  it('naming the data directory in the environment is not "the account\'s own": the default does not apply there, even when it is the same directory', () => {
    const a = account();
    expect(resolveUpdatePolicy({ env: { MEMESH_DIR: a.dir }, activeDir: a.dir, accountHome: a.home })).toMatchObject({ policy: 'off', reason: AUTO_UPDATE_REASONS.policyOffForeignHome });
    expect(resolveUpdatePolicy({ env: {}, activeDir: a.dir, accountHome: a.home }).policy).toBe('major'); // control
  });

  it('honours an explicit non-off setting, including in a foreign directory', () => {
    const a = account();
    const foreign = tmp();
    fs.writeFileSync(path.join(foreign, 'config.json'), '{"autoUpdate":"minor"}');
    expect(resolveUpdatePolicy({ env: {}, activeDir: foreign, accountHome: a.home })).toMatchObject({ policy: 'minor', source: 'config' });
  });
});

describe('the channel', () => {
  it('keeps a stable install on latest, and a trial install on next', () => {
    expect(chooseTarget('4.12.0', { latest: '4.12.1', next: '4.13.0' })).toEqual({ stream: 'latest', target: '4.12.1' });
    expect(chooseTarget('4.12.0', { latest: '4.12.0', next: '4.13.0' })).toEqual({ stream: 'latest', target: null });
    expect(chooseTarget('4.13.0', { latest: '4.12.0', next: '4.13.1' })).toEqual({ stream: 'next', target: '4.13.1' });
    // A trial line whose `next` tag stopped at what is installed while `latest` moved ahead does not leave the install stranded.
    expect(chooseTarget('4.10.11', { latest: '4.11.0', next: '4.10.11' })).toEqual({ stream: 'latest', target: '4.11.0' });
    expect(chooseTarget('4.10.11', { latest: '4.11.0', next: '4.10.9' })).toEqual({ stream: 'latest', target: '4.11.0' });
    expect(chooseTarget('4.10.11', { latest: '4.11.0' })).toEqual({ stream: 'latest', target: '4.11.0' });
    // ... while a trial line that is ahead stays on it, and a stable release that is not newer changes nothing.
    expect(chooseTarget('4.12.0-rc.1', { latest: '4.11.0', next: '4.12.0-rc.2' })).toEqual({ stream: 'next', target: '4.12.0-rc.2' });
    expect(chooseTarget('4.12.0-rc.1', { latest: '4.12.0', next: '4.12.0-rc.1' })).toEqual({ stream: 'latest', target: '4.12.0' });
    // a stable install does not follow `next`
    expect(chooseTarget('4.10.11', { latest: '4.11.0', next: '4.12.0-rc.1' })).toEqual({ stream: 'latest', target: '4.11.0' });
    expect(chooseTarget('4.11.0', { latest: '4.11.0', next: '4.11.0' }).target).toBeNull();
    expect(chooseTarget('4.13.0-rc.1', { latest: '4.12.0', next: '4.13.0' })).toEqual({ stream: 'next', target: '4.13.0' });
  });
});

const canReadPs = process.platform !== 'win32' && processStartTag(process.pid) !== null;
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const DIGEST = 'ab'.repeat(64);
const signer = (version = '4.12.0') => `https://github.com/PCIRCLE-AI/memesh/.github/workflows/publish-npm.yml@refs/tags/v${version}`;
const bound = (version = '4.12.0', digest = DIGEST) => ({ tarballSha512Hex: digest, signerOf: () => signer(version) });

function statement(overrides: Record<string, unknown> = {}, version = '4.12.0', digest = DIGEST, commit: unknown = '1c96ad4b758e7c584909fc69ecd0efea930bac6a') {
  const payload = {
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{ name: `pkg:npm/%40pcircle/memesh@${version}`, digest: { sha512: digest } }],
    predicate: {
      buildDefinition: {
        externalParameters: { workflow: { ref: `refs/tags/v${version}`, repository: 'https://github.com/PCIRCLE-AI/memesh', path: '.github/workflows/publish-npm.yml', ...overrides } },
        resolvedDependencies: [{ digest: { gitCommit: commit } }],
      },
    },
  };
  return { predicateType: 'https://slsa.dev/provenance/v1', bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(payload)).toString('base64') } } };
}
const audit = (verified: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ invalid: [], missing: [], verified, ...extra });

describe('the source check', () => {
  it('accepts the verified release built by this project and returns its commit', () => {
    const json = audit([{ name: '@pcircle/memesh', version: '4.12.0', attestationBundles: [statement()] }]);
    expect(judgeAuditSignatures(json, '@pcircle/memesh', '4.12.0', bound('4.12.0'))).toEqual({ ok: true, gitCommit: '1c96ad4b758e7c584909fc69ecd0efea930bac6a' });
  });

  it('refuses a version that appears in neither verified nor missing (published without provenance, exit 0)', () => {
    expect(judgeAuditSignatures(audit([]), '@pcircle/memesh', '2.6.3', bound('2.6.3'))).toMatchObject({ ok: false });
  });

  it.each([
    ['another repository', { repository: 'https://github.com/someone/memesh' }],
    ['another workflow', { path: '.github/workflows/other.yml' }],
    ['another tag', { ref: 'refs/tags/v9.9.9' }],
  ])('refuses provenance from %s', (_label, override) => {
    const json = audit([{ name: '@pcircle/memesh', version: '4.12.0', attestationBundles: [statement(override)] }]);
    expect(judgeAuditSignatures(json, '@pcircle/memesh', '4.12.0', bound('4.12.0'))).toMatchObject({ ok: false });
  });

  it.each([
    ['no commit (null)', null],
    ['an empty commit', ''],
    ['a commit one character short', 'a'.repeat(39)],
    ['a commit one character long', 'a'.repeat(41)],
    ['a commit that is not hex', 'g'.repeat(40)],
    ['a commit in capitals (git prints lower case)', 'A'.repeat(40)],
    ['a branch name', 'main'],
    ['a number', 12345],
  ])('refuses provenance that names %s', (_label, commit) => {
    const json = audit([{ name: '@pcircle/memesh', version: '4.12.0', attestationBundles: [statement({}, '4.12.0', DIGEST, commit)] }]);
    expect(judgeAuditSignatures(json, '@pcircle/memesh', '4.12.0', bound('4.12.0'))).toMatchObject({ ok: false, reason: 'provenance carries no commit' });
  });

  it('refuses when any package in the install has an invalid signature, or the output is not JSON', () => {
    const entry = { name: '@pcircle/memesh', version: '4.12.0', attestationBundles: [statement()] };
    expect(judgeAuditSignatures(audit([entry], { invalid: [{ name: 'x', version: '1.0.0' }] }), '@pcircle/memesh', '4.12.0', bound('4.12.0'))).toMatchObject({ ok: false });
    expect(judgeAuditSignatures('not json', '@pcircle/memesh', '4.12.0', bound('4.12.0'))).toMatchObject({ ok: false });
    // A reply with no lists at all, or an entry with no attestations, is not "nothing wrong".
    expect(judgeAuditSignatures('{}', '@pcircle/memesh', '4.12.0', bound('4.12.0'))).toMatchObject({ ok: false });
    expect(judgeAuditSignatures(audit([{ name: '@pcircle/memesh', version: '4.12.0' }]), '@pcircle/memesh', '4.12.0', bound('4.12.0'))).toMatchObject({ ok: false });
  });
});

describe('the backup', () => {
  it('copies a real database consistently and keeps only the newest few', () => {
    const d = tmp();
    const dbPath = path.join(d, 'knowledge-graph.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE t (v TEXT); INSERT INTO t VALUES (\'kept\');');
    db.close();
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1) made.push(backupDatabase(dbPath, path.join(d, 'backups'), '4.12.0', new Date(Date.UTC(2026, 10, 3, 0, 0, i)))!);
    const left = fs.readdirSync(path.join(d, 'backups'));
    expect(left).toHaveLength(3);
    const copy = new DatabaseSync(made[4], { readOnly: true });
    expect(copy.prepare('SELECT v FROM t').get()).toEqual({ v: 'kept' });
    copy.close();
  });

  it('has nothing to back up when there is no database yet', () => {
    const d = tmp();
    expect(backupDatabase(path.join(d, 'missing.db'), path.join(d, 'backups'), '1.0.0')).toBeNull();
  });
});

describe('live hosts', () => {
  it('counts a running process and forgets one that exited', () => {
    const d = tmp();
    registerLiveHost(d, process.pid);
    fs.writeFileSync(path.join(d, 'live-hosts', '999999.json'), '{}');
    expect(liveHostPids(d)).toEqual([process.pid]);
    expect(fs.existsSync(path.join(d, 'live-hosts', '999999.json'))).toBe(false);
  });
});

// ─── the whole entry, with the world faked ────────────────────────────────

const OFFICIAL_CODEX_CONFIG = 'model = "mine"\n\n[marketplaces.pcircle-memesh]\nsource_type = "git"\nsource = "https://github.com/PCIRCLE-AI/memesh.git"\n\n[plugins."memesh@pcircle-memesh"]\nenabled = true\n';

const RELEASE_COMMIT = '1c96ad4b758e7c584909fc69ecd0efea930bac6a';
/** What GitHub answers when the release commit is part of main. */
const ON_MAIN = { status: 0, stdout: `200\n${JSON.stringify({ status: 'ahead', merge_base_commit: { sha: RELEASE_COMMIT } })}`, stderr: '' };
/** The pinned-dependency file a release carries (npm's own shape). */
function shrinkwrapText(version = '4.13.0', mutate?: (packages: Record<string, Record<string, unknown>>) => void): string {
  const packages: Record<string, Record<string, unknown>> = {
    '': { name: '@pcircle/memesh', version, dependencies: { zod: '4.6.6', ws: '^8.21.3' } },
    'node_modules/zod': { version: '4.6.6', resolved: 'https://registry.npmjs.org/zod/-/zod-4.6.6.tgz', integrity: `sha512-${'A'.repeat(86)}==` },
    'node_modules/ws': { version: '8.21.3', resolved: 'https://registry.npmjs.org/ws/-/ws-8.21.3.tgz', integrity: `sha512-${'B'.repeat(86)}==` },
  };
  mutate?.(packages);
  return JSON.stringify({ name: '@pcircle/memesh', version, lockfileVersion: 3, packages });
}

function fakeWorld(options: { rehearsalResult?: { status: number | null; stdout: string; stderr: string }; codexRoot?: 'missing' | 'wrong-version'; claudeRegistry?: 'missing' | 'other-commit' | 'other-version'; pinResult?: { status: number | null; stdout: string; stderr: string }; commitAnswer?: { status: number | null; stdout: string; stderr: string }; shrinkwrap?: string | null; } & { channel?: AutoUpdateDeps['channel']; pluginHost?: AutoUpdateDeps['pluginHost']; config?: unknown; env?: NodeJS.ProcessEnv; verified?: boolean; tags?: { latest?: string; next?: string } | null; withDb?: boolean; codexConfig?: string | null; tarballBuilder?: (file: string) => void; realTar?: boolean; lockIntegrity?: string; attestedDigest?: string; verifiedSequence?: boolean[] } = {}) {
  const a = account(options.config);
  const codexHome = tmp();
  if (options.codexConfig !== null) fs.writeFileSync(path.join(codexHome, 'config.toml'), options.codexConfig ?? OFFICIAL_CODEX_CONFIG);
  const calls: string[] = [];
  const stagedTarball = 'pcircle-memesh-4.13.0.tgz';
  let packedDigest = DIGEST;
  let auditCalls = 0;
  const deps: AutoUpdateDeps = {
    env: options.env ?? {},
    accountHome: a.home,
    dir: a.dir,
    configDir: a.dir,
    signerOf: () => signer('4.13.0'),
    dbPath: path.join(a.dir, 'knowledge-graph.db'),
    // A Codex plugin lives under the Codex directory's plugins/cache: that is where the updater finds out which Codex it belongs to.
    packageRoot: options.pluginHost === 'codex' ? path.join(codexHome, 'plugins', 'cache', 'pcircle-memesh', 'memesh', '4.12.0') : tmp(),
    currentVersion: '4.12.0',
    channel: options.channel ?? 'npm-global',
    pluginHost: options.pluginHost ?? null,
    codexHome,
    tmpRoot: tmp(),
    sleep: async () => {},
    now: () => new Date(),
    readInstalledVersion: () => '4.13.0',
    readTags: () => (options.tags === undefined ? { latest: '4.13.0' } : options.tags),
    exec: (cmd, args, opts) => {
      const line = `${cmd} ${args.slice(0, 3).join(' ')}`;
      calls.push(line);
      if (args[0] === 'install' && !args.includes('-g')) {
        fs.writeFileSync(path.join(opts!.cwd!, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@pcircle/memesh': { integrity: 'PLACEHOLDER' } } }));
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === process.execPath && args[0] === '-e') return options.commitAnswer ?? ON_MAIN;
      const globalRoot = path.join(path.dirname(deps.dbPath), 'global-root');
      const installedDir = path.join(globalRoot, '@pcircle', 'memesh');
      if (cmd === 'npm' && args[0] === 'root' && args[1] === '-g') {
        // What is installed now: a version that works, which a failed update must leave working.
        if (!fs.existsSync(installedDir)) {
          fs.mkdirSync(installedDir, { recursive: true });
          fs.writeFileSync(path.join(installedDir, 'package.json'), JSON.stringify({ version: '4.12.0' }));
          fs.writeFileSync(path.join(installedDir, 'WORKS'), 'the old version');
        }
        return { status: 0, stdout: `${globalRoot}\n`, stderr: '' };
      }
      if (cmd === 'npm' && args[0] === 'install' && args.includes('-g')) {
        // npm replaces the installed package: nothing of the old one stays.
        fs.rmSync(installedDir, { recursive: true, force: true });
        fs.mkdirSync(installedDir, { recursive: true });
        fs.writeFileSync(path.join(installedDir, 'package.json'), JSON.stringify({ version: '4.13.0' }));
        fs.writeFileSync(path.join(installedDir, 'NEW'), 'the new version, without its dependencies');
        if (options.shrinkwrap !== null) fs.writeFileSync(path.join(installedDir, 'npm-shrinkwrap.json'), options.shrinkwrap ?? shrinkwrapText());
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'npm' && args[0] === 'ci') {
        // In the installed package: the real pinned install, which empties node_modules first. Anywhere else: the rehearsal in staging.
        if (opts?.cwd === installedDir) return options.pinResult ?? { status: 0, stdout: '', stderr: '' };
        return options.rehearsalResult ?? { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'tar' && args.includes('-xzOf')) {
        return options.shrinkwrap === null ? { status: 2, stdout: '', stderr: 'tar: package/npm-shrinkwrap.json: Not found in archive' } : { status: 0, stdout: options.shrinkwrap ?? shrinkwrapText(), stderr: '' };
      }
      if (cmd === 'tar' && options.realTar) {
        const r = spawnSync(cmd, args, { cwd: opts?.cwd, encoding: 'utf8', env: { ...process.env, ...(opts?.env ?? {}) } });
        return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      }
      if (cmd === 'tar' && args.includes('-tzf')) {
        return { status: 0, stdout: 'package/extensions/hermes-memesh/__init__.py\npackage/extensions/hermes-memesh/plugin.yaml\n', stderr: '' };
      }
      if (cmd === 'tar' && args.includes('-tvzf')) {
        // The listing the extraction is checked against: plain files under the provider directory.
        return { status: 0, stdout: '-rw-r--r--  0 0  0  28 Nov  8 00:00 package/extensions/hermes-memesh/__init__.py\n-rw-r--r--  0 0  0  13 Nov  8 00:00 package/extensions/hermes-memesh/plugin.yaml\n', stderr: '' };
      }
      if (cmd === 'tar') {
        // Extraction always names its directory (-C <dir>): an exec that wrote into the current directory is a bug in the fake, and fails the test.
        if (!args.includes('-C')) throw new Error(`fake tar called without -C: ${args.join(' ')}`);
        const out = path.join(args[args.indexOf('-C') + 1], 'package', 'extensions', 'hermes-memesh');
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(path.join(out, '__init__.py'), '# from the verified tarball\n');
        fs.writeFileSync(path.join(out, 'plugin.yaml'), 'name: memesh\n');
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'codex') {
        if (args[1] !== 'add') return { status: 0, stdout: '', stderr: '' };
        // `plugin add` leaves the plugin where Codex keeps it, and says where.
        const root = path.join(codexHome, 'plugins', 'cache', 'pcircle-memesh', 'memesh', '4.13.0');
        if (options.codexRoot !== 'missing') {
          fs.mkdirSync(root, { recursive: true });
          fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: options.codexRoot === 'wrong-version' ? '4.12.9' : '4.13.0' }));
        }
        return { status: 0, stdout: `Installed plugin root: ${root}\n`, stderr: '' };
      }
      if (args[0] === 'audit') {
        const passes = options.verifiedSequence ? options.verifiedSequence[Math.min(auditCalls, options.verifiedSequence.length - 1)] : options.verified !== false;
        auditCalls += 1;
        const entry = !passes ? [] : [{ name: '@pcircle/memesh', version: '4.13.0', attestationBundles: [statement({}, '4.13.0', options.attestedDigest ?? packedDigest)] }];
        return { status: 0, stdout: audit(entry), stderr: '' };
      }
      if (args[0] === 'pack') {
        const file = path.join(opts!.cwd!, stagedTarball);
        (options.tarballBuilder ?? ((f: string) => fs.writeFileSync(f, 'tarball bytes')))(file);
        packedDigest = createHash('sha512').update(fs.readFileSync(file)).digest('hex');
        const lock = path.join(opts!.cwd!, 'package-lock.json');
        const j = JSON.parse(fs.readFileSync(lock, 'utf8'));
        j.packages['node_modules/@pcircle/memesh'].integrity = options.lockIntegrity ?? sha512Integrity(file);
        fs.writeFileSync(lock, JSON.stringify(j));
        return { status: 0, stdout: `${stagedTarball}\n`, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };
  if ((options.channel ?? 'npm-global') === 'plugin-marketplace' && options.pluginHost !== 'codex') {
    // Claude Code's own record of what is installed: the update script writes it, and the read-back reads it.
    const registry = path.join(a.dir, 'installed_plugins.json');
    deps.claudeRegistryPath = registry;
    if (options.claudeRegistry !== 'missing') {
      fs.writeFileSync(registry, JSON.stringify({ plugins: { 'memesh@pcircle-memesh': [{ installPath: '/x/cache/4.13.0', version: options.claudeRegistry === 'other-version' ? '4.12.9' : '4.13.0', gitCommitSha: options.claudeRegistry === 'other-commit' ? 'e'.repeat(40) : RELEASE_COMMIT }] } }));
    }
  }
  if (options.withDb) {
    const db = new DatabaseSync(deps.dbPath);
    db.exec('CREATE TABLE t (v TEXT)');
    db.close();
  }
  return { deps, calls, a };
}

describe('runAutoUpdate', () => {
  it('does nothing but record when the policy is off — no registry call, no install', async () => {
    const w = fakeWorld({ config: { autoUpdate: 'off' } });
    let registryAsked = false;
    w.deps.readTags = () => { registryAsked = true; return { latest: '4.13.0' }; };
    const result = await runAutoUpdate(w.deps);
    expect(result).toMatchObject({ outcome: 'skipped', reason: AUTO_UPDATE_REASONS.policyOff });
    expect(registryAsked).toBe(false);
    expect(w.calls).toEqual([]);
    expect(readAutoUpdateState(w.a.dir)).toMatchObject({ outcome: 'skipped', reason: AUTO_UPDATE_REASONS.policyOff });
  });

  it('installs the verified tarball for npm-global by default, after the backup, and leaves the receipt', async () => {
    const w = fakeWorld({ withDb: true });
    const result = await runAutoUpdate(w.deps);
    expect(result).toMatchObject({ outcome: 'installed' });
    const installIndex = w.calls.findIndex((c) => c.startsWith('npm install -g'));
    expect(installIndex).toBeGreaterThan(w.calls.findIndex((c) => c.startsWith('npm audit')));
    expect(fs.readdirSync(path.join(w.a.dir, 'backups'))).toHaveLength(1);
    expect(readAutoUpdateState(w.a.dir)).toMatchObject({ outcome: 'installed', from: '4.12.0', to: '4.13.0' });
    expect(fs.existsSync(path.join(w.a.dir, 'just-upgraded.json'))).toBe(true);
  });

  it('does not install when the source cannot be verified, and says so', async () => {
    const w = fakeWorld({ verified: false });
    const result = await runAutoUpdate(w.deps);
    expect(result).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.sourceNotVerified });
    expect(w.calls.some((c) => c.startsWith('npm install -g'))).toBe(false);
  });

  it('does not install when the backup fails', async () => {
    const w = fakeWorld();
    fs.writeFileSync(w.deps.dbPath, 'this is not a database');
    const result = await runAutoUpdate(w.deps);
    expect(result).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.backupFailed });
    expect(w.calls.some((c) => c.startsWith('npm install -g'))).toBe(false);
  });

  it('waits while a session is running and swaps only after it exits', async () => {
    const w = fakeWorld();
    registerLiveHost(w.a.dir, process.pid);
    let polls = 0;
    w.deps.sleep = async () => {
      polls += 1;
      if (polls === 2) fs.rmSync(path.join(w.a.dir, 'live-hosts'), { recursive: true });
    };
    const states: string[] = [];
    const realExec = w.deps.exec;
    w.deps.exec = (cmd, args, opts) => {
      if (args[0] === 'install' && args.includes('-g')) states.push(`install-after-${polls}-polls`);
      return realExec(cmd, args, opts);
    };
    const result = await runAutoUpdate(w.deps);
    expect(result).toMatchObject({ outcome: 'installed' });
    expect(states).toEqual(['install-after-2-polls']);
  });

  it('never moves a stable install to the next channel', async () => {
    const w = fakeWorld({ tags: { latest: '4.12.0', next: '4.14.0' } });
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'skipped', reason: AUTO_UPDATE_REASONS.upToDate });
    expect(w.calls).toEqual([]);
  });

  it('records a registry that did not answer', async () => {
    const w = fakeWorld({ tags: null });
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.registryUnreachable });
  });

  it('records channels that cannot update themselves', async () => {
    for (const channel of ['source-checkout', 'npm-local', 'unknown'] as const) {
      const w = fakeWorld({ channel });
      expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'skipped', reason: AUTO_UPDATE_REASONS.channelUnsupported });
    }
  });

  it('refuses a bump the explicit policy does not permit', async () => {
    const w = fakeWorld({ config: { autoUpdate: 'patch' } });
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'skipped', reason: AUTO_UPDATE_REASONS.bumpNotPermitted });
  });

  it('pins the Claude Code plugin to the attested commit', async () => {
    const w = fakeWorld({ channel: 'plugin-marketplace', pluginHost: 'claude-code' });
    const seen: NodeJS.ProcessEnv[] = [];
    const realExec = w.deps.exec;
    w.deps.exec = (cmd, args, opts) => {
      if (cmd === 'bash') seen.push(opts!.env!);
      return realExec(cmd, args, opts);
    };
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'installed' });
    expect(seen[0]).toMatchObject({ MEMESH_UPGRADE_PIN_COMMIT: '1c96ad4b758e7c584909fc69ecd0efea930bac6a', MEMESH_UPGRADE_EXPECT_VERSION: '4.13.0' });
  });

  it('moves the Codex plugin to the attested commit: remove, add pinned, install', async () => {
    const w = fakeWorld({ channel: 'plugin-marketplace', pluginHost: 'codex' });
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'installed' });
    const codex = w.calls.filter((c) => c.startsWith('codex'));
    expect(codex).toEqual([
      'codex plugin marketplace remove',
      'codex plugin marketplace add',
      'codex plugin add memesh@pcircle-memesh',
    ]);
  });

  it('pins the Codex marketplace to the commit named by the provenance', async () => {
    const w = fakeWorld({ channel: 'plugin-marketplace', pluginHost: 'codex' });
    const adds: string[][] = [];
    const realExec = w.deps.exec;
    w.deps.exec = (cmd, args, opts) => {
      if (cmd === 'codex' && args[1] === 'marketplace' && args[2] === 'add') adds.push(args);
      return realExec(cmd, args, opts);
    };
    await runAutoUpdate(w.deps);
    expect(adds).toEqual([['plugin', 'marketplace', 'add', 'PCIRCLE-AI/memesh', '--ref', '1c96ad4b758e7c584909fc69ecd0efea930bac6a']]);
  });

  it('leaves a Codex marketplace that is not the official repository alone', async () => {
    const w = fakeWorld({ channel: 'plugin-marketplace', pluginHost: 'codex', codexConfig: '[marketplaces.pcircle-memesh]\nsource_type = "local"\nsource = "/home/me/dev/memesh"\n' });
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'skipped', reason: AUTO_UPDATE_REASONS.codexMarketplaceForeign });
    expect(w.calls.some((c) => c.startsWith('codex'))).toBe(false);
  });

  it('puts the Codex marketplace back unpinned when the pinned add fails', async () => {
    const w = fakeWorld({ channel: 'plugin-marketplace', pluginHost: 'codex' });
    const seen: string[][] = [];
    const realExec = w.deps.exec;
    w.deps.exec = (cmd, args, opts) => {
      if (cmd === 'codex') seen.push(args);
      if (cmd === 'codex' && args.includes('--ref')) return { status: 1, stdout: '', stderr: 'no such ref' };
      return realExec(cmd, args, opts);
    };
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.codexInstallFailed });
    expect(seen.at(-1)).toEqual(['plugin', 'marketplace', 'add', 'PCIRCLE-AI/memesh']);
  });

  it('fails when Codex did not install the target version', async () => {
    const w = fakeWorld({ channel: 'plugin-marketplace', pluginHost: 'codex' });
    const realExec = w.deps.exec;
    w.deps.exec = (cmd, args, opts) => (cmd === 'codex' && args[1] === 'add'
      ? { status: 0, stdout: 'Installed plugin root: /x/memesh/4.12.0\n', stderr: '' }
      : realExec(cmd, args, opts));
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.codexReadbackFailed });
  });

  it('stops waiting for running sessions after 3 days, installs, and says so', async () => {
    const w = fakeWorld();
    registerLiveHost(w.a.dir, process.pid);
    let clock = Date.parse('2026-11-03T00:00:00Z');
    w.deps.now = () => new Date(clock);
    w.deps.sleep = async (ms) => { clock += ms; };
    const result = await runAutoUpdate(w.deps);
    expect(result).toMatchObject({ outcome: 'installed', reason: AUTO_UPDATE_REASONS.installedAfterWait });
    expect(clock - Date.parse('2026-11-03T00:00:00Z')).toBeGreaterThanOrEqual(3 * 24 * 60 * 60 * 1000);
    expect(w.calls.some((c) => c.startsWith('npm install -g'))).toBe(true);
  });
  it('shows when the wait began, and a restarted runner does not count the 3 days again', async () => {
    const w = fakeWorld();
    registerLiveHost(w.a.dir, process.pid);
    let clock = Date.parse('2026-11-03T00:00:00Z');
    w.deps.now = () => new Date(clock);
    // The first runner started waiting 3 days and a minute ago, then died; a session is still open.
    fs.writeFileSync(path.join(w.a.dir, 'auto-update-wait.json'), JSON.stringify({ target: '4.13.0', since: new Date(clock - 3 * 24 * 60 * 60 * 1000 - 60_000).toISOString() }));
    let slept = 0;
    w.deps.sleep = async (ms) => { slept += ms; clock += ms; };
    const result = await runAutoUpdate(w.deps);
    expect(result).toMatchObject({ outcome: 'installed', reason: AUTO_UPDATE_REASONS.installedAfterWait });
    expect(slept).toBe(0);
    expect(fs.existsSync(path.join(w.a.dir, 'auto-update-wait.json'))).toBe(false);
  });

  it('writes the start of the wait into the state file while it waits', async () => {
    const w = fakeWorld();
    registerLiveHost(w.a.dir, process.pid);
    const seen: Array<string | null | undefined> = [];
    w.deps.sleep = async () => {
      seen.push(readAutoUpdateState(w.a.dir)?.waitingSince);
      fs.rmSync(path.join(w.a.dir, 'live-hosts'), { recursive: true });
    };
    await runAutoUpdate(w.deps);
    expect(seen).toHaveLength(1);
    expect(typeof seen[0]).toBe('string');
    expect(readAutoUpdateState(w.a.dir)?.waitingSince).toBeNull();
  });

  it('ignores a wait record that belongs to another target version', async () => {
    const w = fakeWorld();
    registerLiveHost(w.a.dir, process.pid);
    let clock = Date.parse('2026-11-03T00:00:00Z');
    w.deps.now = () => new Date(clock);
    fs.writeFileSync(path.join(w.a.dir, 'auto-update-wait.json'), JSON.stringify({ target: '4.12.5', since: new Date(clock - 10 * 24 * 60 * 60 * 1000).toISOString() }));
    let polls = 0;
    w.deps.sleep = async (ms) => { polls += 1; clock += ms; if (polls === 3) fs.rmSync(path.join(w.a.dir, 'live-hosts'), { recursive: true }); };
    const result = await runAutoUpdate(w.deps);
    expect(result).toMatchObject({ outcome: 'installed', reason: AUTO_UPDATE_REASONS.installed });
    expect(polls).toBe(3);
  });
});

describe('Hermes provider copies follow the verified update', () => {
  /** A provider copy MeMesh installed earlier, in a throwaway HERMES_HOME. */
  function withCopy(version = '4.12.0', world: Partial<Parameters<typeof fakeWorld>[0]> = {}) {
    const hermesHome = tmp();
    const w = fakeWorld({ ...world, env: { ...(world.env ?? {}), HERMES_HOME: hermesHome } });
    const oldSource = tmp();
    fs.writeFileSync(path.join(oldSource, '__init__.py'), '# the old provider\n');
    fs.writeFileSync(path.join(oldSource, 'plugin.yaml'), 'name: memesh\n');
    const target = defaultInstallTarget({ HERMES_HOME: hermesHome } as NodeJS.ProcessEnv);
    installProvider({ sourceDir: oldSource, target, version, force: false, backupRoot: path.join(w.a.dir, 'backups'), now: new Date() });
    return { w, target, hermesHome };
  }
  const read = (target: string) => fs.readFileSync(path.join(target, '__init__.py'), 'utf8');

  it('refreshes a copy MeMesh installed from the verified tarball, makes no backup of MeMesh\'s own files, and records it', async () => {
    const { w, target } = withCopy();
    const result = await runAutoUpdate(w.deps);
    expect(result).toMatchObject({ outcome: 'installed' });
    expect(read(target)).toBe('# from the verified tarball\n');
    expect(JSON.parse(fs.readFileSync(path.join(target, MARKER_FILE), 'utf8')).version).toBe('4.13.0');
    const state = readAutoUpdateState(w.a.dir);
    expect(state?.hermes).toMatchObject([{ path: target, outcome: 'refreshed' }]);
    // Every byte of the old copy is in the package it came from: nothing of the owner's is being replaced, so nothing is saved.
    expect(state!.hermes![0].backup).toBeNull();
    expect(fs.existsSync(path.join(w.a.dir, 'backups', 'hermes-provider-none'))).toBe(false);
    expect(fs.readFileSync(path.join(w.a.dir, 'auto-update.log'), 'utf8')).toContain('hermes-provider REFRESHED');
    // The tarball it came from is the one that passed the source check.
    const order = w.calls.filter((c) => c.startsWith('npm audit') || c.startsWith('tar'));
    expect(order[0]).toMatch(/^npm audit/);
    expect(order.at(-1)).toMatch(/^tar/);
  });

  it('does nothing to a copy, and does not even unpack the package, when the policy is off', async () => {
    const { w, target } = withCopy('4.12.0', { config: { autoUpdate: 'off' } });
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'skipped', reason: AUTO_UPDATE_REASONS.policyOff });
    expect(read(target)).toBe('# the old provider\n');
    expect(w.calls.some((c) => c.startsWith('tar'))).toBe(false);
    expect(readAutoUpdateState(w.a.dir)?.hermes).toBeNull();
  });

  it('leaves a copy its owner edited alone, says so, and still updates MeMesh', async () => {
    const { w, target } = withCopy();
    fs.appendFileSync(path.join(target, '__init__.py'), '# my own change\n');
    const result = await runAutoUpdate(w.deps);
    expect(result).toMatchObject({ outcome: 'installed' });
    expect(read(target)).toContain('# my own change');
    expect(readAutoUpdateState(w.a.dir)?.hermes).toMatchObject([{ outcome: 'skipped', reason: expect.stringContaining('changed after MeMesh installed it') }]);
  });

  it('with no copy anywhere, unpacks nothing and records nothing about Hermes', async () => {
    const w = fakeWorld({ env: { HERMES_HOME: tmp() } });
    await runAutoUpdate(w.deps);
    // The only tar run is the read of the release's dependency pins: nothing is listed or unpacked for Hermes.
    // (the other tar runs are the read of the release's pins and the staging rehearsal, both of the release itself)
    expect(w.calls.filter((c) => c.startsWith('tar') && c.includes('package.tgz'))).toEqual([]);
    expect(readAutoUpdateState(w.a.dir)?.hermes).toBeNull();
  });

  it('unpacks the provider from the very tarball that was packed, verified and hashed, not from any other file', async () => {
    const { w } = withCopy();
    const real = w.deps.exec;
    let packed = '';
    const unpackedFrom: string[] = [];
    w.deps.exec = (cmd, args, opts) => {
      const result = real(cmd, args, opts);
      if (cmd === 'npm' && args[0] === 'pack' && opts?.cwd) packed = sha512Integrity(path.join(opts.cwd, 'pcircle-memesh-4.13.0.tgz'));
      if (cmd === 'tar') {
        const flag = args.find((a) => a === '-xzf' || a === '-tzf' || a === '-tvzf');
        if (flag) unpackedFrom.push(sha512Integrity(args[args.indexOf(flag) + 1]));
      }
      return result;
    };
    await runAutoUpdate(w.deps);
    expect(packed).not.toBe('');
    expect(unpackedFrom.length).toBeGreaterThanOrEqual(3); // listed, listed with types, extracted
    expect(new Set(unpackedFrom)).toEqual(new Set([packed]));
  });

  it('does not touch a copy when the package source cannot be verified', async () => {
    const { w, target } = withCopy('4.12.0', { verified: false });
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.sourceNotVerified });
    expect(read(target)).toBe('# the old provider\n');
    expect(w.calls.some((c) => c.startsWith('tar'))).toBe(false);
  });

  it('catches a stale copy up when MeMesh itself is already current, from the verified current version', async () => {
    const { w, target } = withCopy('4.12.0');
    w.deps.currentVersion = '4.13.0';
    const result = await runAutoUpdate(w.deps);
    expect(result).toMatchObject({ outcome: 'skipped', reason: AUTO_UPDATE_REASONS.upToDate });
    expect(read(target)).toBe('# from the verified tarball\n');
    expect(readAutoUpdateState(w.a.dir)?.hermes).toMatchObject([{ outcome: 'refreshed' }]);
    expect(w.calls.some((c) => c.startsWith('npm install -g'))).toBe(false);
  });

  it('records that a stale copy could not be refreshed because the current version cannot be verified', async () => {
    const { w, target } = withCopy('4.12.0', { verified: false });
    w.deps.currentVersion = '4.13.0';
    await runAutoUpdate(w.deps);
    expect(read(target)).toBe('# the old provider\n');
    // The reason is the one the check gave, not a generic "failed".
    expect(readAutoUpdateState(w.a.dir)?.hermes).toMatchObject([{ outcome: 'failed', reason: AUTO_UPDATE_REASONS.sourceNotVerified }]);
  });
});

describe('the policy, hardened', () => {
  it('reads the config that `memesh config set` writes even when the database directory is a different one (MEMESH_DIR and MEMESH_DB_PATH apart)', () => {
    const a = account();
    const dbDir = tmp();
    const configDir = tmp();
    fs.writeFileSync(path.join(configDir, 'config.json'), '{"autoUpdate":"off"}');
    const both = resolveUpdatePolicy({ env: {}, activeDir: dbDir, extraConfigDirs: [configDir], accountHome: a.home });
    expect(both).toMatchObject({ policy: 'off', source: 'config', reason: AUTO_UPDATE_REASONS.policyOff });
    // Without the second directory the off would have been invisible: that was the defect.
    expect(resolveUpdatePolicy({ env: { MEMESH_AUTO_UPDATE: 'major' }, activeDir: dbDir, accountHome: a.home }).policy).toBe('major');
  });

  it('treats a config it cannot read as off, not as absent: a path through a file, a dangling symlink, a directory that cannot be entered', () => {
    const a = account();
    const cases: Array<[string, string]> = [];
    const throughFile = tmp();
    fs.writeFileSync(path.join(throughFile, 'not-a-dir'), 'x');
    cases.push(['ENOTDIR', path.join(throughFile, 'not-a-dir')]);
    const dangling = tmp();
    fs.symlinkSync(path.join(dangling, 'nowhere.json'), path.join(dangling, 'config.json'));
    cases.push(['dangling symlink', dangling]);
    for (const [label, dir] of cases) {
      const decision = resolveUpdatePolicy({ env: {}, activeDir: dir, accountHome: a.home });
      expect(decision, label).toMatchObject({ policy: 'off', reason: AUTO_UPDATE_REASONS.policyOffUnreadableConfig });
      expect(decision.detail, label).toContain('config.json');
    }
    if (process.getuid?.() !== 0) {
      const locked = tmp();
      fs.writeFileSync(path.join(locked, 'config.json'), '{"autoUpdate":"major"}');
      fs.chmodSync(locked, 0o000);
      try {
        expect(resolveUpdatePolicy({ env: {}, activeDir: locked, accountHome: a.home })).toMatchObject({ policy: 'off', reason: AUTO_UPDATE_REASONS.policyOffUnreadableConfig });
      } finally {
        fs.chmodSync(locked, 0o700);
      }
    }
    // A directory that simply has no config is still absent.
    expect(resolveUpdatePolicy({ env: {}, activeDir: a.dir, accountHome: a.home }).policy).toBe('major');
  });

  it('does not apply the default inside CI, but honours an explicit setting there', () => {
    const a = account();
    for (const env of [{ CI: 'true' }, { CI: '1' }, { GITHUB_ACTIONS: 'true' }, { GITLAB_CI: 'true' }, { BUILDKITE: 'true' }]) {
      expect(resolveUpdatePolicy({ env, activeDir: a.dir, accountHome: a.home }), JSON.stringify(env)).toMatchObject({ policy: 'off', reason: AUTO_UPDATE_REASONS.policyOffCi });
    }
    expect(resolveUpdatePolicy({ env: { CI: 'true', MEMESH_AUTO_UPDATE: 'minor' }, activeDir: a.dir, accountHome: a.home }).policy).toBe('minor');
    for (const env of [{ CI: 'false' }, { CI: '0' }, { CI: '' }, {}]) {
      expect(resolveUpdatePolicy({ env, activeDir: a.dir, accountHome: a.home }).policy, JSON.stringify(env)).toBe('major');
    }
    expect(isCi({ CI: 'true' })).toBe(true);
    expect(isCi({})).toBe(false);
    // A container is not a place for a default-on update either: docker and podman set `container`, and it alone is enough.
    for (const env of [{ container: 'docker' }, { container: 'podman' }]) {
      expect(isCi(env), JSON.stringify(env)).toBe(true);
      expect(resolveUpdatePolicy({ env, activeDir: a.dir, accountHome: a.home }), JSON.stringify(env)).toMatchObject({ policy: 'off', reason: AUTO_UPDATE_REASONS.policyOffCi });
    }
    expect(AUTO_UPDATE_REASONS.policyOffCi).toContain('CI or a container');
    expect(resolveUpdatePolicy({ env: { container: 'docker', MEMESH_AUTO_UPDATE: 'minor' }, activeDir: a.dir, accountHome: a.home }).policy).toBe('minor');
    expect(isCi({ container: '' })).toBe(false);
  });

  it('with no passwd entry for this uid the account home is unknown: nothing is applied by default, and nothing throws', () => {
    const a = account();
    const decision = resolveUpdatePolicy({ env: {}, activeDir: a.dir, accountHome: null });
    expect(decision).toMatchObject({ policy: 'off', reason: AUTO_UPDATE_REASONS.policyOffNoAccountHome });
    expect(resolveUpdatePolicy({ env: { MEMESH_AUTO_UPDATE: 'patch' }, activeDir: a.dir, accountHome: null }).policy).toBe('patch');
    const spy = vi.spyOn(os, 'userInfo').mockImplementation(() => { throw new Error('ENOENT: no passwd entry'); });
    try {
      expect(safeAccountHome()).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the source check binds to this tarball and this signer', () => {
  const att = JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/auto-update/attestations-pcircle-memesh-4.12.0.json'), 'utf8')) as { attestations: Array<{ bundle: unknown; predicateType: string }> };
  const realAudit = () => audit([{ name: '@pcircle/memesh', version: '4.12.0', attestationBundles: att.attestations }]);
  const realDigest = '8c77bebe2b2533a33ddbc25d45be8e2fd5af7b4d17bc31e8399d65a43eb436d842e3ab488dc4195c975b961983f1a7d227bd3d9c25c1b47734ff4234f9098ee1';

  it('reads the signer out of the real Sigstore certificate of the real 4.12.0 release, and accepts that release', () => {
    const provenance = att.attestations.find((a) => a.predicateType === 'https://slsa.dev/provenance/v1')!;
    expect(signerIdentity(provenance)).toBe(signer('4.12.0'));
    expect(judgeAuditSignatures(realAudit(), '@pcircle/memesh', '4.12.0', { tarballSha512Hex: realDigest })).toMatchObject({ ok: true });
  });

  it('refuses a tarball whose digest is not the attested one', () => {
    const verdict = judgeAuditSignatures(realAudit(), '@pcircle/memesh', '4.12.0', { tarballSha512Hex: 'deadbeef'.repeat(16) });
    expect(verdict).toMatchObject({ ok: false, reason: expect.stringContaining('digest') });
    expect(judgeAuditSignatures(audit([{ name: '@pcircle/memesh', version: '4.12.0', attestationBundles: [statement()] }]), '@pcircle/memesh', '4.12.0', { tarballSha512Hex: 'deadbeef'.repeat(16), signerOf: () => signer() })).toMatchObject({ ok: false });
  });

  it('refuses a bundle signed by another repository, another workflow or another tag, and one with no certificate', () => {
    const json = audit([{ name: '@pcircle/memesh', version: '4.12.0', attestationBundles: [statement()] }]);
    for (const identity of [
      'https://github.com/someone-else/memesh/.github/workflows/publish-npm.yml@refs/tags/v4.12.0',
      'https://github.com/PCIRCLE-AI/memesh/.github/workflows/other.yml@refs/tags/v4.12.0',
      'https://github.com/PCIRCLE-AI/memesh/.github/workflows/publish-npm.yml@refs/tags/v9.9.9',
      'https://github.com/PCIRCLE-AI/memesh/.github/workflows/publish-npm.yml@refs/heads/main',
    ]) {
      expect(judgeAuditSignatures(json, '@pcircle/memesh', '4.12.0', { tarballSha512Hex: DIGEST, signerOf: () => identity }), identity).toMatchObject({ ok: false });
    }
    expect(judgeAuditSignatures(json, '@pcircle/memesh', '4.12.0', { tarballSha512Hex: DIGEST, signerOf: () => null })).toMatchObject({ ok: false });
    // The statement alone, with no certificate behind it, proves nothing.
    expect(judgeAuditSignatures(json, '@pcircle/memesh', '4.12.0', { tarballSha512Hex: DIGEST })).toMatchObject({ ok: false });
  });
});

describe('only what is inside the verified bundle is read (a registry or mirror can add fields next to it)', () => {
  const att = JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/auto-update/attestations-pcircle-memesh-4.12.0.json'), 'utf8')) as { attestations: Array<{ bundle: unknown; predicateType: string }> };
  const realDigest = '8c77bebe2b2533a33ddbc25d45be8e2fd5af7b4d17bc31e8399d65a43eb436d842e3ab488dc4195c975b961983f1a7d227bd3d9c25c1b47734ff4234f9098ee1';
  const FORGED_COMMIT = 'a'.repeat(40);
  const forged = () => statement({}, '4.12.0', 'ef'.repeat(64), FORGED_COMMIT) as { bundle: { dsseEnvelope: unknown } };
  const withForgedOuter = () => att.attestations.map((a) => ({ ...a, dsseEnvelope: forged().bundle.dsseEnvelope }));

  it('a statement placed next to the real bundle is not read: the verdict comes from the bundle, with its own commit and digest', () => {
    const json = audit([{ name: '@pcircle/memesh', version: '4.12.0', attestationBundles: withForgedOuter() }]);
    const verdict = judgeAuditSignatures(json, '@pcircle/memesh', '4.12.0', { tarballSha512Hex: realDigest });
    expect(verdict).toMatchObject({ ok: true });
    expect((verdict as { gitCommit: string }).gitCommit).not.toBe(FORGED_COMMIT);
    // The forged statement names another tarball: it is not accepted for that one either.
    expect(judgeAuditSignatures(json, '@pcircle/memesh', '4.12.0', { tarballSha512Hex: 'ef'.repeat(64) })).toMatchObject({ ok: false, reason: expect.stringContaining('digest') });
  });

  it('an attestation that has a statement and a certificate-less shell but no bundle of its own is no evidence', () => {
    const outerOnly = [{ predicateType: 'https://slsa.dev/provenance/v1', dsseEnvelope: forged().bundle.dsseEnvelope, verificationMaterial: { certificate: { rawBytes: 'AAAA' } } }];
    const json = audit([{ name: '@pcircle/memesh', version: '4.12.0', attestationBundles: outerOnly }]);
    expect(judgeAuditSignatures(json, '@pcircle/memesh', '4.12.0', { tarballSha512Hex: 'ef'.repeat(64), signerOf: () => signer() })).toMatchObject({ ok: false, reason: 'no provenance statement for this version' });
    expect(signerIdentity(outerOnly[0])).toBeNull();
  });

  it('a certificate placed next to the real bundle is not read for the signer either', () => {
    const real = att.attestations.find((a) => a.predicateType === 'https://slsa.dev/provenance/v1') as { bundle: { verificationMaterial: unknown } };
    const tampered = { ...real, verificationMaterial: { certificate: { rawBytes: 'not a certificate' } } };
    expect(signerIdentity(tampered)).toBe(signer('4.12.0'));
  });
});

describe('the pre-update backup rotation', () => {
  it('keeps the newest backups when the version crosses a digit (4.9.x → 4.10.x sorts the other way by name)', () => {
    const d = tmp();
    const dbPath = path.join(d, 'knowledge-graph.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE t (v TEXT)');
    db.close();
    const backupDir = path.join(d, 'backups');
    fs.mkdirSync(backupDir);
    // Three older backups taken on 4.9.x, oldest first by time.
    ['4.9.7', '4.9.8', '4.9.9'].forEach((v, i) => {
      const f = path.join(backupDir, `pre-update-${v}-2026-10-0${i + 1}.db`);
      fs.writeFileSync(f, 'old');
      const t = new Date(Date.UTC(2026, 9, i + 1));
      fs.utimesSync(f, t, t);
    });
    const made = backupDatabase(dbPath, backupDir, '4.10.0', new Date())!;
    const left = fs.readdirSync(backupDir);
    expect(left).toHaveLength(BACKUPS_KEPT);
    expect(left).toContain(path.basename(made));
    expect(left).not.toContain('pre-update-4.9.7-2026-10-01.db');
  });
});

describe('runAutoUpdate re-reads what it was told, after it waited', () => {
  it('does not install when the owner turned updates off during the wait', async () => {
    const w = fakeWorld();
    registerLiveHost(w.a.dir, process.pid);
    w.deps.sleep = async () => {
      fs.writeFileSync(path.join(w.a.dir, 'config.json'), '{"autoUpdate":"off"}');
      fs.rmSync(path.join(w.a.dir, 'live-hosts'), { recursive: true });
    };
    const result = await runAutoUpdate(w.deps);
    expect(result).toMatchObject({ outcome: 'skipped', reason: AUTO_UPDATE_REASONS.policyOff });
    expect(w.calls.some((c) => c.startsWith('npm install -g'))).toBe(false);
  });

  it('does not touch a Codex marketplace the owner pointed somewhere else during the wait', async () => {
    const w = fakeWorld({ channel: 'plugin-marketplace', pluginHost: 'codex' });
    registerLiveHost(w.a.dir, process.pid);
    w.deps.sleep = async () => {
      fs.writeFileSync(path.join(w.deps.codexHome!, 'config.toml'), '[marketplaces.pcircle-memesh]\nsource_type = "local"\nsource = "/home/me/dev/memesh"\n');
      fs.rmSync(path.join(w.a.dir, 'live-hosts'), { recursive: true });
    };
    const result = await runAutoUpdate(w.deps);
    expect(result).toMatchObject({ outcome: 'skipped', reason: AUTO_UPDATE_REASONS.codexMarketplaceForeign });
    expect(w.calls.some((c) => c.startsWith('codex'))).toBe(false);
  });

  it('reads the config directory that differs from the database directory, at every check', async () => {
    const w = fakeWorld();
    const other = tmp();
    fs.writeFileSync(path.join(other, 'config.json'), '{"autoUpdate":"off"}');
    w.deps.configDir = other;
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'skipped', reason: AUTO_UPDATE_REASONS.policyOff });
    expect(w.calls).toEqual([]);
  });

  it('does not apply the default inside CI, and records why', async () => {
    const w = fakeWorld({ env: { CI: 'true' } });
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'skipped', reason: AUTO_UPDATE_REASONS.policyOffCi });
    expect(readAutoUpdateState(w.a.dir)).toMatchObject({ reason: AUTO_UPDATE_REASONS.policyOffCi });
    expect(w.calls).toEqual([]);
  });
});

describe('the Codex steps, hardened', () => {
  it('runs codex with the CODEX_HOME that was checked, not whatever HOME implies', async () => {
    const w = fakeWorld({ channel: 'plugin-marketplace', pluginHost: 'codex' });
    const seen: Array<string | undefined> = [];
    const realExec = w.deps.exec;
    w.deps.exec = (cmd, args, opts) => {
      if (cmd === 'codex') seen.push(opts?.env?.CODEX_HOME);
      return realExec(cmd, args, opts);
    };
    await runAutoUpdate(w.deps);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([w.deps.codexHome]));
  });

  it('reports a restore that failed, in the state file, instead of saying the marketplace was put back', async () => {
    const w = fakeWorld({ channel: 'plugin-marketplace', pluginHost: 'codex' });
    const realExec = w.deps.exec;
    let adds = 0;
    w.deps.exec = (cmd, args, opts) => {
      if (cmd === 'codex' && args[1] === 'marketplace' && args[2] === 'add') {
        adds += 1;
        return { status: 1, stdout: '', stderr: adds === 1 ? 'no such ref' : 'network down' }; // the pinned add fails, and so does the restore
      }
      return realExec(cmd, args, opts);
    };
    const result = await runAutoUpdate(w.deps);
    expect(result).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.codexRestoreFailed });
    expect(readAutoUpdateState(w.a.dir)).toMatchObject({ reason: AUTO_UPDATE_REASONS.codexRestoreFailed });
  });

  it('does NOT put a marketplace back that is not in config.toml: whoever removed it did that on purpose, and the reason says how to add it again', async () => {
    const w = fakeWorld({ channel: 'plugin-marketplace', pluginHost: 'codex', codexConfig: 'model = "mine"\n' });
    expect(codexMarketplaceState(w.deps.codexHome!)).toBe('missing');
    const result = await runAutoUpdate(w.deps);
    expect(result).toMatchObject({ outcome: 'skipped', reason: AUTO_UPDATE_REASONS.codexMarketplaceMissing });
    expect(w.calls.filter((c) => c.startsWith('codex'))).toEqual([]);
    expect(result.reason).toContain('memesh update --reinstall');
  });
});

describe('what is checked between "verified" and "installed"', () => {
  it('does not install when the lockfile integrity is not the integrity of the tarball', async () => {
    const w = fakeWorld({ lockIntegrity: 'sha512-AAAA' });
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.tarballMismatch });
    expect(w.calls.some((c) => c.startsWith('npm install -g'))).toBe(false);
  });

  it('does not install when the attested digest is not the digest of the tarball that was downloaded', async () => {
    const w = fakeWorld({ attestedDigest: 'deadbeef'.repeat(16) });
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.sourceNotVerified });
    expect(w.calls.some((c) => c.startsWith('npm install -g'))).toBe(false);
  });

  it('hashes the tarball again right before it installs it: a file swapped after the check is not installed', async () => {
    const w = fakeWorld();
    w.deps.beforeInstall = (tarball) => fs.appendFileSync(tarball, 'tampered after the check');
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.tarballChanged });
    expect(w.calls.some((c) => c.startsWith('npm install -g'))).toBe(false);
  });

  it('verifies again after a wait: a version that no longer verifies is not installed', async () => {
    const w = fakeWorld({ verifiedSequence: [true, false] });
    registerLiveHost(w.a.dir, process.pid);
    w.deps.sleep = async () => { fs.rmSync(path.join(w.a.dir, 'live-hosts'), { recursive: true }); };
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.sourceNotVerified });
    expect(w.calls.some((c) => c.startsWith('npm install -g'))).toBe(false);
  });

  it('reads the installed version back after the install, and fails when it is not the target', async () => {
    const w = fakeWorld();
    w.deps.readInstalledVersion = () => '4.13.0-rc.1';
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.readbackFailed });
  });

  it('does not take 4.13.0-rc.1 for 4.13.0 when Codex says what it installed', async () => {
    const w = fakeWorld({ channel: 'plugin-marketplace', pluginHost: 'codex' });
    const realExec = w.deps.exec;
    w.deps.exec = (cmd, args, opts) => (cmd === 'codex' && args[1] === 'add'
      ? { status: 0, stdout: 'Installed plugin root: /x/plugins/cache/pcircle-memesh/memesh/4.13.0-rc.1\n', stderr: '' }
      : realExec(cmd, args, opts));
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.codexReadbackFailed });
  });
});

describe('the wait, when the clock or the filesystem misbehaves', () => {
  it('a recorded start in the future is not obeyed: the 3 days count from now, not from 30 days ahead', async () => {
    const w = fakeWorld();
    registerLiveHost(w.a.dir, process.pid);
    const t0 = Date.parse('2026-11-08T00:00:00Z');
    let clock = t0;
    w.deps.now = () => new Date(clock);
    const recordedStarts: Array<string | null | undefined> = [];
    w.deps.sleep = async (ms) => { recordedStarts.push(readAutoUpdateState(w.a.dir)?.waitingSince); clock += ms; };
    fs.writeFileSync(path.join(w.a.dir, 'auto-update-wait.json'), JSON.stringify({ target: '4.13.0', since: new Date(t0 + 30 * 86_400_000).toISOString() }));
    const result = await runAutoUpdate(w.deps);
    // What doctor shows as "waiting since" is now, not 30 days ahead.
    expect(recordedStarts[0]).toBe(new Date(t0).toISOString());
    expect(result).toMatchObject({ outcome: 'installed', reason: AUTO_UPDATE_REASONS.installedAfterWait });
    const waitedDays = (clock - t0) / 86_400_000;
    expect(waitedDays).toBeGreaterThanOrEqual(3);
    expect(waitedDays).toBeLessThan(3.1);
    expect(fs.readFileSync(path.join(w.a.dir, 'auto-update.log'), 'utf8')).toContain('is in the future');
  });

  it('a clock that keeps moving back cannot stretch the wait: the time actually spent waiting counts too', async () => {
    const w = fakeWorld();
    registerLiveHost(w.a.dir, process.pid);
    let clock = Date.parse('2026-11-08T00:00:00Z');
    w.deps.now = () => new Date(clock);
    w.deps.sleep = async () => { clock -= 1000; };
    const result = await runAutoUpdate(w.deps);
    expect(result).toMatchObject({ outcome: 'installed', reason: AUTO_UPDATE_REASONS.installedAfterWait });
  });

  it('calls the heartbeat on every poll, so a lock file can show its owner is alive', async () => {
    const w = fakeWorld();
    registerLiveHost(w.a.dir, process.pid);
    let beats = 0;
    w.deps.heartbeat = () => { beats += 1; };
    let polls = 0;
    w.deps.sleep = async () => { polls += 1; if (polls === 4) fs.rmSync(path.join(w.a.dir, 'live-hosts'), { recursive: true }); };
    await runAutoUpdate(w.deps);
    expect(beats).toBe(5); // once per poll of the wait, and once more right before the install
  });

  it('a live-hosts directory that cannot be read is "unknown", not "nobody is running": it waits, and says so', async () => {
    const d = tmp();
    expect(liveHostPids(d)).toEqual([]); // no directory at all: no host ever registered
    fs.writeFileSync(path.join(d, 'live-hosts'), 'a file where the directory should be');
    expect(liveHostPids(d)).toBeNull();
    const w = fakeWorld();
    fs.writeFileSync(path.join(w.a.dir, 'live-hosts'), 'a file where the directory should be');
    let clock = Date.parse('2026-11-08T00:00:00Z');
    w.deps.now = () => new Date(clock);
    let polls = 0;
    w.deps.sleep = async (ms) => { polls += 1; clock += ms; };
    const result = await runAutoUpdate(w.deps);
    expect(polls).toBeGreaterThan(1000); // it did wait (the 3-day cap, polled), instead of swapping at once
    expect(result).toMatchObject({ outcome: 'installed', reason: AUTO_UPDATE_REASONS.installedAfterWait });
    expect(fs.readFileSync(path.join(w.a.dir, 'auto-update.log'), 'utf8')).toContain('cannot be listed');
  });
});

describe('the Hermes provider is taken out of a tarball without trusting it', () => {
  const dirLine = 'drwxr-xr-x  0 0  0  0 Nov  8 00:00 package/extensions/hermes-memesh/';
  const fileLine = (n: string) => `-rw-r--r--  0 0  0  28 Nov  8 00:00 ${n}`;
  const P = 'package/extensions/hermes-memesh/';

  it('accepts plain files and directories under the provider directory, whatever the language the verbose listing is printed in', () => {
    const names = [P, `${P}__init__.py`, `${P}plugin.yaml`];
    expect(unsafeTarEntries([dirLine, fileLine(names[1]), fileLine(names[2])].join('\n'), names)).toEqual([]);
    // The date column is not read at all: Chinese, German and French months must not matter.
    const zh = ['drwxr-xr-x  0 0  0  0 11月  8 02:59 ' + P, '-rw-r--r--  0 0  0  28 11月  8 02:59 ' + names[1], '-rw-r--r--  0 0  0  13 11月  8 02:59 ' + names[2]];
    expect(unsafeTarEntries(zh.join('\n'), names)).toEqual([]);
    const de = ['-rw-r--r--  0 0  0  28 8 Nov. 02:59 ' + names[1]];
    expect(unsafeTarEntries(de.join('\n'), [names[1]])).toEqual([]);
  });

  it.each([
    ['a symlink', 'l', `${P}link`],
    ['a hardlink', 'h', `${P}hard`],
    ['a device', 'c', `${P}dev`],
    ['a path that climbs out', '-', `${P}../../../escape.txt`],
    ['an absolute path', '-', '/etc/cron.d/evil'],
    ['a file outside the provider directory', '-', 'package/dist/core/paths.js'],
  ])('refuses %s', (_label, type, name) => {
    const names = [`${P}__init__.py`, name];
    const verbose = [fileLine(names[0]), `${type}rw-r--r--  0 0  0  0 Nov  8 00:00 ${name}`].join('\n');
    expect(unsafeTarEntries(verbose, names).length).toBeGreaterThan(0);
  });

  it('trusts nothing when the two listings do not line up (an entry name with a newline, a tar that prints extra lines)', () => {
    const names = [`${P}a.py`, `${P}b.py`];
    const out = unsafeTarEntries([fileLine(names[0]), fileLine(names[1]), fileLine('extra')].join('\n'), names);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('do not line up');
  });

  /** A real .tgz built with the system tar, from entries the test lays out. */
  function tgz(layout: (root: string) => string[]): { tarball: string; root: string } {
    const root = tmp();
    const names = layout(root);
    const tarball = path.join(tmp(), 'pkg.tgz');
    const r = spawnSync('tar', ['-czPf', tarball, ...names], { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`tar: ${r.stderr}`);
    return { tarball, root };
  }
  const provider = (root: string) => {
    const dir = path.join(root, 'package', 'extensions', 'hermes-memesh');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '__init__.py'), '# provider from the tarball\n');
    fs.writeFileSync(path.join(dir, 'plugin.yaml'), 'name: memesh\n');
    return dir;
  };

  /** deps with the real tar, a managed copy at the default location, and its untouched content. */
  function withManagedCopy() {
    const hermesHome = tmp();
    const w = fakeWorld({ env: { HERMES_HOME: hermesHome } });
    w.deps.exec = (cmd, args, opts) => {
      const r = spawnSync(cmd, args, { cwd: opts?.cwd, encoding: 'utf8' });
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    const old = tmp();
    fs.writeFileSync(path.join(old, '__init__.py'), '# the old provider\n');
    const target = defaultInstallTarget({ HERMES_HOME: hermesHome } as NodeJS.ProcessEnv);
    installProvider({ sourceDir: old, target, version: '4.12.0', force: false, backupRoot: path.join(w.a.dir, 'backups'), now: new Date() });
    return { w, target };
  }
  const read = (target: string) => fs.readFileSync(path.join(target, '__init__.py'), 'utf8');

  it('extracts and installs a clean tarball with the real tar (control: the refusals below are not just a broken harness)', () => {
    const { w, target } = withManagedCopy();
    const { tarball } = tgz((root) => { provider(root); return ['package/extensions/hermes-memesh']; });
    const results = refreshHermes(w.deps, tarball, '4.13.0', sha512Integrity(tarball));
    expect(results).toMatchObject([{ outcome: 'refreshed' }]);
    expect(read(target)).toBe('# provider from the tarball\n');
  });

  it.each([
    ['a symlink next to the provider files', (root: string) => { const d = provider(root); fs.symlinkSync('/etc/hosts', path.join(d, 'hosts-link')); return ['package/extensions/hermes-memesh']; }],
    ['a hardlink to a file outside the provider directory', (root: string) => { const d = provider(root); fs.writeFileSync(path.join(root, 'package', 'package.json'), '{}'); fs.linkSync(path.join(root, 'package', 'package.json'), path.join(d, 'hard.json')); return ['package/package.json', 'package/extensions/hermes-memesh']; }],
    ['a path that climbs out of the extraction directory', (root: string) => { provider(root); fs.writeFileSync(path.join(root, 'escape.txt'), 'x'); return ['package/extensions/hermes-memesh', 'package/extensions/hermes-memesh/../../../escape.txt']; }],
  ])('refuses a tarball with %s, writes nothing from it, and leaves the installed copy as it was', (_label, layout) => {
    const { w, target } = withManagedCopy();
    const before = fs.readdirSync(w.deps.tmpRoot).sort();
    const { tarball } = tgz(layout);
    const results = refreshHermes(w.deps, tarball, '4.13.0', sha512Integrity(tarball));
    expect(results).toMatchObject([{ outcome: 'failed', reason: expect.stringContaining('refused') }]);
    expect(read(target)).toBe('# the old provider\n');
    expect(fs.existsSync(path.join(w.deps.tmpRoot, 'escape.txt'))).toBe(false);
    // The working directory it used is gone again.
    expect(fs.readdirSync(w.deps.tmpRoot).filter((n) => n.startsWith('memesh-hermes-')).sort()).toEqual(before.filter((n) => n.startsWith('memesh-hermes-')));
  });

  it('refuses a tarball that is no longer the one that was verified', () => {
    const { w, target } = withManagedCopy();
    const { tarball } = tgz((root) => { provider(root); return ['package/extensions/hermes-memesh']; });
    const verified = sha512Integrity(tarball);
    fs.appendFileSync(tarball, 'extra');
    const results = refreshHermes(w.deps, tarball, '4.13.0', verified);
    expect(results).toMatchObject([{ outcome: 'failed', reason: AUTO_UPDATE_REASONS.tarballChanged }]);
    expect(read(target)).toBe('# the old provider\n');
  });
});

describe('dispatch (what starts the runner)', () => {
  function fakePlugin(): string {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'scripts', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'hooks', 'auto-update-runner.mjs'), 'process.exit(0);\n');
    return root;
  }
  const withMemeshDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
    const dir = tmp();
    const saved = { MEMESH_DIR: process.env.MEMESH_DIR, MEMESH_DB_PATH: process.env.MEMESH_DB_PATH };
    process.env.MEMESH_DIR = dir;
    delete process.env.MEMESH_DB_PATH;
    try { return await fn(dir); } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };

  const CAN = { canSelfUpdate: () => ({ ok: true, label: 'test install' }) };

  it('starts the runner at most once per interval, and says how long ago the last attempt was', async () => {
    await withMemeshDir(async (dir) => {
      const root = fakePlugin();
      expect(await dispatchAutoUpdate(root, 1_000_000, CAN)).toEqual({ state: 'dispatched' });
      expect(await dispatchAutoUpdate(root, 1_000_000 + 60_000, CAN)).toEqual({ state: 'throttled' });
      expect(fs.readFileSync(path.join(dir, 'auto-update.log'), 'utf8')).toMatch(/THROTTLED: the last attempt was 1 minute\(s\) ago/);
    });
  });

  it('a start that is being decided by another session right now is not a second start, and a claim left by a dead process is taken over', async () => {
    await withMemeshDir(async (dir) => {
      const root = fakePlugin();
      const claim = path.join(dir, DISPATCH_CLAIM);
      fs.mkdirSync(claim);
      expect(await dispatchAutoUpdate(root, Date.now(), CAN)).toEqual({ state: 'throttled' });
      expect(fs.readFileSync(path.join(dir, 'auto-update.log'), 'utf8')).toContain('another session is deciding');
      expect(fs.existsSync(path.join(dir, 'auto-update-attempt'))).toBe(false); // nothing was started
      expect(fs.existsSync(claim)).toBe(true);                                   // and the other session's claim was not removed
      const old = new Date(Date.now() - 10 * 60_000);
      fs.utimesSync(claim, old, old);
      expect(await dispatchAutoUpdate(root, Date.now(), CAN)).toEqual({ state: 'dispatched' });
      expect(fs.existsSync(claim)).toBe(false); // released when it is done
    });
  });

  it('two starts in the same moment (nothing awaited between their first lines): exactly one runner is started', async () => {
    await withMemeshDir(async (dir) => {
      const root = fakePlugin();
      const now = Date.now();
      // Both run their synchronous first part before either has awaited anything: without one atomic claim both would find no
      // earlier attempt and both would spawn.
      const results = await Promise.all([dispatchAutoUpdate(root, now, CAN), dispatchAutoUpdate(root, now, CAN)]);
      expect(results.map((r) => r.state).sort()).toEqual(['dispatched', 'throttled']);
      expect((fs.readFileSync(path.join(dir, 'auto-update.log'), 'utf8').match(/auto-update DISPATCHED/g) ?? [])).toHaveLength(1);
      expect(fs.existsSync(path.join(dir, DISPATCH_CLAIM))).toBe(false);
    });
  });

  it('an attempt time in the future does not suppress the attempt, and the log says it was ignored', async () => {
    await withMemeshDir(async (dir) => {
      const root = fakePlugin();
      fs.writeFileSync(path.join(dir, 'auto-update-attempt'), String(Date.now() + 40 * 86_400_000));
      expect(await dispatchAutoUpdate(root, Date.now(), CAN)).toEqual({ state: 'dispatched' });
      expect(fs.readFileSync(path.join(dir, 'auto-update.log'), 'utf8')).toContain('is in the future');
    });
  });

  it('says so when the runner is missing, and when the log cannot be opened', async () => {
    await withMemeshDir(async (dir) => {
      expect(await dispatchAutoUpdate(tmp(), Date.now(), CAN)).toEqual({ state: 'failed' });
      expect(fs.readFileSync(path.join(dir, 'auto-update.log'), 'utf8')).toContain('runner missing');
    });
    const file = path.join(tmp(), 'not-a-directory');
    fs.writeFileSync(file, 'x');
    const saved = process.env.MEMESH_DIR;
    process.env.MEMESH_DIR = file;
    try { expect(await dispatchAutoUpdate(fakePlugin(), Date.now(), CAN)).toEqual({ state: 'failed' }); } finally {
      if (saved === undefined) delete process.env.MEMESH_DIR; else process.env.MEMESH_DIR = saved;
    }
  });

  it('writes a line another module can add to the same log', () => {
    const d = tmp();
    logAutoUpdateLine(d, 'auto-update: a line from elsewhere');
    expect(fs.readFileSync(path.join(d, 'auto-update.log'), 'utf8')).toContain('a line from elsewhere');
  });
});

describe('memesh update (manual): the same verified path, without the policy or the wait', () => {
  it('installs although updates are off and a session is running, and still verifies and backs up first', async () => {
    const w = fakeWorld({ config: { autoUpdate: 'off' }, withDb: true });
    registerLiveHost(w.a.dir, process.pid);
    w.deps.manual = true;
    const result = await runAutoUpdate(w.deps);
    // "installed", not "installed after waiting 3 days": it did not wait.
    expect(result).toMatchObject({ outcome: 'installed', reason: AUTO_UPDATE_REASONS.installed });
    expect(w.calls.some((c) => c.startsWith('npm audit signatures'))).toBe(true);
    expect(w.calls.some((c) => c.startsWith('npm install -g'))).toBe(true);
    expect(readAutoUpdateState(w.a.dir)?.backup).toBeTruthy();
  });

  it('still refuses what cannot be verified', async () => {
    const w = fakeWorld({ config: { autoUpdate: 'off' }, verified: false });
    w.deps.manual = true;
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.sourceNotVerified });
    expect(w.calls.some((c) => c.startsWith('npm install -g'))).toBe(false);
  });

  it('without manual, the same setup does not install (control)', async () => {
    const w = fakeWorld({ config: { autoUpdate: 'off' } });
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'skipped' });
  });

  function stubRunner(body: string): string {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'scripts', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'hooks', 'auto-update-runner.mjs'), body);
    return root;
  }
  // The stub records a result only when it is called with the flag it is for, as the real runner only acts on the flag it is given.
  const stateWriter = (state: Record<string, unknown>, flag = '--manual') => `
    import fs from 'node:fs'; import path from 'node:path';
    if (process.argv[3] !== ${JSON.stringify(flag)}) process.exit(9);
    fs.writeFileSync(path.join(path.dirname(process.argv[2]), 'auto-update-state.json'), JSON.stringify({ at: new Date().toISOString(), hermes: null, channel: null, backup: '/b/x.db', waitingSince: null, from: '4.12.0', to: '4.13.0', ...${JSON.stringify(state)} }));
  `;

  it('runs the runner in the foreground with --manual and reports an install', () => {
    const dir = tmp();
    const out = runManualUpdate(stubRunner(stateWriter({ outcome: 'installed', reason: 'installed' })), dir);
    expect(out.code).toBe(0);
    expect(out.lines.join('\n')).toContain('4.12.0 → 4.13.0');
  });

  it('reports a refusal as a failure with its reason, and "already current" as success', () => {
    const refused = runManualUpdate(stubRunner(stateWriter({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.sourceNotVerified })), tmp());
    expect(refused.code).toBe(1);
    expect(refused.lines.join('\n')).toContain(AUTO_UPDATE_REASONS.sourceNotVerified);
    const current = runManualUpdate(stubRunner(stateWriter({ outcome: 'skipped', reason: AUTO_UPDATE_REASONS.upToDate })), tmp());
    expect(current.code).toBe(0);
  });

  it('says so when no new record was written (the runner could not start)', () => {
    const out = runManualUpdate(stubRunner('process.exit(0);'), tmp());
    expect(out.code).toBe(1);
    expect(out.lines.join('\n')).toContain('No update was made');
    expect(runManualUpdate(tmp(), tmp()).code).toBe(1);
  });

  it('calls the runner with --manual, and with --reinstall only when asked (the stub answers to one flag only)', () => {
    const manualOnly = stubRunner(stateWriter({ outcome: 'installed', reason: 'installed' }, '--manual'));
    expect(runManualUpdate(manualOnly, tmp()).code).toBe(0);
    expect(runManualUpdate(manualOnly, tmp(), { reinstall: true }).code).toBe(1);
    const reinstallOnly = stubRunner(stateWriter({ outcome: 'installed', reason: 'installed', from: '4.13.0', to: '4.13.0' }, '--reinstall'));
    const out = runManualUpdate(reinstallOnly, tmp(), { reinstall: true });
    expect(out.code).toBe(0);
    expect(out.lines.join('\n')).toContain('Reinstalled 4.13.0');
    expect(runManualUpdate(reinstallOnly, tmp()).code).toBe(1);
  });

  it.each([
    [AUTO_UPDATE_REASONS.commitNotOnMain, 'still on 4.12.0', 'Nothing was installed'],
    [AUTO_UPDATE_REASONS.sourceNotVerified, 'still on 4.12.0', 'Nothing was installed'],
    [AUTO_UPDATE_REASONS.dependenciesNotFetched, 'still on 4.12.0', 'Nothing was installed'],
    [AUTO_UPDATE_REASONS.dependencyPinFailed, 'still on 4.12.0', 'Nothing was changed: the install was undone and 4.12.0 is still what runs'],
    [AUTO_UPDATE_REASONS.installNotUndone, null, 'some files may be new'],
    [AUTO_UPDATE_REASONS.installFailed, null, 'some files may be new'],
  ])('a failed update tells the truth about this machine in its first line and its second: %s', (reason, still, effect) => {
    const out = runManualUpdate(stubRunner(stateWriter({ outcome: 'failed', reason })), tmp());
    expect(out.code).toBe(1);
    const [first] = out.lines;
    expect(first).toContain(reason);
    if (still) expect(first).toContain(still);                       // the old version is named where it is known to be what runs
    else expect(first).not.toContain('still on');                    // and not claimed where an install step ran
    expect(out.lines.join('\n')).toContain(effect);
  });

  it('an old record is not mistaken for a new one: a runner that records nothing is a failure whatever the file says', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'auto-update-state.json'), JSON.stringify({ at: '2020-01-01T00:00:00.000Z', outcome: 'installed', reason: 'installed', from: '1.0.0', to: '1.1.0', hermes: null, backup: null, channel: null, waitingSince: null }));
    const out = runManualUpdate(stubRunner('process.exit(0);'), dir);
    expect(out.code).toBe(1);
    expect(out.lines.join('\n')).toContain('without recording a result');
    expect(out.lines.join('\n')).not.toContain('1.1.0');
  });

  it('names who holds the update lock, since when, and what a waiting automatic update is waiting for', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'auto-update.lock'), `token\n${process.pid}\n${Date.parse('2026-11-08T01:02:03.000Z')}\nauto\n`);
    fs.writeFileSync(path.join(dir, 'auto-update-state.json'), JSON.stringify({ at: '2020-01-01T00:00:00.000Z', outcome: 'waiting', reason: 'waiting', from: '4.12.0', to: '4.13.0', hermes: null, backup: null, channel: null, waitingSince: '2026-11-07T00:00:00.000Z' }));
    const out = runManualUpdate(stubRunner('process.exit(1);'), dir);
    const text = out.lines.join('\n');
    expect(out.code).toBe(1);
    expect(text).toContain('an automatic update is already running');
    expect(text).toContain('2026-11-08T01:02:03.000Z');
    expect(text).toContain(`pid ${process.pid}`);
    expect(text).toContain('waiting for running sessions to end');
    expect(text).toContain('at most 3 days');
  });

  it('a lock whose owner is gone is not "already running"', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'auto-update.lock'), `token\n2147483000\n${Date.now()}\nmanual\n`);
    const out = runManualUpdate(stubRunner('process.exit(1);'), dir);
    expect(out.lines.join('\n')).not.toContain('already running');
    expect(out.lines.join('\n')).toContain('without recording a result');
  });

  it('a runner killed by a signal is reported as interrupted, and an install that had begun says how to put the version back', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'auto-update-installing.json'), JSON.stringify({ at: '2026-11-08T00:00:00.000Z', from: '4.12.0', to: '4.13.0', pid: 2_147_483_000, started: null }));
    const killed = runManualUpdate(stubRunner("process.kill(process.pid, 'SIGKILL');"), dir);
    const text = killed.lines.join('\n');
    expect(killed.code).toBe(1);
    expect(text).toContain('interrupted');
    expect(text).toContain('SIGKILL');
    expect(text).toContain('some files may already be new');
    expect(text).toContain('memesh update --reinstall');
    const early = runManualUpdate(stubRunner("process.kill(process.pid, 'SIGKILL');"), tmp());
    expect(early.lines.join('\n')).toContain('Nothing had been installed yet');
  });

  it('a record that cannot be read after a runner that exited 0 is not reported as "another update running"', () => {
    const dir = tmp();
    const bad = stubRunner("import fs from 'node:fs'; import path from 'node:path'; fs.writeFileSync(path.join(path.dirname(process.argv[2]), 'auto-update-state.json'), '{ not json');");
    const out = runManualUpdate(bad, dir);
    expect(out.code).toBe(1);
    expect(out.lines.join('\n')).toContain('its record cannot be read');
    expect(out.lines.join('\n')).not.toContain('already running');
  });

  it('a failure after the install began says so, names the backup and the log, and shows the reason in detail (the log is under the data directory it was given)', () => {
    const dir = tmp();
    const out = runManualUpdate(stubRunner(stateWriter({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.readbackFailed, detail: 'npm error EACCES', backup: '/b/pre-update.db' })), dir);
    const text = out.lines.join('\n');
    expect(out.code).toBe(1);
    expect(text).toContain('An install step had already run');
    expect(text).toContain('memesh update --reinstall');
    expect(text).toContain('/b/pre-update.db');
    expect(text).toContain('npm error EACCES');
    expect(text).toContain(path.join(dir, 'auto-update.log'));
    expect(text).not.toContain('~/.memesh');
    expect(text).not.toContain('Nothing was changed unless');
  });

  it('a failure before anything was installed says nothing was installed', () => {
    const out = runManualUpdate(stubRunner(stateWriter({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.sourceNotVerified, backup: null })), tmp());
    const text = out.lines.join('\n');
    expect(text).toContain('Nothing was installed.');
    expect(text).not.toContain('install step had already run');
  });

  it('every reason raised after an install step ran is on the list that says so', () => {
    for (const reason of [AUTO_UPDATE_REASONS.installFailed, AUTO_UPDATE_REASONS.readbackFailed, AUTO_UPDATE_REASONS.codexReadbackFailed, AUTO_UPDATE_REASONS.claudeReadbackFailed, AUTO_UPDATE_REASONS.installNotUndone, AUTO_UPDATE_REASONS.codexInstallFailed, AUTO_UPDATE_REASONS.codexRestoreFailed]) {
      const out = runManualUpdate(stubRunner(stateWriter({ outcome: 'failed', reason })), tmp());
      expect(out.lines.join('\n'), reason).toContain('An install step had already run');
    }
    for (const reason of [AUTO_UPDATE_REASONS.dependencyPinFailed, AUTO_UPDATE_REASONS.dependenciesNotFetched, AUTO_UPDATE_REASONS.globalDirUnknown, AUTO_UPDATE_REASONS.rollbackUnavailable, AUTO_UPDATE_REASONS.sourceNotVerified, AUTO_UPDATE_REASONS.commitNotOnMain, AUTO_UPDATE_REASONS.commitUnconfirmed, AUTO_UPDATE_REASONS.dependenciesNotPinned, AUTO_UPDATE_REASONS.backupFailed, AUTO_UPDATE_REASONS.codexRemoveFailed, AUTO_UPDATE_REASONS.tarballChanged]) {
      const out = runManualUpdate(stubRunner(stateWriter({ outcome: 'failed', reason })), tmp());
      expect(out.lines.join('\n'), reason).toMatch(reason === AUTO_UPDATE_REASONS.dependencyPinFailed ? /Nothing was changed/ : /Nothing was installed\./);
    }
  });

  it('does not print the runner\'s own raw line: what is shown is read from its record', () => {
    const body = "console.log('[memesh auto-update] SKIPPED raw-runner-line'); console.error('[memesh auto-update] FAILED raw-runner-error');\n" + stateWriter({ outcome: 'skipped', reason: AUTO_UPDATE_REASONS.upToDate });
    const lines: string[] = [];
    const log = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write);
    let out: { code: number; lines: string[] };
    try { out = runManualUpdate(stubRunner(body), tmp()); } finally { log.mockRestore(); }
    expect(lines.join('')).not.toContain('raw-runner-line');
    expect(out.lines.join('\n')).not.toContain('raw-runner');
    expect(out.code).toBe(0);
  });
});

describe('the record of the last attempt is read as absent, unreadable or fine', () => {
  const stateFile = (d: string) => path.join(d, 'auto-update-state.json');

  it('absent: no file', () => {
    expect(inspectAutoUpdateState(tmp())).toEqual({ kind: 'absent' });
  });

  it('ok: a well-formed record', () => {
    const d = tmp();
    fs.writeFileSync(stateFile(d), JSON.stringify({ at: 'x', outcome: 'skipped', reason: 'r' }));
    expect(inspectAutoUpdateState(d)).toMatchObject({ kind: 'ok', state: { outcome: 'skipped' } });
  });

  it.each([
    ['a null entry in the hermes list', JSON.stringify({ at: 'x', outcome: 'skipped', reason: 'r', hermes: [null] })],
    ['a hermes list that is not a list', JSON.stringify({ at: 'x', outcome: 'skipped', reason: 'r', hermes: 'oops' })],
    ['a hermes entry without a reason', JSON.stringify({ at: 'x', outcome: 'skipped', reason: 'r', hermes: [{ path: '/p', outcome: 'failed' }] })],
  ])('unreadable (and no crash for whoever reads it): %s', (_label, text) => {
    const d = tmp();
    fs.writeFileSync(stateFile(d), text);
    expect(inspectAutoUpdateState(d)).toMatchObject({ kind: 'unreadable', detail: expect.stringContaining('hermes') });
    expect(readAutoUpdateState(d)).toBeNull();
  });

  it('a well-formed hermes list, and no list at all, are fine', () => {
    const d = tmp();
    fs.writeFileSync(stateFile(d), JSON.stringify({ at: 'x', outcome: 'skipped', reason: 'r', hermes: [{ path: '/p', outcome: 'refreshed', reason: 'ok', backup: null }] }));
    expect(inspectAutoUpdateState(d).kind).toBe('ok');
    fs.writeFileSync(stateFile(d), JSON.stringify({ at: 'x', outcome: 'skipped', reason: 'r' }));
    expect(inspectAutoUpdateState(d).kind).toBe('ok');
  });

  it.each([
    ['not JSON', (f: string) => fs.writeFileSync(f, '{ not json')],
    ['JSON of the wrong shape', (f: string) => fs.writeFileSync(f, '[1,2,3]')],
    ['a directory where the file should be', (f: string) => fs.mkdirSync(f)],
    ['a dangling symlink', (f: string) => fs.symlinkSync(path.join(path.dirname(f), 'nowhere'), f)],
  ])('unreadable (never "absent"): %s', (_label, make) => {
    const d = tmp();
    make(stateFile(d));
    const read = inspectAutoUpdateState(d);
    expect(read.kind).toBe('unreadable');
    expect(readAutoUpdateState(d)).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')('what MeMesh writes under ~/.memesh stays owner-only, also where an older version or a person made it looser', () => {
  const mode = (f: string) => fs.statSync(f).mode & 0o777;

  /** A data directory as an older MeMesh (or a hand-made one) left it: everything readable by others. */
  function looseDir(): string {
    const dir = tmp();
    fs.chmodSync(dir, 0o755);
    for (const name of ['auto-update.log', 'auto-update-attempt', 'auto-update-state.json', 'auto-update-wait.json']) {
      fs.writeFileSync(path.join(dir, name), name === 'auto-update-attempt' ? '0' : '{}', { mode: 0o644 });
      fs.chmodSync(path.join(dir, name), 0o644);
    }
    fs.mkdirSync(path.join(dir, 'live-hosts'), { mode: 0o755 });
    fs.chmodSync(path.join(dir, 'live-hosts'), 0o755);
    return dir;
  }

  const root = typeof process.getuid === 'function' && process.getuid() === 0;

  it.skipIf(root)('a folder or file its owner made read-only stays read-only: only group and others are taken away, nothing is added (#520)', () => {
    const base = tmp();
    const dir = path.join(base, 'snapshot');
    fs.mkdirSync(dir);
    const file = path.join(dir, 'f');
    fs.writeFileSync(file, 'x');
    try {
      fs.chmodSync(file, 0o444);
      ownerOnly(file);
      expect(mode(file)).toBe(0o400);
      fs.chmodSync(dir, 0o555);
      ensureOwnerDir(dir);
      expect(mode(dir)).toBe(0o500);
      ownerOnly(dir);
      expect(mode(dir)).toBe(0o500);
    } finally { fs.chmodSync(dir, 0o700); }
  });

  it.skipIf(root)('what is written into a read-only data directory fails there, is said, and leaves the directory read-only', () => {
    const dir = tmp();
    fs.chmodSync(dir, 0o500);
    try {
      expect(() => registerLiveHost(dir, process.pid)).toThrow(/EACCES/);
      expect(() => logAutoUpdateLine(dir, 'a line')).not.toThrow();
      expect(mode(dir)).toBe(0o500);
      expect(fs.existsSync(path.join(dir, 'live-hosts'))).toBe(false);
    } finally { fs.chmodSync(dir, 0o700); }
  });

  it('ownerOnly and ensureOwnerDir tighten what already exists, and never throw', () => {
    const dir = tmp();
    const file = path.join(dir, 'f');
    fs.writeFileSync(file, 'x', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    ownerOnly(file);
    expect(mode(file)).toBe(0o600);
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub, { mode: 0o755 });
    fs.chmodSync(sub, 0o755);
    ensureOwnerDir(sub);
    expect(mode(sub)).toBe(0o700);
    expect(() => ownerOnly(path.join(dir, 'does-not-exist'))).not.toThrow();
  });

  it('the dispatch (the path memesh serve and the hooks both take) tightens the directory, the log and the attempt time', async () => {
    const dir = looseDir();
    const saved = { MEMESH_DIR: process.env.MEMESH_DIR, MEMESH_DB_PATH: process.env.MEMESH_DB_PATH };
    process.env.MEMESH_DIR = dir;
    delete process.env.MEMESH_DB_PATH;
    try {
      const root = tmp();
      fs.mkdirSync(path.join(root, 'scripts', 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(root, 'scripts', 'hooks', 'auto-update-runner.mjs'), 'process.exit(0);\n');
      expect(await dispatchAutoUpdate(root, Date.now(), { canSelfUpdate: () => ({ ok: true, label: 'test install' }) })).toEqual({ state: 'dispatched' });
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    expect(mode(dir)).toBe(0o700);
    expect(mode(path.join(dir, 'auto-update.log'))).toBe(0o600);
    expect(mode(path.join(dir, 'auto-update-attempt'))).toBe(0o600);
  });

  it('an attempt, a log line and a registered host tighten the state, the log, the wait record and the live-hosts directory', async () => {
    const w = fakeWorld({ withDb: true });
    const dir = looseDir();
    w.deps.dir = dir;
    w.deps.env = { MEMESH_AUTO_UPDATE: 'major' }; // another data directory than the account's own: the setting must be explicit
    w.deps.dbPath = path.join(dir, 'knowledge-graph.db');
    new DatabaseSync(w.deps.dbPath).close();
    registerLiveHost(dir, process.pid);
    expect(mode(path.join(dir, 'live-hosts'))).toBe(0o700);
    expect(mode(path.join(dir, 'live-hosts', `${process.pid}.json`))).toBe(0o600);
    w.deps.sleep = async () => { fs.rmSync(path.join(dir, 'live-hosts'), { recursive: true }); };
    await runAutoUpdate(w.deps);
    for (const name of ['auto-update.log', 'auto-update-state.json']) expect(mode(path.join(dir, name)), name).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
    logAutoUpdateLine(dir, 'one more line');
    expect(mode(path.join(dir, 'auto-update.log'))).toBe(0o600);
  });

  it('a wait record that was readable by others is tightened when it is written again', async () => {
    const w = fakeWorld({ withDb: true });
    const dir = looseDir();
    w.deps.dir = dir;
    w.deps.env = { MEMESH_AUTO_UPDATE: 'major' }; // another data directory than the account's own: the setting must be explicit
    w.deps.dbPath = path.join(dir, 'knowledge-graph.db');
    new DatabaseSync(w.deps.dbPath).close();
    registerLiveHost(dir, process.pid);
    let waitModeWhileWaiting = 0;
    w.deps.sleep = async () => {
      waitModeWhileWaiting = mode(path.join(dir, 'auto-update-wait.json'));
      fs.rmSync(path.join(dir, 'live-hosts'), { recursive: true });
    };
    await runAutoUpdate(w.deps);
    expect(waitModeWhileWaiting).toBe(0o600);
  });
});

// ─── what the second round of review found ─────────────────────────────────

/** A tarball with the shape of the real package: the provider is a few files among hundreds of others. */
function packageShapedTarball(providerBody = '# provider from the tarball\n'): string {
  const root = tmp();
  const pkg = path.join(root, 'package');
  for (const [rel, body] of [
    ['package.json', '{"name":"@pcircle/memesh","version":"4.13.0"}'],
    ['LICENSE', 'MIT'],
    ['dist/core/paths.js', '// compiled'],
    ['scripts/hooks/session-start.js', '// hook'],
    ['extensions/hermes-memesh/__init__.py', providerBody],
    ['extensions/hermes-memesh/plugin.yaml', 'name: memesh\n'],
  ] as const) {
    fs.mkdirSync(path.dirname(path.join(pkg, rel)), { recursive: true });
    fs.writeFileSync(path.join(pkg, rel), body);
  }
  const tarball = path.join(tmp(), 'pcircle-memesh-4.13.0.tgz');
  const r = spawnSync('tar', ['-czf', tarball, '-C', root, 'package'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tar: ${r.stderr}`);
  return tarball;
}

describe('a real, package-shaped tarball is not refused for being a package (the provider is a few files among hundreds)', () => {
  function managedCopy(world: Parameters<typeof fakeWorld>[0] = {}) {
    const hermesHome = tmp();
    const w = fakeWorld({ ...world, env: { HERMES_HOME: hermesHome }, realTar: true });
    const old = tmp();
    fs.writeFileSync(path.join(old, '__init__.py'), '# the old provider\n');
    fs.writeFileSync(path.join(old, 'plugin.yaml'), 'name: memesh\n');
    const target = defaultInstallTarget({ HERMES_HOME: hermesHome } as NodeJS.ProcessEnv);
    installProvider({ sourceDir: old, target, version: '4.12.0', force: false, backupRoot: path.join(w.a.dir, 'backups'), now: new Date() });
    return { w, target };
  }
  const body = (target: string) => fs.readFileSync(path.join(target, '__init__.py'), 'utf8');

  it('refreshHermes lists and extracts only the provider and installs it', () => {
    const { w, target } = managedCopy();
    const tarball = packageShapedTarball();
    expect(refreshHermes(w.deps, tarball, '4.13.0', sha512Integrity(tarball))).toMatchObject([{ outcome: 'refreshed' }]);
    expect(body(target)).toBe('# provider from the tarball\n');
  });

  it.each([
    ['a Chinese date (one word, different width)', '2026年11月8日 04:12'],
    ['a German date', '8. Nov. 2026 04:12'],
    ['a French date with a long month', '8 novembre 2026 04:12'],
    ['an ISO date and seconds', '2026-11-08 04:12:33'],
  ])('a machine whose tar prints %s in the long listing refreshes the provider too: names come from the plain listing, never from the dates', (_label, date) => {
    const { w, target } = managedCopy();
    const real = w.deps.exec;
    w.deps.exec = (cmd, args, opts) => {
      const r = real(cmd, args, opts);
      if (cmd !== 'tar' || !args.includes('-tvzf')) return r;
      // Same entries and types, with the date column written the way another language writes it.
      const lines = r.stdout.split('\n').map((line) => line.replace(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+)\S+\s+\d+\s+\d\d:\d\d\s+/, `$1${date} `));
      return { ...r, stdout: lines.join('\n') };
    };
    const tarball = packageShapedTarball();
    expect(refreshHermes(w.deps, tarball, '4.13.0', sha512Integrity(tarball))).toMatchObject([{ outcome: 'refreshed' }]);
    expect(body(target)).toBe('# provider from the tarball\n');
  });

  it('an entry outside the provider directory is neither listed nor extracted: nothing of it lands anywhere', () => {
    const { w, target } = managedCopy();
    const real = w.deps.exec;
    const landed: string[][] = [];
    w.deps.exec = (cmd, args, opts) => {
      const r = real(cmd, args, opts);
      // right after the extraction, before the working directory is removed: what is under work/package
      if (cmd === 'tar' && args.includes('-xzf')) landed.push(fs.readdirSync(path.join(args[args.indexOf('-C') + 1], 'package')), fs.readdirSync(path.join(args[args.indexOf('-C') + 1], 'package', 'extensions')));
      return r;
    };
    const tarball = packageShapedTarball();
    refreshHermes(w.deps, tarball, '4.13.0', sha512Integrity(tarball));
    expect(landed).toEqual([['extensions'], ['hermes-memesh']]); // package.json, LICENSE, dist and scripts of the package were not extracted
    expect(fs.readdirSync(path.dirname(target))).toEqual(['memesh']);
  });

  it.each([
    ['the plain listing', '-tzf', 'the verified package could not be listed (tar exit 2: disk gone)'],
    ['the long listing', '-tvzf', 'the verified package could not be listed (tar exit 2: disk gone)'],
    ['the extraction', '-xzf', 'the provider could not be extracted (tar exit 2: disk gone)'],
  ])('when tar fails at %s the failure says which step and what tar said, and the copy is left as it was', (_label, flag, message) => {
    const { w, target } = managedCopy();
    const real = w.deps.exec;
    w.deps.exec = (cmd, args, opts) => (cmd === 'tar' && args.includes(flag) ? { status: 2, stdout: '', stderr: 'disk gone' } : real(cmd, args, opts));
    const tarball = packageShapedTarball();
    const results = refreshHermes(w.deps, tarball, '4.13.0', sha512Integrity(tarball));
    expect(results).toHaveLength(1);
    expect(results?.[0]).toMatchObject({ outcome: 'failed', reason: message });
    expect(body(target)).toBe('# the old provider\n');
  });

  it('with npm pack itself: a tarball made by the real packer is accepted (the shape that was refused 525 times)', () => {
    const { w, target } = managedCopy();
    const src = tmp();
    for (const [rel, text] of [['package.json', JSON.stringify({ name: 'memesh-shape', version: '1.0.0', files: ['LICENSE', 'dist', 'extensions'] })], ['LICENSE', 'MIT'], ['dist/a.js', '//'], ['extensions/hermes-memesh/__init__.py', '# packed by npm\n'], ['extensions/hermes-memesh/plugin.yaml', 'name: memesh\n']]) {
      fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
      fs.writeFileSync(path.join(src, rel), text);
    }
    // On Windows npm is npm.cmd, which only a shell can start.
    const packed = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', src], { cwd: src, encoding: 'utf8', shell: process.platform === 'win32' });
    expect(packed.status, packed.stderr).toBe(0); // npm is needed to build this repository at all: a missing one is a failure, not a pass
    const tarball = path.join(src, packed.stdout.trim().split('\n').pop()!);
    expect(refreshHermes(w.deps, tarball, '4.13.0', sha512Integrity(tarball))).toMatchObject([{ outcome: 'refreshed' }]);
    expect(body(target)).toBe('# packed by npm\n');
  });

  it('end to end: after one run the copy is current, and the next run downloads nothing', async () => {
    const world = { realTar: true, tarballBuilder: (file: string) => fs.copyFileSync(packageShapedTarball(), file) } as const;
    const { w, target } = managedCopy(world);
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'installed' });
    expect(body(target)).toBe('# provider from the tarball\n');
    expect(readAutoUpdateState(w.a.dir)?.hermes).toMatchObject([{ outcome: 'refreshed' }]);
    const callsAfterFirst = w.calls.length;
    w.deps.currentVersion = '4.13.0';
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'skipped', reason: AUTO_UPDATE_REASONS.upToDate });
    expect(w.calls.slice(callsAfterFirst).filter((c) => /^npm (install|pack|audit)/.test(c))).toEqual([]);
  });

  it('a copy its owner edited does not make every attempt download the package again', async () => {
    const { w, target } = managedCopy();
    fs.appendFileSync(path.join(target, '__init__.py'), '# my own change\n');
    w.deps.currentVersion = '4.13.0';
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'skipped', reason: AUTO_UPDATE_REASONS.upToDate });
    expect(w.calls.filter((c) => /^npm (install|pack|audit)/.test(c))).toEqual([]);
    expect(staleInstalls(w.a.dir, w.deps.env, '4.13.0', w.deps.accountHome)).toEqual([]);
  });

  it('a directory somebody else put in the default place is not reported as a failure of ours when the package is refused', () => {
    const { w, target } = managedCopy();
    const other = path.join(path.dirname(path.dirname(target)), 'plugins-other', 'memesh');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, '__init__.py'), '# not ours\n'); // no marker
    registerInstall(w.a.dir, other);
    const tarball = packageShapedTarball();
    fs.appendFileSync(tarball, 'tampered');
    const results = refreshHermes(w.deps, tarball, '4.13.0', 'sha512-not-this-one')!;
    expect(results.map((r) => r.path)).toEqual([target]);
    expect(results[0]).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.tarballChanged });
  });

  it('says why tar failed instead of "no provider": a tar that exits non-zero keeps its exit code and message', () => {
    const { w } = managedCopy();
    const tarball = packageShapedTarball();
    const real = w.deps.exec;
    w.deps.exec = (cmd, args, opts) => (cmd === 'tar' && args.includes('-tvzf') ? { status: 2, stdout: '', stderr: 'tar: Error opening archive: Unrecognized archive format' } : real(cmd, args, opts));
    const [result] = refreshHermes(w.deps, tarball, '4.13.0', sha512Integrity(tarball))!;
    expect(result.reason).toContain('tar exit 2');
    expect(result.reason).toContain('Unrecognized archive format');
    expect(result.reason).not.toContain('holds no Hermes provider');
    w.deps.exec = (cmd, args, opts) => (cmd === 'tar' && args.includes('-xzf') ? { status: 1, stdout: '', stderr: 'tar: Pathname too long' } : real(cmd, args, opts));
    expect(refreshHermes(w.deps, tarball, '4.13.0', sha512Integrity(tarball))![0].reason).toContain('tar exit 1');
  });

  it('hashes, lists and extracts ONE private copy: a file swapped in the middle is not what gets installed', () => {
    const { w, target } = managedCopy();
    const tarball = packageShapedTarball();
    const verified = sha512Integrity(tarball);
    const evil = packageShapedTarball('# UNVERIFIED CONTENT\n');
    const real = w.deps.exec;
    w.deps.exec = (cmd, args, opts) => {
      if (cmd === 'tar' && args.includes('-tvzf')) fs.copyFileSync(evil, tarball); // swapped after the hash, before the listing
      return real(cmd, args, opts);
    };
    expect(refreshHermes(w.deps, tarball, '4.13.0', verified)).toMatchObject([{ outcome: 'refreshed' }]);
    expect(body(target)).toBe('# provider from the tarball\n');
  });

  it('refuses an extraction that does not land where it should (a source that resolves outside the working directory)', () => {
    const { w, target } = managedCopy();
    const tarball = packageShapedTarball();
    const outside = tmp();
    fs.writeFileSync(path.join(outside, '__init__.py'), '# outside\n');
    const real = w.deps.exec;
    w.deps.exec = (cmd, args, opts) => {
      if (cmd === 'tar' && args.includes('-xzf')) {
        const dir = path.join(args[args.indexOf('-C') + 1], 'package', 'extensions');
        fs.mkdirSync(dir, { recursive: true });
        fs.symlinkSync(outside, path.join(dir, 'hermes-memesh'));
        return { status: 0, stdout: '', stderr: '' };
      }
      return real(cmd, args, opts);
    };
    expect(refreshHermes(w.deps, tarball, '4.13.0', sha512Integrity(tarball))).toMatchObject([{ outcome: 'failed', reason: expect.stringContaining('not where it was expected') }]);
    expect(body(target)).toBe('# the old provider\n');
  });
});

describe('the Hermes copy: what is kept, what is put back, what is cleaned up', () => {
  const sourceOf = (text: string) => { const d = tmp(); fs.writeFileSync(path.join(d, '__init__.py'), text); fs.writeFileSync(path.join(d, 'plugin.yaml'), 'name: memesh\n'); return d; };
  const setup = () => {
    const memeshDir = tmp();
    const hermesHome = tmp();
    const target = defaultInstallTarget({ HERMES_HOME: hermesHome } as NodeJS.ProcessEnv);
    const input = (text: string, version: string, now = new Date()) => ({ sourceDir: sourceOf(text), version, memeshDir, env: { HERMES_HOME: hermesHome } as NodeJS.ProcessEnv, accountHome: null, now });
    return { memeshDir, hermesHome, target, input };
  };
  const DEAD_PID = 2147483000;
  /** The directory a refresh leaves beside the target: hidden, named for the target and its owner; the copy is one level down. */
  const aside = (target: string, kind: 'new' | 'old', pid: number, tag: string) => path.join(path.dirname(target), `.memesh-${kind}-${path.basename(target)}-${pid}-${tag}`);

  it('what --force replaced is the owner\'s: five refreshes later it is all still there, and refreshing MeMesh\'s own copy made no backup', () => {
    const { memeshDir, target, input } = setup();
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(path.join(target, 'sessions'));
    fs.writeFileSync(path.join(target, 'sessions', 'precious.json'), 'precious user session');
    fs.writeFileSync(path.join(target, 'config.yaml'), 'mine: true\n');
    const forced = installProvider({ ...input('# v1\n', '1.0.0'), target, force: true, backupRoot: path.join(memeshDir, 'backups') });
    expect(forced).toMatchObject({ outcome: 'refreshed' });
    const kept = forced.backup!;
    for (const n of [1, 2, 3, 4, 5]) {
      const out = refreshInstalls(input(`# v${n + 1}\n`, `1.0.${n}`));
      expect(out).toMatchObject([{ outcome: 'refreshed', backup: null }]);
    }
    expect(fs.readFileSync(path.join(kept, 'sessions', 'precious.json'), 'utf8')).toBe('precious user session');
    expect(fs.readFileSync(path.join(kept, 'config.yaml'), 'utf8')).toBe('mine: true\n');
    expect(fs.readdirSync(path.join(memeshDir, 'backups'))).toEqual([path.basename(kept)]);
  });

  it('a managed copy its owner edited, replaced with --force, is saved first and kept', () => {
    const { memeshDir, target, input } = setup();
    installProvider({ ...input('# v1\n', '1.0.0'), target, force: false, backupRoot: path.join(memeshDir, 'backups') });
    fs.appendFileSync(path.join(target, '__init__.py'), '# my edit\n');
    const forced = installProvider({ ...input('# v2\n', '2.0.0'), target, force: true, backupRoot: path.join(memeshDir, 'backups') });
    expect(fs.readFileSync(path.join(forced.backup!, '__init__.py'), 'utf8')).toContain('# my edit');
  });

  it('two copies replaced in the same second keep their own backups (the same timestamp does not make them one directory)', () => {
    const { memeshDir, hermesHome, input } = setup();
    const now = new Date('2026-11-08T00:00:00Z');
    const a = path.join(hermesHome, 'a'); const b = path.join(hermesHome, 'b');
    for (const [dir, text] of [[a, 'A'], [b, 'B']] as const) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'who.txt'), text); }
    const ra = installProvider({ ...input('# new\n', '1.0.0', now), target: a, force: true, backupRoot: path.join(memeshDir, 'backups') });
    const rb = installProvider({ ...input('# new\n', '1.0.0', now), target: b, force: true, backupRoot: path.join(memeshDir, 'backups') });
    expect(ra.backup).not.toBe(rb.backup);
    expect(fs.readFileSync(path.join(ra.backup!, 'who.txt'), 'utf8')).toBe('A');
    expect(fs.readFileSync(path.join(rb.backup!, 'who.txt'), 'utf8')).toBe('B');
  });

  it('a refresh killed between its two renames is put back by the next one, and says so', () => {
    const { memeshDir, target, input } = setup();
    installProvider({ ...input('# v1\n', '1.0.0'), target, force: false, backupRoot: path.join(memeshDir, 'backups') });
    registerInstall(memeshDir, target);
    // What the kill leaves: the old copy aside under its own name, the target gone, the new copy unfinished.
    fs.mkdirSync(aside(target, 'old', DEAD_PID, 'x'));
    fs.renameSync(target, path.join(aside(target, 'old', DEAD_PID, 'x'), 'copy'));
    fs.mkdirSync(path.join(aside(target, 'new', DEAD_PID, 'x'), 'copy'), { recursive: true });
    fs.writeFileSync(path.join(aside(target, 'new', DEAD_PID, 'x'), 'copy', 'plugin.yaml'), 'name: memesh\n');
    expect(staleInstalls(memeshDir, { HERMES_HOME: path.dirname(path.dirname(target)) } as NodeJS.ProcessEnv, '2.0.0', null)).toEqual([target]);
    const out = refreshInstalls(input('# v2\n', '2.0.0'));
    expect(out).toMatchObject([{ outcome: 'refreshed', reason: expect.stringContaining('interrupted') }]);
    expect(fs.readFileSync(path.join(target, '__init__.py'), 'utf8')).toBe('# v2\n');
    expect(fs.readdirSync(path.dirname(target))).toEqual(['memesh']); // both leftovers are gone, hidden ones included
  });

  it('puts the old copy back even when there is nothing newer to install', () => {
    const { memeshDir, target, input } = setup();
    installProvider({ ...input('# v1\n', '1.0.0'), target, force: false, backupRoot: path.join(memeshDir, 'backups') });
    registerInstall(memeshDir, target);
    fs.mkdirSync(aside(target, 'old', DEAD_PID, 'x'));
    fs.renameSync(target, path.join(aside(target, 'old', DEAD_PID, 'x'), 'copy'));
    const out = refreshInstalls({ ...input('# v1\n', '1.0.0'), sourceDir: sourceOf('# v1\n') });
    expect(out[0].reason).toContain('interrupted');
    expect(fs.existsSync(target)).toBe(true);
  });

  it('leftovers of a process that is gone are removed; those of a process that is still running are not touched', () => {
    const { memeshDir, target, input } = setup();
    installProvider({ ...input('# v1\n', '1.0.0'), target, force: false, backupRoot: path.join(memeshDir, 'backups') });
    const dead = aside(target, 'new', DEAD_PID, 'x');
    const live = aside(target, 'new', process.pid, 'x'); // an owner that is running (no start time recorded: judged by the pid)
    fs.mkdirSync(dead); fs.mkdirSync(live);
    refreshInstalls(input('# v2\n', '2.0.0'));
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
  });

  it.skipIf(!canReadPs)('a leftover whose pid is alive but belongs to another program (reused pid) is removed: pid AND start time make the identity', () => {
    const { memeshDir, target, input } = setup();
    installProvider({ ...input('# v1\n', '1.0.0'), target, force: false, backupRoot: path.join(memeshDir, 'backups') });
    const reused = aside(target, 'new', process.pid, '0123456789'); // this pid, but not this start time
    fs.mkdirSync(reused);
    refreshInstalls(input('# v2\n', '2.0.0'));
    expect(fs.existsSync(reused)).toBe(false);
  });

  it('a copy MeMesh registered that has vanished is reported as failed; an unregistered empty default place is not news', () => {
    const { memeshDir, target, input } = setup();
    expect(refreshInstalls(input('# v\n', '1.0.0'))).toEqual([]);
    registerInstall(memeshDir, target);
    expect(refreshTargets(memeshDir, { HERMES_HOME: path.dirname(path.dirname(target)) } as NodeJS.ProcessEnv, null)).toEqual([target]);
    expect(refreshInstalls(input('# v\n', '1.0.0'))).toMatchObject([{ path: target, outcome: 'failed', reason: HERMES_REASONS.gone }]);
  });

  it('a target that is a symlink is not touched, neither through nor over: it says why, even with --force', () => {
    const { memeshDir, hermesHome, target, input } = setup();
    const real = path.join(hermesHome, 'real-place', 'memesh');
    installProvider({ ...input('# v1\n', '1.0.0'), target: real, force: false, backupRoot: path.join(memeshDir, 'backups') });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(real, target);
    const out = refreshInstalls(input('# v2\n', '2.0.0'));
    expect(out).toMatchObject([{ outcome: 'skipped', reason: expect.stringContaining('symbolic link') }]);
    expect(out[0].reason).toContain(real);
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(real, '__init__.py'), 'utf8')).toBe('# v1\n');
    expect(installProvider({ ...input('# v2\n', '2.0.0'), target, force: true, backupRoot: path.join(memeshDir, 'backups') })).toMatchObject({ outcome: 'skipped' });
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
  });

  it.skipIf(isRoot)('something unreadable in the copy is reported as that, with the error: not as "edited" and not as "not ours"', () => {
    const { memeshDir, target, input } = setup();
    installProvider({ ...input('# v1\n', '1.0.0'), target, force: false, backupRoot: path.join(memeshDir, 'backups') });
    fs.chmodSync(path.join(target, '__init__.py'), 0o000);
    try {
      expect(inspectInstall(target)).toMatchObject({ state: 'unreadable', why: expect.stringContaining('EACCES') });
      const out = refreshInstalls(input('# v2\n', '2.0.0'));
      expect(out).toMatchObject([{ outcome: 'failed', reason: expect.stringContaining('EACCES') }]);
      expect(out[0].reason).not.toContain('changed after MeMesh installed it');
      expect(out[0].reason).not.toContain('not installed by MeMesh');
    } finally { fs.chmodSync(path.join(target, '__init__.py'), 0o644); }
    fs.chmodSync(path.join(target, '.memesh-install.json'), 0o000);
    try {
      expect(inspectInstall(target)).toMatchObject({ state: 'unreadable', why: expect.stringContaining('EACCES') });
    } finally { fs.chmodSync(path.join(target, '.memesh-install.json'), 0o644); }
  });

  it('the temporary directories have no plugin.yaml of their own: Hermes cannot mistake one for a second MeMesh provider', () => {
    const { memeshDir, target, input } = setup();
    installProvider({ ...input('# v1\n', '1.0.0'), target, force: false, backupRoot: path.join(memeshDir, 'backups') });
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('stop here'); });
    try {
      // The failure comes after the new copy was staged and before it was moved in.
      installProvider({ ...input('# v2\n', '2.0.0'), target, force: false, backupRoot: path.join(memeshDir, 'backups') });
    } finally { spy.mockRestore(); }
    const seen = fs.readdirSync(path.dirname(target));
    expect(seen.length).toBeGreaterThan(1); // something besides the provider is there to be judged
    for (const name of seen) {
      if (name === 'memesh') continue;
      expect(fs.existsSync(path.join(path.dirname(target), name, 'plugin.yaml')), name).toBe(false);
    }
  });

  it('a failed backup leaves no half directory behind, and the copy is left as it was', () => {
    const { memeshDir, target, input } = setup();
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, '__init__.py'), '# not ours\n');
    const real = fs.cpSync;
    let calls = 0;
    const spy = vi.spyOn(fs, 'cpSync').mockImplementation((from, to, opts) => {
      calls += 1;
      if (String(to).includes('hermes-provider-')) { fs.mkdirSync(String(to), { recursive: true }); throw new Error('ENOSPC: no space left on device'); }
      return real(from, to, opts);
    });
    try {
      const out = installProvider({ ...input('# v2\n', '2.0.0'), target, force: true, backupRoot: path.join(memeshDir, 'backups') });
      expect(out).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('ENOSPC') });
    } finally { spy.mockRestore(); }
    expect(calls).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(target, '__init__.py'), 'utf8')).toBe('# not ours\n');
    expect(fs.existsSync(path.join(memeshDir, 'backups')) ? fs.readdirSync(path.join(memeshDir, 'backups')) : []).toEqual([]);
  });

  it('when the new copy is in place but the old one cannot be removed, the refresh is still a success, and says where the old one is', () => {
    const { memeshDir, target, input } = setup();
    installProvider({ ...input('# v1\n', '1.0.0'), target, force: false, backupRoot: path.join(memeshDir, 'backups') });
    const real = fs.rmSync;
    const spy = vi.spyOn(fs, 'rmSync').mockImplementation((p, o) => {
      if (String(p).includes('.memesh-old-') && fs.existsSync(path.join(String(p), 'copy'))) throw new Error('EBUSY: resource busy'); // only once the old copy is the thing in it
      return real(p, o);
    });
    let out;
    try { out = installProvider({ ...input('# v2\n', '2.0.0'), target, force: false, backupRoot: path.join(memeshDir, 'backups') }); } finally { spy.mockRestore(); }
    expect(out).toMatchObject({ outcome: 'refreshed', reason: expect.stringContaining('could not be removed') });
    expect(fs.readFileSync(path.join(target, '__init__.py'), 'utf8')).toBe('# v2\n');
  });
});

describe('the list of registered copies', () => {
  it('a damaged list is reported, never read as "no copies", and never overwritten (that would erase every other copy it names)', () => {
    const memeshDir = tmp();
    const target = path.join(tmp(), 'plugins', 'memesh');
    const list = path.join(memeshDir, 'hermes-installs.json');
    fs.writeFileSync(list, '{ not json');
    expect(registryProblem(memeshDir)).toContain('not valid JSON');
    expect(() => registerInstall(memeshDir, target)).toThrow(/cannot be read/);
    expect(fs.readFileSync(list, 'utf8')).toBe('{ not json');
    const out = refreshInstalls({ sourceDir: tmp(), version: '1.0.0', memeshDir, env: { HERMES_HOME: tmp() } as NodeJS.ProcessEnv, accountHome: null, now: new Date() });
    expect(out).toMatchObject([{ path: list, outcome: 'failed', reason: expect.stringContaining('cannot be read') }]);
  });

  it('a list that does not exist is an empty list, and registering writes it whole: through a temporary file that is renamed', () => {
    const memeshDir = tmp();
    expect(registryProblem(memeshDir)).toBeNull();
    const target = path.join(tmp(), 'plugins', 'memesh');
    registerInstall(memeshDir, target);
    registerInstall(memeshDir, path.join(tmp(), 'plugins', 'memesh'));
    expect(JSON.parse(fs.readFileSync(path.join(memeshDir, 'hermes-installs.json'), 'utf8')).installs).toHaveLength(2);
    expect(fs.readdirSync(memeshDir)).toEqual(['hermes-installs.json']);
  });

  it('the Hermes home is never guessed at a shared directory: with no HERMES_HOME and no home directory it is an error, and a relative HERMES_HOME is made absolute', () => {
    expect(() => defaultInstallTarget({} as NodeJS.ProcessEnv, null)).toThrow(/cannot be worked out/);
    expect(defaultInstallTarget({ HERMES_HOME: 'relative/place' } as NodeJS.ProcessEnv, null)).toBe(path.join(path.resolve('relative/place'), 'plugins', 'memesh'));
    expect(path.isAbsolute(defaultInstallTarget({ HOME: '/h' } as NodeJS.ProcessEnv, null))).toBe(true);
  });
});

describe('running hosts: where they are registered, and what is said when one cannot be', () => {
  it('a host whose process id cannot be watched (1, or nothing) leaves a line in the log instead of vanishing', () => {
    const d = tmp();
    registerLiveHost(d, 1);
    registerLiveHost(d, 0);
    const log = fs.readFileSync(path.join(d, 'auto-update.log'), 'utf8');
    expect(log).toContain('process id (1) cannot be registered');
    expect(log).toContain('process id (0) cannot be registered');
    expect(fs.existsSync(path.join(d, 'live-hosts'))).toBe(false);
  });

  it('the update waits for a host registered in the shared place, not only in this data directory', async () => {
    const w = fakeWorld();
    const shared = tmp();
    w.deps.liveHostsDir = shared;
    registerLiveHost(shared, process.pid);
    let polls = 0;
    w.deps.sleep = async () => { polls += 1; if (polls === 3) fs.rmSync(path.join(shared, 'live-hosts'), { recursive: true }); };
    await runAutoUpdate(w.deps);
    expect(polls).toBe(3);
    // The same registration in the data directory (which no longer matters) would not have held it.
    const other = fakeWorld();
    other.deps.liveHostsDir = tmp();
    registerLiveHost(other.deps.dir, process.pid);
    let otherPolls = 0;
    other.deps.sleep = async () => { otherPolls += 1; };
    await runAutoUpdate(other.deps);
    expect(otherPolls).toBe(0);
  });
});

describe('a process id alone is not a running host', () => {
  it('a registered host records its start time (in the pinned form when ps can be read)', () => {
    const d = tmp();
    registerLiveHost(d, process.pid);
    const record = JSON.parse(fs.readFileSync(path.join(d, 'live-hosts', `${process.pid}.json`), 'utf8')) as { started: string | null };
    expect(record.started).toBe(processStartTag(process.pid));
    expect(liveHostPids(d)).toEqual([process.pid]);
  });

  it.skipIf(!canReadPs)('a record whose pid is alive but started at another time is a gone host', () => {
    const d = tmp();
    registerLiveHost(d, process.pid);
    fs.writeFileSync(path.join(d, 'live-hosts', `${process.pid}.json`), JSON.stringify({ pid: process.pid, at: 'x', started: 'v2:Thu Jan  1 00:00:00 1970' }));
    expect(liveHostPids(d)).toEqual([]);
    expect(fs.existsSync(path.join(d, 'live-hosts', `${process.pid}.json`))).toBe(false);
  });
});

describe('the pre-update backup, when the directory holds something unreadable or odd', () => {
  const mkDb = (d: string) => { const f = path.join(d, 'knowledge-graph.db'); const db = new DatabaseSync(f); db.exec('CREATE TABLE t (v TEXT)'); db.close(); return f; };

  it('a dangling link among the backups does not fail the backup, and is cleaned up once there are too many', () => {
    const d = tmp();
    const dbPath = mkDb(d);
    const backupDir = path.join(d, 'backups');
    fs.mkdirSync(backupDir);
    fs.symlinkSync(path.join(d, 'nowhere.db'), path.join(backupDir, 'pre-update-4.1.0-old.db'));
    for (let i = 1; i <= 3; i += 1) {
      const f = path.join(backupDir, `pre-update-4.1.0-${i}.db`);
      fs.writeFileSync(f, 'x');
      const t = new Date(Date.UTC(2026, 9, i)); fs.utimesSync(f, t, t);
    }
    const made = backupDatabase(dbPath, backupDir, '4.2.0', new Date())!;
    expect(fs.existsSync(made)).toBe(true);
    expect(fs.readdirSync(backupDir)).not.toContain('pre-update-4.1.0-old.db');
  });

  it('the backup just made survives even when every other backup looks newer (a clock that was set back)', () => {
    const d = tmp();
    const dbPath = mkDb(d);
    const backupDir = path.join(d, 'backups');
    fs.mkdirSync(backupDir);
    for (let i = 1; i <= 3; i += 1) {
      const f = path.join(backupDir, `pre-update-4.1.0-${i}.db`);
      fs.writeFileSync(f, 'x');
      const future = new Date(Date.now() + i * 86_400_000); fs.utimesSync(f, future, future);
    }
    const made = backupDatabase(dbPath, backupDir, '4.2.0', new Date())!;
    expect(fs.existsSync(made)).toBe(true);
  });
});

describe('Codex: where it lives, and what is not known', () => {
  const codexWorld = (extra: Parameters<typeof fakeWorld>[0] = {}) => fakeWorld({ channel: 'plugin-marketplace', pluginHost: 'codex', ...extra });
  const codexCalls = (calls: string[]) => calls.filter((c) => c.startsWith('codex'));

  it('codexHomeFor: the Codex directory a plugin of ours was installed into, whatever HOME is now; anything else is null, never a guess', () => {
    expect(codexHomeFor('/h/other/.codex/plugins/cache/pcircle-memesh/memesh/4.12.0')).toBe('/h/other/.codex');
    expect(codexHomeFor('/srv/codex-x/plugins/cache/pcircle-memesh/memesh/4.12.0')).toBe('/srv/codex-x');
    // Another marketplace's plugin (a local development copy) is not ours to replace with the official release.
    expect(codexHomeFor('/h/me/.codex/plugins/cache/my-dev-marketplace/memesh/4.12.0')).toBeNull();
    // Not a Codex plugin cache at all: no fallback to the account's .codex, no fallback to a temporary directory.
    expect(codexHomeFor('/usr/lib/node_modules/@pcircle/memesh')).toBeNull();
  });

  it('HOME is not the account home: the update goes to the Codex the plugin is in, and the account\'s own .codex is not touched', async () => {
    const w = codexWorld();
    const accountCodex = path.join(w.a.home, '.codex');
    const seen = new Set<string | undefined>();
    const real = w.deps.exec;
    w.deps.exec = (cmd, args, opts) => { if (cmd === 'codex') seen.add(opts?.env?.CODEX_HOME); return real(cmd, args, opts); };
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'installed' });
    expect(seen).toEqual(new Set([w.deps.codexHome]));
    expect(fs.existsSync(accountCodex)).toBe(false);
  });

  it('a Codex directory that is not known skips with the reason and runs nothing', async () => {
    const w = codexWorld();
    w.deps.codexHome = null;
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'skipped', reason: AUTO_UPDATE_REASONS.codexHomeUnknown });
    expect(codexCalls(w.calls)).toEqual([]);
  });

  it('a config.toml that cannot be read is "unknown", not "not the official repository": skipped with that reason', async () => {
    const w = codexWorld({ codexConfig: null });
    fs.mkdirSync(path.join(w.deps.codexHome!, 'config.toml')); // reading a directory fails with EISDIR
    expect(codexMarketplaceState(w.deps.codexHome!)).toBe('unreadable');
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'skipped', reason: AUTO_UPDATE_REASONS.codexMarketplaceUnreadable });
    expect(codexCalls(w.calls)).toEqual([]);
  });

  it('no config.toml at all is "missing": skipped, nothing run', async () => {
    const w = codexWorld({ codexConfig: null });
    expect(codexMarketplaceState(w.deps.codexHome!)).toBe('missing');
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'skipped', reason: AUTO_UPDATE_REASONS.codexMarketplaceMissing });
    expect(codexCalls(w.calls)).toEqual([]);
  });

  it('when removing the marketplace fails nothing was changed, so no restore is attempted and the failure says the marketplace is as it was', async () => {
    const w = codexWorld();
    const real = w.deps.exec;
    w.deps.exec = (cmd, args, opts) => (cmd === 'codex' && args[2] === 'remove' ? { status: 1, stdout: '', stderr: 'locked' } : real(cmd, args, opts));
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.codexRemoveFailed });
    expect(AUTO_UPDATE_REASONS.codexRemoveFailed).toContain('nothing was changed');
    expect(w.calls.filter((c) => c === 'codex plugin marketplace add')).toEqual([]);
  });

  it('when the plugin add fails the marketplace is put back; whether that worked decides what is reported', async () => {
    for (const [restoreWorks, reason] of [[true, AUTO_UPDATE_REASONS.codexInstallFailed], [false, AUTO_UPDATE_REASONS.codexRestoreFailed]] as const) {
      const w = codexWorld();
      const real = w.deps.exec;
      let marketplaceAdds = 0;
      const steps: string[] = [];
      w.deps.exec = (cmd, args, opts) => {
        if (cmd === 'codex' && args[1] === 'marketplace') steps.push(args[2]);
        if (cmd === 'codex' && args[1] === 'add') return { status: 1, stdout: '', stderr: 'no such plugin' };
        if (cmd === 'codex' && args[2] === 'add') { marketplaceAdds += 1; if (marketplaceAdds === 2 && !restoreWorks) return { status: 1, stdout: '', stderr: 'offline' }; }
        return real(cmd, args, opts);
      };
      expect(await runAutoUpdate(w.deps), String(restoreWorks)).toMatchObject({ outcome: 'failed', reason });
      expect(marketplaceAdds).toBe(2); // the pinned add, then the restore
      // The pinned marketplace has to be removed before the unpinned one is added: Codex refuses an add of a name that exists.
      expect(steps, String(restoreWorks)).toEqual(['remove', 'add', 'remove', 'add']);
    }
    expect(AUTO_UPDATE_REASONS.codexRestoreFailed).toContain('codex plugin marketplace add PCIRCLE-AI/memesh');
  });

  it.each([
    ['the directory Codex reported is not there', { codexRoot: 'missing' as const }],
    ['the plugin in it is another version than its directory name says', { codexRoot: 'wrong-version' as const }],
  ])('reads the plugin back from disk, not from the words of a command: %s', async (_label, extra) => {
    const w = codexWorld(extra);
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.codexReadbackFailed });
  });
});

describe('a Codex marketplace written in any form but the plain table is the owner\'s, and is left alone', () => {
  const WRITTEN = {
    'a quoted header': '[marketplaces."pcircle-memesh"]\nsource_type = "local"\nsource = "/home/me/dev/memesh"\n',
    'a dotted header': '[marketplaces.pcircle-memesh.extra]\nx = 1\n',
    'a header with spaces': '[ marketplaces . pcircle-memesh ]\nsource_type = "local"\nsource = "/home/me/dev/memesh"\n',
    'dotted keys': 'marketplaces.pcircle-memesh.source_type = "local"\nmarketplaces.pcircle-memesh.source = "/home/me/dev/memesh"\n',
    'an inline table': 'marketplaces = { pcircle-memesh = { source_type = "local", source = "/home/me/dev/memesh" } }\n',
    'a bare key under [marketplaces]': '[marketplaces]\npcircle-memesh = { source_type = "local", source = "/home/me/dev/memesh" }\n',
  } as const;

  it.each(Object.entries(WRITTEN))('%s: judged foreign (never missing), and codex is not run at all', async (_label, toml) => {
    const w = fakeWorld({ channel: 'plugin-marketplace', pluginHost: 'codex', codexConfig: `model = "mine"\n\n${toml}` });
    expect(codexMarketplaceState(w.deps.codexHome!)).toBe('foreign');
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'skipped', reason: AUTO_UPDATE_REASONS.codexMarketplaceForeign });
    expect(w.calls.filter((c) => c.startsWith('codex'))).toEqual([]);
  });

  it('a file that mentions the plugin but not the marketplace is still "missing" (what a failed restore leaves)', () => {
    const w = fakeWorld({ channel: 'plugin-marketplace', pluginHost: 'codex', codexConfig: 'model = "mine"\n\n[plugins."memesh@pcircle-memesh"]\nenabled = true\n' });
    expect(codexMarketplaceState(w.deps.codexHome!)).toBe('missing');
  });

  it('a comment that names the marketplace is not a marketplace', () => {
    const w = fakeWorld({ channel: 'plugin-marketplace', pluginHost: 'codex', codexConfig: '# marketplaces: pcircle-memesh was removed\nmodel = "mine"\n' });
    expect(codexMarketplaceState(w.deps.codexHome!)).toBe('missing');
  });
});

describe('what an attempt leaves for doctor and the log', () => {
  it('records the note it was given (a recovered lock) in the state file', async () => {
    const w = fakeWorld({ withDb: true });
    w.deps.notice = 'the update lock was damaged and untouched for over 15 minutes';
    await runAutoUpdate(w.deps);
    expect(readAutoUpdateState(w.a.dir)?.notice).toBe('the update lock was damaged and untouched for over 15 minutes');
  });

  it('writes why the setting could not be read into the log (the path and the error code), not only that it is off', async () => {
    const w = fakeWorld();
    fs.mkdirSync(path.join(w.a.dir, 'config.json')); // a directory where the config file should be
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'skipped' });
    expect(fs.readFileSync(path.join(w.a.dir, 'auto-update.log'), 'utf8')).toMatch(/config\.json: EISDIR/);
  });
});

describe('the v0.3 attestation bundle (what npm 11 publishes) is read like the v0.2 one', () => {
  const att = JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/auto-update/attestations-pcircle-memesh-4.12.0.json'), 'utf8')) as { attestations: Array<{ bundle: Record<string, any>; predicateType: string }> };
  const realDigest = '8c77bebe2b2533a33ddbc25d45be8e2fd5af7b4d17bc31e8399d65a43eb436d842e3ab488dc4195c975b961983f1a7d227bd3d9c25c1b47734ff4234f9098ee1';
  /** The same real certificate, moved to where a v0.3 bundle keeps it. */
  const asV03 = (bundle: Record<string, any>) => {
    const copy = JSON.parse(JSON.stringify(bundle));
    const cert = copy.verificationMaterial.x509CertificateChain.certificates[0];
    delete copy.verificationMaterial.x509CertificateChain;
    copy.verificationMaterial.certificate = cert;
    copy.mediaType = 'application/vnd.dev.sigstore.bundle.v0.3+json';
    return copy;
  };
  /** The attestation as the registry serves it: the sigstore bundle under `.bundle`. */
  const served = (a: { bundle: Record<string, any>; predicateType: string }, bundle: Record<string, any> = a.bundle) => ({ predicateType: a.predicateType, bundle });

  it('reads the signer from verificationMaterial.certificate, and accepts the real release in that shape', () => {
    const bundles = att.attestations.map((a) => served(a, a.predicateType === 'https://slsa.dev/provenance/v1' ? asV03(a.bundle) : a.bundle));
    const provenance = bundles[att.attestations.findIndex((a) => a.predicateType === 'https://slsa.dev/provenance/v1')];
    expect(signerIdentity(provenance)).toBe(signer('4.12.0'));
    const json = audit([{ name: '@pcircle/memesh', version: '4.12.0', attestationBundles: bundles }]);
    expect(judgeAuditSignatures(json, '@pcircle/memesh', '4.12.0', { tarballSha512Hex: realDigest })).toMatchObject({ ok: true });
  });

  it('still refuses a v0.3 bundle that names another signer or carries no certificate', () => {
    const provenance = att.attestations.find((a) => a.predicateType === 'https://slsa.dev/provenance/v1')!;
    const noCert = asV03(provenance.bundle);
    delete noCert.verificationMaterial.certificate;
    expect(signerIdentity(served(provenance, noCert))).toBeNull();
    const json = audit([{ name: '@pcircle/memesh', version: '4.12.0', attestationBundles: [served(provenance, asV03(provenance.bundle))] }]);
    expect(judgeAuditSignatures(json, '@pcircle/memesh', '4.12.0', { tarballSha512Hex: realDigest, signerOf: () => 'https://github.com/someone-else/memesh/.github/workflows/publish-npm.yml@refs/tags/v4.12.0' })).toMatchObject({ ok: false });
  });
});

describe('memesh update (manual), what it tells the person', () => {
  function stubRunner(state: Record<string, unknown>): string {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'scripts', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'hooks', 'auto-update-runner.mjs'), `
      import fs from 'node:fs'; import path from 'node:path';
      fs.writeFileSync(path.join(path.dirname(process.argv[2]), 'auto-update-state.json'), JSON.stringify({ at: new Date().toISOString(), hermes: null, channel: null, backup: null, waitingSince: null, from: '4.12.0', to: '4.13.0', ...${JSON.stringify(state)} }));
    `);
    return root;
  }
  const withSetting = <T>(value: string, fn: () => T): T => {
    const saved = process.env.MEMESH_AUTO_UPDATE;
    process.env.MEMESH_AUTO_UPDATE = value;
    try { return fn(); } finally { if (saved === undefined) delete process.env.MEMESH_AUTO_UPDATE; else process.env.MEMESH_AUTO_UPDATE = saved; }
  };

  it('says that automatic updates are still off when they are, and says nothing of the kind when they are not', () => {
    const off = withSetting('off', () => runManualUpdate(stubRunner({ outcome: 'installed', reason: 'installed' }), tmp()));
    expect(off.code).toBe(0);
    expect(off.lines.join('\n')).toContain('Automatic updates are still off; this was an update you asked for by hand');
    const on = withSetting('major', () => runManualUpdate(stubRunner({ outcome: 'installed', reason: 'installed' }), tmp()));
    expect(on.lines.join('\n')).not.toContain('still off');
    const offCurrent = withSetting('off', () => runManualUpdate(stubRunner({ outcome: 'skipped', reason: AUTO_UPDATE_REASONS.upToDate }), tmp()));
    expect(offCurrent.lines.join('\n')).toContain('still off');
  });

  it('does not print a plain success when MeMesh is current but the Hermes provider could not be refreshed', () => {
    const hermes = [{ path: '/h/plugins/memesh', outcome: 'failed', reason: 'tar exit 2: broken archive', backup: null }];
    const current = withSetting('major', () => runManualUpdate(stubRunner({ outcome: 'skipped', reason: AUTO_UPDATE_REASONS.upToDate, hermes }), tmp()));
    expect(current.code).toBe(1);
    expect(current.lines.join('\n')).toContain('tar exit 2: broken archive');
    expect(current.lines.join('\n')).not.toContain('✅');
    const installed = withSetting('major', () => runManualUpdate(stubRunner({ outcome: 'installed', reason: 'installed', hermes }), tmp()));
    expect(installed.code).toBe(1);
    expect(installed.lines.join('\n')).toContain('✅ Updated');
    expect(installed.lines.join('\n')).toContain('Hermes provider at /h/plugins/memesh was not updated');
  });
});

describe('a runner that has lost its lock stops, and an off written late still stops the install', () => {
  it('stops with the reason, and installs nothing, when the heartbeat says the lock is no longer its own (during the wait)', async () => {
    const w = fakeWorld();
    registerLiveHost(w.a.dir, process.pid);
    w.deps.heartbeat = () => false;
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.lockLost });
    expect(w.calls.some((c) => c.startsWith('npm install -g'))).toBe(false);
  });

  it('a runner that lost its lock does not keep waiting: it stops at the first poll, before sleeping at all', async () => {
    const w = fakeWorld();
    registerLiveHost(w.a.dir, process.pid);
    let sleeps = 0;
    w.deps.sleep = async () => { sleeps += 1; };
    w.deps.heartbeat = () => false;
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.lockLost });
    expect(sleeps).toBe(0);
  });

  it('an off written while the package is fetched and verified AGAIN after a long wait still stops the install', async () => {
    const w = fakeWorld();
    registerLiveHost(w.a.dir, process.pid);
    const real = w.deps.exec;
    let audits = 0;
    w.deps.exec = (cmd, args, opts) => {
      if (args[0] === 'audit') { audits += 1; if (audits === 2) fs.writeFileSync(path.join(w.a.dir, 'config.json'), '{"autoUpdate":"off"}'); }
      return real(cmd, args, opts);
    };
    let polls = 0;
    w.deps.sleep = async () => { polls += 1; if (polls === 2) fs.rmSync(path.join(w.a.dir, 'live-hosts'), { recursive: true }); };
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'skipped', reason: AUTO_UPDATE_REASONS.policyOff });
    expect(audits).toBe(2); // the second check really ran, so the off came after the wait
    expect(w.calls.some((c) => c.startsWith('npm install -g'))).toBe(false);
  });

  it('and the same right before the install, when there was no wait at all (the checks ran for minutes in blocking steps)', async () => {
    const w = fakeWorld();
    w.deps.heartbeat = () => false;
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.lockLost });
    expect(w.calls.some((c) => c.startsWith('npm install -g'))).toBe(false);
  });

  it('an off written while the download, the checks and the backup ran stops the install, on the path without a wait', async () => {
    const w = fakeWorld();
    const real = w.deps.exec;
    // The owner turns updates off while the (blocking) audit step is running.
    w.deps.exec = (cmd, args, opts) => {
      if (args[0] === 'audit') fs.writeFileSync(path.join(w.a.dir, 'config.json'), '{"autoUpdate":"off"}');
      return real(cmd, args, opts);
    };
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'skipped', reason: AUTO_UPDATE_REASONS.policyOff });
    expect(w.calls.some((c) => c.startsWith('npm install -g'))).toBe(false);
  });

  it('and a setting that now forbids this size of change stops it too', async () => {
    const w = fakeWorld();
    const real = w.deps.exec;
    w.deps.currentVersion = '3.0.0';
    w.deps.exec = (cmd, args, opts) => {
      if (args[0] === 'audit') fs.writeFileSync(path.join(w.a.dir, 'config.json'), '{"autoUpdate":"patch"}');
      return real(cmd, args, opts);
    };
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'skipped', reason: AUTO_UPDATE_REASONS.bumpNotPermitted });
    expect(w.calls.some((c) => c.startsWith('npm install -g'))).toBe(false);
  });
});

describe('an explicit off is written where every MeMesh looks', () => {
  const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, unknown>;

  it('also writes off to the account config when this process uses another data directory, and keeps the rest of that file', () => {
    const active = tmp();
    const account = tmp();
    fs.writeFileSync(path.join(account, 'config.json'), '{"sessionLimit":7}');
    const out = propagateOff(active, account);
    expect(out).toEqual({ path: path.join(account, 'config.json'), error: null });
    expect(readJson(path.join(account, 'config.json'))).toEqual({ sessionLimit: 7, autoUpdate: 'off' });
    // The point of it: a MeMesh started WITHOUT the other data directory (it reads the account's own) is now off.
    expect(resolveUpdatePolicy({ env: {}, activeDir: account, accountHome: path.dirname(account) === account ? null : path.dirname(account) })).toMatchObject({ policy: 'off' });
  });

  it('does nothing when this process already is the account\'s', () => {
    const dir = tmp();
    expect(propagateOff(dir, dir)).toEqual({ path: null, error: null });
    expect(propagateOff(dir, null)).toEqual({ path: null, error: null });
    expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(false);
  });

  it('says so when the account config cannot be written, and does not overwrite one it cannot read', () => {
    const active = tmp();
    const account = tmp();
    fs.writeFileSync(path.join(account, 'config.json'), '{ not json');
    const out = propagateOff(active, account);
    expect(out.error).toContain('could not be read');
    expect(fs.readFileSync(path.join(account, 'config.json'), 'utf8')).toBe('{ not json');
  });

  it('accountConfigHolding finds an off, or an unreadable file (which counts as off), that the process\'s own config does not carry', () => {
    const active = tmp();
    const account = tmp();
    expect(accountConfigHolding(active, account)).toBeNull();
    fs.writeFileSync(path.join(account, 'config.json'), '{"autoUpdate":"major"}');
    expect(accountConfigHolding(active, account)).toBeNull();
    fs.writeFileSync(path.join(account, 'config.json'), '{"autoUpdate":"off"}');
    expect(accountConfigHolding(active, account)).toEqual({ path: path.join(account, 'config.json'), kind: 'off', why: null });
    fs.writeFileSync(path.join(account, 'config.json'), '{ not json');
    expect(accountConfigHolding(active, account)).toEqual({ path: path.join(account, 'config.json'), kind: 'unreadable', why: 'not valid JSON' });
    expect(accountConfigHolding(account, account)).toBeNull();
    expect(accountConfigHolding(active, null)).toBeNull();
  });
});

describe('productionDeps: which plugin installs are ours to update', () => {
  it('a Codex plugin of the pcircle-memesh marketplace is a Codex install, with its own Codex directory; one from another marketplace is not an install this updater touches', () => {
    const root = tmp();
    const ours = path.join(root, '.codex', 'plugins', 'cache', 'pcircle-memesh', 'memesh', '4.12.0');
    const dev = path.join(root, '.codex', 'plugins', 'cache', 'my-dev-marketplace', 'memesh', '4.12.0');
    for (const d of [ours, dev]) fs.mkdirSync(d, { recursive: true });
    const a = productionDeps(ours, '4.12.0');
    expect(a).toMatchObject({ channel: 'plugin-marketplace', pluginHost: 'codex', codexHome: path.join(root, '.codex') });
    const b = productionDeps(dev, '4.12.0');
    expect(b.codexHome).toBeNull();
    expect(b.pluginHost).toBeNull();
  });
});

describe('the release must come from a tag, whatever the workflow in that branch says', () => {
  const entry = (ref: string) => [{ name: '@pcircle/memesh', version: '4.12.0', attestationBundles: [statement({ ref })] }];
  const signedAs = (ref: string) => ({ tarballSha512Hex: DIGEST, signerOf: () => `https://github.com/PCIRCLE-AI/memesh/.github/workflows/publish-npm.yml@${ref}` });

  it.each(['refs/heads/main', 'refs/heads/some-branch', 'refs/pull/7/merge', 'refs/tags/4.12.0', 'refs/tags/v4.12.1'])('refuses a build whose workflow ref is %s, even when the certificate says the same', (ref) => {
    expect(judgeAuditSignatures(audit(entry(ref)), '@pcircle/memesh', '4.12.0', signedAs(ref))).toMatchObject({ ok: false });
  });

  it('refuses a provenance that says tag while the certificate says branch (the two must agree)', () => {
    expect(judgeAuditSignatures(audit(entry('refs/tags/v4.12.0')), '@pcircle/memesh', '4.12.0', signedAs('refs/heads/main'))).toMatchObject({ ok: false });
  });

  it('accepts exactly refs/tags/v<this version>', () => {
    expect(judgeAuditSignatures(audit(entry('refs/tags/v4.12.0')), '@pcircle/memesh', '4.12.0', signedAs('refs/tags/v4.12.0'))).toMatchObject({ ok: true });
  });
});

describe('the release commit is confirmed to be part of main by the updater itself', () => {
  const answer = (http: string, body: unknown) => ({ status: 0, stdout: `${http}\n${typeof body === 'string' ? body : JSON.stringify(body)}`, stderr: '' });
  const base = (status: string, sha = RELEASE_COMMIT) => ({ status, merge_base_commit: { sha } });

  it('asks GitHub whether the attested commit is an ancestor of main, naming the official repository', () => {
    expect(compareUrl(RELEASE_COMMIT)).toBe(`https://api.github.com/repos/PCIRCLE-AI/memesh/compare/${RELEASE_COMMIT}...refs/heads/main?per_page=1`);
  });

  it.each([['ahead'], ['identical']])('%s with the commit as the merge base: it is part of main', (status) => {
    expect(judgeCommitOnMain(answer('200', base(status)), RELEASE_COMMIT)).toEqual({ ok: true });
  });

  it.each([
    ['diverged: it is on a side branch', answer('200', base('diverged', 'f'.repeat(40)))],
    ['behind: main does not contain it', answer('200', base('behind'))],
    ['ahead but the merge base is another commit', answer('200', base('ahead', 'e'.repeat(40)))],
    ['unknown to the repository (404)', answer('404', { message: 'Not Found' })],
  ])('%s: refused for good', (_label, result) => {
    expect(judgeCommitOnMain(result, RELEASE_COMMIT)).toMatchObject({ ok: false, code: 'notOnMain' });
  });

  it.each([
    ['rate limited (403)', answer('403', { message: 'rate limit' })],
    ['rate limited (429)', answer('429', '')],
    ['GitHub down (503)', answer('503', '')],
    ['the lookup itself failed', { status: 1, stdout: '', stderr: 'TypeError: fetch failed' }],
    ['no connection at all', { status: null, stdout: '', stderr: '' }],
    ['not JSON', answer('200', '<html>')],
    ['no status in the answer', answer('200', {})],
    ['empty output', { status: 0, stdout: '', stderr: '' }],
    // A failed or non-200 reply that still carries a body shaped like a yes must not be believed.
    ['the lookup failed after printing a yes', { status: 1, stdout: `200\n${JSON.stringify(base('ahead'))}`, stderr: 'killed' }],
    ['a 500 whose body looks like a yes', answer('500', base('ahead'))],
    ['a 302 whose body looks like a yes', answer('302', base('identical'))],
  ])('%s: not installed, and not final either (a later run asks again)', (_label, result) => {
    expect(judgeCommitOnMain(result, RELEASE_COMMIT)).toMatchObject({ ok: false, code: 'unconfirmed' });
  });

  it('a commit on main goes through, and the question was asked with the attested commit before anything is installed', async () => {
    const w = fakeWorld();
    const real = w.deps.exec;
    const asked: string[] = [];
    w.deps.exec = (cmd, args, opts) => { if (cmd === process.execPath && args[0] === '-e') asked.push(args[2]); return real(cmd, args, opts); };
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'installed' });
    expect(asked).toEqual([compareUrl(RELEASE_COMMIT)]);
    // the whole address, literally: the commit as the base and the BRANCH (not a name a tag could also have) as the head
    expect(asked[0]).toBe(`https://api.github.com/repos/PCIRCLE-AI/memesh/compare/${RELEASE_COMMIT}...refs/heads/main?per_page=1`);
  });

  it('behind a proxy: fetch is told to use it where this node can, and a node that cannot says so when the lookup fails', async () => {
    expect(compareEnv({ HTTPS_PROXY: 'http://p:1' }, '24.15.0')).toMatchObject({ NODE_USE_ENV_PROXY: '1' });
    expect(compareEnv({ https_proxy: 'http://p:1' }, '22.21.0')).toMatchObject({ NODE_USE_ENV_PROXY: '1' });
    expect(compareEnv({ HTTPS_PROXY: 'http://p:1' }, '22.20.0').NODE_USE_ENV_PROXY).toBeUndefined();
    expect(compareEnv({ HTTPS_PROXY: 'http://p:1' }, '23.9.0').NODE_USE_ENV_PROXY).toBeUndefined();
    expect(compareEnv({}, '24.15.0').NODE_USE_ENV_PROXY).toBeUndefined(); // no proxy set: nothing is switched on
    expect(nodeUsesEnvProxy('20.19.0')).toBe(false);
    const failed = judgeCommitOnMain({ status: 1, stdout: '', stderr: 'TimeoutError' }, RELEASE_COMMIT, true);
    expect(failed).toMatchObject({ ok: false, code: 'unconfirmed' });
    expect((failed as { detail: string }).detail).toContain('a proxy is configured but this Node');
    expect((judgeCommitOnMain({ status: 1, stdout: '', stderr: 'TimeoutError' }, RELEASE_COMMIT) as { detail: string }).detail).not.toContain('proxy');
  });

  // A node that cannot use the proxy environment is covered by the version table above; here it shows as skipped, not passed.
  it.skipIf(!nodeUsesEnvProxy())('the real lookup script goes through a proxy with the environment compareEnv gives it, and does not without it', async () => {
    const http = await import('node:http');
    const seen: string[] = [];
    // Node tunnels even a plain-http address with CONNECT: answer it, then serve the request that arrives inside the tunnel.
    const inner = http.createServer((_req, res) => { res.end('{}'); });
    const proxy = http.createServer();
    proxy.on('connect', (req, socket) => { seen.push(req.url ?? ''); socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); inner.emit('connection', socket); });
    const proxied = await new Promise<number>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve((proxy.address() as { port: number }).port)));
    try {
      // a plain-http address: a proxy forwards it as one request; its answer's status is printed first by the script
      const env = { PATH: process.env.PATH ?? '', HTTP_PROXY: `http://127.0.0.1:${proxied}` };
      const url = 'http://memesh-proxy-probe.invalid/compare';
      // asynchronous: the proxy lives in this process, and a synchronous spawn would stop it from answering
      const { execFile } = await import('node:child_process');
      const run = (e: NodeJS.ProcessEnv) => new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
        execFile(process.execPath, ['-e', COMPARE_SCRIPT, url], { env: e, encoding: 'utf8', timeout: 30_000 }, (err, stdout, stderr) => resolve({ status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }));
      });
      const through = await run(compareEnv(env));
      expect(through.status === 0, through.stderr).toBe(true);
      expect(through.stdout.startsWith('200')).toBe(true);
      expect(seen).toEqual(['memesh-proxy-probe.invalid:80']); // the request really went to the proxy, asking for that host
      seen.length = 0;
      const direct = await run(env); // without NODE_USE_ENV_PROXY node ignores the proxy and cannot resolve the name
      expect(direct.status === 0).toBe(false);
      expect(seen).toEqual([]);
    } finally { proxy.close(); }
  }, 60_000);

  it('a commit that is not on main stops the update, records why, and installs nothing (also by hand)', async () => {
    for (const manual of [false, true]) {
      const w = fakeWorld({ commitAnswer: answer('200', base('diverged', 'f'.repeat(40))) });
      w.deps.manual = manual;
      expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.commitNotOnMain });
      expect(w.calls.some((c) => c.startsWith('npm install -g'))).toBe(false);
      expect(readAutoUpdateState(w.a.dir)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.commitNotOnMain });
    }
  });

  it('GitHub not answering stops it too (fail closed), with its own reason', async () => {
    const w = fakeWorld({ commitAnswer: answer('403', { message: 'rate limit exceeded' }) });
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.commitUnconfirmed });
    expect(w.calls.some((c) => c.startsWith('npm install -g'))).toBe(false);
  });

  it('is not asked for a release whose provenance already failed', async () => {
    const w = fakeWorld({ verified: false });
    const real = w.deps.exec;
    let asked = 0;
    w.deps.exec = (cmd, args, opts) => { if (cmd === process.execPath) asked += 1; return real(cmd, args, opts); };
    await runAutoUpdate(w.deps);
    expect(asked).toBe(0);
  });
});

describe('the dependency tree is pinned by the release, and installed without running anybody\'s scripts', () => {
  it('accepts a complete shrinkwrap for this version', () => {
    expect(judgeShrinkwrap(shrinkwrapText(), '4.13.0')).toEqual({ ok: true });
  });

  it.each([
    ['not JSON', 'nope'],
    ['no package list', JSON.stringify({ lockfileVersion: 3 })],
    ['another version', shrinkwrapText('4.12.0')],
    ['a declared dependency that is not pinned', shrinkwrapText('4.13.0', (p) => { delete p['node_modules/ws']; })],
    ['an entry without a version', shrinkwrapText('4.13.0', (p) => { delete p['node_modules/zod'].version; })],
    ['an entry without an integrity hash', shrinkwrapText('4.13.0', (p) => { delete p['node_modules/zod'].integrity; })],
    ['an entry with a weak hash', shrinkwrapText('4.13.0', (p) => { p['node_modules/zod'].integrity = 'md5-AAAA'; })],
    ['an entry fetched from somewhere else', shrinkwrapText('4.13.0', (p) => { p['node_modules/zod'].resolved = 'https://example.com/zod.tgz'; })],
    ['an entry fetched from a repository', shrinkwrapText('4.13.0', (p) => { p['node_modules/zod'].resolved = 'git+ssh://example.com/zod.git#abc'; })],
    ['an entry with no address', shrinkwrapText('4.13.0', (p) => { delete p['node_modules/zod'].resolved; })],
    ['a nested copy with no integrity', shrinkwrapText('4.13.0', (p) => { p['node_modules/ws/node_modules/x'] = { version: '1.0.0', resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz' }; })],
    ['a sha1 hash', shrinkwrapText('4.13.0', (p) => { p['node_modules/zod'].integrity = 'sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA='; })],
    ['an address that is another package\'s', shrinkwrapText('4.13.0', (p) => { p['node_modules/zod'].resolved = 'https://registry.npmjs.org/ws/-/ws-8.21.3.tgz'; })],
  ])('refuses %s, and says which entry and why', (_label, text) => {
    const verdict = judgeShrinkwrap(text, '4.13.0');
    expect(verdict.ok).toBe(false);
    expect((verdict as { detail: string }).detail.length).toBeGreaterThan(10);
    expect((verdict as { detail: string }).detail).toMatch(/npm-shrinkwrap\.json|zod|ws|x /);
  });

  it('a release without a shrinkwrap, or with an incomplete one, is not installed', async () => {
    for (const shrinkwrap of [null, 'garbage', shrinkwrapText('4.13.0', (p) => { delete p['node_modules/zod'].integrity; })]) {
      const w = fakeWorld({ shrinkwrap });
      expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.dependenciesNotPinned });
      expect(w.calls.some((c) => c.startsWith('npm install -g'))).toBe(false);
    }
  });

  it('the shrinkwrap read is the one inside the verified tarball', async () => {
    const w = fakeWorld();
    const real = w.deps.exec;
    const seen: string[][] = [];
    w.deps.exec = (cmd, args, opts) => { if (cmd === 'tar' && args.includes('-xzOf')) seen.push(args); return real(cmd, args, opts); };
    await runAutoUpdate(w.deps);
    expect(seen).toHaveLength(1);
    expect(seen[0].at(-1)).toBe('package/npm-shrinkwrap.json');
    expect(seen[0][1]).toMatch(/pcircle-memesh-4\.13\.0\.tgz$/);
  });

  it.each([false, true])('the pinned install runs in staging BEFORE anything is installed, and again in the installed package, and no scripts run (manual=%s)', async (manual) => {
    const w = fakeWorld();
    w.deps.manual = manual;
    const real = w.deps.exec;
    const order: string[] = [];
    w.deps.exec = (cmd, args, opts) => {
      if (cmd === 'npm' && args[0] === 'install' && args.includes('-g')) order.push('install -g');
      if (cmd === 'npm' && args[0] === 'ci') order.push(`ci(${/global-root[\\/]@pcircle[\\/]memesh$/.test(opts?.cwd ?? '') ? 'installed' : 'staging'}):${args.slice(1).join(' ')}`);
      return real(cmd, args, opts);
    };
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'installed' });
    expect(order).toEqual(['ci(staging):--omit=dev --ignore-scripts --no-audit --no-fund', 'install -g', 'ci(installed):--omit=dev --ignore-scripts --no-audit --no-fund']);
  });

  it('when the pinned install fails after npm replaced the package, the previous version is put back, works, and the failure is recorded for a retry', async () => {
    const w = fakeWorld({ pinResult: { status: 1, stdout: '', stderr: 'npm error code EINTEGRITY' } });
    const installedDir = path.join(path.dirname(w.deps.dbPath), 'global-root', '@pcircle', 'memesh');
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.dependencyPinFailed });
    // the version that worked is back, and none of the new one is left
    expect(fs.readFileSync(path.join(installedDir, 'WORKS'), 'utf8')).toBe('the old version');
    expect(JSON.parse(fs.readFileSync(path.join(installedDir, 'package.json'), 'utf8')).version).toBe('4.12.0');
    expect(fs.existsSync(path.join(installedDir, 'NEW'))).toBe(false);
    expect(fs.readdirSync(path.dirname(installedDir)).filter((n) => n.startsWith('memesh.rollback'))).toEqual([]);
    const state = readAutoUpdateState(w.a.dir);
    expect(state).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.dependencyPinFailed });
    expect(state?.detail).toContain('EINTEGRITY');
    expect(state?.detail).toContain('previous version was put back');
    expect(fs.existsSync(path.join(w.a.dir, 'just-upgraded.json'))).toBe(false);
    // because the old version is what runs, the next attempt sees an older version than the target and tries again
    expect(state).toMatchObject({ from: '4.12.0', to: '4.13.0' });
  });

  it.each([
    ['the registry answers 500', { status: 1, stdout: '', stderr: 'npm error code E500' }],
    ['the download hangs and the step is killed', { status: null, stdout: '', stderr: '' }],
    ['a hash does not match (EINTEGRITY)', { status: 1, stdout: '', stderr: 'npm error code EINTEGRITY' }],
  ])('%s while rehearsing the pinned install in staging: nothing is installed and the working version is not touched', async (_label, rehearsalResult) => {
    const w = fakeWorld({ rehearsalResult });
    const installedDir = path.join(path.dirname(w.deps.dbPath), 'global-root', '@pcircle', 'memesh');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(path.join(installedDir, 'WORKS'), 'the old version');
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.dependenciesNotFetched });
    expect(w.calls.some((c) => c.startsWith('npm install -g'))).toBe(false);
    expect(fs.readFileSync(path.join(installedDir, 'WORKS'), 'utf8')).toBe('the old version');
    expect(fs.readdirSync(installedDir)).toEqual(['WORKS']);
    expect(readAutoUpdateState(w.a.dir)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.dependenciesNotFetched });
  });

  it('a failed global install itself also leaves the previous version in place', async () => {
    const w = fakeWorld();
    const real = w.deps.exec;
    const installedDir = path.join(path.dirname(w.deps.dbPath), 'global-root', '@pcircle', 'memesh');
    // npm half-replaced it and then failed
    w.deps.exec = (cmd, args, opts) => {
      if (cmd === 'npm' && args[0] === 'install' && args.includes('-g')) { fs.rmSync(path.join(installedDir, 'WORKS'), { force: true }); return { status: 1, stdout: '', stderr: 'npm error ENOSPC' }; }
      return real(cmd, args, opts);
    };
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.installFailed });
    expect(fs.readFileSync(path.join(installedDir, 'WORKS'), 'utf8')).toBe('the old version');
  });

  it('when the previous version cannot be put back either, the record says so, and the next run does not call that "already current"', async () => {
    const w = fakeWorld({ pinResult: { status: 1, stdout: '', stderr: 'npm error code EINTEGRITY' } });
    const real = w.deps.exec;
    const installedDir = path.join(path.dirname(w.deps.dbPath), 'global-root', '@pcircle', 'memesh');
    w.deps.exec = (cmd, args, opts) => {
      // the copy kept beside the install is lost before the way back is needed
      if (cmd === 'npm' && args[0] === 'ci' && opts?.cwd === installedDir) fs.rmSync(path.join(path.dirname(installedDir), `memesh.rollback-${process.pid}`), { recursive: true, force: true });
      return real(cmd, args, opts);
    };
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.installNotUndone });
    expect(AUTO_UPDATE_REASONS.installNotUndone).toContain('memesh update --reinstall');
    // The new version is what is on disk now; the registry says it is the newest. That is not "up to date".
    w.deps.currentVersion = '4.13.0';
    w.deps.readTags = () => ({ latest: '4.13.0' });
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.installNotUndone });
    expect(readAutoUpdateState(w.a.dir)?.detail).toContain('still unfinished');
  });

  it('when npm cannot say where global packages live, nothing is installed (a failed install could not be undone)', async () => {
    const w = fakeWorld();
    const real = w.deps.exec;
    w.deps.exec = (cmd, args, opts) => (cmd === 'npm' && args[0] === 'root' ? { status: 1, stdout: '', stderr: 'npm error boom' } : real(cmd, args, opts));
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.globalDirUnknown });
    expect(w.calls.some((c) => c.startsWith('npm install -g'))).toBe(false);
  });

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)('when a copy of the installed version cannot be made, nothing is installed', async () => {
    const w = fakeWorld();
    const real = w.deps.exec;
    const installedDir = path.join(path.dirname(w.deps.dbPath), 'global-root', '@pcircle', 'memesh');
    let unreadable = '';
    w.deps.exec = (cmd, args, opts) => {
      const r = real(cmd, args, opts);
      if (cmd === 'npm' && args[0] === 'root') { unreadable = path.join(installedDir, 'secret'); fs.writeFileSync(unreadable, 'x'); fs.chmodSync(unreadable, 0o000); }
      return r;
    };
    try {
      expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.rollbackUnavailable });
      expect(w.calls.some((c) => c.startsWith('npm install -g'))).toBe(false);
      expect(fs.readdirSync(path.dirname(installedDir)).filter((n) => n.startsWith('memesh.rollback'))).toEqual([]);
    } finally { if (unreadable) fs.chmodSync(unreadable, 0o600); }
  });

  it('copies left beside the install by a runner that was killed are swept, those of a running one are not', async () => {
    const w = fakeWorld();
    const parent = path.join(path.dirname(w.deps.dbPath), 'global-root', '@pcircle');
    fs.mkdirSync(path.join(parent, 'memesh.rollback-2147483000'), { recursive: true });
    fs.mkdirSync(path.join(parent, `memesh.rollback-${process.ppid}`), { recursive: true });
    await runAutoUpdate(w.deps);
    expect(fs.existsSync(path.join(parent, 'memesh.rollback-2147483000'))).toBe(false);
    expect(fs.existsSync(path.join(parent, `memesh.rollback-${process.ppid}`))).toBe(true);
  });

  it('an installed directory that has no shrinkwrap after the install is a failed update that is undone, not a success', async () => {
    const bare = fakeWorld();
    const bareReal = bare.deps.exec;
    const installedDir = path.join(path.dirname(bare.deps.dbPath), 'global-root', '@pcircle', 'memesh');
    bare.deps.exec = (cmd, args, opts) => {
      const r = bareReal(cmd, args, opts);
      if (cmd === 'npm' && args[0] === 'install' && args.includes('-g')) fs.rmSync(path.join(installedDir, 'npm-shrinkwrap.json'));
      return r;
    };
    expect(await runAutoUpdate(bare.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.dependencyPinFailed });
    expect(fs.readFileSync(path.join(installedDir, 'WORKS'), 'utf8')).toBe('the old version');
  });

  it.each([false, true])('the global install runs no install scripts (manual=%s)', async (manual) => {
    const w = fakeWorld();
    w.deps.manual = manual;
    const real = w.deps.exec;
    const installs: string[][] = [];
    let packed = '';
    w.deps.exec = (cmd, args, opts) => {
      if (cmd === 'npm' && args[0] === 'pack' && opts?.cwd) packed = path.join(opts.cwd, 'pcircle-memesh-4.13.0.tgz');
      if (cmd === 'npm' && args[0] === 'install' && args.includes('-g')) installs.push(args);
      return real(cmd, args, opts);
    };
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'installed' });
    expect(installs).toHaveLength(1);
    expect(installs[0].slice(0, 3)).toEqual(['install', '-g', '--ignore-scripts']);
    // The very file that was packed, verified and hashed, not a name npm would fetch again.
    expect(installs[0][3]).toBe(packed);
  });
});

describe('the Claude Code plugin read-back looks at the plugin registry, not at the script\'s exit code', () => {
  const claudeWorld = (extra: Parameters<typeof fakeWorld>[0] = {}) => fakeWorld({ channel: 'plugin-marketplace', pluginHost: 'claude-code', ...extra });

  it('a registry that records the pinned commit and the target version is an install', async () => {
    const w = claudeWorld();
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'installed' });
  });

  it.each([
    ['no registry at all', { claudeRegistry: 'missing' as const }],
    ['a registry that records another commit', { claudeRegistry: 'other-commit' as const }],
    ['a registry that records another version', { claudeRegistry: 'other-version' as const }],
  ])('%s: the script said 0, and it is still a failed update', async (_label, extra) => {
    const w = claudeWorld(extra);
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.claudeReadbackFailed });
    expect(fs.existsSync(path.join(w.a.dir, 'just-upgraded.json'))).toBe(false);
  });
});

describe('memesh update --reinstall: this very version, through the same checks', () => {
  it('asks the registry nothing, verifies THIS version, and installs it even though nothing is newer', async () => {
    const w = fakeWorld();
    w.deps.reinstall = true;
    w.deps.manual = true;
    w.deps.currentVersion = '4.13.0';
    w.deps.readTags = () => { throw new Error('the registry must not be asked'); };
    const real = w.deps.exec;
    const installs: string[][] = [];
    w.deps.exec = (cmd, args, opts) => { if (cmd === 'npm' && args[0] === 'install' && args.includes('-g')) installs.push(args); return real(cmd, args, opts); };
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'installed' });
    expect(readAutoUpdateState(w.a.dir)).toMatchObject({ outcome: 'installed', from: '4.13.0', to: '4.13.0' });
    expect(installs).toHaveLength(1);
    // The same checks: the source was verified, the dependency pins applied, a backup was made.
    expect(w.calls.some((c) => c.startsWith('npm audit'))).toBe(true);
    expect(w.calls.some((c) => c.startsWith('npm ci'))).toBe(true);
  });

  it('is refused like any update when the source cannot be verified: a reinstall is not a way around the check', async () => {
    const w = fakeWorld({ verified: false });
    w.deps.reinstall = true;
    w.deps.manual = true;
    w.deps.currentVersion = '4.13.0';
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.sourceNotVerified });
    expect(w.calls.some((c) => c.startsWith('npm install -g'))).toBe(false);
  });

  it('is refused for a release that is not on main, and for one without pinned dependencies', async () => {
    const offMain = fakeWorld({ commitAnswer: { status: 0, stdout: `200\n${JSON.stringify({ status: 'diverged', merge_base_commit: { sha: 'f'.repeat(40) } })}`, stderr: '' } });
    offMain.deps.reinstall = true; offMain.deps.manual = true; offMain.deps.currentVersion = '4.13.0';
    expect(await runAutoUpdate(offMain.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.commitNotOnMain });
    const unpinned = fakeWorld({ shrinkwrap: null });
    unpinned.deps.reinstall = true; unpinned.deps.manual = true; unpinned.deps.currentVersion = '4.13.0';
    expect(await runAutoUpdate(unpinned.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.dependenciesNotPinned });
  });

  it('puts the plugin back to the commit named by this version\'s provenance (Claude Code)', async () => {
    const w = fakeWorld({ channel: 'plugin-marketplace', pluginHost: 'claude-code' });
    w.deps.reinstall = true; w.deps.manual = true; w.deps.currentVersion = '4.13.0';
    const real = w.deps.exec;
    let pin: string | undefined;
    w.deps.exec = (cmd, args, opts) => { if (cmd === 'bash') pin = opts?.env?.MEMESH_UPGRADE_PIN_COMMIT; return real(cmd, args, opts); };
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'installed' });
    expect(pin).toBe(RELEASE_COMMIT);
  });
});

describe('an install that dies half way leaves a trace, and a result record clears it', () => {
  it('the marker exists while the install runs and is gone once the attempt has recorded its result', async () => {
    const w = fakeWorld();
    const real = w.deps.exec;
    let during: unknown = null;
    w.deps.exec = (cmd, args, opts) => {
      if (cmd === 'npm' && args[0] === 'install' && args.includes('-g')) during = readInstalling(w.a.dir);
      return real(cmd, args, opts);
    };
    await runAutoUpdate(w.deps);
    expect(during).toMatchObject({ marker: { from: '4.12.0', to: '4.13.0', pid: process.pid }, running: true });
    expect(readInstalling(w.a.dir)).toBeNull();
  });

  it('a runner that is killed in the install leaves the marker behind, and it says its process is gone', async () => {
    const w = fakeWorld();
    const real = w.deps.exec;
    w.deps.exec = (cmd, args, opts) => {
      if (cmd === 'npm' && args[0] === 'install' && args.includes('-g')) {
        // The writer was a process that no longer exists: rewrite the marker with a pid that is gone, then "die" without recording anything.
        const file = path.join(w.a.dir, 'auto-update-installing.json');
        fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), pid: 2_147_483_000, started: null }));
        throw Object.assign(new Error('killed'), { simulatedDeath: true });
      }
      return real(cmd, args, opts);
    };
    // runAutoUpdate catches and records a failure; what a SIGKILL leaves is the marker alone, so put it back as the kill would have left it.
    await runAutoUpdate(w.deps);
    fs.writeFileSync(path.join(w.a.dir, 'auto-update-installing.json'), JSON.stringify({ at: new Date().toISOString(), from: '4.12.0', to: '4.13.0', pid: 2_147_483_000, started: null }));
    expect(readInstalling(w.a.dir)).toMatchObject({ marker: { to: '4.13.0' }, running: false });
  });

  it('an unreadable or foreign marker is no marker', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'auto-update-installing.json'), '{ not json');
    expect(readInstalling(d)).toBeNull();
    fs.writeFileSync(path.join(d, 'auto-update-installing.json'), JSON.stringify({ at: 1 }));
    expect(readInstalling(d)).toBeNull();
  });
});

describe('a process id that exists but is not ours is not our host (EPERM)', () => {
  it('a registered host whose pid now answers EPERM is gone, and its file is removed', () => {
    const d = tmp();
    registerLiveHost(d, 424242);
    const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => { if (pid === 424242) throw Object.assign(new Error('not permitted'), { code: 'EPERM' }); return true; }) as typeof process.kill);
    try {
      expect(liveHostPids(d)).toEqual([]);
      expect(fs.existsSync(path.join(d, 'live-hosts', '424242.json'))).toBe(false);
    } finally { kill.mockRestore(); }
  });

  it('while a registered host that answers is waited for (control)', () => {
    const d = tmp();
    registerLiveHost(d, process.pid);
    expect(liveHostPids(d)).toEqual([process.pid]);
  });
});

describe('a log entry is one line', () => {
  it('a newline in what is logged does not start a second, forged entry', () => {
    const d = tmp();
    logAutoUpdateLine(d, 'auto-update INSTALLED: forged\n[2020-01-01T00:00:00.000Z] auto-update INSTALLED: second\r\nthird\u2028fourth');
    const lines = fs.readFileSync(path.join(d, 'auto-update.log'), 'utf8').split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('forged');
    expect(lines[0]).toContain('fourth');
  });

  it('and so does a state detail that is an npm error with newlines', async () => {
    const w = fakeWorld();
    const real = w.deps.exec;
    w.deps.exec = (cmd, args, opts) => (cmd === 'npm' && args[0] === 'install' && args.includes('-g') ? { status: 1, stdout: '', stderr: 'npm error one\nnpm error two\n\n' + 'x'.repeat(500) } : real(cmd, args, opts));
    await runAutoUpdate(w.deps);
    const detail = readAutoUpdateState(w.a.dir)?.detail ?? '';
    expect(detail).toContain('npm error one npm error two');
    expect(detail).not.toContain('\n');
    expect(detail.length).toBeLessThanOrEqual(300);
    expect(fs.readFileSync(path.join(w.a.dir, 'auto-update.log'), 'utf8').split('\n').filter((l) => l.includes('install failed')).length).toBe(1);
  });
});

describe('a dispatch from an install that cannot update itself starts nothing and takes no slot', () => {
  const withDir = async (fn: (dir: string) => Promise<void>) => {
    const dir = tmp();
    const saved = { MEMESH_DIR: process.env.MEMESH_DIR, MEMESH_DB_PATH: process.env.MEMESH_DB_PATH };
    process.env.MEMESH_DIR = dir;
    delete process.env.MEMESH_DB_PATH;
    try { await fn(dir); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  };
  const runnerRoot = () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'scripts', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'hooks', 'auto-update-runner.mjs'), 'process.exit(0);\n');
    return root;
  };

  it('a source checkout: no runner, no attempt time, no record; one log line says why; and a plugin that can update is not throttled by it afterwards', async () => {
    await withDir(async (dir) => {
      const root = runnerRoot();
      expect(await dispatchAutoUpdate(root, 1_000_000, { canSelfUpdate: () => ({ ok: false, label: 'source checkout' }) })).toEqual({ state: 'unsupported' });
      expect(fs.existsSync(path.join(dir, 'auto-update-attempt'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'auto-update-state.json'))).toBe(false);
      expect(fs.readFileSync(path.join(dir, 'auto-update.log'), 'utf8')).toContain('source checkout cannot update itself');
      // the slot every install of this account shares was not used
      expect(await dispatchAutoUpdate(root, 1_000_000 + 60_000, { canSelfUpdate: () => ({ ok: true, label: 'Claude Code plugin' }) })).toEqual({ state: 'dispatched' });
    });
  });

  it('removes what older versions left and nothing reads any more (the notice snooze, the reply-Upgrade consent files), and nothing else', async () => {
    await withDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'update-snooze.json'), '{}');
      fs.mkdirSync(path.join(dir, 'update-consent'));
      fs.writeFileSync(path.join(dir, 'update-consent', 'x'), 'x');
      fs.writeFileSync(path.join(dir, 'config.json'), '{}');
      await dispatchAutoUpdate(runnerRoot(), 1_000_000, { canSelfUpdate: () => ({ ok: false, label: 'source checkout' }) });
      expect(fs.existsSync(path.join(dir, 'update-snooze.json'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'update-consent'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(true);
    });
  });

  it('the real channel check says a temporary stand-in directory is not an install that can update itself', async () => {
    await withDir(async (dir) => {
      expect(await dispatchAutoUpdate(runnerRoot(), 1_000_000)).toEqual({ state: 'unsupported' });
      expect(fs.existsSync(path.join(dir, 'auto-update-attempt'))).toBe(false);
    });
  });
});

describe('a Codex config.toml is read as TOML reads it: a multi-line string is text, not a table', () => {
  const write = (toml: string) => { const w = fakeWorld({ channel: 'plugin-marketplace', pluginHost: 'codex', codexConfig: toml }); return w.deps.codexHome!; };
  const OFFICIAL = '[marketplaces.pcircle-memesh]\nsource_type = "git"\nsource = "https://github.com/PCIRCLE-AI/memesh.git"\n';

  it('a decoy of the official table inside a multi-line string ahead of the owner\'s own marketplace does not make it official', () => {
    for (const quotes of ['"""', "'''"]) {
      const home = write(`notes = ${quotes}\n${OFFICIAL}${quotes}\n\n[marketplaces.pcircle-memesh]\nsource_type = "local"\nsource = "/home/me/dev/memesh"\n`);
      expect(codexMarketplaceState(home), quotes).toBe('foreign');
    }
  });

  it('a decoy that is the only mention is "missing", not "official": there is no marketplace', () => {
    expect(codexMarketplaceState(write(`notes = """\n${OFFICIAL}"""\n`))).toBe('missing');
  });

  it('the real table is still read, with strings of both kinds around it', () => {
    expect(codexMarketplaceState(write(`a = """one\ntwo"""\nb = '''x'''\n${OFFICIAL}c = "y"\n`))).toBe('official');
  });

  it('stripMultilineStrings takes out only the multi-line strings', () => {
    expect(stripMultilineStrings('x = """a\nb"""\ny = "c"\nz = \'\'\'d\ne\'\'\'\n')).toBe('x = ""\ny = "c"\nz = ""\n');
  });
});

describe('working directories left by an update that was killed', () => {
  const GONE = 2_147_483_000;
  const workDir = (root: string, name: string, owner?: { pid: number; started: string | null }) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'package.tgz'), 'x');
    if (owner) fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify(owner));
    return dir;
  };

  it('removes those whose owner is gone, keeps those whose owner runs, and leaves everything else alone', () => {
    const root = tmp();
    const dead = workDir(root, 'memesh-update-dead', { pid: GONE, started: null });
    const hermes = workDir(root, 'memesh-hermes-dead', { pid: GONE, started: 'Sat Jan  1 00:00:00 2000' });
    const live = workDir(root, 'memesh-update-live', { pid: process.pid, started: null });
    const stranger = workDir(root, 'other-directory-dead', { pid: GONE, started: null });
    const file = path.join(root, 'memesh-update-a-file');
    fs.writeFileSync(file, 'x');
    const removed = sweepWorkDirs(root);
    expect(removed.sort()).toEqual([dead, hermes].sort());
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(hermes)).toBe(false);
    for (const kept of [live, stranger, file]) expect(fs.existsSync(kept), kept).toBe(true);
  });

  it('a directory with no owner record is removed only once it is an hour old', () => {
    const root = tmp();
    const fresh = workDir(root, 'memesh-update-fresh');
    const old = workDir(root, 'memesh-update-old');
    const past = new Date(Date.now() - 2 * 3_600_000);
    fs.utimesSync(old, past, past);
    expect(sweepWorkDirs(root)).toEqual([old]);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('an update that stages a package sweeps first, says so in the log, and writes its own owner record', async () => {
    const w = fakeWorld();
    const left = workDir(w.deps.tmpRoot, 'memesh-update-left-by-kill', { pid: GONE, started: null });
    const real = w.deps.exec;
    let ownerSeen: unknown = null;
    w.deps.exec = (cmd, args, opts) => {
      if (cmd === 'npm' && args[0] === 'install' && !args.includes('-g') && opts?.cwd) ownerSeen = JSON.parse(fs.readFileSync(path.join(opts.cwd, 'owner.json'), 'utf8'));
      return real(cmd, args, opts);
    };
    await runAutoUpdate(w.deps);
    expect(fs.existsSync(left)).toBe(false);
    expect(ownerSeen).toMatchObject({ pid: process.pid });
    expect(fs.readFileSync(path.join(w.a.dir, 'auto-update.log'), 'utf8')).toContain('removed 1 working directory left by an update that was killed');
  });
});

describe('a wait that cannot be recorded says so', () => {
  it('a wait file that cannot be written (a directory is in its place) leaves a line in the log, and the wait goes on', async () => {
    const w = fakeWorld();
    registerLiveHost(w.a.dir, process.pid);
    fs.mkdirSync(path.join(w.a.dir, 'auto-update-wait.json'));
    let polls = 0;
    w.deps.sleep = async () => { polls += 1; if (polls === 2) fs.rmSync(path.join(w.a.dir, 'live-hosts'), { recursive: true }); };
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'installed' });
    expect(polls).toBe(2);
    expect(fs.readFileSync(path.join(w.a.dir, 'auto-update.log'), 'utf8')).toContain('could not record when the wait began');
  });
});

describe('the attempt time is taken when the runner has started', () => {
  const root = () => {
    const r = tmp();
    fs.mkdirSync(path.join(r, 'scripts', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(r, 'scripts', 'hooks', 'auto-update-runner.mjs'), 'process.exit(0);\n');
    return r;
  };
  const withDir = async (fn: (dir: string) => Promise<void>) => {
    const dir = tmp();
    const saved = { MEMESH_DIR: process.env.MEMESH_DIR, MEMESH_DB_PATH: process.env.MEMESH_DB_PATH };
    process.env.MEMESH_DIR = dir;
    delete process.env.MEMESH_DB_PATH;
    try { await fn(dir); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  };
  const fakeChild = (event: 'spawn' | 'error') => (() => {
    const child = Object.assign(new EventEmitter(), { pid: 4242, unref: () => undefined });
    queueMicrotask(() => child.emit(event, event === 'error' ? new Error('EAGAIN') : undefined));
    return child;
  }) as unknown as typeof import('child_process').spawn;
  const CAN = { canSelfUpdate: () => ({ ok: true, label: 'test install' }) };

  it('a runner that could not start leaves no attempt time, so the next session tries again at once', async () => {
    await withDir(async (dir) => {
      expect(await dispatchAutoUpdate(root(), 1_000_000, { ...CAN, spawnImpl: fakeChild('error') })).toEqual({ state: 'failed' });
      expect(fs.existsSync(path.join(dir, 'auto-update-attempt'))).toBe(false);
      expect(fs.readFileSync(path.join(dir, 'auto-update.log'), 'utf8')).toContain('stage=dispatch error=EAGAIN');
      expect(await dispatchAutoUpdate(root(), 1_000_000 + 1000, { ...CAN, spawnImpl: fakeChild('spawn') })).toEqual({ state: 'dispatched' });
    });
  });

  it('one that started takes the slot, owner-only, with the time it was dispatched', async () => {
    await withDir(async (dir) => {
      expect(await dispatchAutoUpdate(root(), 1_000_000, { ...CAN, spawnImpl: fakeChild('spawn') })).toEqual({ state: 'dispatched' });
      expect(fs.readFileSync(path.join(dir, 'auto-update-attempt'), 'utf8')).toBe('1000000');
      expect(fs.statSync(path.join(dir, 'auto-update-attempt')).mode & 0o777).toBe(0o600);
      expect(await dispatchAutoUpdate(root(), 1_000_000 + 60_000, { ...CAN, spawnImpl: fakeChild('spawn') })).toEqual({ state: 'throttled' });
    });
  });
});

describe('what the install steps answer decides the outcome', () => {
  it('a global install that exits non-zero is a failed update, with npm\'s reason, and nothing is read back as installed', async () => {
    const w = fakeWorld();
    const real = w.deps.exec;
    w.deps.exec = (cmd, args, opts) => (cmd === 'npm' && args[0] === 'install' && args.includes('-g') ? { status: 243, stdout: '', stderr: 'npm error EACCES: permission denied' } : real(cmd, args, opts));
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.installFailed });
    expect(readAutoUpdateState(w.a.dir)).toMatchObject({ detail: expect.stringContaining('EACCES') });
    expect(w.calls.filter((c) => c.startsWith('npm ci'))).toHaveLength(1); // the rehearsal in staging; none in the installed package
    expect(fs.existsSync(path.join(w.a.dir, 'just-upgraded.json'))).toBe(false);
  });

  it('a plugin script that exits non-zero is a failed update (Claude Code)', async () => {
    const w = fakeWorld({ channel: 'plugin-marketplace', pluginHost: 'claude-code' });
    const real = w.deps.exec;
    w.deps.exec = (cmd, args, opts) => (cmd === 'bash' ? { status: 1, stdout: '', stderr: 'ERROR: marketplace cache not found' } : real(cmd, args, opts));
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.installFailed });
    expect(readAutoUpdateState(w.a.dir)?.detail).toContain('marketplace cache not found');
  });

  it('the wait is recorded while it lasts (the file a restarted runner counts from), and is gone when it ends', async () => {
    const w = fakeWorld();
    registerLiveHost(w.a.dir, process.pid);
    const waitFile = path.join(w.a.dir, 'auto-update-wait.json');
    let polls = 0;
    let seen: unknown = null;
    w.deps.sleep = async () => {
      polls += 1;
      if (polls === 1) seen = JSON.parse(fs.readFileSync(waitFile, 'utf8'));
      if (polls === 2) fs.rmSync(path.join(w.a.dir, 'live-hosts'), { recursive: true });
    };
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'installed' });
    expect(seen).toMatchObject({ target: '4.13.0', since: expect.stringMatching(/^20\d\d-/) });
    expect(fs.existsSync(waitFile)).toBe(false);
  });

  it('a log that cannot be opened (a directory is in its place) is said on stderr, and nothing is started', async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'auto-update.log'));
    const saved = { MEMESH_DIR: process.env.MEMESH_DIR, MEMESH_DB_PATH: process.env.MEMESH_DB_PATH };
    process.env.MEMESH_DIR = dir;
    delete process.env.MEMESH_DB_PATH;
    const root = tmp();
    fs.mkdirSync(path.join(root, 'scripts', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'hooks', 'auto-update-runner.mjs'), 'process.exit(0);\n');
    const written: string[] = [];
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write);
    try {
      expect(await dispatchAutoUpdate(root, Date.now(), { canSelfUpdate: () => ({ ok: true, label: 'test install' }) })).toEqual({ state: 'failed' });
    } finally {
      err.mockRestore();
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    expect(written.join('')).toContain('durable log unavailable');
    expect(fs.existsSync(path.join(dir, 'auto-update-attempt'))).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('the global install and its way back, with the real npm (a throwaway prefix, cache and HOME)', () => {
  const NODE_BIN = process.execPath;
  function realNpm(env: NodeJS.ProcessEnv, args: string[], cwd?: string) {
    const r = spawnSync('npm', args, { cwd, env, encoding: 'utf8', timeout: 120_000 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }
  /** A package named like MeMesh that prints which version it is; its shrinkwrap is in sync with its package.json, or is not. */
  function makeTarball(base: string, version: string, label: string, inSync: boolean): string {
    const dir = path.join(base, `pkg-${label}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@pcircle/memesh', version, main: 'index.js', files: ['index.js', 'npm-shrinkwrap.json'], devDependencies: inSync ? {} : { 'a-dev-tool': '1.0.0' } }));
    fs.writeFileSync(path.join(dir, 'index.js'), `console.log('${label}');\n`);
    // npm ci refuses a shrinkwrap that does not match package.json: that is the failure that comes AFTER npm install -g succeeded.
    fs.writeFileSync(path.join(dir, 'npm-shrinkwrap.json'), JSON.stringify({ name: '@pcircle/memesh', version, lockfileVersion: 3, requires: true, packages: { '': { name: '@pcircle/memesh', version } } }));
    const packed = spawnSync('npm', ['pack', '--pack-destination', base, '--ignore-scripts', '--silent'], { cwd: dir, encoding: 'utf8', env: { ...process.env, npm_config_cache: path.join(base, 'cache') } });
    if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
    return path.join(base, packed.stdout.trim().split('\n').pop() ?? '');
  }

  function setup(newInSync: boolean) {
    const base = tmp();
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: path.join(base, 'home'), npm_config_prefix: path.join(base, 'prefix'), npm_config_cache: path.join(base, 'cache'), npm_config_offline: 'true', npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' };
    fs.mkdirSync(env.HOME!);
    fs.mkdirSync(env.npm_config_prefix!);
    const oldTgz = makeTarball(base, '4.12.0', 'OLD', true);
    const newTgz = makeTarball(base, '4.13.0', 'NEW', newInSync);
    expect(realNpm(env, ['install', '-g', '--ignore-scripts', oldTgz]).status).toBe(0);
    const installedDir = path.join(env.npm_config_prefix!, 'lib', 'node_modules', '@pcircle', 'memesh');
    const w = fakeWorld({ tarballBuilder: (file) => fs.copyFileSync(newTgz, file) });
    const fake = w.deps.exec;
    // The checks are the fake world's; the install steps are the real npm's, on the throwaway prefix.
    w.deps.exec = (cmd, args, opts) => {
      const mine = cmd === 'npm' && (args[0] === 'root' || (args[0] === 'install' && args.includes('-g')) || (args[0] === 'ci' && opts?.cwd?.startsWith(env.npm_config_prefix!)));
      return mine ? realNpm(env, args, opts?.cwd) : fake(cmd, args, opts);
    };
    const prints = () => spawnSync(NODE_BIN, [path.join(installedDir, 'index.js')], { encoding: 'utf8' }).stdout.trim();
    return { w, installedDir, prints, parent: path.dirname(installedDir) };
  }

  it('control: a release whose pinned install works replaces the old version, and no copy of the old one is left', async () => {
    const t = setup(true);
    expect(t.prints()).toBe('OLD');
    expect(await runAutoUpdate(t.w.deps)).toMatchObject({ outcome: 'installed' });
    expect(t.prints()).toBe('NEW');
    expect(fs.readdirSync(t.parent).filter((n) => n.startsWith('memesh.rollback'))).toEqual([]);
  }, 180_000);

  it('a pinned install that fails after npm install -g succeeded (npm ci refuses the lock) leaves the OLD version in place and running', async () => {
    const t = setup(false);
    expect(t.prints()).toBe('OLD');
    const result = await runAutoUpdate(t.w.deps);
    expect(result).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.dependencyPinFailed });
    expect(t.prints()).toBe('OLD'); // the CLI still runs, which is the point
    expect(JSON.parse(fs.readFileSync(path.join(t.installedDir, 'package.json'), 'utf8')).version).toBe('4.12.0');
    expect(fs.readdirSync(t.parent).filter((n) => n.startsWith('memesh.rollback'))).toEqual([]);
    expect(readAutoUpdateState(t.w.a.dir)?.detail).toContain('previous version was put back');
  }, 180_000);
});

describe('a pin that failed and was undone is tried again by the next update (the doctor says so)', () => {
  it('the next run after a dependencyPinFailed installs the same release once the pin works', async () => {
    const options: Parameters<typeof fakeWorld>[0] = { pinResult: { status: 1, stdout: '', stderr: 'npm error network' } };
    const w = fakeWorld(options);
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.dependencyPinFailed });
    expect(w.deps.currentVersion).toBe('4.12.0'); // what runs did not change: the release is still the newer one
    options.pinResult = undefined; // the network is back
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'installed', reason: AUTO_UPDATE_REASONS.installed });
    expect(readAutoUpdateState(w.a.dir)).toMatchObject({ outcome: 'installed', to: '4.13.0' });
  });
});

describe('a Codex marketplace that an update removed and could not put back is put back by the next run, and only that one', () => {
  /** A fake Codex that really edits config.toml: `marketplace remove` deletes the table, `marketplace add` writes it. */
  function editingCodex(w: ReturnType<typeof fakeWorld>, failures: { restore?: boolean } = {}) {
    const real = w.deps.exec;
    const config = path.join(w.deps.codexHome!, 'config.toml');
    let adds = 0;
    const seen: string[] = [];
    w.deps.exec = (cmd, args, opts) => {
      if (cmd === 'codex' && args[1] === 'marketplace') {
        seen.push(args.slice(2).join(' '));
        if (args[2] === 'remove') { fs.writeFileSync(config, 'model = "mine"\n'); return { status: 0, stdout: '', stderr: '' }; }
        if (args[2] === 'add') {
          adds += 1;
          if (adds === 1) return { status: 1, stdout: '', stderr: 'no such ref' };            // the pinned add fails
          if (failures.restore) return { status: 1, stdout: '', stderr: 'offline' };           // so does the restore
          fs.writeFileSync(config, OFFICIAL_CODEX_CONFIG);
          return { status: 0, stdout: '', stderr: '' };
        }
      }
      return real(cmd, args, opts);
    };
    return { config, seen, restoreWorks: () => { failures.restore = false; } };
  }
  const recordPath = (w: ReturnType<typeof fakeWorld>) => path.join(w.a.dir, CODEX_RESTORE_FILE);

  it('(a) restore failed: the failure writes a record; the next run restores while config.toml is as it was left, and clears the record', async () => {
    const w = fakeWorld({ channel: 'plugin-marketplace', pluginHost: 'codex' });
    const fake = editingCodex(w, { restore: true });
    expect(await runAutoUpdate(w.deps)).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.codexRestoreFailed });
    expect(codexMarketplaceState(w.deps.codexHome!)).toBe('missing');
    const record = JSON.parse(fs.readFileSync(recordPath(w), 'utf8'));
    expect(record).toMatchObject({ marketplace: 'pcircle-memesh', original: 'https://github.com/PCIRCLE-AI/memesh.git', source: 'PCIRCLE-AI/memesh' }); // what config.toml said before, and what is put back
    // the next run: Codex works now
    fake.restoreWorks();
    const calls: string[] = [];
    const exec = w.deps.exec;
    w.deps.exec = (cmd, args, opts) => { if (cmd === 'codex') calls.push(args.join(' ')); return exec(cmd, args, opts); };
    w.deps.readTags = () => ({ latest: '4.13.0' }); // already current: only the repair has anything to do
    await runAutoUpdate(w.deps);
    expect(calls).toContain('plugin marketplace add PCIRCLE-AI/memesh');
    expect(codexMarketplaceState(w.deps.codexHome!)).toBe('official');
    expect(fs.existsSync(recordPath(w))).toBe(false);
    expect(fs.readFileSync(path.join(w.a.dir, 'auto-update.log'), 'utf8')).toContain('was put back');
  });

  it('(c) config.toml changed after the failed restore: nothing is restored, the record is dropped, and the log says why', async () => {
    const w = fakeWorld({ channel: 'plugin-marketplace', pluginHost: 'codex' });
    editingCodex(w, { restore: true });
    await runAutoUpdate(w.deps);
    fs.appendFileSync(path.join(w.deps.codexHome!, 'config.toml'), 'sandbox = "mine"\n'); // the owner edited it
    const calls: string[] = [];
    const exec = w.deps.exec;
    w.deps.exec = (cmd, args, opts) => { if (cmd === 'codex') calls.push(args.join(' ')); return exec(cmd, args, opts); };
    w.deps.readTags = () => ({ latest: '4.13.0' });
    await runAutoUpdate(w.deps);
    expect(calls.filter((c) => c.startsWith('plugin marketplace add'))).toEqual([]);
    expect(codexMarketplaceState(w.deps.codexHome!)).toBe('missing');
    expect(fs.existsSync(recordPath(w))).toBe(false);
    expect(fs.readFileSync(path.join(w.a.dir, 'auto-update.log'), 'utf8')).toContain('config.toml changed after the failed restore');
  });

  it('a restore that still fails keeps the record, so the run after tries again', async () => {
    const w = fakeWorld({ channel: 'plugin-marketplace', pluginHost: 'codex' });
    editingCodex(w, { restore: true });
    await runAutoUpdate(w.deps);
    w.deps.readTags = () => ({ latest: '4.13.0' });
    await runAutoUpdate(w.deps); // Codex is still offline
    expect(fs.existsSync(recordPath(w))).toBe(true);
    expect(fs.readFileSync(path.join(w.a.dir, 'auto-update.log'), 'utf8')).toContain('could not be put back yet');
  });

  it('(b) no record and a missing marketplace: not restored (the owner removed it), and the reason names the reinstall, not an unpinned add', async () => {
    const w = fakeWorld({ channel: 'plugin-marketplace', pluginHost: 'codex', codexConfig: 'model = "mine"\n' });
    const result = await runAutoUpdate(w.deps);
    expect(result).toMatchObject({ outcome: 'skipped', reason: AUTO_UPDATE_REASONS.codexMarketplaceMissing });
    expect(w.calls.filter((c) => c.startsWith('codex'))).toEqual([]);
    expect(result.reason).toContain('memesh update --reinstall');
    expect(result.reason).not.toContain('codex plugin add');
    expect(AUTO_UPDATE_REASONS.codexRestoreFailed).toContain('not because you removed it');
  });

  it('the owner asking for a reinstall adds the missing marketplace back, pinned, and installs the plugin', async () => {
    const w = fakeWorld({ channel: 'plugin-marketplace', pluginHost: 'codex', codexConfig: 'model = "mine"\n' });
    w.deps.reinstall = true; w.deps.manual = true; w.deps.currentVersion = '4.13.0';
    const steps: string[] = [];
    const exec = w.deps.exec;
    w.deps.exec = (cmd, args, opts) => { if (cmd === 'codex') steps.push(args.join(' ')); return exec(cmd, args, opts); };
    const result = await runAutoUpdate(w.deps);
    expect(result.outcome).toBe('installed');
    expect(steps[0]).toBe(`plugin marketplace add PCIRCLE-AI/memesh --ref ${RELEASE_COMMIT}`);
    expect(steps.some((x) => x.startsWith('plugin marketplace remove'))).toBe(false); // nothing to remove: it was not there
  });

  it('a damaged record is dropped and nothing is run from it', async () => {
    const w = fakeWorld({ channel: 'plugin-marketplace', pluginHost: 'codex', codexConfig: 'model = "mine"\n' });
    fs.writeFileSync(recordPath(w), '{broken');
    await runAutoUpdate(w.deps);
    expect(w.calls.filter((c) => c.startsWith('codex'))).toEqual([]);
    expect(fs.existsSync(recordPath(w))).toBe(false);
  });
});

// Needs the network (the published package and its dependencies are installed for real), so it only runs when asked for:
//   MEMESH_REAL_MEMESH=1 node scripts/run-tests-isolated.mjs tests/core/auto-update.test.ts --maxWorkers=1 -t "real MeMesh"
describe.skipIf(process.platform === 'win32' || process.env.MEMESH_REAL_MEMESH !== '1')('a failed update with the real MeMesh as the old version: it still runs afterwards', () => {
  const published = '4.12.0'; // a release that is on npm, installed with its real dependencies
  function realNpm(env: NodeJS.ProcessEnv, args: string[], cwd?: string) {
    const r = spawnSync('npm', args, { cwd, env, encoding: 'utf8', timeout: 240_000 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }
  function setup() {
    const base = tmp();
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: path.join(base, 'home'), npm_config_prefix: path.join(base, 'prefix'), npm_config_cache: path.join(base, 'cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' };
    fs.mkdirSync(env.HOME!);
    fs.mkdirSync(env.npm_config_prefix!);
    const oldInstall = realNpm(env, ['install', '-g', `@pcircle/memesh@${published}`]);
    expect(oldInstall.status, oldInstall.stderr).toBe(0);
    // The new version is this tree, packed as it would be published (prepack writes the shrinkwrap).
    const packed = spawnSync('npm', ['pack', '--pack-destination', base, '--silent'], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, npm_config_cache: path.join(base, 'pack-cache') } });
    expect(packed.status, packed.stderr).toBe(0);
    const newTgz = path.join(base, packed.stdout.trim().split('\n').pop() ?? '');
    const installedDir = path.join(env.npm_config_prefix!, 'lib', 'node_modules', '@pcircle', 'memesh');
    const w = fakeWorld({ tarballBuilder: (file) => fs.copyFileSync(newTgz, file) });
    const fake = w.deps.exec;
    // The checks are the fake world's. The install steps are the real npm's, on the throwaway prefix; the pinned install
    // of dependencies (npm ci) is the step that fails: an empty cache and a registry nobody listens on.
    const dead: NodeJS.ProcessEnv = { ...env, npm_config_cache: path.join(base, 'cache-empty'), npm_config_registry: 'http://127.0.0.1:9/', npm_config_fetch_retries: '0', npm_config_fetch_retry_mintimeout: '0', npm_config_fetch_retry_maxtimeout: '0' };
    w.deps.exec = (cmd, args, opts) => {
      if (cmd === 'npm' && args[0] === 'ci' && opts?.cwd?.startsWith(env.npm_config_prefix!)) return realNpm(dead, args, opts.cwd);
      const mine = cmd === 'npm' && (args[0] === 'root' || (args[0] === 'install' && args.includes('-g')));
      return mine ? realNpm(env, args, opts?.cwd) : fake(cmd, args, opts);
    };
    return { w, installedDir, base };
  }
  function expectOldStillRuns(t: ReturnType<typeof setup>) {
    const version = spawnSync(process.execPath, [path.join(t.installedDir, 'dist', 'transports', 'cli', 'cli.js'), '--version'], { encoding: 'utf8' });
    expect(version.status === 0, version.stderr).toBe(true);
    expect(version.stdout.trim()).toBe(published);
    // The Claude host runtime loads every module it needs (its dependencies are there) and reaches its own check of its
    // configuration: that message comes from the program, a module that could not be loaded would say so instead.
    const host = spawnSync(process.execPath, [path.join(t.installedDir, 'dist', 'host-runtime', 'claude.js')], { encoding: 'utf8', input: '', timeout: 60_000 });
    expect(`${host.stdout}${host.stderr}`).toContain('A host config file is required');
    expect(`${host.stdout}${host.stderr}`).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/);
    expect(JSON.parse(fs.readFileSync(path.join(t.installedDir, 'package.json'), 'utf8')).version).toBe(published);
    expect(fs.existsSync(path.join(t.installedDir, 'node_modules', '@modelcontextprotocol', 'sdk'))).toBe(true);
    expect(fs.readdirSync(path.dirname(t.installedDir)).filter((n) => n.startsWith('memesh.rollback'))).toEqual([]);
  }

  it.each([['automatic', false], ['by hand (memesh update)', true]])('the new version\'s pinned install fails, %s: the real MeMesh is put back and still runs', async (_label, manual) => {
    const t = setup();
    t.w.deps.manual = manual;
    t.w.deps.currentVersion = published;
    const result = await runAutoUpdate(t.w.deps);
    expect(result).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.dependencyPinFailed });
    expectOldStillRuns(t);
    expect(readAutoUpdateState(t.w.a.dir)?.detail).toContain('previous version was put back');
  }, 600_000);
});

describe('Q4_03 / Q4_08 rewritten probe: a pin that fails after the install is undone, and says so', () => {
  it('the old version is what is left, and the record says the previous version was put back', async () => {
    const w = fakeWorld({ pinResult: { status: 1, stdout: '', stderr: 'npm error network' } });
    const result = await runAutoUpdate(w.deps);
    expect(result).toMatchObject({ outcome: 'failed', reason: AUTO_UPDATE_REASONS.dependencyPinFailed });
    expect(readAutoUpdateState(w.a.dir)?.detail).toContain('previous version was put back');
  });
});
