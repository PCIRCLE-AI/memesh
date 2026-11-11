/**
 * Automatic updates: the one place that decides whether MeMesh updates itself.
 *
 * Every install channel (npm global, Claude Code plugin, Codex plugin) comes
 * through `runAutoUpdate`, and the `off` setting is read here and nowhere else:
 * the hooks only start the runner, which calls this module.
 *
 * What it promises:
 *   - On by default, any bump (major included). An explicit `off` is never
 *     overridden, whichever of the places it could be written in says it.
 *   - It follows the channel the install is on: a stable install never moves to
 *     a trial build published under `next`.
 *   - The package source is verified before anything is installed (npm
 *     provenance bound to this project's repository, workflow and tag).
 *   - The database is backed up first, and nothing is replaced while a session
 *     is running: the swap waits until every registered host has exited, so the
 *     new version takes effect in the next session.
 *   - Every early return and every result is written down (`auto-update-state.json`
 *     and `auto-update.log`); `memesh doctor` reads the first.
 */
import { spawn, spawnSync } from 'child_process';
import { createHash, X509Certificate } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from '../storage/sqlite.js';
import { detectPluginHost, getCurrentInstallChannel, getInstallChannelSupport, type InstallChannel } from './install-channel.js';
import { getMemeshDirFromDbPath, memeshDir } from './paths.js';
import { updateConfigInDir } from './config.js';
import { inspectInstall, refreshTargets, refreshInstalls, registryProblemResult, staleInstalls, type InstallResult } from './hermes-provider.js';
import { compareSemVerPrecedence, normalizeRegistryVersion, parseSemVer } from './semver.js';
import { writeJustUpgradedMarker } from './update-notice.js';
import { processStartTag, sameProcessAlive } from './process-identity.js';
import { removeGroupAndOtherAccess } from './file-mode.js';
import { classifyBump, getInstalledGlobalVersion, type AutoUpdatePolicy } from './updater.js';

export const DEFAULT_AUTO_UPDATE_POLICY: AutoUpdatePolicy = 'major';
export const PACKAGE_NAME = '@pcircle/memesh';
/** The repository and workflow a release must have been built by. */
export const EXPECTED_SOURCE = {
  repository: 'https://github.com/PCIRCLE-AI/memesh',
  workflowPath: '.github/workflows/publish-npm.yml',
} as const;

export const STATE_FILE = 'auto-update-state.json';
export const LOG_FILE = 'auto-update.log';
export const LIVE_HOSTS_DIR = 'live-hosts';
export const WAIT_FILE = 'auto-update-wait.json';
export const ATTEMPT_FILE = 'auto-update-attempt';
/** Made (atomically) by the one process that is deciding whether to start a runner; removed when it has decided. */
export const DISPATCH_CLAIM = 'auto-update-dispatch.claim';
/** A claim older than this was left by a process that died: it is taken over. */
const DISPATCH_CLAIM_STALE_MS = 60_000;
export const INSTALLING_FILE = 'auto-update-installing.json';
/** Written when an update removed the Codex marketplace and could not put it back: what to restore, and what config.toml looked like when it was left. */
export const CODEX_RESTORE_FILE = 'auto-update-codex-restore.json';
export const BACKUPS_KEPT = 3;
/** The runner is started at most this often; each start is recorded. */
export const ATTEMPT_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const LIVE_WAIT_POLL_MS = 15 * 1000;
/** Running sessions delay the swap, but never longer than this: someone who never closes a session must still get updates. */
export const LIVE_WAIT_MAX_MS = 3 * 24 * 60 * 60 * 1000;
export const CODEX_MARKETPLACE = 'pcircle-memesh';
export const CODEX_PLUGIN = 'memesh@pcircle-memesh';
export const CODEX_MARKETPLACE_SOURCE = 'PCIRCLE-AI/memesh';

/** Why an attempt ended. Stored verbatim; never free text from a registry or a user. */
/**
 * Owner-only files and directories. The `mode` given to mkdir / writeFile / open is applied only when the
 * thing is CREATED: one that already exists with looser permissions (an older MeMesh, a hand-made directory)
 * keeps them. So group and others are taken away again after every create-or-write, and the owner's bits are
 * left exactly as they are: a fixed 0600/0700 would ADD the owner's write bit to a folder or file its owner
 * made read-only (a snapshot, a backup), which is what #520 forbids (see removeGroupAndOtherAccess). A path
 * that cannot be changed is said on stderr once (the runner's stderr is the log); this never throws.
 */
export function ownerOnly(target: string): void {
  removeGroupAndOtherAccess(target);
}

export function ensureOwnerDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  ownerOnly(dir);
}

export const AUTO_UPDATE_REASONS = {
  policyOff: 'policy is off',
  policyOffUnreadableConfig: 'policy is off: a config file could not be read, so an explicit off cannot be ruled out',
  policyOffInvalidValue: 'policy is off: a setting held a value that is not off, patch, minor or major',
  policyOffUpdateCheck: 'policy is off: update checks were turned off (updateCheck=false)',
  policyOffCi: 'no update: this run is inside CI or a container and the setting was not given explicitly',
  policyOffNoAccountHome: 'no update: the account\'s home directory cannot be determined (no passwd entry) and the setting was not given explicitly',
  policyOffForeignHome: 'no update: this run uses a data directory that is not the account\'s own ~/.memesh and the setting was not given explicitly',
  channelUnsupported: 'no update: this install channel cannot update itself (source checkout, project-local or unknown)',
  registryUnreachable: 'no update: the npm registry did not answer',
  upToDate: 'already on the newest version for this channel',
  bumpNotPermitted: 'no update: the policy does not permit this kind of version bump',
  sourceNotVerified: 'not installed: the package source could not be verified',
  tarballMismatch: 'not installed: the downloaded package does not match the verified one',
  dependencyPinFailed: 'install ran but its dependencies could not be set to the versions the release pins; the previous version was put back',
  installNotUndone: 'an install ran, its dependencies could not be set to the versions the release pins, AND the previous version could not be put back: run `memesh update --reinstall` to finish it (until then MeMesh may not start)',
  dependenciesNotFetched: 'not installed: the release\'s pinned dependencies could not be fetched and checked (network, registry or a hash that did not match), so the installed version was not touched',
  globalDirUnknown: 'not installed: the directory npm keeps global packages in could not be found, so a failed install could not be undone',
  rollbackUnavailable: 'not installed: a copy of the installed version could not be made, so a failed install could not be undone',
  commitNotOnMain: 'not installed: the release was not built from a commit on the main branch of the official repository',
  commitUnconfirmed: 'not installed: it could not be confirmed that the release commit is on the main branch of the official repository (GitHub did not answer); a later run tries again',
  dependenciesNotPinned: 'not installed: the package does not pin its dependencies (no complete npm-shrinkwrap.json), so what would be installed could not be checked',
  codexMarketplaceUnreadable: 'not installed: the Codex config.toml could not be read, so it is not known whether the pcircle-memesh marketplace is the official one',
  codexHomeUnknown: 'not installed: the Codex directory this plugin lives in could not be worked out from where it is installed, so the Codex plugin was left alone',
  codexMarketplaceMissing: 'not installed: the Codex marketplace pcircle-memesh is not in config.toml and MeMesh did not remove it, so it was taken as removed on purpose and not added back; `memesh update --reinstall` adds it back (pinned to this release) and installs the plugin',
  codexMarketplaceForeign: 'not installed: the Codex marketplace named pcircle-memesh does not come from the official repository, so it was left alone',
  codexInstallFailed: 'Codex plugin install failed; the marketplace was put back to its unpinned state',
  codexRestoreFailed: 'Codex plugin install failed AND MeMesh could not put the marketplace it had removed back (the pcircle-memesh marketplace is now missing because of this update, not because you removed it): the next run puts it back if config.toml is still as this run left it, or run `codex plugin marketplace add PCIRCLE-AI/memesh` yourself',
  codexRemoveFailed: 'Codex plugin not updated: the marketplace could not be removed, so nothing was changed',
  codexReadbackFailed: 'Codex plugin install ran but did not install the target version',
  claudeReadbackFailed: 'Claude Code plugin install ran but the plugin registry does not record the target commit',
  backupFailed: 'not installed: the database backup failed',
  waitingForHosts: 'waiting: a session is still running; the update is applied after it ends',
  installedAfterWait: 'installed after waiting 3 days: sessions were still running, so they may use the new files before they restart',
  hostsUnreadable: 'running sessions cannot be listed (the live-hosts directory is unreadable or cannot be written to, so sessions could not register), so they are assumed to be running',
  installFailed: 'install failed',
  tarballChanged: 'not installed: the verified tarball changed on disk between the check and the install',
  readbackFailed: 'install ran but the installed version is not the target',
  lockLost: 'not installed: this runner no longer holds the update lock (another update took it over), so it stopped',
  installed: 'installed',
} as const;

export type AutoUpdateOutcome = 'installed' | 'skipped' | 'failed' | 'waiting';

export interface AutoUpdateState {
  at: string;
  outcome: AutoUpdateOutcome;
  reason: string;
  from: string | null;
  to: string | null;
  channel: InstallChannel | null;
  backup: string | null;
  /** While outcome is 'waiting': when the wait for running sessions began (it survives a restarted runner). */
  waitingSince: string | null;
  /** What happened to each Hermes provider copy MeMesh installed (null: there was none to consider). */
  hermes: InstallResult[] | null;
  /** Something about this attempt that is not its outcome, e.g. a recovered update lock. */
  notice?: string | null;
  /** The short reason behind a failure or skip (an npm error, the step that failed), for the terminal and doctor. */
  detail?: string | null;
}

// ─── policy ────────────────────────────────────────────────────────────────

const POLICY_RANK: Record<AutoUpdatePolicy, number> = { off: 0, patch: 1, minor: 2, major: 3 };
const BUMP_RANK = { patch: 1, minor: 2, major: 3 } as const;

export interface PolicyDecision {
  policy: AutoUpdatePolicy;
  source: 'env' | 'config' | 'account-config' | 'default' | 'none';
  /** One of AUTO_UPDATE_REASONS when the policy is off. */
  reason: string | null;
  /** For the log only: the file or variable behind the reason. */
  detail?: string;
}

export interface PolicyInput {
  env: NodeJS.ProcessEnv;
  /** The data directory this process is using. */
  activeDir: string;
  /** The account's real home directory, whatever HOME says; null when the system cannot say (no passwd entry). */
  accountHome: string | null;
  /** Other directories a `memesh config set` of this process writes to (the config directory can differ from the database directory). */
  extraConfigDirs?: string[];
}

type ConfigRead = { state: 'absent' } | { state: 'unreadable'; why: string } | { state: 'ok'; raw: Record<string, unknown> };

/**
 * "Absent" needs two answers: the read says ENOENT and an lstat of the same path
 * says ENOENT too. A dangling symlink (read: ENOENT, lstat: exists), a directory
 * that cannot be entered (EACCES), a path through a file (ENOTDIR) all mean the
 * file may exist and say off, so they are unreadable, not absent.
 */
function readConfigFile(file: string): ConfigRead {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    if (code !== 'ENOENT') return { state: 'unreadable', why: code };
    try {
      fs.lstatSync(file);
      return { state: 'unreadable', why: 'dangling symlink' };
    } catch (lerr) {
      const lcode = (lerr as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      return lcode === 'ENOENT' ? { state: 'absent' } : { state: 'unreadable', why: lcode };
    }
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'unreadable', why: 'not a JSON object' };
    return { state: 'ok', raw: parsed as Record<string, unknown> };
  } catch {
    return { state: 'unreadable', why: 'not valid JSON' };
  }
}

/** Inside a CI system or a container (the `container` variable docker, podman and systemd-nspawn set), where a default-on update would change a shared runner or a throwaway filesystem. */
export function isCi(env: NodeJS.ProcessEnv): boolean {
  const truthy = (v: string | undefined) => v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
  return truthy(env.CI)
    || ['GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'JENKINS_URL', 'TF_BUILD', 'TRAVIS', 'APPVEYOR', 'CODEBUILD_BUILD_ID', 'TEAMCITY_VERSION', 'DRONE', 'BITBUCKET_BUILD_NUMBER', 'CIRRUS_CI', 'SEMAPHORE', 'container'].some((k) => truthy(env[k]));
}

/** The account's real home, or null where the system has no passwd entry for this uid (arbitrary-uid containers). */
export function safeAccountHome(): string | null {
  try {
    const home = os.userInfo().homedir;
    return home ? home : null;
  } catch {
    return null;
  }
}

function parsePolicy(value: unknown): AutoUpdatePolicy | null {
  if (typeof value !== 'string') return null;
  const lowered = value.toLowerCase();
  return lowered === 'off' || lowered === 'patch' || lowered === 'minor' || lowered === 'major' ? lowered : null;
}

function samePath(a: string, b: string): boolean {
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return real(a) === real(b);
}

/**
 * The policy in force. Any `off` found anywhere wins: the environment, this
 * process's config, and the account's real config (so a run started with a
 * different HOME or data directory cannot update a binary the owner shares
 * with the account that said off). A config that cannot be read, or a setting
 * with a value that is not one of the four, is treated as off: absence of
 * evidence is not consent. With nothing explicit, the default applies only to
 * the account's own `~/.memesh`.
 */
export function resolveUpdatePolicy(input: PolicyInput): PolicyDecision {
  const off = (reason: string, source: PolicyDecision['source'], detail?: string): PolicyDecision => ({ policy: 'off', source, reason, ...(detail ? { detail } : {}) });
  const accountDir = input.accountHome === null ? null : path.join(input.accountHome, '.memesh');
  const configs: Array<{ file: string; source: 'config' | 'account-config' }> = [];
  const seen: string[] = [];
  const addConfigDir = (dir: string, source: 'config' | 'account-config') => {
    if (seen.some((d) => samePath(d, dir))) return;
    seen.push(dir);
    configs.push({ file: path.join(dir, 'config.json'), source });
  };
  addConfigDir(input.activeDir, 'config');
  const extraDirs = Array.isArray(input.extraConfigDirs) ? input.extraConfigDirs : [];
  for (const dir of extraDirs) addConfigDir(dir, 'config');
  if (accountDir !== null) addConfigDir(accountDir, 'account-config');

  const explicit: Array<{ policy: AutoUpdatePolicy; source: PolicyDecision['source'] }> = [];
  const envValue = input.env.MEMESH_AUTO_UPDATE;
  if (envValue !== undefined) {
    const parsed = parsePolicy(envValue);
    if (parsed === null) return off(AUTO_UPDATE_REASONS.policyOffInvalidValue, 'env');
    if (parsed === 'off') return off(AUTO_UPDATE_REASONS.policyOff, 'env');
    explicit.push({ policy: parsed, source: 'env' });
  }
  for (const { file, source } of configs) {
    const read = readConfigFile(file);
    if (read.state === 'unreadable') return off(AUTO_UPDATE_REASONS.policyOffUnreadableConfig, source, `${file}: ${read.why}`);
    if (read.state === 'absent') continue;
    if (read.raw.updateCheck === false) return off(AUTO_UPDATE_REASONS.policyOffUpdateCheck, source);
    if (read.raw.autoUpdate === undefined) continue;
    const parsed = parsePolicy(read.raw.autoUpdate);
    if (parsed === null) return off(AUTO_UPDATE_REASONS.policyOffInvalidValue, source);
    explicit.push({ policy: parsed, source });
  }
  const refused = explicit.find((e) => e.policy === 'off');
  if (refused) return off(AUTO_UPDATE_REASONS.policyOff, refused.source);
  if (explicit.length > 0) return { policy: explicit[0].policy, source: explicit[0].source, reason: null };

  if (accountDir === null) return off(AUTO_UPDATE_REASONS.policyOffNoAccountHome, 'none');
  if (isCi(input.env)) return off(AUTO_UPDATE_REASONS.policyOffCi, 'none');
  const ownData = samePath(input.activeDir, accountDir) && !input.env.MEMESH_DB_PATH && !input.env.MEMESH_DIR;
  if (!ownData) return off(AUTO_UPDATE_REASONS.policyOffForeignHome, 'none');
  return { policy: DEFAULT_AUTO_UPDATE_POLICY, source: 'default', reason: null };
}

/** The account's own data directory (`~/.memesh`), or null when the account's home cannot be determined. */
export function accountMemeshDir(): string | null {
  const home = safeAccountHome();
  return home === null ? null : path.join(home, '.memesh');
}

/**
 * `memesh config set autoUpdate off` writes the config of THIS process's data directory. A MeMesh started without
 * that directory (a host that does not pass MEMESH_DIR) looks in the account's own `~/.memesh` and would never
 * see that off, and would update. So an explicit off is also written where every MeMesh looks. Returns where it
 * was written, or the error (the caller must say so: the off is then not everywhere).
 */
export function propagateOff(activeConfigDir: string, accountDir: string | null): { path: string | null; error: string | null } {
  if (accountDir === null || samePath(accountDir, activeConfigDir)) return { path: null, error: null };
  const file = path.join(accountDir, 'config.json');
  try {
    updateConfigInDir(accountDir, { autoUpdate: 'off' });
    return { path: file, error: null };
  } catch (err) {
    return { path: file, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * What in the account's own config keeps automatic updates off although the config this process uses does not: a file that
 * says `off`, or one that cannot be read (that counts as off too). Null when it holds nothing back, or is the config in use.
 */
export function accountConfigHolding(activeConfigDir: string, accountDir: string | null): { path: string; kind: 'off' | 'unreadable'; why: string | null } | null {
  if (accountDir === null || samePath(accountDir, activeConfigDir)) return null;
  const file = path.join(accountDir, 'config.json');
  const read = readConfigFile(file);
  if (read.state === 'unreadable') return { path: file, kind: 'unreadable', why: read.why };
  return read.state === 'ok' && read.raw.autoUpdate === 'off' ? { path: file, kind: 'off', why: null } : null;
}

export function currentPolicy(env: NodeJS.ProcessEnv = process.env): PolicyDecision {
  return resolveUpdatePolicy({ env, activeDir: getMemeshDirFromDbPath(), extraConfigDirs: [memeshDir()], accountHome: safeAccountHome() });
}

// ─── target ────────────────────────────────────────────────────────────────

export interface DistTags { latest?: string; next?: string }

/** Which line this install follows, and the version that line points at. */
export function chooseTarget(current: string, tags: DistTags): { stream: 'latest' | 'next'; target: string | null } {
  const cur = parseSemVer(current);
  const latest = tags.latest ? parseSemVer(tags.latest) : null;
  const onNext = Boolean(cur && (cur.prerelease !== null || current === tags.next || (latest && compareSemVerPrecedence(cur, latest) > 0)));
  let stream: 'latest' | 'next' = onNext ? 'next' : 'latest';
  let target = tags[stream] ?? null;
  // A trial line that stopped behind the stable one (`next` still points at what is installed, `latest` moved on) would never update:
  // the stable release is newer than this install, so it is the target.
  if (stream === 'next' && cur && latest && compareSemVerPrecedence(latest, cur) > 0) {
    const nextVersion = tags.next ? parseSemVer(tags.next) : null;
    if (!nextVersion || compareSemVerPrecedence(nextVersion, cur) <= 0) { stream = 'latest'; target = tags.latest ?? null; }
  }
  const parsedTarget = target ? parseSemVer(target) : null;
  if (!cur || !parsedTarget || compareSemVerPrecedence(cur, parsedTarget) >= 0) return { stream, target: null };
  return { stream, target };
}

export function bumpKind(from: string, to: string): 'patch' | 'minor' | 'major' {
  return classifyBump(from, to) ?? 'patch';
}

export function policyPermits(policy: AutoUpdatePolicy, bump: 'patch' | 'minor' | 'major'): boolean {
  return POLICY_RANK[policy] >= BUMP_RANK[bump];
}

// ─── source verification ───────────────────────────────────────────────────

export type SourceVerdict = { ok: true; gitCommit: string } | { ok: false; reason: string };

interface AuditEntry { name?: string; version?: string; attestationBundles?: unknown[] }

/** Walk `value` along `keys`; undefined as soon as a step is not an object. */
function at(value: unknown, ...keys: Array<string | number>): unknown {
  let cur = value;
  for (const key of keys) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

/**
 * What npm verified of an attestation is its `.bundle` (the sigstore bundle: certificate, signature, statement), and only
 * that. The registry's answer wraps it in an object that carries other fields next to it (npm does not look at them): anything
 * read from outside `.bundle` can be put there by a mirror or a registry that was never asked to sign it. So the statement and
 * the certificate are read from `element.bundle` and from nowhere else; an element without one is no evidence.
 */
function statementOf(element: unknown): unknown {
  const payload = at(element, 'bundle', 'dsseEnvelope', 'payload');
  if (typeof payload !== 'string') return null;
  try { return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')); } catch { return null; }
}

/**
 * The identity the signing certificate of an attestation names (the URI in its subject alternative name), read from the
 * certificate inside `element.bundle` only, or null.
 * Two bundle formats exist: v0.2 (what npm 10 publishes) keeps the certificate in
 * `verificationMaterial.x509CertificateChain.certificates[0]`; v0.3 (what npm 11 publishes) in
 * `verificationMaterial.certificate`. Reading only one would stop every update the day a release is published by the other.
 */
export function signerIdentity(element: unknown): string | null {
  const root = at(element, 'bundle');
  const raw = at(root, 'verificationMaterial', 'x509CertificateChain', 'certificates', 0, 'rawBytes')
    ?? at(root, 'verificationMaterial', 'certificate', 'rawBytes');
  if (typeof raw !== 'string') return null;
  try {
    const san = new X509Certificate(Buffer.from(raw, 'base64')).subjectAltName;
    const uri = san === undefined ? undefined : /URI:([^,\s]+)/.exec(san)?.[1];
    return uri ?? null;
  } catch {
    return null;
  }
}

export interface JudgeOptions {
  /** sha512 (hex) of the tarball that will be installed: the attested subject must be exactly this file. */
  tarballSha512Hex: string;
  /** Test seam: how the signer is read from a bundle. */
  signerOf?: (bundle: unknown) => string | null;
}

/**
 * Judge `npm audit signatures --json --include-attestations` for one package.
 * The exit code is not used: a version published without provenance exits 0
 * and appears in neither the verified nor the missing list, so only presence
 * in `verified`, with a provenance statement built by this project's workflow
 * at this version's tag, counts.
 */
export function judgeAuditSignatures(json: string, name: string, version: string, options: JudgeOptions): SourceVerdict {
  let parsed: Record<string, AuditEntry[]>;
  try { parsed = JSON.parse(json); } catch { return { ok: false, reason: 'npm audit signatures printed no JSON' }; }
  // Both lists must be present: a reply with neither is not "nothing wrong".
  if (!Array.isArray(parsed.invalid) || !Array.isArray(parsed.verified)) return { ok: false, reason: 'npm audit signatures output has no verified/invalid lists' };
  if (parsed.invalid.length > 0) return { ok: false, reason: 'a package in the install has an invalid signature' };
  const entry = parsed.verified.find((e) => e.name === name && e.version === version);
  if (!entry) return { ok: false, reason: `${name}@${version} has no verified signature and provenance` };
  if (!Array.isArray(entry.attestationBundles)) return { ok: false, reason: 'no attestation was included for this version' };
  for (const bundle of entry.attestationBundles) {
    const statement = statementOf(bundle);
    if (at(statement, 'predicateType') !== 'https://slsa.dev/provenance/v1') continue;
    const subjectList = at(statement, 'subject');
    const subjects: unknown[] = Array.isArray(subjectList) ? subjectList : [];
    const subjectNames = subjects.map((s) => String(at(s, 'name')));
    if (!subjectNames.includes(`pkg:npm/${name.replace('@', '%40')}@${version}`)) continue;
    const workflow = at(statement, 'predicate', 'buildDefinition', 'externalParameters', 'workflow');
    const digest = subjects.find((subject) => at(subject, 'name') === `pkg:npm/${name.replace('@', '%40')}@${version}`);
    if (at(digest, 'digest', 'sha512') !== options.tarballSha512Hex) return { ok: false, reason: 'the attested package digest is not the digest of the downloaded tarball' };
    const expectedSigner = `${EXPECTED_SOURCE.repository}/${EXPECTED_SOURCE.workflowPath}@refs/tags/v${version}`;
    if ((options.signerOf ?? signerIdentity)(bundle) !== expectedSigner) return { ok: false, reason: 'the signing certificate does not name this repository\'s release workflow at this version\'s tag' };
    if (at(workflow, 'repository') !== EXPECTED_SOURCE.repository) return { ok: false, reason: 'provenance names a different repository' };
    if (at(workflow, 'path') !== EXPECTED_SOURCE.workflowPath) return { ok: false, reason: 'provenance names a different workflow' };
    if (at(workflow, 'ref') !== `refs/tags/v${version}`) return { ok: false, reason: 'provenance names a different tag' };
    const commit = at(statement, 'predicate', 'buildDefinition', 'resolvedDependencies', 0, 'digest', 'gitCommit');
    if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) return { ok: false, reason: 'provenance carries no commit' };
    return { ok: true, gitCommit: commit };
  }
  return { ok: false, reason: 'no provenance statement for this version' };
}

/**
 * The release workflow only checks "this commit is on main" in a step anybody who can push a branch could edit, so the
 * updater asks for itself: GitHub's compare endpoint, with the attested commit as the base and `main` as the head,
 * answers `ahead` or `identical` exactly when the commit is an ancestor of main (and then the merge base IS the commit).
 * Asked with the machine's own node (`fetch`), so no other program is needed. (The answer lists the changed files too, up
 * to the cap of 300: about a megabyte at most, read once per update.)
 */
export const COMPARE_SCRIPT ="fetch(process.argv[1],{headers:{accept:'application/vnd.github+json','user-agent':'memesh-auto-update'},signal:AbortSignal.timeout(20000)}).then(async(r)=>{process.stdout.write(r.status+'\\n'+await r.text())}).catch((e)=>{process.stderr.write(String(e));process.exit(1)})";

export function compareUrl(commit: string): string {
  const slug = EXPECTED_SOURCE.repository.replace('https://github.com/', '');
  // `refs/heads/main`, not `main`: a tag or another ref named main must not be able to stand in for the branch.
  return `https://api.github.com/repos/${slug}/compare/${commit}...refs/heads/main?per_page=1`;
}

/** Is a proxy set for this process's environment? (Node's fetch ignores it unless told to use it.) */
export function proxyConfigured(env: NodeJS.ProcessEnv): boolean {
  return ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some((k) => typeof env[k] === 'string' && env[k] !== '');
}

/** Node reads HTTP(S)_PROXY for fetch when NODE_USE_ENV_PROXY=1 from 24.0 and 22.21 on; before that it cannot. */
export function nodeUsesEnvProxy(version: string = process.versions.node): boolean {
  const [major, minor] = version.split('.').map(Number);
  return major > 24 || major === 24 || (major === 22 && minor >= 21);
}

/** The environment the commit lookup runs in: with a proxy set, fetch is told to use it (where this node can). */
export function compareEnv(env: NodeJS.ProcessEnv, version: string = process.versions.node): NodeJS.ProcessEnv {
  return proxyConfigured(env) && nodeUsesEnvProxy(version) ? { ...env, NODE_USE_ENV_PROXY: '1' } : env;
}

export type MainVerdict = { ok: true } | { ok: false; code: 'notOnMain' | 'unconfirmed'; detail: string };

/** Judge the compare answer (`<http status>\n<body>`). Anything that is not a clear yes is a no; only a clear no is final. */
export function judgeCommitOnMain(result: { status: number | null; stdout: string; stderr: string }, commit: string, proxyIgnored = false): MainVerdict {
  if (result.status !== 0) {
    // A proxy that this node cannot use is the likely reason a lookup from behind one times out: say so instead of a bare timeout.
    const note = proxyIgnored ? `; a proxy is configured but this Node (${process.versions.node}) does not use it for fetch (it needs Node 22.21 or 24 and newer), so the request went out directly` : '';
    return { ok: false, code: 'unconfirmed', detail: `the lookup did not complete (${result.stderr.trim().slice(0, 120) || `exit ${result.status ?? 'none'}`})${note}` };
  }
  const newline = result.stdout.indexOf('\n');
  const http = newline < 0 ? result.stdout : result.stdout.slice(0, newline);
  const body = newline < 0 ? '' : result.stdout.slice(newline + 1);
  // 404: GitHub does not know this commit in the repository at all (a commit that only exists in somebody's fork).
  if (http === '404') return { ok: false, code: 'notOnMain', detail: 'the repository has no such commit' };
  if (http !== '200') return { ok: false, code: 'unconfirmed', detail: `GitHub answered ${http || 'nothing'}` };
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return { ok: false, code: 'unconfirmed', detail: 'GitHub\'s answer was not JSON' }; }
  const status = at(parsed, 'status');
  const mergeBase = at(parsed, 'merge_base_commit', 'sha');
  if (typeof status !== 'string' || typeof mergeBase !== 'string') return { ok: false, code: 'unconfirmed', detail: 'GitHub\'s answer had no status and merge base' };
  if ((status === 'ahead' || status === 'identical') && mergeBase === commit) return { ok: true };
  return { ok: false, code: 'notOnMain', detail: `the commit is ${status} of main, not part of it` };
}

/** The same questions scripts/shrinkwrap.mjs asks when it writes the file (tests/core/shrinkwrap.test.ts requires the two to agree). */
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
function shrinkwrapEntryProblem(key: string, entry: unknown): string | null {
  const where = key.replace(/^node_modules\//, '');
  const version = at(entry, 'version');
  if (typeof version !== 'string') return `${where} has no pinned version`;
  const resolved = at(entry, 'resolved');
  if (typeof resolved !== 'string') return `${where} is not pinned to the npm registry`;
  const alias = at(entry, 'name');
  const name = typeof alias === 'string' ? alias : key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const last = name.startsWith('@') ? name.split('/')[1] : name;
  if (resolved !== `https://registry.npmjs.org/${name}/-/${last}-${version}.tgz`) return `${where} is not pinned to its own address on the npm registry (${resolved})`;
  const integrity = at(entry, 'integrity');
  if (typeof integrity !== 'string' || !SHA512_INTEGRITY.test(integrity)) return `${where} has no full sha512 integrity hash`;
  return null;
}

/**
 * npm resolves a package's dependencies at install time unless the package carries an `npm-shrinkwrap.json`: then the
 * published file decides every version. An unattended install must not depend on what the registry answers that day, so
 * a release without a complete one is not installed. Complete: this version's own root entry, every dependency it
 * declares present, and every installed entry with a version, its own address on the npm registry and a full sha512 integrity.
 */
export function judgeShrinkwrap(text: string, version: string): { ok: true } | { ok: false; detail: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false, detail: 'npm-shrinkwrap.json is not JSON' }; }
  const packages = at(parsed, 'packages');
  if (packages === null || typeof packages !== 'object' || Array.isArray(packages)) return { ok: false, detail: 'npm-shrinkwrap.json has no package list' };
  const entries = Object.entries(packages as Record<string, unknown>);
  if (at(packages, '', 'version') !== version) return { ok: false, detail: 'npm-shrinkwrap.json is not for this version' };
  const dependencies = at(packages, '', 'dependencies');
  for (const name of dependencies !== null && typeof dependencies === 'object' ? Object.keys(dependencies as object) : []) {
    if (typeof at(packages, `node_modules/${name}`, 'version') !== 'string') return { ok: false, detail: `npm-shrinkwrap.json does not pin ${name}` };
  }
  for (const [key, entry] of entries) {
    if (key === '') continue;
    const problem = shrinkwrapEntryProblem(key, entry);
    if (problem) return { ok: false, detail: problem };
  }
  return { ok: true };
}

export function sha512Integrity(file: string): string {
  return `sha512-${createHash('sha512').update(fs.readFileSync(file)).digest('base64')}`;
}

// ─── live hosts ────────────────────────────────────────────────────────────

/**
 * Is `pid` one of our own processes, running? A hook, an MCP server or a runner of ours is started by this account and
 * can always be signalled: EPERM means the id now belongs to another user's process (the number was reused), so it is
 * not the program that registered. Only an error that says nothing either way counts as alive.
 */
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== 'ESRCH' && code !== 'EPERM';
  }
}

/** Note that a host process (the agent that started a session) is running. */
export function registerLiveHost(dir: string, pid: number = process.ppid, logDir: string = dir): void {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    // A host whose pid is 1 (an agent that is the first process of a container) or unknown cannot be watched: say so, so the log shows why the updater did not wait for it.
    // `logDir` is where this process writes its log (its own data directory); `dir` is the shared account directory, which may not be writable.
    appendLog(logDir, `auto-update: this host's process id (${pid}) cannot be registered as a running host, so the updater will not wait for it`);
    return;
  }
  const root = path.join(dir, LIVE_HOSTS_DIR);
  ensureOwnerDir(root);
  const hostFile = path.join(root, `${pid}.json`);
  fs.writeFileSync(hostFile, JSON.stringify({ pid, at: new Date().toISOString(), started: processStartTag(pid) }), { mode: 0o600 });
  ownerOnly(hostFile);
}

/**
 * Host pids still alive; the files of the ones that exited are removed. Null
 * when the directory exists but cannot be read: that is "unknown", never "nobody
 * is running" (a missing directory is the one case that means no host registered).
 */
export function liveHostPids(dir: string): number[] | null {
  const root = path.join(dir, LIVE_HOSTS_DIR);
  let names: string[];
  try { names = fs.readdirSync(root); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    // No live-hosts directory: nobody registered, unless nobody COULD (the directory above it cannot be written to).
    try { fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK); return []; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null; }
  }
  // A directory hosts cannot write to is one nobody could have registered in: the list is not the truth, so it is unknown, never "nobody is running".
  try { fs.accessSync(root, fs.constants.W_OK | fs.constants.X_OK); } catch { return null; }
  const alive: number[] = [];
  for (const name of names) {
    const pid = Number(name.replace(/\.json$/, ''));
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    let started: string | null = null;
    try { started = (JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')) as { started?: unknown }).started as string | null ?? null; } catch { /* an unreadable record: judge by the pid alone */ }
    // A pid that is alive but started at another time is a different program: the host that registered is gone.
    if (sameProcessAlive(pid, started, pidAlive)) alive.push(pid);
    else {
      // A host that is judged gone is not waited for: say so, so a wrong judgement can be found afterwards.
      const reused = pidAlive(pid);
      appendLog(dir, `auto-update: host pid ${pid} ${reused ? `is now another program${started ? ` (registered as started ${started})` : ''}` : 'is no longer running'}; its registration was removed`);
      try { fs.unlinkSync(path.join(root, name)); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') appendLog(dir, `auto-update: could not remove the registration of host pid ${pid} (${(err as Error).message}); it is checked again next time`);
      }
    }
  }
  return alive;
}

// ─── backup, state, log ────────────────────────────────────────────────────

/** A consistent copy of the database (`VACUUM INTO`), keeping the newest few. */
export function backupDatabase(dbPath: string, backupDir: string, tag: string, now: Date = new Date()): string | null {
  if (!fs.existsSync(dbPath)) return null;
  ensureOwnerDir(backupDir);
  const target = path.join(backupDir, `pre-update-${tag}-${now.toISOString().replace(/[:.]/g, '-')}.db`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  fs.chmodSync(target, 0o600);
  // Oldest first by modification time: sorting by name puts "4.10.0" before "4.9.9" and would delete the backup just made.
  const stamped = fs.readdirSync(backupDir)
    .filter((f) => f.startsWith('pre-update-') && f.endsWith('.db'))
    .map((f) => {
      // A dangling link, or a file removed since the listing, must not fail the update that is making a backup.
      try { return { f, at: fs.statSync(path.join(backupDir, f)).mtimeMs }; } catch { return { f, at: 0 }; }
    })
    .sort((x, y) => x.at - y.at || x.f.localeCompare(y.f));
  for (const { f } of stamped.slice(0, Math.max(0, stamped.length - BACKUPS_KEPT))) {
    if (path.join(backupDir, f) === target) continue; // never the one just made
    try { fs.unlinkSync(path.join(backupDir, f)); } catch { /* best effort */ }
  }
  return target;
}

/** When the wait for running sessions began for this target, if an earlier runner already started it. */
function readWaitStart(dir: string, target: string): number | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, WAIT_FILE), 'utf8')) as { target?: unknown; since?: unknown };
    const since = typeof value.since === 'string' ? Date.parse(value.since) : NaN;
    return value.target === target && Number.isFinite(since) ? since : null;
  } catch {
    return null;
  }
}

function writeWaitStart(dir: string, target: string, since: number): void {
  try {
    ensureOwnerDir(dir);
    const waitFile = path.join(dir, WAIT_FILE);
    fs.writeFileSync(waitFile, JSON.stringify({ target, since: new Date(since).toISOString() }), { mode: 0o600 });
    ownerOnly(waitFile);
  } catch (err) {
    // Without it a restarted runner counts the 3 days again; the state file still shows the wait.
    appendLog(dir, `auto-update: could not record when the wait began (${err instanceof Error ? err.message : String(err)}); a restarted runner would count the 3 days again`);
  }
}

function clearWaitStart(dir: string): void {
  try { fs.unlinkSync(path.join(dir, WAIT_FILE)); } catch { /* none was written */ }
}

function writeState(dir: string, state: AutoUpdateState): void {
  try {
    ensureOwnerDir(dir);
    const file = path.join(dir, STATE_FILE);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    ownerOnly(tmp);
    fs.renameSync(tmp, file);
  } catch { /* the log below is the second place it is written */ }
}

/**
 * The record of the last attempt, in three states: there is none (no attempt has
 * run), it cannot be read (damaged, not JSON, wrong shape, permission), or it is
 * fine. "Cannot be read" must not be shown as "nothing has run yet".
 */
export type StateRead = { kind: 'absent' } | { kind: 'unreadable'; detail: string } | { kind: 'ok'; state: AutoUpdateState };

export function inspectAutoUpdateState(dir: string): StateRead {
  const file = path.join(dir, STATE_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      try { fs.lstatSync(file); } catch (e2) { if ((e2 as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'absent' }; }
    }
    return { kind: 'unreadable', detail: err instanceof Error ? err.message : String(err) };
  }
  try {
    const value = JSON.parse(raw) as AutoUpdateState;
    if (!value || typeof value !== 'object' || typeof value.outcome !== 'string') return { kind: 'unreadable', detail: 'the file is JSON but not an update record' };
    // Every field the readers (doctor, the CLI) walk is checked here: one element of the wrong shape must not crash them.
    const hermes = (value as { hermes?: unknown }).hermes;
    if (hermes !== undefined && hermes !== null) {
      const element = (h: unknown) => h !== null && typeof h === 'object'
        && typeof (h as InstallResult).path === 'string' && typeof (h as InstallResult).outcome === 'string' && typeof (h as InstallResult).reason === 'string';
      if (!Array.isArray(hermes) || !hermes.every(element)) return { kind: 'unreadable', detail: 'the "hermes" list holds an entry that is not a result (path, outcome, reason)' };
    }
    return { kind: 'ok', state: value };
  } catch (err) {
    return { kind: 'unreadable', detail: err instanceof Error ? err.message : String(err) };
  }
}

export function readAutoUpdateState(dir: string): AutoUpdateState | null {
  const read = inspectAutoUpdateState(dir);
  return read.kind === 'ok' ? read.state : null;
}

/**
 * Written just before the install steps and removed when the attempt records its result. If the runner is killed in
 * between, it stays: it says an install may be half done, which no result record can (none was written).
 */
export interface InstallingMarker { at: string; from: string; to: string; pid: number; started: string | null }

function writeInstalling(dir: string, marker: InstallingMarker): void {
  try {
    ensureOwnerDir(dir);
    const file = path.join(dir, INSTALLING_FILE);
    fs.writeFileSync(file, JSON.stringify(marker), { mode: 0o600 });
    ownerOnly(file);
  } catch (err) { appendLog(dir, `auto-update: could not write the record that an install started (${err instanceof Error ? err.message : String(err)})`); }
}

function clearInstalling(dir: string): void {
  try { fs.unlinkSync(path.join(dir, INSTALLING_FILE)); } catch { /* none was written */ }
}

/** The marker, and whether the process that wrote it is still running. null when there is none (or it cannot be read). */
export function readInstalling(dir: string): { marker: InstallingMarker; running: boolean } | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, INSTALLING_FILE), 'utf8')) as Partial<InstallingMarker>;
    if (typeof value.at !== 'string' || typeof value.to !== 'string' || typeof value.pid !== 'number') return null;
    const marker: InstallingMarker = { at: value.at, from: String(value.from ?? '?'), to: value.to, pid: value.pid, started: typeof value.started === 'string' ? value.started : null };
    return { marker, running: sameProcessAlive(marker.pid, marker.started, pidAlive) };
  } catch { return null; }
}

/** One line in auto-update.log, for callers outside this module (the MCP server, the hooks). */
export function logAutoUpdateLine(dir: string, line: string): void {
  appendLog(dir, line);
}

/** A log entry is one line: a newline in a path or an error message must not start a second, forged one. */
function oneLine(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, ' ');
}

function appendLog(dir: string, line: string): void {
  try {
    ensureOwnerDir(dir);
    fs.appendFileSync(path.join(dir, LOG_FILE), `[${new Date().toISOString()}] ${oneLine(line)}\n`, { mode: 0o600 });
    ownerOnly(path.join(dir, LOG_FILE));
  } catch { /* nowhere left to write it */ }
}

// ─── the entry ─────────────────────────────────────────────────────────────

type Exec = (cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => { status: number | null; stdout: string; stderr: string };

export interface AutoUpdateDeps {
  env: NodeJS.ProcessEnv;
  accountHome: string | null;
  /** The data directory records and backups go in. */
  dir: string;
  /** Where running hosts are registered and looked for: a place every data directory shares (the account's own ~/.memesh), because the program an update replaces is shared by all of them. Defaults to `dir`. */
  liveHostsDir?: string;
  /** Where `memesh config set` writes this process's settings (can differ from `dir`). */
  configDir: string;
  /** Test seam: how the signing identity is read from an attestation bundle. */
  signerOf?: (bundle: unknown) => string | null;
  /** Test seam: called with the tarball path immediately before it is checked once more and installed. */
  beforeInstall?: (tarball: string) => void;
  /** Called on every poll of the wait and before the install: shows a lock file that its owner is alive, and says false when the lock is no longer this runner's (it must then stop, not install). */
  heartbeat?: () => boolean | void;
  /** Something the owner should know about this attempt that is not its outcome (a recovered lock). */
  notice?: string | null;
  /** The owner ran `memesh update` by hand: the policy and the wait for running sessions do not apply. Everything that checks the release still does. */
  manual?: boolean;
  /** `memesh update --reinstall`: put this very version back (a damaged or unverifiable install) through the same checks. Implies manual. */
  reinstall?: boolean;
  /** Where Claude Code records installed plugins; defaults to the config root the upgrade script uses. */
  claudeRegistryPath?: string;
  dbPath: string;
  packageRoot: string;
  currentVersion: string;
  channel: InstallChannel;
  /** 'claude-code' | 'codex' for a plugin install, else null. */
  pluginHost: 'claude-code' | 'codex' | null;
  /** The Codex config directory this plugin was installed into (worked out from its own path, `<X>/plugins/cache/pcircle-memesh/...`), or null when it is not a Codex install of ours. */
  codexHome: string | null;
  exec: Exec;
  readTags: () => DistTags | null;
  tmpRoot: string;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  readInstalledVersion: () => string | null;
}

const defaultExec: Exec = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, encoding: 'utf8', timeout: opts.timeoutMs ?? 8 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

export function readRegistryTags(exec: Exec = defaultExec): DistTags | null {
  const r = exec('npm', ['view', PACKAGE_NAME, 'dist-tags', '--json'], { timeoutMs: 15_000 });
  if (r.status !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    const tags: DistTags = {};
    for (const key of ['latest', 'next'] as const) {
      const raw = parsed[key];
      const v = typeof raw === 'string' ? normalizeRegistryVersion(raw) : null;
      if (v) tags[key] = v;
    }
    return tags;
  } catch {
    return null;
  }
}

type Staged = { ok: true; tarball: string; integrity: string; gitCommit: string; cleanup: () => void };

/** True when the tarball on disk is still exactly the file that was verified. */
function unchanged(staged: Staged): boolean {
  try { return sha512Integrity(staged.tarball) === staged.integrity; } catch { return false; }
}

/** How long one pinned install may take (the default for a blocking step is 8 minutes: this one is the longest). */
const PIN_TIMEOUT_MS = 10 * 60 * 1000;

const WORK_PREFIXES = ['memesh-update-', 'memesh-hermes-'];
const WORK_OWNER = 'owner.json';

/** A private working directory with its owner (pid and start) written inside, so a leftover of a runner that was killed can be told from one in use. */
function makeWorkDir(root: string, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(root, prefix));
  try { fs.writeFileSync(path.join(dir, WORK_OWNER), JSON.stringify({ pid: process.pid, started: processStartTag(process.pid) })); } catch { /* the sweep then waits for it to be an hour old */ }
  return dir;
}

/**
 * Remove the working directories of runners that are gone (SIGKILL, power loss): a directory whose owner is no longer running, or
 * that records no owner and is an hour old. Another user's directories and those of a runner that is running (a wait can last days
 * with its staged package) stay.
 */
export function sweepWorkDirs(root: string, nowMs: number = Date.now()): string[] {
  const removed: string[] = [];
  let names: string[];
  try { names = fs.readdirSync(root); } catch { return removed; }
  for (const name of names) {
    if (!WORK_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const dir = path.join(root, name);
    try {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) continue;
      let owner: { pid?: unknown; started?: unknown } | null = null;
      try { owner = JSON.parse(fs.readFileSync(path.join(dir, WORK_OWNER), 'utf8')); } catch { /* no owner record */ }
      if (owner && typeof owner.pid === 'number') {
        if (sameProcessAlive(owner.pid, typeof owner.started === 'string' ? owner.started : null, pidAlive)) continue;
      } else if (nowMs - stat.mtimeMs < 3_600_000) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch { /* leave it: it is not worth failing an update for */ }
  }
  return removed;
}

/** Install the target into a throwaway directory, verify it, return the verified tarball. */
function stageAndVerify(deps: AutoUpdateDeps, target: string): Staged | { ok: false; code: string; detail: string } {
  const swept = sweepWorkDirs(deps.tmpRoot);
  if (swept.length > 0) appendLog(deps.dir, `auto-update: removed ${swept.length} working director${swept.length === 1 ? 'y' : 'ies'} left by an update that was killed`);
  const stage = makeWorkDir(deps.tmpRoot, 'memesh-update-');
  const cleanup = () => { try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* best effort */ } };
  const fail = (code: string, detail: string) => { cleanup(); return { ok: false as const, code, detail }; };
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: 'memesh-update-probe', version: '1.0.0', private: true }));
  const install = deps.exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', `${PACKAGE_NAME}@${target}`], { cwd: stage });
  if (install.status !== 0) return fail(AUTO_UPDATE_REASONS.sourceNotVerified, 'staging install failed');
  const pack = deps.exec('npm', ['pack', `${PACKAGE_NAME}@${target}`, '--pack-destination', stage, '--silent'], { cwd: stage });
  const tarball = path.join(stage, pack.stdout.trim().split('\n').pop() ?? '');
  if (pack.status !== 0 || !fs.existsSync(tarball) || !fs.statSync(tarball).isFile()) return fail(AUTO_UPDATE_REASONS.tarballMismatch, 'npm pack produced no tarball');
  const audit = deps.exec('npm', ['audit', 'signatures', '--json', '--include-attestations'], { cwd: stage });
  const bytes = fs.readFileSync(tarball); // read once: the attestation and the lockfile are both judged against these bytes
  const verdict = judgeAuditSignatures(audit.stdout, PACKAGE_NAME, target, {
    tarballSha512Hex: createHash('sha512').update(bytes).digest('hex'),
    ...(deps.signerOf ? { signerOf: deps.signerOf } : {}),
  });
  if (!verdict.ok) return fail(AUTO_UPDATE_REASONS.sourceNotVerified, verdict.reason);
  const onMain = judgeCommitOnMain(deps.exec(process.execPath, ['-e', COMPARE_SCRIPT, compareUrl(verdict.gitCommit)], { cwd: stage, env: compareEnv(deps.env), timeoutMs: 40_000 }), verdict.gitCommit, proxyConfigured(deps.env) && !nodeUsesEnvProxy());
  if (!onMain.ok) return fail(onMain.code === 'notOnMain' ? AUTO_UPDATE_REASONS.commitNotOnMain : AUTO_UPDATE_REASONS.commitUnconfirmed, onMain.detail);
  const shrinkwrap = deps.exec('tar', ['-xzOf', tarball, 'package/npm-shrinkwrap.json']);
  const pinned = shrinkwrap.status === 0 ? judgeShrinkwrap(shrinkwrap.stdout, target) : { ok: false as const, detail: 'the package has no npm-shrinkwrap.json' };
  if (!pinned.ok) return fail(AUTO_UPDATE_REASONS.dependenciesNotPinned, pinned.detail);
  // The pinned install is done here first, with nothing installed yet: a registry that answers 500, a download that hangs or a hash
  // that does not match then stops the update while the version that works is still in place. (The real install repeats it, from the cache.)
  const unpackDir = path.join(stage, 'pinned');
  fs.mkdirSync(unpackDir);
  const unpack = deps.exec('tar', ['-xzf', tarball, '-C', unpackDir, '--no-same-owner']);
  const unpacked = path.join(unpackDir, 'package');
  if (unpack.status !== 0 || !fs.existsSync(unpacked)) return fail(AUTO_UPDATE_REASONS.dependenciesNotFetched, 'the verified package could not be unpacked');
  const rehearsal = deps.exec('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: unpacked, timeoutMs: PIN_TIMEOUT_MS });
  if (rehearsal.status !== 0) return fail(AUTO_UPDATE_REASONS.dependenciesNotFetched, rehearsal.stderr.trim() || `npm ci ${rehearsal.status === null ? 'did not finish in time' : `exited ${rehearsal.status}`}`);
  let lockIntegrity: unknown;
  try {
    lockIntegrity = JSON.parse(fs.readFileSync(path.join(stage, 'package-lock.json'), 'utf8')).packages?.[`node_modules/${PACKAGE_NAME}`]?.integrity;
  } catch { /* handled below */ }
  if (typeof lockIntegrity !== 'string' || lockIntegrity !== `sha512-${createHash('sha512').update(bytes).digest('base64')}`) return fail(AUTO_UPDATE_REASONS.tarballMismatch, 'integrity differs from the verified install');
  return { ok: true, tarball, integrity: lockIntegrity, gitCommit: verdict.gitCommit, cleanup };
}

/**
 * What config.toml says about the Codex marketplace named pcircle-memesh:
 * `official` (our git repository), `foreign` (something else: a local copy
 * someone develops against), `missing` (no such table — also what a failed
 * restore leaves behind, so the next attempt can repair it instead of calling
 * it foreign for good), or `unreadable` (the file exists and cannot be read).
 */
/**
 * What a multi-line TOML string ("""...""" or '''...''') holds is text, however much it looks like a table header: a decoy of
 * `[marketplaces.pcircle-memesh]` inside one must not be read as the marketplace.
 */
export function stripMultilineStrings(toml: string): string {
  return toml.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, '""');
}

export function codexMarketplaceState(codexHome: string): 'official' | 'foreign' | 'missing' | 'unreadable' {
  let text: string;
  try { text = stripMultilineStrings(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8')); } catch (err) {
    // No file is "no marketplace"; a file that cannot be read is neither official nor foreign: it is unknown.
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
  }
  const table = new RegExp(`^\\[marketplaces\\.${CODEX_MARKETPLACE}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm').exec(text);
  if (!table) {
    // No plain table. "Missing" is only true when the file does not mention the marketplace at all: a quoted
    // header, dotted keys, an inline table or a bare key are all somebody's own way of writing it (a local copy, say),
    // and adding the official one next to or over that would change the owner's setup.
    const mentioned = text.split('\n').some((line) => {
      const code = line.replace(/#.*$/, '');
      return /marketplaces/.test(code) && code.includes(CODEX_MARKETPLACE)
        || new RegExp(`^\\s*["']?${CODEX_MARKETPLACE}["']?\\s*[=.]`).test(code);
    });
    return mentioned ? 'foreign' : 'missing';
  }
  const source = /^source\s*=\s*"([^"]*)"/m.exec(table[1])?.[1];
  const type = /^source_type\s*=\s*"([^"]*)"/m.exec(table[1])?.[1];
  return type === 'git' && (source === `https://github.com/${CODEX_MARKETPLACE_SOURCE}.git` || source === `https://github.com/${CODEX_MARKETPLACE_SOURCE}` || source === CODEX_MARKETPLACE_SOURCE) ? 'official' : 'foreign';
}

/**
 * Whether the Codex plugin may be touched at all, and in what state its marketplace is. A marketplace that is not in
 * config.toml is NOT put back: unless MeMesh removed it itself (a restore that failed is recorded, see CODEX_RESTORE_FILE, and
 * repaired at the start of the next run), whoever removed it did that on purpose, and re-adding it would undo a deliberate
 * act. `memesh update --reinstall` is the owner's way to ask for it (pinned). Doctor says it is missing and how.
 */
function codexDecision(deps: AutoUpdateDeps): { state: 'official' | 'foreign' | 'missing' | 'unreadable'; skip: string | null } {
  if (deps.codexHome === null) return { state: 'missing', skip: AUTO_UPDATE_REASONS.codexHomeUnknown };
  const state = codexMarketplaceState(deps.codexHome);
  if (state === 'foreign') return { state, skip: AUTO_UPDATE_REASONS.codexMarketplaceForeign };
  if (state === 'unreadable') return { state, skip: AUTO_UPDATE_REASONS.codexMarketplaceUnreadable };
  // A reinstall is the owner asking for exactly this: the marketplace is added back, pinned to this release.
  if (state === 'missing' && !deps.reinstall) return { state, skip: AUTO_UPDATE_REASONS.codexMarketplaceMissing };
  return { state, skip: null };
}

/**
 * The Codex directory a plugin install of ours lives in: `<X>` for a package at
 * `<X>/plugins/cache/pcircle-memesh/<plugin>/<version>` (the directory Codex itself installed it into, whatever HOME
 * is now). Anything else is null: a plugin from another marketplace (a local development copy, say) is not ours to
 * replace with the official release, and there is no fallback to the account's `.codex` or to a temporary directory.
 */
export function codexHomeFor(packageRoot: string): string | null {
  const parts = path.resolve(packageRoot).split(path.sep);
  for (let i = parts.length - 4; i >= 1; i -= 1) {
    if (parts[i] === 'plugins' && parts[i + 1] === 'cache' && parts[i + 2] === CODEX_MARKETPLACE) return parts.slice(0, i).join(path.sep) || path.sep;
  }
  return null;
}

type CodexFailure = { kind: 'readback' } | { kind: 'step'; detail: string; restored: boolean; untouched?: boolean };

interface CodexRestoreRecord { marketplace: string; original: string | null; source: string; configAfter: string; at: string }

/** A fingerprint of config.toml as it is now ('absent' / 'unreadable' are values of their own). */
function codexConfigFingerprint(codexHome: string): string {
  try { return createHash('sha256').update(fs.readFileSync(path.join(codexHome, 'config.toml'))).digest('hex'); } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable';
  }
}

/** The `source` the marketplace had in config.toml before we removed it (for the record), or null. */
function codexMarketplaceSource(codexHome: string): string | null {
  try {
    const text = stripMultilineStrings(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
    const table = new RegExp(`^\\[marketplaces\\.${CODEX_MARKETPLACE}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm').exec(text);
    return table ? (/^source\s*=\s*"([^"]*)"/m.exec(table[1])?.[1] ?? null) : null;
  } catch { return null; }
}

function readCodexRestoreRecord(dir: string): CodexRestoreRecord | 'damaged' | null {
  let text: string;
  try { text = fs.readFileSync(path.join(dir, CODEX_RESTORE_FILE), 'utf8'); } catch (err) { return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'damaged'; }
  try {
    const v = JSON.parse(text) as Partial<CodexRestoreRecord>;
    return typeof v.marketplace === 'string' && typeof v.source === 'string' && typeof v.configAfter === 'string' && typeof v.at === 'string'
      ? { marketplace: v.marketplace, original: typeof v.original === 'string' ? v.original : null, source: v.source, configAfter: v.configAfter, at: v.at }
      : 'damaged';
  } catch { return 'damaged'; }
}

/**
 * At the start of a Codex run: if an earlier update removed the marketplace and could not put it back, put it back now, but only
 * while config.toml is still as that run left it. If anything touched it since, the marketplace's absence is the owner's
 * business again (taken as removed on purpose) and nothing is restored. The record is deleted once it has been dealt with.
 */
function repairCodexMarketplace(deps: AutoUpdateDeps): void {
  if (deps.codexHome === null) return;
  const file = path.join(deps.dir, CODEX_RESTORE_FILE);
  const record = readCodexRestoreRecord(deps.dir);
  if (record === null) return;
  const drop = (why: string) => {
    appendLog(deps.dir, `auto-update: codex marketplace record dropped: ${why}`);
    try { fs.rmSync(file, { force: true }); } catch (err) { appendLog(deps.dir, `auto-update: could not delete ${file} (${err instanceof Error ? err.message : String(err)})`); }
  };
  if (record === 'damaged') return drop('the record could not be read, so nothing is restored from it');
  const state = codexMarketplaceState(deps.codexHome);
  if (state !== 'missing') return drop(`the marketplace is ${state} now, so there is nothing to put back`);
  if (codexConfigFingerprint(deps.codexHome) !== record.configAfter) return drop('config.toml changed after the failed restore, so the missing marketplace is not ours to put back');
  const added = deps.exec('codex', ['plugin', 'marketplace', 'add', record.source], { env: { ...deps.env, CODEX_HOME: deps.codexHome } });
  if (added.status === 0 && codexMarketplaceState(deps.codexHome) === 'official') {
    appendLog(deps.dir, `auto-update: the Codex marketplace ${record.marketplace} that a failed update had removed was put back (${record.source})`);
    try { fs.rmSync(file, { force: true }); } catch (err) { appendLog(deps.dir, `auto-update: could not delete ${file} (${err instanceof Error ? err.message : String(err)})`); }
    return;
  }
  // The record stays: config.toml is as we left it, so the next run tries again.
  appendLog(deps.dir, `auto-update: the Codex marketplace ${record.marketplace} could not be put back yet (${oneLine(added.stderr).slice(0, 160)}); the next run tries again`);
}

/**
 * Move the Codex plugin to `commit`: remove the marketplace (when there is one),
 * add it again pinned to that commit (a different ref cannot be added over the
 * old one, and `upgrade` keeps whatever ref is pinned), then install the plugin
 * from it. Measured with codex-cli 0.166.0: the user's other config and the
 * plugin's enabled flag survive, and the old plugin cache version is replaced.
 * If a step fails the marketplace is added back unpinned, as the README installs
 * it, and whether that worked is reported.
 */
function updateCodexPlugin(deps: AutoUpdateDeps, codexHome: string, commit: string, target: string, wasMissing = false): CodexFailure | null {
  // Codex decides where its config lives from CODEX_HOME, else from HOME: give it the directory that was checked.
  const env = { ...deps.env, CODEX_HOME: codexHome };
  const codex = (...args: string[]) => deps.exec('codex', ['plugin', ...args], { env });
  // Back to the unpinned marketplace: the pinned one must be removed first, or `add` is refused as already added from another source.
  const restore = (): boolean => {
    codex('marketplace', 'remove', CODEX_MARKETPLACE);
    // It was not there when this started (the owner removed it, and asked for a reinstall): back to that is back to missing.
    if (wasMissing) return codexMarketplaceState(codexHome) === 'missing';
    return codex('marketplace', 'add', CODEX_MARKETPLACE_SOURCE).status === 0;
  };
  if (!wasMissing) {
    const removed = codex('marketplace', 'remove', CODEX_MARKETPLACE);
    if (removed.status !== 0) return { kind: 'step', detail: `marketplace remove: ${removed.stderr}`, restored: true, untouched: true };
  }
  const added = codex('marketplace', 'add', CODEX_MARKETPLACE_SOURCE, '--ref', commit);
  if (added.status !== 0) return { kind: 'step', detail: `marketplace add: ${added.stderr}`, restored: restore() };
  const installed = codex('add', CODEX_PLUGIN);
  if (installed.status !== 0) return { kind: 'step', detail: `plugin add: ${installed.stderr}`, restored: restore() };
  // The plugin root's last segment is the installed version; compare it exactly (4.13.0-rc.1 is not 4.13.0).
  const root = /Installed plugin root:\s*(.+)$/m.exec(installed.stdout)?.[1]?.trim();
  if (root === undefined || path.basename(root) !== target) return { kind: 'readback' };
  // The words of a command's output are not the installed plugin: the directory has to be there, and say the target version if it says any.
  try { if (!fs.statSync(root).isDirectory()) return { kind: 'readback' }; } catch { return { kind: 'readback' }; }
  try {
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    if (typeof version === 'string' && version !== target) return { kind: 'readback' };
  } catch { /* no readable package.json: the directory and its name are what there is */ }
  return null;
}

/** The Claude Code config root, resolved the way scripts/upgrade-plugin.sh resolves it. */
function claudeConfigRoot(env: NodeJS.ProcessEnv): string | null {
  if (env.CLAUDE_CONFIG_DIR) return env.CLAUDE_CONFIG_DIR;
  return env.HOME ? path.join(env.HOME, '.claude') : null;
}

/** True when Claude Code's plugin registry records this commit (and this version, if it records one) for MeMesh. */
function claudeRegistryRecords(deps: AutoUpdateDeps, commit: string, version: string): boolean {
  const root = claudeConfigRoot(deps.env);
  const file = deps.claudeRegistryPath ?? (root === null ? null : path.join(root, 'plugins', 'installed_plugins.json'));
  if (file === null) return false;
  try {
    const entries = at(JSON.parse(fs.readFileSync(file, 'utf8')), 'plugins', 'memesh@pcircle-memesh');
    return Array.isArray(entries) && entries.some((e) => at(e, 'gitCommitSha') === commit && (typeof at(e, 'version') !== 'string' || at(e, 'version') === version));
  } catch { return false; }
}

/**
 * `npm install -g` of the verified tarball, and the way back. npm replaces the installed package first and only then
 * does the pinned install (`npm ci`, which npm does not do for a tarball it installs globally: it resolves the dependencies
 * itself, from the registry, that day). `npm ci` empties node_modules before it fills it, so a failure in it (the network, an
 * answer of 500, a hash that does not match) leaves the NEW version on disk with no dependencies: the CLI, the hooks and the MCP
 * servers would not start. So a copy of what is installed is kept beside it, and a failure at any step puts it back.
 *
 * The pinned install has also been done once already in the staging directory (stageAndVerify), so a failure here is rare:
 * the way back is for the rare one.
 */
function installGlobal(deps: AutoUpdateDeps, tarball: string): { ok: true } | { ok: false; reason: string; detail?: string } {
  const root = deps.exec('npm', ['root', '-g']);
  const rootDir = root.status === 0 ? root.stdout.trim() : '';
  if (rootDir === '') return { ok: false, reason: AUTO_UPDATE_REASONS.globalDirUnknown, detail: root.stderr };
  const installedDir = path.join(rootDir, ...PACKAGE_NAME.split('/'));
  // Copies left beside it by a runner that was killed, and are not needed any more.
  try {
    for (const name of fs.readdirSync(path.dirname(installedDir))) {
      const m = /^memesh\.rollback-(\d+)$/.exec(name);
      if (m && !pidAlive(Number(m[1]))) fs.rmSync(path.join(path.dirname(installedDir), name), { recursive: true, force: true });
    }
  } catch { /* the directory is not there (yet) or cannot be listed: nothing to sweep */ }
  const had = fs.existsSync(installedDir);
  const rollbackDir = path.join(path.dirname(installedDir), `memesh.rollback-${process.pid}`);
  if (had) {
    try {
      fs.rmSync(rollbackDir, { recursive: true, force: true });
      fs.cpSync(installedDir, rollbackDir, { recursive: true, verbatimSymlinks: true });
    } catch (err) {
      try { fs.rmSync(rollbackDir, { recursive: true, force: true }); } catch { /* best effort */ }
      return { ok: false, reason: AUTO_UPDATE_REASONS.rollbackUnavailable, detail: err instanceof Error ? err.message : String(err) };
    }
  }
  const putBack = (): boolean => {
    if (!had) return true; // there was nothing installed before
    try {
      fs.rmSync(installedDir, { recursive: true, force: true });
      fs.renameSync(rollbackDir, installedDir);
      return true;
    } catch { return false; }
  };
  const failed = (reason: string, detail: string): { ok: false; reason: string; detail: string } => {
    // The state keeps the first 300 characters of a detail, and npm's error is long: what happened to the installed version comes first.
    if (putBack()) return { ok: false, reason, detail: `the previous version was put back; npm said: ${detail.trim()}` };
    return { ok: false, reason: AUTO_UPDATE_REASONS.installNotUndone, detail: `a copy of the previous version is at ${rollbackDir}; npm said: ${detail.trim()}` };
  };
  const install = deps.exec('npm', ['install', '-g', '--ignore-scripts', tarball]);
  if (install.status !== 0) return failed(AUTO_UPDATE_REASONS.installFailed, install.stderr);
  if (!fs.existsSync(path.join(installedDir, 'npm-shrinkwrap.json'))) return failed(AUTO_UPDATE_REASONS.dependencyPinFailed, 'the installed package has no npm-shrinkwrap.json');
  const pin = deps.exec('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: installedDir, timeoutMs: PIN_TIMEOUT_MS });
  if (pin.status !== 0) return failed(AUTO_UPDATE_REASONS.dependencyPinFailed, pin.stderr.trim() || `npm ci ${pin.status === null ? 'did not finish in time' : `exited ${pin.status}`}`);
  if (had) { try { fs.rmSync(rollbackDir, { recursive: true, force: true }); } catch { /* a copy that stays is swept by the next run */ } }
  return { ok: true };
}

/**
 * Bring the Hermes provider copies MeMesh installed to the version that was
 * just verified. The provider is taken out of the verified tarball, never from
 * anywhere else; when no copy exists nothing is extracted.
 */
const PROVIDER_PREFIX = 'package/extensions/hermes-memesh/';

/**
 * Entries of the tarball that must not be extracted, judged before anything is written: only plain files and
 * directories under the provider directory, nothing absolute, nothing with `..`, no links.
 *
 * `verbose` is `tar -tvzf` and `names` is `tar -tzf`, one entry per line in the same order. The names are taken
 * from `names` only: the verbose listing prints its date in the language of the machine ("11月  8 02:59", "8 Nov. 02:59"),
 * and picking the name out of it by the shape of the date refused every file on those machines. From the verbose line
 * only its first character, the entry type, is used, and that is the same everywhere. If the two listings do not line up
 * (an entry whose name holds a newline, a tar that prints something else) nothing is trusted: it is refused.
 */
export function unsafeTarEntries(verbose: string, names: string[]): string[] {
  const lines = verbose.split('\n').filter((line) => line.trim() !== '');
  if (lines.length !== names.length) return [`the two listings of the package do not line up (${lines.length} entries with a type, ${names.length} names)`];
  const bad: string[] = [];
  names.forEach((name, i) => {
    const type = lines[i][0];
    const segments = name.split('/');
    const outside = !(name === 'package/extensions/hermes-memesh' || name === PROVIDER_PREFIX || name.startsWith(PROVIDER_PREFIX));
    if (type !== '-' && type !== 'd') bad.push(`${name} (type ${type})`);
    else if (name.startsWith('/') || segments.includes('..')) bad.push(`${name} (path escapes)`);
    else if (outside) bad.push(`${name} (outside the provider directory)`);
  });
  return bad;
}

/**
 * Bring the Hermes provider copies MeMesh installed to the version that was
 * just verified. The provider is taken out of the verified tarball, never from
 * anywhere else; when there is no copy to look at nothing is extracted.
 *
 * The tarball is copied once into a private (0700) working directory, and that
 * copy is the one that is hashed, listed and extracted: a file swapped in
 * between the three steps cannot be installed. Only the provider directory is
 * listed and extracted (the package holds a few hundred other files, which are
 * none of this function's business), the listing is checked before anything is
 * written, and what lands on disk is checked to be inside the working directory.
 */
export function refreshHermes(deps: AutoUpdateDeps, tarball: string, version: string, expectedIntegrity: string): InstallResult[] | null {
  const targets = refreshTargets(deps.dir, deps.env, deps.accountHome);
  // A list of copies that cannot be read means copies MeMesh cannot see: that is a result to report, not "nothing to do".
  const problem = registryProblemResult(deps.dir);
  if (targets.length === 0) return problem ? [problem] : null;
  // Only copies MeMesh owns (its own marked copies, and ones it registered or lost) are reported as failed:
  // a directory somebody else put there is not a failure of ours.
  const ours = targets.filter((p) => { const state = inspectInstall(p).state; return state === 'managed' || state === 'absent'; });
  const failAll = (reason: string): InstallResult[] => [...(problem ? [problem] : []), ...ours.map((p) => ({ path: p, outcome: 'failed' as const, reason, backup: null }))];
  const work = makeWorkDir(deps.tmpRoot, 'memesh-hermes-');
  try {
    const mine = path.join(work, 'package.tgz');
    try { fs.copyFileSync(tarball, mine); } catch { return failAll(AUTO_UPDATE_REASONS.tarballChanged); }
    if (sha512Integrity(mine) !== expectedIntegrity) return failAll(AUTO_UPDATE_REASONS.tarballChanged);
    const why = (r: { status: number | null; stderr: string }) => `tar exit ${r.status ?? 'none'}${r.stderr.trim() ? `: ${r.stderr.trim().replace(/\s+/g, ' ').slice(0, 120)}` : ''}`;
    const names = deps.exec('tar', ['-tzf', mine, 'package/extensions/hermes-memesh']);
    if (names.status !== 0) return failAll(`the verified package could not be listed (${why(names)})`);
    if (names.stdout.trim() === '') return failAll('the verified package holds no Hermes provider');
    const listing = deps.exec('tar', ['-tvzf', mine, 'package/extensions/hermes-memesh']);
    if (listing.status !== 0) return failAll(`the verified package could not be listed (${why(listing)})`);
    const hostile = unsafeTarEntries(listing.stdout, names.stdout.split('\n').filter((line) => line !== ''));
    if (hostile.length > 0) return failAll(`refused: the package holds entries that are not plain files under the provider directory (${hostile.slice(0, 3).join('; ')})`);
    const extracted = deps.exec('tar', ['-xzf', mine, '-C', work, '--no-same-owner', 'package/extensions/hermes-memesh']);
    if (extracted.status !== 0) return failAll(`the provider could not be extracted (${why(extracted)})`);
    const sourceDir = path.join(work, 'package', 'extensions', 'hermes-memesh');
    if (!fs.existsSync(sourceDir)) return failAll('the verified package holds no Hermes provider');
    // Whatever tar did, the source must resolve inside the working directory.
    const realWork = fs.realpathSync(work);
    const realSource = fs.realpathSync(sourceDir);
    if (realSource !== path.join(realWork, 'package', 'extensions', 'hermes-memesh')) return failAll('refused: the extracted provider is not where it was expected');
    return refreshInstalls({ sourceDir, version, memeshDir: deps.dir, env: deps.env, accountHome: deps.accountHome, now: deps.now(), log: (line) => appendLog(deps.dir, `auto-update: ${line}`) });
  } catch (err) {
    return failAll(`failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`);
  } finally {
    // Cleaning up must never turn a result into another one: what could not be removed is a line in the log.
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (err) { appendLog(deps.dir, `auto-update: could not remove the working directory ${work} (${err instanceof Error ? err.message : String(err)})`); }
  }
}

/**
 * One update attempt. Resolves to the recorded result; never throws.
 * Order matters: policy first (nothing else is touched when it says off),
 * then the registry, the source check, the backup, the wait for running
 * sessions, and only then the swap.
 */
export async function runAutoUpdate(deps: AutoUpdateDeps): Promise<{ outcome: AutoUpdateOutcome; reason: string }> {
  const base = { from: deps.currentVersion, channel: deps.channel };
  let to: string | null = null;
  let backup: string | null = null;
  let waitingSince: string | null = null;
  let hermes: InstallResult[] | null = null;
  const finish = (outcome: AutoUpdateOutcome, reason: string, detail?: string) => {
    const state: AutoUpdateState = { at: deps.now().toISOString(), outcome, reason, from: base.from, to, channel: base.channel, backup, waitingSince: outcome === 'waiting' ? waitingSince : null, hermes, notice: deps.notice ?? null, detail: detail ? oneLine(detail).trim().slice(0, 300) : null };
    writeState(deps.dir, state);
    if (outcome !== 'waiting') clearInstalling(deps.dir);
    if (hermes !== null) for (const h of hermes) appendLog(deps.dir, `auto-update hermes-provider ${h.outcome.toUpperCase()}: ${h.reason} path=${h.path}${h.backup ? ` backup=${h.backup}` : ''}`);
    appendLog(deps.dir, `auto-update ${outcome.toUpperCase()}: ${reason}${detail ? ` (${detail.replace(/[\r\n]+/g, ' ').slice(0, 200)})` : ''} from=${base.from} to=${to ?? '-'} channel=${base.channel}`);
    return { outcome, reason };
  };
  try {
    const policyNow = () => deps.manual
      ? ({ policy: 'major', source: 'default', reason: null } as PolicyDecision)
      : resolveUpdatePolicy({ env: deps.env, activeDir: deps.dir, extraConfigDirs: [deps.configDir], accountHome: deps.accountHome });
    const decision = policyNow();
    if (decision.policy === 'off') return finish('skipped', decision.reason ?? AUTO_UPDATE_REASONS.policyOff, decision.detail);

    const supported = deps.channel === 'npm-global' || (deps.channel === 'plugin-marketplace' && deps.pluginHost !== null);
    if (!supported) return finish('skipped', AUTO_UPDATE_REASONS.channelUnsupported);
    // A marketplace that an earlier update removed and could not put back is put back first (only while config.toml is as that update left it).
    if (deps.pluginHost === 'codex') repairCodexMarketplace(deps);

    let target: string | null;
    if (deps.reinstall) {
      // This very version, from its own verified release: no registry question and no newer version.
      target = deps.currentVersion;
    } else {
      const tags = deps.readTags();
      if (!tags) return finish('failed', AUTO_UPDATE_REASONS.registryUnreachable);
      target = chooseTarget(deps.currentVersion, tags).target;
    }
    if (!target) {
      // An install whose pinned dependencies are unfinished and could not be undone is not "up to date": it must not be reported as that.
      if (readAutoUpdateState(deps.dir)?.reason === AUTO_UPDATE_REASONS.installNotUndone) return finish('failed', AUTO_UPDATE_REASONS.installNotUndone, 'still unfinished from the earlier attempt');
      const stale = staleInstalls(deps.dir, deps.env, deps.currentVersion, deps.accountHome);
      const unreadableList = registryProblemResult(deps.dir);
      if (stale.length > 0) {
        const current = stageAndVerify(deps, deps.currentVersion);
        if (current.ok) {
          try { hermes = refreshHermes(deps, current.tarball, deps.currentVersion, current.integrity); } finally { current.cleanup(); }
        } else {
          hermes = [...(unreadableList ? [unreadableList] : []), ...stale.map((p) => ({ path: p, outcome: 'failed' as const, reason: current.code, backup: null }))];
        }
      } else if (unreadableList) {
        // Nothing is known to be stale, but the copies MeMesh cannot see may be: say it, every time, instead of "already current".
        hermes = [unreadableList];
      }
      return finish('skipped', AUTO_UPDATE_REASONS.upToDate);
    }
    to = target;
    if (!policyPermits(decision.policy, bumpKind(deps.currentVersion, target))) return finish('skipped', AUTO_UPDATE_REASONS.bumpNotPermitted);

    if (deps.pluginHost === 'codex') {
      const decided = codexDecision(deps);
      if (decided.skip) return finish('skipped', decided.skip);
    }

    const first = stageAndVerify(deps, target);
    if (!first.ok) return finish('failed', first.code, first.detail);
    let staged: Staged = first;
    try {
      try {
        backup = backupDatabase(deps.dbPath, path.join(deps.dir, 'backups'), deps.currentVersion, deps.now());
      } catch (err) {
        return finish('failed', AUTO_UPDATE_REASONS.backupFailed, err instanceof Error ? err.message : String(err));
      }

      // A runner that was restarted during the wait must not count the 3 days again,
      // and a start time in the future (the clock was set back) is no start time.
      const startNow = deps.now().getTime();
      const stored = readWaitStart(deps.dir, target);
      const waitedFrom = stored !== null && stored <= startNow ? stored : startNow;
      if (stored !== null && stored > startNow) appendLog(deps.dir, 'auto-update: the recorded start of the wait is in the future (the clock moved back); counting from now');
      let announced = false;
      let waitedOut = false;
      let slept = 0;
      let unknownLogged = false;
      for (;;) {
        if (deps.manual) break;
        const live = liveHostPids(deps.liveHostsDir ?? deps.dir);
        if (live !== null && live.length === 0) break;
        if (live === null && !unknownLogged) {
          unknownLogged = true;
          appendLog(deps.dir, `auto-update: ${AUTO_UPDATE_REASONS.hostsUnreadable}`);
        }
        if (!announced) {
          announced = true;
          waitingSince = new Date(waitedFrom).toISOString();
          writeWaitStart(deps.dir, target, waitedFrom);
          finish('waiting', live === null ? AUTO_UPDATE_REASONS.hostsUnreadable : AUTO_UPDATE_REASONS.waitingForHosts);
        }
        // Wall time and time actually spent waiting both count: a clock set back must not stretch the wait.
        if (deps.now().getTime() - waitedFrom >= LIVE_WAIT_MAX_MS || slept >= LIVE_WAIT_MAX_MS) { waitedOut = true; break; }
        if (deps.heartbeat?.() === false) return finish('failed', AUTO_UPDATE_REASONS.lockLost);
        await deps.sleep(LIVE_WAIT_POLL_MS);
        slept += LIVE_WAIT_POLL_MS;
      }
      clearWaitStart(deps.dir);
      // Days may have passed: the owner may have turned updates off, or changed
      // what the Codex marketplace points at. Both are read again before anything is changed.
      const after = policyNow();
      if (after.policy === 'off') return finish('skipped', after.reason ?? AUTO_UPDATE_REASONS.policyOff, after.detail);
      if (!policyPermits(after.policy, bumpKind(deps.currentVersion, target))) return finish('skipped', AUTO_UPDATE_REASONS.bumpNotPermitted);
      if (announced) {
        // The staged files may be days old (and a temp directory can be swept):
        // fetch and verify again, so what is installed is what was just checked.
        staged.cleanup();
        const again = stageAndVerify(deps, target);
        if (!again.ok) return finish('failed', again.code, again.detail);
        staged = again;
      }

      // The download, the checks and the backup ran for minutes in blocking steps (with or without a wait before them): an `off`
      // written meanwhile must still stop the install. Asked here, once, it covers the path with a wait and the path without.
      const last = policyNow();
      if (last.policy === 'off') return finish('skipped', last.reason ?? AUTO_UPDATE_REASONS.policyOff, last.detail);
      if (!policyPermits(last.policy, bumpKind(deps.currentVersion, target))) return finish('skipped', AUTO_UPDATE_REASONS.bumpNotPermitted);
      // Make sure the lock is still ours.
      if (deps.heartbeat?.() === false) return finish('failed', AUTO_UPDATE_REASONS.lockLost);
      writeInstalling(deps.dir, { at: deps.now().toISOString(), from: deps.currentVersion, to: target, pid: process.pid, started: processStartTag(process.pid) });
      deps.beforeInstall?.(staged.tarball);
      if (!unchanged(staged)) return finish('failed', AUTO_UPDATE_REASONS.tarballChanged);
      if (deps.channel === 'npm-global') {
        const done = installGlobal(deps, staged.tarball);
        if (!done.ok) return finish('failed', done.reason, done.detail);
        if (deps.readInstalledVersion() !== target) return finish('failed', AUTO_UPDATE_REASONS.readbackFailed);
      } else if (deps.pluginHost === 'codex') {
        const { skip, state: codexState } = codexDecision(deps);
        if (skip || deps.codexHome === null) return finish('skipped', skip ?? AUTO_UPDATE_REASONS.codexHomeUnknown);
        const originalSource = codexMarketplaceSource(deps.codexHome);
        const failure = updateCodexPlugin(deps, deps.codexHome, staged.gitCommit, target, codexState === 'missing');
        if (failure?.kind === 'step' && !failure.restored && !failure.untouched) {
          // This update removed the marketplace and could not put it back: write down what to put back, and what config.toml looked like then.
          try {
            const record: CodexRestoreRecord = { marketplace: CODEX_MARKETPLACE, original: originalSource, source: CODEX_MARKETPLACE_SOURCE, configAfter: codexConfigFingerprint(deps.codexHome), at: deps.now().toISOString() };
            fs.writeFileSync(path.join(deps.dir, CODEX_RESTORE_FILE), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
            ownerOnly(path.join(deps.dir, CODEX_RESTORE_FILE));
          } catch (err) { appendLog(deps.dir, `auto-update: could not write ${CODEX_RESTORE_FILE} (${err instanceof Error ? err.message : String(err)}); the marketplace will not be put back by itself`); }
        }
        if (failure?.kind === 'readback') return finish('failed', AUTO_UPDATE_REASONS.codexReadbackFailed);
        if (failure?.kind === 'step' && failure.untouched) return finish('failed', AUTO_UPDATE_REASONS.codexRemoveFailed, failure.detail);
        if (failure) return finish('failed', failure.restored ? AUTO_UPDATE_REASONS.codexInstallFailed : AUTO_UPDATE_REASONS.codexRestoreFailed, failure.detail);
      } else {
        const script = path.join(deps.packageRoot, 'scripts', 'upgrade-plugin.sh');
        const run = deps.exec('bash', [script], {
          env: { ...deps.env, MEMESH_UPGRADE_PIN_COMMIT: staged.gitCommit, MEMESH_UPGRADE_EXPECT_VERSION: target },
        });
        if (run.status !== 0) return finish('failed', AUTO_UPDATE_REASONS.installFailed, run.stderr);
        // The script's exit code is not the installed plugin: Claude Code's own record must name the commit that was pinned.
        if (!claudeRegistryRecords(deps, staged.gitCommit, target)) return finish('failed', AUTO_UPDATE_REASONS.claudeReadbackFailed);
      }
      hermes = refreshHermes(deps, staged.tarball, target, staged.integrity);
      try { writeJustUpgradedMarker(deps.dir, deps.currentVersion, target, deps.now()); } catch { /* the banner is optional; the state file below is the record */ }
      return finish('installed', waitedOut ? AUTO_UPDATE_REASONS.installedAfterWait : AUTO_UPDATE_REASONS.installed);
    } finally {
      staged.cleanup();
    }
  } catch (err) {
    return finish('failed', AUTO_UPDATE_REASONS.installFailed, err instanceof Error ? err.message : String(err));
  }
}

/** What older versions left in the data directory and nothing reads any more: the update-notice snooze and the reply-Upgrade consent files. */
function removeRetiredFiles(dir: string): void {
  for (const name of ['update-snooze.json', 'update-consent']) {
    try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); } catch { /* not worth failing a dispatch for */ }
  }
}

function defaultCanSelfUpdate(root: string): { ok: boolean; label: string } {
  const support = getInstallChannelSupport(getCurrentInstallChannel({ packageRoot: root }), root);
  return { ok: support.canSelfUpdate, label: support.label };
}

/**
 * Start the detached updater runner for the install at `pluginRoot`, at most
 * once per ATTEMPT_INTERVAL_MS. This only starts the runner; every decision is
 * made by `runAutoUpdate`. Every outcome is written to auto-update.log.
 * An attempt time in the future (the clock moved back) is ignored, not obeyed:
 * obeying it would suppress every attempt until the clock caught up.
 */
export async function dispatchAutoUpdate(
  pluginRoot: string,
  nowMs: number = Date.now(),
  options: { canSelfUpdate?: (root: string) => { ok: boolean; label: string }; spawnImpl?: typeof spawn } = {},
): Promise<{ state: 'dispatched' | 'throttled' | 'failed' | 'unsupported' }> {
  const dir = getMemeshDirFromDbPath();
  let fd = -1;
  let claim: string | null = null;
  const say = (line: string) => {
    try {
      ensureOwnerDir(dir);
      fs.appendFileSync(path.join(dir, LOG_FILE), `[${new Date().toISOString()}] ${oneLine(line)}\n`, { mode: 0o600 });
      ownerOnly(path.join(dir, LOG_FILE));
    } catch {
      try { process.stderr.write(`[memesh] ${oneLine(line)}\n`); } catch { /* stderr unavailable */ }
    }
  };
  try {
    ensureOwnerDir(dir);
    removeRetiredFiles(dir);
    // An install that cannot update itself (a source checkout, a project-local package) would only record "cannot update itself" in the
    // state, the attempt time and the 6-hour slot that every install of this account shares, and the plugin that CAN update would be throttled for it.
    const support = (options.canSelfUpdate ?? defaultCanSelfUpdate)(pluginRoot);
    if (!support.ok) {
      say(`auto-update: no runner started: ${support.label} cannot update itself`);
      return { state: 'unsupported' };
    }
    // Several sessions start together (a hook and an MCP server each): reading the attempt time and writing it later is not
    // atomic, so two of them could both see "no attempt" and both start a runner. One claim, made with mkdir, decides who asks.
    const claimPath = path.join(dir, DISPATCH_CLAIM);
    for (let attempt = 0; ; attempt += 1) {
      try { fs.mkdirSync(claimPath); claim = claimPath; break; } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        let age = 0;
        let vanished = false;
        try { age = Date.now() - fs.statSync(claimPath).mtimeMs; } catch { vanished = true; }
        if (attempt === 0 && vanished) continue; // it was removed between the two calls: try to make it
        if (attempt === 0 && age > DISPATCH_CLAIM_STALE_MS) { say(`auto-update: a dispatch claim ${Math.round(age / 1000)} seconds old was left behind; taking it over`); fs.rmSync(claimPath, { recursive: true, force: true }); continue; }
        say('auto-update THROTTLED: another session is deciding whether to start the updater right now');
        return { state: 'throttled' };
      }
    }
    const attemptPath = path.join(dir, ATTEMPT_FILE);
    try {
      const last = Number(fs.readFileSync(attemptPath, 'utf8'));
      if (Number.isFinite(last) && last > nowMs) {
        say(`auto-update: the last attempt time is in the future (${new Date(last).toISOString()}); ignoring it`);
      } else if (Number.isFinite(last) && nowMs - last < ATTEMPT_INTERVAL_MS) {
        say(`auto-update THROTTLED: the last attempt was ${Math.round((nowMs - last) / 60000)} minute(s) ago, under the ${ATTEMPT_INTERVAL_MS / 3600000}-hour interval`);
        return { state: 'throttled' };
      }
    } catch { /* no earlier attempt */ }
    const runnerPath = path.join(pluginRoot, 'scripts', 'hooks', 'auto-update-runner.mjs');
    if (!fs.existsSync(runnerPath)) {
      say(`auto-update FAILED: runner missing at ${runnerPath}`);
      return { state: 'failed' };
    }
    const logPath = path.join(dir, LOG_FILE);
    try {
      fd = fs.openSync(logPath, 'a', 0o600);
    } catch (err) {
      try { process.stderr.write(`[memesh] auto-update FAILED: durable log unavailable at ${logPath} (${err instanceof Error ? err.message : String(err)})\n`); } catch { /* stderr unavailable */ }
      return { state: 'failed' };
    }
    const lockPath = path.join(dir, 'auto-update.lock');
    const child = (options.spawnImpl ?? spawn)(process.execPath, [runnerPath, lockPath], { detached: true, stdio: ['ignore', fd, fd], env: process.env, windowsHide: true });
    return await new Promise((resolve) => {
      let settled = false;
      const finishWith = (state: 'dispatched' | 'failed', line: string) => {
        if (settled) return;
        settled = true;
        if (fd >= 0) { try { fs.closeSync(fd); } catch { /* already closed */ } fd = -1; }
        say(line);
        resolve({ state });
      };
      child.once('spawn', () => {
        child.unref();
        // Taken now, not before: a runner that could not start must not hold back the next attempt for 6 hours.
        try { fs.writeFileSync(attemptPath, String(nowMs), { mode: 0o600 }); ownerOnly(attemptPath); } catch (err) { say(`auto-update: could not record the attempt time (${err instanceof Error ? err.message : String(err)})`); }
        finishWith('dispatched', `auto-update DISPATCHED: worker_pid=${child.pid ?? 'unknown'} lock=${lockPath}`);
      });
      child.once('error', (err) => finishWith('failed', `auto-update FAILED: stage=dispatch error=${err.message}`));
    });
  } catch (err) {
    if (fd >= 0) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    say(`auto-update FAILED: stage=dispatch error=${err instanceof Error ? err.message : String(err)}`);
    return { state: 'failed' };
  } finally {
    if (claim !== null) { try { fs.rmSync(claim, { recursive: true, force: true }); } catch (err) { say(`auto-update: could not remove the dispatch claim (${err instanceof Error ? err.message : String(err)}); it is taken over after a minute`); } }
  }
}

/**
 * Reasons after which an install step had already run: some files on the machine may be new. Everything else that fails
 * stops before the first thing is changed.
 */
const INSTALL_ALREADY_RAN: ReadonlySet<string> = new Set([
  AUTO_UPDATE_REASONS.installFailed,
  AUTO_UPDATE_REASONS.readbackFailed,
  AUTO_UPDATE_REASONS.codexReadbackFailed,
  AUTO_UPDATE_REASONS.claudeReadbackFailed,
  AUTO_UPDATE_REASONS.installNotUndone,
  AUTO_UPDATE_REASONS.codexInstallFailed,
  AUTO_UPDATE_REASONS.codexRestoreFailed,
]);

/** Who holds the update lock, from the lock file itself (label, pid, start), or null when there is none or it cannot be read. */
export function describeLockHolder(dir: string): { label: string; pid: number; startedAt: string; running: boolean } | null {
  try {
    const [, pid, startedAt, label, startTag] = fs.readFileSync(path.join(dir, 'auto-update.lock'), 'utf8').split('\n');
    const started = Number(startedAt);
    if (!Number.isSafeInteger(Number(pid)) || !Number.isFinite(started)) return null;
    return { label: label === 'manual' ? 'manual' : 'auto', pid: Number(pid), startedAt: new Date(started).toISOString(), running: sameProcessAlive(Number(pid), startTag || null, pidAlive) };
  } catch { return null; }
}

/**
 * `memesh update` (and `--reinstall`): the same verified, reversible path the automatic update takes, run in the
 * foreground and started by hand. The policy and the wait for running sessions do not apply (the owner asked); the source
 * check, the database backup, the pinned install and the read-back all do. There is no second install path: this runs the
 * runner's own entry with --manual (or --reinstall).
 */
export function runManualUpdate(pluginRoot: string, dir: string = getMemeshDirFromDbPath(), options: { reinstall?: boolean } = {}): { code: number; lines: string[] } {
  const runnerPath = path.join(pluginRoot, 'scripts', 'hooks', 'auto-update-runner.mjs');
  const logPath = path.join(dir, LOG_FILE);
  if (!fs.existsSync(runnerPath)) {
    return { code: 1, lines: [`❌ The update runner is missing (${runnerPath}); reinstall MeMesh.`] };
  }
  ensureOwnerDir(dir);
  const before = readAutoUpdateState(dir)?.at ?? null;
  const offBeforeRun = currentPolicy().policy === 'off';
  // The runner's own one-line report is not shown: what is printed below is read from the record it wrote.
  const ran = spawnSync(process.execPath, [runnerPath, path.join(dir, 'auto-update.lock'), options.reinstall ? '--reinstall' : '--manual'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: process.env });
  const read = inspectAutoUpdateState(dir);
  const state = read.kind === 'ok' ? read.state : null;
  const fresh = state !== null && state.at !== before;
  // "off" stops the AUTOMATIC update only; this one was asked for. Say so, so nobody reads it as the setting having changed.
  const offNote = offBeforeRun ? ['ℹ️  Automatic updates are still off; this was an update you asked for by hand.'] : [];
  if (!fresh) {
    const tail = `${ran.stderr ?? ''}${ran.stdout ?? ''}`.trim().split('\n').slice(-3).join(' | ');
    if (ran.error) return { code: 1, lines: [`❌ No update was made: the runner could not start (${ran.error.message}).`, `   Log: ${logPath}`] };
    const interrupted = readInstalling(dir);
    if (ran.signal !== null || (interrupted && !interrupted.running)) {
      return { code: 1, lines: [
        `❌ The update was interrupted${ran.signal ? ` (${ran.signal})` : ''} before it recorded a result.`,
        interrupted ? `   An install to ${interrupted.marker.to} had started at ${interrupted.marker.at}, so some files may already be new: run \`memesh update --reinstall\` to put this version back through the same checks.` : '   Nothing had been installed yet.',
        `   Log: ${logPath}`,
      ] };
    }
    const holder = describeLockHolder(dir);
    const waiting = readAutoUpdateState(dir);
    if (holder !== null && holder.running && ran.status !== 0) {
      const what = holder.label === 'manual' ? 'an update you started by hand' : 'an automatic update';
      const wait = waiting?.outcome === 'waiting' && waiting.waitingSince
        ? ` It is waiting for running sessions to end (since ${waiting.waitingSince}, at most 3 days); closing them lets it finish.`
        : '';
      return { code: 1, lines: [`❌ No update was made: ${what} is already running (started ${holder.startedAt}, pid ${holder.pid}).${wait}`, '   Try again when it has finished; `memesh doctor` shows its state.'] };
    }
    if (read.kind === 'unreadable') return { code: 1, lines: [`❌ The update ran, but its record cannot be read (${read.detail}); \`memesh doctor\` shows what is on the machine.`, `   Log: ${logPath}`] };
    return { code: 1, lines: [`❌ No update was made: the runner ended (exit ${ran.status ?? 'none'}) without recording a result${tail ? `: ${tail}` : ''}.`, `   Log: ${logPath}`] };
  }
  const fresh_ = state as AutoUpdateState;
  // A provider copy that could not be refreshed is part of the result, not a detail of the state file.
  const hermesFailed = (Array.isArray(fresh_.hermes) ? fresh_.hermes : []).filter((h) => h.outcome === 'failed');
  const hermesLines = hermesFailed.map((h) => `⚠️  Hermes provider at ${h.path} was not updated: ${h.reason}`);
  if (fresh_.outcome === 'installed') {
    const verb = options.reinstall ? `Reinstalled ${fresh_.to ?? '?'}` : `Updated ${fresh_.from ?? '?'} → ${fresh_.to ?? '?'}`;
    const lines = [`✅ ${verb} (source verified; database backup: ${fresh_.backup ?? 'none'}).`, '   It takes effect in the next session you start; sessions already running keep the old version until they restart.', ...hermesLines, ...offNote];
    return { code: hermesFailed.length > 0 ? 1 : 0, lines };
  }
  if (fresh_.reason === AUTO_UPDATE_REASONS.upToDate) {
    if (hermesFailed.length > 0) return { code: 1, lines: [`⚠️  MeMesh itself is on the newest version (${fresh_.from ?? '?'}), but the Hermes provider could not be brought to it.`, ...hermesLines, ...offNote] };
    return { code: 0, lines: [`✅ Already on the newest version for this install (${fresh_.from ?? '?'}).`, ...offNote] };
  }
  const backupLine = fresh_.backup ? ` Your database backup: ${fresh_.backup}.` : '';
  const installRan = INSTALL_ALREADY_RAN.has(fresh_.reason);
  const effect = installRan
    ? `   An install step had already run, so some files may be new. \`memesh doctor\` shows what is on the machine; \`memesh update --reinstall\` puts this version back through the same checks.${backupLine}`
    : fresh_.reason === AUTO_UPDATE_REASONS.dependencyPinFailed
      ? `   Nothing was changed: the install was undone and ${fresh_.from ?? 'the version that was running'} is still what runs. The next \`memesh update\` tries again.${backupLine}`
      : `   Nothing was installed.${backupLine}`;
  // The first line says which version this machine is on when that is known to be true: it is, unless an install step ran.
  const still = !installRan && fresh_.from ? ` (still on ${fresh_.from})` : '';
  return { code: 1, lines: [`❌ Not updated${still}: ${fresh_.reason}`, ...(fresh_.detail ? [`   ${fresh_.detail}`] : []), effect, `   Log: ${logPath}`, ...offNote] };
}

/**
 * `memesh doctor --fix` for a plugin cache: start the verified reinstall in the background (it downloads, verifies and backs up,
 * which takes minutes: more than a repair button can wait). The result lands in the same record `memesh doctor` reads.
 */
export function startReinstall(pluginRoot: string, dir: string = getMemeshDirFromDbPath()): { started: boolean; message: string } {
  const runnerPath = path.join(pluginRoot, 'scripts', 'hooks', 'auto-update-runner.mjs');
  if (!fs.existsSync(runnerPath)) throw new Error(`The update runner is missing at ${runnerPath}; reinstall MeMesh.`);
  ensureOwnerDir(dir);
  const logPath = path.join(dir, LOG_FILE);
  const fd = fs.openSync(logPath, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [runnerPath, path.join(dir, 'auto-update.lock'), '--reinstall'], { detached: true, stdio: ['ignore', fd, fd], env: process.env, windowsHide: true });
    child.unref();
  } finally { fs.closeSync(fd); }
  return { started: true, message: `A verified reinstall of this version was started in the background (source check, database backup, install). It takes a few minutes; \`memesh doctor\` shows the result, and the log is ${logPath}.` };
}

/** The production wiring of `runAutoUpdate`, for the runner. */
export function productionDeps(packageRoot: string, currentVersion: string): AutoUpdateDeps {
  const channel = getCurrentInstallChannel({ packageRoot });
  const host = channel === 'plugin-marketplace' ? detectPluginHost(packageRoot) : null;
  const codexHome = codexHomeFor(packageRoot);
  return {
    env: process.env,
    accountHome: safeAccountHome(),
    dir: getMemeshDirFromDbPath(),
    liveHostsDir: accountMemeshDir() ?? getMemeshDirFromDbPath(),
    configDir: memeshDir(),
    dbPath: process.env.MEMESH_DB_PATH ?? path.join(memeshDir(), 'knowledge-graph.db'),
    packageRoot,
    currentVersion,
    channel,
    // A Codex plugin that is not ours (another marketplace's, a local development copy) is not a Codex install this updater may replace.
    pluginHost: host === 'codex' && codexHome === null ? null : host,
    codexHome,
    exec: defaultExec,
    readTags: () => readRegistryTags(defaultExec),
    tmpRoot: os.tmpdir(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
    readInstalledVersion: () => getInstalledGlobalVersion(),
  };
}
