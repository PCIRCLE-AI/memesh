import { spawn, spawnSync } from 'child_process';
import { createHash, X509Certificate } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from '../storage/sqlite.js';
import { detectPluginHost, getCurrentInstallChannel, getInstallChannelSupport } from './install-channel.js';
import { getMemeshDirFromDbPath, memeshDir } from './paths.js';
import { updateConfigInDir } from './config.js';
import { inspectInstall, refreshTargets, refreshInstalls, registryProblemResult, staleInstalls } from './hermes-provider.js';
import { compareSemVerPrecedence, normalizeRegistryVersion, parseSemVer } from './semver.js';
import { writeJustUpgradedMarker } from './update-notice.js';
import { processStartTag, sameProcessAlive } from './process-identity.js';
import { removeGroupAndOtherAccess } from './file-mode.js';
import { classifyBump, getInstalledGlobalVersion } from './updater.js';
export const DEFAULT_AUTO_UPDATE_POLICY = 'major';
export const PACKAGE_NAME = '@pcircle/memesh';
export const EXPECTED_SOURCE = {
    repository: 'https://github.com/PCIRCLE-AI/memesh',
    workflowPath: '.github/workflows/publish-npm.yml',
};
export const STATE_FILE = 'auto-update-state.json';
export const LOG_FILE = 'auto-update.log';
export const LIVE_HOSTS_DIR = 'live-hosts';
export const WAIT_FILE = 'auto-update-wait.json';
export const ATTEMPT_FILE = 'auto-update-attempt';
export const DISPATCH_CLAIM = 'auto-update-dispatch.claim';
const DISPATCH_CLAIM_STALE_MS = 60_000;
export const INSTALLING_FILE = 'auto-update-installing.json';
export const CODEX_RESTORE_FILE = 'auto-update-codex-restore.json';
export const BACKUPS_KEPT = 3;
export const ATTEMPT_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const LIVE_WAIT_POLL_MS = 15 * 1000;
export const LIVE_WAIT_MAX_MS = 3 * 24 * 60 * 60 * 1000;
export const CODEX_MARKETPLACE = 'pcircle-memesh';
export const CODEX_PLUGIN = 'memesh@pcircle-memesh';
export const CODEX_MARKETPLACE_SOURCE = 'PCIRCLE-AI/memesh';
export function ownerOnly(target) {
    removeGroupAndOtherAccess(target);
}
export function ensureOwnerDir(dir) {
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
};
const POLICY_RANK = { off: 0, patch: 1, minor: 2, major: 3 };
const BUMP_RANK = { patch: 1, minor: 2, major: 3 };
function readConfigFile(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    }
    catch (err) {
        const code = err.code ?? 'UNKNOWN';
        if (code !== 'ENOENT')
            return { state: 'unreadable', why: code };
        try {
            fs.lstatSync(file);
            return { state: 'unreadable', why: 'dangling symlink' };
        }
        catch (lerr) {
            const lcode = lerr.code ?? 'UNKNOWN';
            return lcode === 'ENOENT' ? { state: 'absent' } : { state: 'unreadable', why: lcode };
        }
    }
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return { state: 'unreadable', why: 'not a JSON object' };
        return { state: 'ok', raw: parsed };
    }
    catch {
        return { state: 'unreadable', why: 'not valid JSON' };
    }
}
export function isCi(env) {
    const truthy = (v) => v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
    return truthy(env.CI)
        || ['GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'JENKINS_URL', 'TF_BUILD', 'TRAVIS', 'APPVEYOR', 'CODEBUILD_BUILD_ID', 'TEAMCITY_VERSION', 'DRONE', 'BITBUCKET_BUILD_NUMBER', 'CIRRUS_CI', 'SEMAPHORE', 'container'].some((k) => truthy(env[k]));
}
export function safeAccountHome() {
    try {
        const home = os.userInfo().homedir;
        return home ? home : null;
    }
    catch {
        return null;
    }
}
function parsePolicy(value) {
    if (typeof value !== 'string')
        return null;
    const lowered = value.toLowerCase();
    return lowered === 'off' || lowered === 'patch' || lowered === 'minor' || lowered === 'major' ? lowered : null;
}
function samePath(a, b) {
    const real = (p) => { try {
        return fs.realpathSync(p);
    }
    catch {
        return path.resolve(p);
    } };
    return real(a) === real(b);
}
export function resolveUpdatePolicy(input) {
    const off = (reason, source, detail) => ({ policy: 'off', source, reason, ...(detail ? { detail } : {}) });
    const accountDir = input.accountHome === null ? null : path.join(input.accountHome, '.memesh');
    const configs = [];
    const seen = [];
    const addConfigDir = (dir, source) => {
        if (seen.some((d) => samePath(d, dir)))
            return;
        seen.push(dir);
        configs.push({ file: path.join(dir, 'config.json'), source });
    };
    addConfigDir(input.activeDir, 'config');
    const extraDirs = Array.isArray(input.extraConfigDirs) ? input.extraConfigDirs : [];
    for (const dir of extraDirs)
        addConfigDir(dir, 'config');
    if (accountDir !== null)
        addConfigDir(accountDir, 'account-config');
    const explicit = [];
    const envValue = input.env.MEMESH_AUTO_UPDATE;
    if (envValue !== undefined) {
        const parsed = parsePolicy(envValue);
        if (parsed === null)
            return off(AUTO_UPDATE_REASONS.policyOffInvalidValue, 'env');
        if (parsed === 'off')
            return off(AUTO_UPDATE_REASONS.policyOff, 'env');
        explicit.push({ policy: parsed, source: 'env' });
    }
    for (const { file, source } of configs) {
        const read = readConfigFile(file);
        if (read.state === 'unreadable')
            return off(AUTO_UPDATE_REASONS.policyOffUnreadableConfig, source, `${file}: ${read.why}`);
        if (read.state === 'absent')
            continue;
        if (read.raw.updateCheck === false)
            return off(AUTO_UPDATE_REASONS.policyOffUpdateCheck, source);
        if (read.raw.autoUpdate === undefined)
            continue;
        const parsed = parsePolicy(read.raw.autoUpdate);
        if (parsed === null)
            return off(AUTO_UPDATE_REASONS.policyOffInvalidValue, source);
        explicit.push({ policy: parsed, source });
    }
    const refused = explicit.find((e) => e.policy === 'off');
    if (refused)
        return off(AUTO_UPDATE_REASONS.policyOff, refused.source);
    if (explicit.length > 0)
        return { policy: explicit[0].policy, source: explicit[0].source, reason: null };
    if (accountDir === null)
        return off(AUTO_UPDATE_REASONS.policyOffNoAccountHome, 'none');
    if (isCi(input.env))
        return off(AUTO_UPDATE_REASONS.policyOffCi, 'none');
    const ownData = samePath(input.activeDir, accountDir) && !input.env.MEMESH_DB_PATH && !input.env.MEMESH_DIR;
    if (!ownData)
        return off(AUTO_UPDATE_REASONS.policyOffForeignHome, 'none');
    return { policy: DEFAULT_AUTO_UPDATE_POLICY, source: 'default', reason: null };
}
export function accountMemeshDir() {
    const home = safeAccountHome();
    return home === null ? null : path.join(home, '.memesh');
}
export function propagateOff(activeConfigDir, accountDir) {
    if (accountDir === null || samePath(accountDir, activeConfigDir))
        return { path: null, error: null };
    const file = path.join(accountDir, 'config.json');
    try {
        updateConfigInDir(accountDir, { autoUpdate: 'off' });
        return { path: file, error: null };
    }
    catch (err) {
        return { path: file, error: err instanceof Error ? err.message : String(err) };
    }
}
export function accountConfigHolding(activeConfigDir, accountDir) {
    if (accountDir === null || samePath(accountDir, activeConfigDir))
        return null;
    const file = path.join(accountDir, 'config.json');
    const read = readConfigFile(file);
    if (read.state === 'unreadable')
        return { path: file, kind: 'unreadable', why: read.why };
    return read.state === 'ok' && read.raw.autoUpdate === 'off' ? { path: file, kind: 'off', why: null } : null;
}
export function currentPolicy(env = process.env) {
    return resolveUpdatePolicy({ env, activeDir: getMemeshDirFromDbPath(), extraConfigDirs: [memeshDir()], accountHome: safeAccountHome() });
}
export function chooseTarget(current, tags) {
    const cur = parseSemVer(current);
    const latest = tags.latest ? parseSemVer(tags.latest) : null;
    const onNext = Boolean(cur && (cur.prerelease !== null || current === tags.next || (latest && compareSemVerPrecedence(cur, latest) > 0)));
    let stream = onNext ? 'next' : 'latest';
    let target = tags[stream] ?? null;
    if (stream === 'next' && cur && latest && compareSemVerPrecedence(latest, cur) > 0) {
        const nextVersion = tags.next ? parseSemVer(tags.next) : null;
        if (!nextVersion || compareSemVerPrecedence(nextVersion, cur) <= 0) {
            stream = 'latest';
            target = tags.latest ?? null;
        }
    }
    const parsedTarget = target ? parseSemVer(target) : null;
    if (!cur || !parsedTarget || compareSemVerPrecedence(cur, parsedTarget) >= 0)
        return { stream, target: null };
    return { stream, target };
}
export function bumpKind(from, to) {
    return classifyBump(from, to) ?? 'patch';
}
export function policyPermits(policy, bump) {
    return POLICY_RANK[policy] >= BUMP_RANK[bump];
}
function at(value, ...keys) {
    let cur = value;
    for (const key of keys) {
        if (cur === null || typeof cur !== 'object')
            return undefined;
        cur = cur[key];
    }
    return cur;
}
function statementOf(element) {
    const payload = at(element, 'bundle', 'dsseEnvelope', 'payload');
    if (typeof payload !== 'string')
        return null;
    try {
        return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    }
    catch {
        return null;
    }
}
export function signerIdentity(element) {
    const root = at(element, 'bundle');
    const raw = at(root, 'verificationMaterial', 'x509CertificateChain', 'certificates', 0, 'rawBytes')
        ?? at(root, 'verificationMaterial', 'certificate', 'rawBytes');
    if (typeof raw !== 'string')
        return null;
    try {
        const san = new X509Certificate(Buffer.from(raw, 'base64')).subjectAltName;
        const uri = san === undefined ? undefined : /URI:([^,\s]+)/.exec(san)?.[1];
        return uri ?? null;
    }
    catch {
        return null;
    }
}
export function judgeAuditSignatures(json, name, version, options) {
    let parsed;
    try {
        parsed = JSON.parse(json);
    }
    catch {
        return { ok: false, reason: 'npm audit signatures printed no JSON' };
    }
    if (!Array.isArray(parsed.invalid) || !Array.isArray(parsed.verified))
        return { ok: false, reason: 'npm audit signatures output has no verified/invalid lists' };
    if (parsed.invalid.length > 0)
        return { ok: false, reason: 'a package in the install has an invalid signature' };
    const entry = parsed.verified.find((e) => e.name === name && e.version === version);
    if (!entry)
        return { ok: false, reason: `${name}@${version} has no verified signature and provenance` };
    if (!Array.isArray(entry.attestationBundles))
        return { ok: false, reason: 'no attestation was included for this version' };
    for (const bundle of entry.attestationBundles) {
        const statement = statementOf(bundle);
        if (at(statement, 'predicateType') !== 'https://slsa.dev/provenance/v1')
            continue;
        const subjectList = at(statement, 'subject');
        const subjects = Array.isArray(subjectList) ? subjectList : [];
        const subjectNames = subjects.map((s) => String(at(s, 'name')));
        if (!subjectNames.includes(`pkg:npm/${name.replace('@', '%40')}@${version}`))
            continue;
        const workflow = at(statement, 'predicate', 'buildDefinition', 'externalParameters', 'workflow');
        const digest = subjects.find((subject) => at(subject, 'name') === `pkg:npm/${name.replace('@', '%40')}@${version}`);
        if (at(digest, 'digest', 'sha512') !== options.tarballSha512Hex)
            return { ok: false, reason: 'the attested package digest is not the digest of the downloaded tarball' };
        const expectedSigner = `${EXPECTED_SOURCE.repository}/${EXPECTED_SOURCE.workflowPath}@refs/tags/v${version}`;
        if ((options.signerOf ?? signerIdentity)(bundle) !== expectedSigner)
            return { ok: false, reason: 'the signing certificate does not name this repository\'s release workflow at this version\'s tag' };
        if (at(workflow, 'repository') !== EXPECTED_SOURCE.repository)
            return { ok: false, reason: 'provenance names a different repository' };
        if (at(workflow, 'path') !== EXPECTED_SOURCE.workflowPath)
            return { ok: false, reason: 'provenance names a different workflow' };
        if (at(workflow, 'ref') !== `refs/tags/v${version}`)
            return { ok: false, reason: 'provenance names a different tag' };
        const commit = at(statement, 'predicate', 'buildDefinition', 'resolvedDependencies', 0, 'digest', 'gitCommit');
        if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit))
            return { ok: false, reason: 'provenance carries no commit' };
        return { ok: true, gitCommit: commit };
    }
    return { ok: false, reason: 'no provenance statement for this version' };
}
export const COMPARE_SCRIPT = "fetch(process.argv[1],{headers:{accept:'application/vnd.github+json','user-agent':'memesh-auto-update'},signal:AbortSignal.timeout(20000)}).then(async(r)=>{process.stdout.write(r.status+'\\n'+await r.text())}).catch((e)=>{process.stderr.write(String(e));process.exit(1)})";
export function compareUrl(commit) {
    const slug = EXPECTED_SOURCE.repository.replace('https://github.com/', '');
    return `https://api.github.com/repos/${slug}/compare/${commit}...refs/heads/main?per_page=1`;
}
export function proxyConfigured(env) {
    return ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some((k) => typeof env[k] === 'string' && env[k] !== '');
}
export function nodeUsesEnvProxy(version = process.versions.node) {
    const [major, minor] = version.split('.').map(Number);
    return major > 24 || major === 24 || (major === 22 && minor >= 21);
}
export function compareEnv(env, version = process.versions.node) {
    return proxyConfigured(env) && nodeUsesEnvProxy(version) ? { ...env, NODE_USE_ENV_PROXY: '1' } : env;
}
export function judgeCommitOnMain(result, commit, proxyIgnored = false) {
    if (result.status !== 0) {
        const note = proxyIgnored ? `; a proxy is configured but this Node (${process.versions.node}) does not use it for fetch (it needs Node 22.21 or 24 and newer), so the request went out directly` : '';
        return { ok: false, code: 'unconfirmed', detail: `the lookup did not complete (${result.stderr.trim().slice(0, 120) || `exit ${result.status ?? 'none'}`})${note}` };
    }
    const newline = result.stdout.indexOf('\n');
    const http = newline < 0 ? result.stdout : result.stdout.slice(0, newline);
    const body = newline < 0 ? '' : result.stdout.slice(newline + 1);
    if (http === '404')
        return { ok: false, code: 'notOnMain', detail: 'the repository has no such commit' };
    if (http !== '200')
        return { ok: false, code: 'unconfirmed', detail: `GitHub answered ${http || 'nothing'}` };
    let parsed;
    try {
        parsed = JSON.parse(body);
    }
    catch {
        return { ok: false, code: 'unconfirmed', detail: 'GitHub\'s answer was not JSON' };
    }
    const status = at(parsed, 'status');
    const mergeBase = at(parsed, 'merge_base_commit', 'sha');
    if (typeof status !== 'string' || typeof mergeBase !== 'string')
        return { ok: false, code: 'unconfirmed', detail: 'GitHub\'s answer had no status and merge base' };
    if ((status === 'ahead' || status === 'identical') && mergeBase === commit)
        return { ok: true };
    return { ok: false, code: 'notOnMain', detail: `the commit is ${status} of main, not part of it` };
}
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
function shrinkwrapEntryProblem(key, entry) {
    const where = key.replace(/^node_modules\//, '');
    const version = at(entry, 'version');
    if (typeof version !== 'string')
        return `${where} has no pinned version`;
    const resolved = at(entry, 'resolved');
    if (typeof resolved !== 'string')
        return `${where} is not pinned to the npm registry`;
    const alias = at(entry, 'name');
    const name = typeof alias === 'string' ? alias : key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const last = name.startsWith('@') ? name.split('/')[1] : name;
    if (resolved !== `https://registry.npmjs.org/${name}/-/${last}-${version}.tgz`)
        return `${where} is not pinned to its own address on the npm registry (${resolved})`;
    const integrity = at(entry, 'integrity');
    if (typeof integrity !== 'string' || !SHA512_INTEGRITY.test(integrity))
        return `${where} has no full sha512 integrity hash`;
    return null;
}
export function judgeShrinkwrap(text, version) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return { ok: false, detail: 'npm-shrinkwrap.json is not JSON' };
    }
    const packages = at(parsed, 'packages');
    if (packages === null || typeof packages !== 'object' || Array.isArray(packages))
        return { ok: false, detail: 'npm-shrinkwrap.json has no package list' };
    const entries = Object.entries(packages);
    if (at(packages, '', 'version') !== version)
        return { ok: false, detail: 'npm-shrinkwrap.json is not for this version' };
    const dependencies = at(packages, '', 'dependencies');
    for (const name of dependencies !== null && typeof dependencies === 'object' ? Object.keys(dependencies) : []) {
        if (typeof at(packages, `node_modules/${name}`, 'version') !== 'string')
            return { ok: false, detail: `npm-shrinkwrap.json does not pin ${name}` };
    }
    for (const [key, entry] of entries) {
        if (key === '')
            continue;
        const problem = shrinkwrapEntryProblem(key, entry);
        if (problem)
            return { ok: false, detail: problem };
    }
    return { ok: true };
}
export function sha512Integrity(file) {
    return `sha512-${createHash('sha512').update(fs.readFileSync(file)).digest('base64')}`;
}
function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        const code = err.code;
        return code !== 'ESRCH' && code !== 'EPERM';
    }
}
export function registerLiveHost(dir, pid = process.ppid, logDir = dir) {
    if (!Number.isSafeInteger(pid) || pid <= 1) {
        appendLog(logDir, `auto-update: this host's process id (${pid}) cannot be registered as a running host, so the updater will not wait for it`);
        return;
    }
    const root = path.join(dir, LIVE_HOSTS_DIR);
    ensureOwnerDir(root);
    const hostFile = path.join(root, `${pid}.json`);
    fs.writeFileSync(hostFile, JSON.stringify({ pid, at: new Date().toISOString(), started: processStartTag(pid) }), { mode: 0o600 });
    ownerOnly(hostFile);
}
export function liveHostPids(dir) {
    const root = path.join(dir, LIVE_HOSTS_DIR);
    let names;
    try {
        names = fs.readdirSync(root);
    }
    catch (err) {
        if (err.code !== 'ENOENT')
            return null;
        try {
            fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
            return [];
        }
        catch (e) {
            return e.code === 'ENOENT' ? [] : null;
        }
    }
    try {
        fs.accessSync(root, fs.constants.W_OK | fs.constants.X_OK);
    }
    catch {
        return null;
    }
    const alive = [];
    for (const name of names) {
        const pid = Number(name.replace(/\.json$/, ''));
        if (!Number.isSafeInteger(pid) || pid <= 1)
            continue;
        let started = null;
        try {
            started = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')).started ?? null;
        }
        catch { }
        if (sameProcessAlive(pid, started, pidAlive))
            alive.push(pid);
        else {
            const reused = pidAlive(pid);
            appendLog(dir, `auto-update: host pid ${pid} ${reused ? `is now another program${started ? ` (registered as started ${started})` : ''}` : 'is no longer running'}; its registration was removed`);
            try {
                fs.unlinkSync(path.join(root, name));
            }
            catch (err) {
                if (err.code !== 'ENOENT')
                    appendLog(dir, `auto-update: could not remove the registration of host pid ${pid} (${err.message}); it is checked again next time`);
            }
        }
    }
    return alive;
}
export function backupDatabase(dbPath, backupDir, tag, now = new Date()) {
    if (!fs.existsSync(dbPath))
        return null;
    ensureOwnerDir(backupDir);
    const target = path.join(backupDir, `pre-update-${tag}-${now.toISOString().replace(/[:.]/g, '-')}.db`);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    }
    finally {
        db.close();
    }
    fs.chmodSync(target, 0o600);
    const stamped = fs.readdirSync(backupDir)
        .filter((f) => f.startsWith('pre-update-') && f.endsWith('.db'))
        .map((f) => {
        try {
            return { f, at: fs.statSync(path.join(backupDir, f)).mtimeMs };
        }
        catch {
            return { f, at: 0 };
        }
    })
        .sort((x, y) => x.at - y.at || x.f.localeCompare(y.f));
    for (const { f } of stamped.slice(0, Math.max(0, stamped.length - BACKUPS_KEPT))) {
        if (path.join(backupDir, f) === target)
            continue;
        try {
            fs.unlinkSync(path.join(backupDir, f));
        }
        catch { }
    }
    return target;
}
function readWaitStart(dir, target) {
    try {
        const value = JSON.parse(fs.readFileSync(path.join(dir, WAIT_FILE), 'utf8'));
        const since = typeof value.since === 'string' ? Date.parse(value.since) : NaN;
        return value.target === target && Number.isFinite(since) ? since : null;
    }
    catch {
        return null;
    }
}
function writeWaitStart(dir, target, since) {
    try {
        ensureOwnerDir(dir);
        const waitFile = path.join(dir, WAIT_FILE);
        fs.writeFileSync(waitFile, JSON.stringify({ target, since: new Date(since).toISOString() }), { mode: 0o600 });
        ownerOnly(waitFile);
    }
    catch (err) {
        appendLog(dir, `auto-update: could not record when the wait began (${err instanceof Error ? err.message : String(err)}); a restarted runner would count the 3 days again`);
    }
}
function clearWaitStart(dir) {
    try {
        fs.unlinkSync(path.join(dir, WAIT_FILE));
    }
    catch { }
}
function writeState(dir, state) {
    try {
        ensureOwnerDir(dir);
        const file = path.join(dir, STATE_FILE);
        const tmp = `${file}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
        ownerOnly(tmp);
        fs.renameSync(tmp, file);
    }
    catch { }
}
export function inspectAutoUpdateState(dir) {
    const file = path.join(dir, STATE_FILE);
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    }
    catch (err) {
        const code = err?.code;
        if (code === 'ENOENT') {
            try {
                fs.lstatSync(file);
            }
            catch (e2) {
                if (e2?.code === 'ENOENT')
                    return { kind: 'absent' };
            }
        }
        return { kind: 'unreadable', detail: err instanceof Error ? err.message : String(err) };
    }
    try {
        const value = JSON.parse(raw);
        if (!value || typeof value !== 'object' || typeof value.outcome !== 'string')
            return { kind: 'unreadable', detail: 'the file is JSON but not an update record' };
        const hermes = value.hermes;
        if (hermes !== undefined && hermes !== null) {
            const element = (h) => h !== null && typeof h === 'object'
                && typeof h.path === 'string' && typeof h.outcome === 'string' && typeof h.reason === 'string';
            if (!Array.isArray(hermes) || !hermes.every(element))
                return { kind: 'unreadable', detail: 'the "hermes" list holds an entry that is not a result (path, outcome, reason)' };
        }
        return { kind: 'ok', state: value };
    }
    catch (err) {
        return { kind: 'unreadable', detail: err instanceof Error ? err.message : String(err) };
    }
}
export function readAutoUpdateState(dir) {
    const read = inspectAutoUpdateState(dir);
    return read.kind === 'ok' ? read.state : null;
}
function writeInstalling(dir, marker) {
    try {
        ensureOwnerDir(dir);
        const file = path.join(dir, INSTALLING_FILE);
        fs.writeFileSync(file, JSON.stringify(marker), { mode: 0o600 });
        ownerOnly(file);
    }
    catch (err) {
        appendLog(dir, `auto-update: could not write the record that an install started (${err instanceof Error ? err.message : String(err)})`);
    }
}
function clearInstalling(dir) {
    try {
        fs.unlinkSync(path.join(dir, INSTALLING_FILE));
    }
    catch { }
}
export function readInstalling(dir) {
    try {
        const value = JSON.parse(fs.readFileSync(path.join(dir, INSTALLING_FILE), 'utf8'));
        if (typeof value.at !== 'string' || typeof value.to !== 'string' || typeof value.pid !== 'number')
            return null;
        const marker = { at: value.at, from: String(value.from ?? '?'), to: value.to, pid: value.pid, started: typeof value.started === 'string' ? value.started : null };
        return { marker, running: sameProcessAlive(marker.pid, marker.started, pidAlive) };
    }
    catch {
        return null;
    }
}
export function logAutoUpdateLine(dir, line) {
    appendLog(dir, line);
}
function oneLine(text) {
    return text.replace(/[\r\n\u2028\u2029]+/g, ' ');
}
function appendLog(dir, line) {
    try {
        ensureOwnerDir(dir);
        fs.appendFileSync(path.join(dir, LOG_FILE), `[${new Date().toISOString()}] ${oneLine(line)}\n`, { mode: 0o600 });
        ownerOnly(path.join(dir, LOG_FILE));
    }
    catch { }
}
const defaultExec = (cmd, args, opts = {}) => {
    const r = spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, encoding: 'utf8', timeout: opts.timeoutMs ?? 8 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
export function readRegistryTags(exec = defaultExec) {
    const r = exec('npm', ['view', PACKAGE_NAME, 'dist-tags', '--json'], { timeoutMs: 15_000 });
    if (r.status !== 0)
        return null;
    try {
        const parsed = JSON.parse(r.stdout);
        const tags = {};
        for (const key of ['latest', 'next']) {
            const raw = parsed[key];
            const v = typeof raw === 'string' ? normalizeRegistryVersion(raw) : null;
            if (v)
                tags[key] = v;
        }
        return tags;
    }
    catch {
        return null;
    }
}
function unchanged(staged) {
    try {
        return sha512Integrity(staged.tarball) === staged.integrity;
    }
    catch {
        return false;
    }
}
const PIN_TIMEOUT_MS = 10 * 60 * 1000;
const WORK_PREFIXES = ['memesh-update-', 'memesh-hermes-'];
const WORK_OWNER = 'owner.json';
function makeWorkDir(root, prefix) {
    const dir = fs.mkdtempSync(path.join(root, prefix));
    try {
        fs.writeFileSync(path.join(dir, WORK_OWNER), JSON.stringify({ pid: process.pid, started: processStartTag(process.pid) }));
    }
    catch { }
    return dir;
}
export function sweepWorkDirs(root, nowMs = Date.now()) {
    const removed = [];
    let names;
    try {
        names = fs.readdirSync(root);
    }
    catch {
        return removed;
    }
    for (const name of names) {
        if (!WORK_PREFIXES.some((prefix) => name.startsWith(prefix)))
            continue;
        const dir = path.join(root, name);
        try {
            const stat = fs.lstatSync(dir);
            if (!stat.isDirectory() || (typeof process.getuid === 'function' && stat.uid !== process.getuid()))
                continue;
            let owner = null;
            try {
                owner = JSON.parse(fs.readFileSync(path.join(dir, WORK_OWNER), 'utf8'));
            }
            catch { }
            if (owner && typeof owner.pid === 'number') {
                if (sameProcessAlive(owner.pid, typeof owner.started === 'string' ? owner.started : null, pidAlive))
                    continue;
            }
            else if (nowMs - stat.mtimeMs < 3_600_000)
                continue;
            fs.rmSync(dir, { recursive: true, force: true });
            removed.push(dir);
        }
        catch { }
    }
    return removed;
}
function stageAndVerify(deps, target) {
    const swept = sweepWorkDirs(deps.tmpRoot);
    if (swept.length > 0)
        appendLog(deps.dir, `auto-update: removed ${swept.length} working director${swept.length === 1 ? 'y' : 'ies'} left by an update that was killed`);
    const stage = makeWorkDir(deps.tmpRoot, 'memesh-update-');
    const cleanup = () => { try {
        fs.rmSync(stage, { recursive: true, force: true });
    }
    catch { } };
    const fail = (code, detail) => { cleanup(); return { ok: false, code, detail }; };
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: 'memesh-update-probe', version: '1.0.0', private: true }));
    const install = deps.exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', `${PACKAGE_NAME}@${target}`], { cwd: stage });
    if (install.status !== 0)
        return fail(AUTO_UPDATE_REASONS.sourceNotVerified, 'staging install failed');
    const pack = deps.exec('npm', ['pack', `${PACKAGE_NAME}@${target}`, '--pack-destination', stage, '--silent'], { cwd: stage });
    const tarball = path.join(stage, pack.stdout.trim().split('\n').pop() ?? '');
    if (pack.status !== 0 || !fs.existsSync(tarball) || !fs.statSync(tarball).isFile())
        return fail(AUTO_UPDATE_REASONS.tarballMismatch, 'npm pack produced no tarball');
    const audit = deps.exec('npm', ['audit', 'signatures', '--json', '--include-attestations'], { cwd: stage });
    const bytes = fs.readFileSync(tarball);
    const verdict = judgeAuditSignatures(audit.stdout, PACKAGE_NAME, target, {
        tarballSha512Hex: createHash('sha512').update(bytes).digest('hex'),
        ...(deps.signerOf ? { signerOf: deps.signerOf } : {}),
    });
    if (!verdict.ok)
        return fail(AUTO_UPDATE_REASONS.sourceNotVerified, verdict.reason);
    const onMain = judgeCommitOnMain(deps.exec(process.execPath, ['-e', COMPARE_SCRIPT, compareUrl(verdict.gitCommit)], { cwd: stage, env: compareEnv(deps.env), timeoutMs: 40_000 }), verdict.gitCommit, proxyConfigured(deps.env) && !nodeUsesEnvProxy());
    if (!onMain.ok)
        return fail(onMain.code === 'notOnMain' ? AUTO_UPDATE_REASONS.commitNotOnMain : AUTO_UPDATE_REASONS.commitUnconfirmed, onMain.detail);
    const shrinkwrap = deps.exec('tar', ['-xzOf', tarball, 'package/npm-shrinkwrap.json']);
    const pinned = shrinkwrap.status === 0 ? judgeShrinkwrap(shrinkwrap.stdout, target) : { ok: false, detail: 'the package has no npm-shrinkwrap.json' };
    if (!pinned.ok)
        return fail(AUTO_UPDATE_REASONS.dependenciesNotPinned, pinned.detail);
    const unpackDir = path.join(stage, 'pinned');
    fs.mkdirSync(unpackDir);
    const unpack = deps.exec('tar', ['-xzf', tarball, '-C', unpackDir, '--no-same-owner']);
    const unpacked = path.join(unpackDir, 'package');
    if (unpack.status !== 0 || !fs.existsSync(unpacked))
        return fail(AUTO_UPDATE_REASONS.dependenciesNotFetched, 'the verified package could not be unpacked');
    const rehearsal = deps.exec('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: unpacked, timeoutMs: PIN_TIMEOUT_MS });
    if (rehearsal.status !== 0)
        return fail(AUTO_UPDATE_REASONS.dependenciesNotFetched, rehearsal.stderr.trim() || `npm ci ${rehearsal.status === null ? 'did not finish in time' : `exited ${rehearsal.status}`}`);
    let lockIntegrity;
    try {
        lockIntegrity = JSON.parse(fs.readFileSync(path.join(stage, 'package-lock.json'), 'utf8')).packages?.[`node_modules/${PACKAGE_NAME}`]?.integrity;
    }
    catch { }
    if (typeof lockIntegrity !== 'string' || lockIntegrity !== `sha512-${createHash('sha512').update(bytes).digest('base64')}`)
        return fail(AUTO_UPDATE_REASONS.tarballMismatch, 'integrity differs from the verified install');
    return { ok: true, tarball, integrity: lockIntegrity, gitCommit: verdict.gitCommit, cleanup };
}
export function stripMultilineStrings(toml) {
    return toml.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, '""');
}
export function codexMarketplaceState(codexHome) {
    let text;
    try {
        text = stripMultilineStrings(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
    }
    catch (err) {
        return err.code === 'ENOENT' ? 'missing' : 'unreadable';
    }
    const table = new RegExp(`^\\[marketplaces\\.${CODEX_MARKETPLACE}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm').exec(text);
    if (!table) {
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
function codexDecision(deps) {
    if (deps.codexHome === null)
        return { state: 'missing', skip: AUTO_UPDATE_REASONS.codexHomeUnknown };
    const state = codexMarketplaceState(deps.codexHome);
    if (state === 'foreign')
        return { state, skip: AUTO_UPDATE_REASONS.codexMarketplaceForeign };
    if (state === 'unreadable')
        return { state, skip: AUTO_UPDATE_REASONS.codexMarketplaceUnreadable };
    if (state === 'missing' && !deps.reinstall)
        return { state, skip: AUTO_UPDATE_REASONS.codexMarketplaceMissing };
    return { state, skip: null };
}
export function codexHomeFor(packageRoot) {
    const parts = path.resolve(packageRoot).split(path.sep);
    for (let i = parts.length - 4; i >= 1; i -= 1) {
        if (parts[i] === 'plugins' && parts[i + 1] === 'cache' && parts[i + 2] === CODEX_MARKETPLACE)
            return parts.slice(0, i).join(path.sep) || path.sep;
    }
    return null;
}
function codexConfigFingerprint(codexHome) {
    try {
        return createHash('sha256').update(fs.readFileSync(path.join(codexHome, 'config.toml'))).digest('hex');
    }
    catch (err) {
        return err.code === 'ENOENT' ? 'absent' : 'unreadable';
    }
}
function codexMarketplaceSource(codexHome) {
    try {
        const text = stripMultilineStrings(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
        const table = new RegExp(`^\\[marketplaces\\.${CODEX_MARKETPLACE}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm').exec(text);
        return table ? (/^source\s*=\s*"([^"]*)"/m.exec(table[1])?.[1] ?? null) : null;
    }
    catch {
        return null;
    }
}
function readCodexRestoreRecord(dir) {
    let text;
    try {
        text = fs.readFileSync(path.join(dir, CODEX_RESTORE_FILE), 'utf8');
    }
    catch (err) {
        return err.code === 'ENOENT' ? null : 'damaged';
    }
    try {
        const v = JSON.parse(text);
        return typeof v.marketplace === 'string' && typeof v.source === 'string' && typeof v.configAfter === 'string' && typeof v.at === 'string'
            ? { marketplace: v.marketplace, original: typeof v.original === 'string' ? v.original : null, source: v.source, configAfter: v.configAfter, at: v.at }
            : 'damaged';
    }
    catch {
        return 'damaged';
    }
}
function repairCodexMarketplace(deps) {
    if (deps.codexHome === null)
        return;
    const file = path.join(deps.dir, CODEX_RESTORE_FILE);
    const record = readCodexRestoreRecord(deps.dir);
    if (record === null)
        return;
    const drop = (why) => {
        appendLog(deps.dir, `auto-update: codex marketplace record dropped: ${why}`);
        try {
            fs.rmSync(file, { force: true });
        }
        catch (err) {
            appendLog(deps.dir, `auto-update: could not delete ${file} (${err instanceof Error ? err.message : String(err)})`);
        }
    };
    if (record === 'damaged')
        return drop('the record could not be read, so nothing is restored from it');
    const state = codexMarketplaceState(deps.codexHome);
    if (state !== 'missing')
        return drop(`the marketplace is ${state} now, so there is nothing to put back`);
    if (codexConfigFingerprint(deps.codexHome) !== record.configAfter)
        return drop('config.toml changed after the failed restore, so the missing marketplace is not ours to put back');
    const added = deps.exec('codex', ['plugin', 'marketplace', 'add', record.source], { env: { ...deps.env, CODEX_HOME: deps.codexHome } });
    if (added.status === 0 && codexMarketplaceState(deps.codexHome) === 'official') {
        appendLog(deps.dir, `auto-update: the Codex marketplace ${record.marketplace} that a failed update had removed was put back (${record.source})`);
        try {
            fs.rmSync(file, { force: true });
        }
        catch (err) {
            appendLog(deps.dir, `auto-update: could not delete ${file} (${err instanceof Error ? err.message : String(err)})`);
        }
        return;
    }
    appendLog(deps.dir, `auto-update: the Codex marketplace ${record.marketplace} could not be put back yet (${oneLine(added.stderr).slice(0, 160)}); the next run tries again`);
}
function updateCodexPlugin(deps, codexHome, commit, target, wasMissing = false) {
    const env = { ...deps.env, CODEX_HOME: codexHome };
    const codex = (...args) => deps.exec('codex', ['plugin', ...args], { env });
    const restore = () => {
        codex('marketplace', 'remove', CODEX_MARKETPLACE);
        if (wasMissing)
            return codexMarketplaceState(codexHome) === 'missing';
        return codex('marketplace', 'add', CODEX_MARKETPLACE_SOURCE).status === 0;
    };
    if (!wasMissing) {
        const removed = codex('marketplace', 'remove', CODEX_MARKETPLACE);
        if (removed.status !== 0)
            return { kind: 'step', detail: `marketplace remove: ${removed.stderr}`, restored: true, untouched: true };
    }
    const added = codex('marketplace', 'add', CODEX_MARKETPLACE_SOURCE, '--ref', commit);
    if (added.status !== 0)
        return { kind: 'step', detail: `marketplace add: ${added.stderr}`, restored: restore() };
    const installed = codex('add', CODEX_PLUGIN);
    if (installed.status !== 0)
        return { kind: 'step', detail: `plugin add: ${installed.stderr}`, restored: restore() };
    const root = /Installed plugin root:\s*(.+)$/m.exec(installed.stdout)?.[1]?.trim();
    if (root === undefined || path.basename(root) !== target)
        return { kind: 'readback' };
    try {
        if (!fs.statSync(root).isDirectory())
            return { kind: 'readback' };
    }
    catch {
        return { kind: 'readback' };
    }
    try {
        const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
        if (typeof version === 'string' && version !== target)
            return { kind: 'readback' };
    }
    catch { }
    return null;
}
function claudeConfigRoot(env) {
    if (env.CLAUDE_CONFIG_DIR)
        return env.CLAUDE_CONFIG_DIR;
    return env.HOME ? path.join(env.HOME, '.claude') : null;
}
function claudeRegistryRecords(deps, commit, version) {
    const root = claudeConfigRoot(deps.env);
    const file = deps.claudeRegistryPath ?? (root === null ? null : path.join(root, 'plugins', 'installed_plugins.json'));
    if (file === null)
        return false;
    try {
        const entries = at(JSON.parse(fs.readFileSync(file, 'utf8')), 'plugins', 'memesh@pcircle-memesh');
        return Array.isArray(entries) && entries.some((e) => at(e, 'gitCommitSha') === commit && (typeof at(e, 'version') !== 'string' || at(e, 'version') === version));
    }
    catch {
        return false;
    }
}
function installGlobal(deps, tarball) {
    const root = deps.exec('npm', ['root', '-g']);
    const rootDir = root.status === 0 ? root.stdout.trim() : '';
    if (rootDir === '')
        return { ok: false, reason: AUTO_UPDATE_REASONS.globalDirUnknown, detail: root.stderr };
    const installedDir = path.join(rootDir, ...PACKAGE_NAME.split('/'));
    try {
        for (const name of fs.readdirSync(path.dirname(installedDir))) {
            const m = /^memesh\.rollback-(\d+)$/.exec(name);
            if (m && !pidAlive(Number(m[1])))
                fs.rmSync(path.join(path.dirname(installedDir), name), { recursive: true, force: true });
        }
    }
    catch { }
    const had = fs.existsSync(installedDir);
    const rollbackDir = path.join(path.dirname(installedDir), `memesh.rollback-${process.pid}`);
    if (had) {
        try {
            fs.rmSync(rollbackDir, { recursive: true, force: true });
            fs.cpSync(installedDir, rollbackDir, { recursive: true, verbatimSymlinks: true });
        }
        catch (err) {
            try {
                fs.rmSync(rollbackDir, { recursive: true, force: true });
            }
            catch { }
            return { ok: false, reason: AUTO_UPDATE_REASONS.rollbackUnavailable, detail: err instanceof Error ? err.message : String(err) };
        }
    }
    const putBack = () => {
        if (!had)
            return true;
        try {
            fs.rmSync(installedDir, { recursive: true, force: true });
            fs.renameSync(rollbackDir, installedDir);
            return true;
        }
        catch {
            return false;
        }
    };
    const failed = (reason, detail) => {
        if (putBack())
            return { ok: false, reason, detail: `the previous version was put back; npm said: ${detail.trim()}` };
        return { ok: false, reason: AUTO_UPDATE_REASONS.installNotUndone, detail: `a copy of the previous version is at ${rollbackDir}; npm said: ${detail.trim()}` };
    };
    const install = deps.exec('npm', ['install', '-g', '--ignore-scripts', tarball]);
    if (install.status !== 0)
        return failed(AUTO_UPDATE_REASONS.installFailed, install.stderr);
    if (!fs.existsSync(path.join(installedDir, 'npm-shrinkwrap.json')))
        return failed(AUTO_UPDATE_REASONS.dependencyPinFailed, 'the installed package has no npm-shrinkwrap.json');
    const pin = deps.exec('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: installedDir, timeoutMs: PIN_TIMEOUT_MS });
    if (pin.status !== 0)
        return failed(AUTO_UPDATE_REASONS.dependencyPinFailed, pin.stderr.trim() || `npm ci ${pin.status === null ? 'did not finish in time' : `exited ${pin.status}`}`);
    if (had) {
        try {
            fs.rmSync(rollbackDir, { recursive: true, force: true });
        }
        catch { }
    }
    return { ok: true };
}
const PROVIDER_PREFIX = 'package/extensions/hermes-memesh/';
export function unsafeTarEntries(verbose, names) {
    const lines = verbose.split('\n').filter((line) => line.trim() !== '');
    if (lines.length !== names.length)
        return [`the two listings of the package do not line up (${lines.length} entries with a type, ${names.length} names)`];
    const bad = [];
    names.forEach((name, i) => {
        const type = lines[i][0];
        const segments = name.split('/');
        const outside = !(name === 'package/extensions/hermes-memesh' || name === PROVIDER_PREFIX || name.startsWith(PROVIDER_PREFIX));
        if (type !== '-' && type !== 'd')
            bad.push(`${name} (type ${type})`);
        else if (name.startsWith('/') || segments.includes('..'))
            bad.push(`${name} (path escapes)`);
        else if (outside)
            bad.push(`${name} (outside the provider directory)`);
    });
    return bad;
}
export function refreshHermes(deps, tarball, version, expectedIntegrity) {
    const targets = refreshTargets(deps.dir, deps.env, deps.accountHome);
    const problem = registryProblemResult(deps.dir);
    if (targets.length === 0)
        return problem ? [problem] : null;
    const ours = targets.filter((p) => { const state = inspectInstall(p).state; return state === 'managed' || state === 'absent'; });
    const failAll = (reason) => [...(problem ? [problem] : []), ...ours.map((p) => ({ path: p, outcome: 'failed', reason, backup: null }))];
    const work = makeWorkDir(deps.tmpRoot, 'memesh-hermes-');
    try {
        const mine = path.join(work, 'package.tgz');
        try {
            fs.copyFileSync(tarball, mine);
        }
        catch {
            return failAll(AUTO_UPDATE_REASONS.tarballChanged);
        }
        if (sha512Integrity(mine) !== expectedIntegrity)
            return failAll(AUTO_UPDATE_REASONS.tarballChanged);
        const why = (r) => `tar exit ${r.status ?? 'none'}${r.stderr.trim() ? `: ${r.stderr.trim().replace(/\s+/g, ' ').slice(0, 120)}` : ''}`;
        const names = deps.exec('tar', ['-tzf', mine, 'package/extensions/hermes-memesh']);
        if (names.status !== 0)
            return failAll(`the verified package could not be listed (${why(names)})`);
        if (names.stdout.trim() === '')
            return failAll('the verified package holds no Hermes provider');
        const listing = deps.exec('tar', ['-tvzf', mine, 'package/extensions/hermes-memesh']);
        if (listing.status !== 0)
            return failAll(`the verified package could not be listed (${why(listing)})`);
        const hostile = unsafeTarEntries(listing.stdout, names.stdout.split('\n').filter((line) => line !== ''));
        if (hostile.length > 0)
            return failAll(`refused: the package holds entries that are not plain files under the provider directory (${hostile.slice(0, 3).join('; ')})`);
        const extracted = deps.exec('tar', ['-xzf', mine, '-C', work, '--no-same-owner', 'package/extensions/hermes-memesh']);
        if (extracted.status !== 0)
            return failAll(`the provider could not be extracted (${why(extracted)})`);
        const sourceDir = path.join(work, 'package', 'extensions', 'hermes-memesh');
        if (!fs.existsSync(sourceDir))
            return failAll('the verified package holds no Hermes provider');
        const realWork = fs.realpathSync(work);
        const realSource = fs.realpathSync(sourceDir);
        if (realSource !== path.join(realWork, 'package', 'extensions', 'hermes-memesh'))
            return failAll('refused: the extracted provider is not where it was expected');
        return refreshInstalls({ sourceDir, version, memeshDir: deps.dir, env: deps.env, accountHome: deps.accountHome, now: deps.now(), log: (line) => appendLog(deps.dir, `auto-update: ${line}`) });
    }
    catch (err) {
        return failAll(`failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`);
    }
    finally {
        try {
            fs.rmSync(work, { recursive: true, force: true });
        }
        catch (err) {
            appendLog(deps.dir, `auto-update: could not remove the working directory ${work} (${err instanceof Error ? err.message : String(err)})`);
        }
    }
}
export async function runAutoUpdate(deps) {
    const base = { from: deps.currentVersion, channel: deps.channel };
    let to = null;
    let backup = null;
    let waitingSince = null;
    let hermes = null;
    const finish = (outcome, reason, detail) => {
        const state = { at: deps.now().toISOString(), outcome, reason, from: base.from, to, channel: base.channel, backup, waitingSince: outcome === 'waiting' ? waitingSince : null, hermes, notice: deps.notice ?? null, detail: detail ? oneLine(detail).trim().slice(0, 300) : null };
        writeState(deps.dir, state);
        if (outcome !== 'waiting')
            clearInstalling(deps.dir);
        if (hermes !== null)
            for (const h of hermes)
                appendLog(deps.dir, `auto-update hermes-provider ${h.outcome.toUpperCase()}: ${h.reason} path=${h.path}${h.backup ? ` backup=${h.backup}` : ''}`);
        appendLog(deps.dir, `auto-update ${outcome.toUpperCase()}: ${reason}${detail ? ` (${detail.replace(/[\r\n]+/g, ' ').slice(0, 200)})` : ''} from=${base.from} to=${to ?? '-'} channel=${base.channel}`);
        return { outcome, reason };
    };
    try {
        const policyNow = () => deps.manual
            ? { policy: 'major', source: 'default', reason: null }
            : resolveUpdatePolicy({ env: deps.env, activeDir: deps.dir, extraConfigDirs: [deps.configDir], accountHome: deps.accountHome });
        const decision = policyNow();
        if (decision.policy === 'off')
            return finish('skipped', decision.reason ?? AUTO_UPDATE_REASONS.policyOff, decision.detail);
        const supported = deps.channel === 'npm-global' || (deps.channel === 'plugin-marketplace' && deps.pluginHost !== null);
        if (!supported)
            return finish('skipped', AUTO_UPDATE_REASONS.channelUnsupported);
        if (deps.pluginHost === 'codex')
            repairCodexMarketplace(deps);
        let target;
        if (deps.reinstall) {
            target = deps.currentVersion;
        }
        else {
            const tags = deps.readTags();
            if (!tags)
                return finish('failed', AUTO_UPDATE_REASONS.registryUnreachable);
            target = chooseTarget(deps.currentVersion, tags).target;
        }
        if (!target) {
            if (readAutoUpdateState(deps.dir)?.reason === AUTO_UPDATE_REASONS.installNotUndone)
                return finish('failed', AUTO_UPDATE_REASONS.installNotUndone, 'still unfinished from the earlier attempt');
            const stale = staleInstalls(deps.dir, deps.env, deps.currentVersion, deps.accountHome);
            const unreadableList = registryProblemResult(deps.dir);
            if (stale.length > 0) {
                const current = stageAndVerify(deps, deps.currentVersion);
                if (current.ok) {
                    try {
                        hermes = refreshHermes(deps, current.tarball, deps.currentVersion, current.integrity);
                    }
                    finally {
                        current.cleanup();
                    }
                }
                else {
                    hermes = [...(unreadableList ? [unreadableList] : []), ...stale.map((p) => ({ path: p, outcome: 'failed', reason: current.code, backup: null }))];
                }
            }
            else if (unreadableList) {
                hermes = [unreadableList];
            }
            return finish('skipped', AUTO_UPDATE_REASONS.upToDate);
        }
        to = target;
        if (!policyPermits(decision.policy, bumpKind(deps.currentVersion, target)))
            return finish('skipped', AUTO_UPDATE_REASONS.bumpNotPermitted);
        if (deps.pluginHost === 'codex') {
            const decided = codexDecision(deps);
            if (decided.skip)
                return finish('skipped', decided.skip);
        }
        const first = stageAndVerify(deps, target);
        if (!first.ok)
            return finish('failed', first.code, first.detail);
        let staged = first;
        try {
            try {
                backup = backupDatabase(deps.dbPath, path.join(deps.dir, 'backups'), deps.currentVersion, deps.now());
            }
            catch (err) {
                return finish('failed', AUTO_UPDATE_REASONS.backupFailed, err instanceof Error ? err.message : String(err));
            }
            const startNow = deps.now().getTime();
            const stored = readWaitStart(deps.dir, target);
            const waitedFrom = stored !== null && stored <= startNow ? stored : startNow;
            if (stored !== null && stored > startNow)
                appendLog(deps.dir, 'auto-update: the recorded start of the wait is in the future (the clock moved back); counting from now');
            let announced = false;
            let waitedOut = false;
            let slept = 0;
            let unknownLogged = false;
            for (;;) {
                if (deps.manual)
                    break;
                const live = liveHostPids(deps.liveHostsDir ?? deps.dir);
                if (live !== null && live.length === 0)
                    break;
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
                if (deps.now().getTime() - waitedFrom >= LIVE_WAIT_MAX_MS || slept >= LIVE_WAIT_MAX_MS) {
                    waitedOut = true;
                    break;
                }
                if (deps.heartbeat?.() === false)
                    return finish('failed', AUTO_UPDATE_REASONS.lockLost);
                await deps.sleep(LIVE_WAIT_POLL_MS);
                slept += LIVE_WAIT_POLL_MS;
            }
            clearWaitStart(deps.dir);
            const after = policyNow();
            if (after.policy === 'off')
                return finish('skipped', after.reason ?? AUTO_UPDATE_REASONS.policyOff, after.detail);
            if (!policyPermits(after.policy, bumpKind(deps.currentVersion, target)))
                return finish('skipped', AUTO_UPDATE_REASONS.bumpNotPermitted);
            if (announced) {
                staged.cleanup();
                const again = stageAndVerify(deps, target);
                if (!again.ok)
                    return finish('failed', again.code, again.detail);
                staged = again;
            }
            const last = policyNow();
            if (last.policy === 'off')
                return finish('skipped', last.reason ?? AUTO_UPDATE_REASONS.policyOff, last.detail);
            if (!policyPermits(last.policy, bumpKind(deps.currentVersion, target)))
                return finish('skipped', AUTO_UPDATE_REASONS.bumpNotPermitted);
            if (deps.heartbeat?.() === false)
                return finish('failed', AUTO_UPDATE_REASONS.lockLost);
            writeInstalling(deps.dir, { at: deps.now().toISOString(), from: deps.currentVersion, to: target, pid: process.pid, started: processStartTag(process.pid) });
            deps.beforeInstall?.(staged.tarball);
            if (!unchanged(staged))
                return finish('failed', AUTO_UPDATE_REASONS.tarballChanged);
            if (deps.channel === 'npm-global') {
                const done = installGlobal(deps, staged.tarball);
                if (!done.ok)
                    return finish('failed', done.reason, done.detail);
                if (deps.readInstalledVersion() !== target)
                    return finish('failed', AUTO_UPDATE_REASONS.readbackFailed);
            }
            else if (deps.pluginHost === 'codex') {
                const { skip, state: codexState } = codexDecision(deps);
                if (skip || deps.codexHome === null)
                    return finish('skipped', skip ?? AUTO_UPDATE_REASONS.codexHomeUnknown);
                const originalSource = codexMarketplaceSource(deps.codexHome);
                const failure = updateCodexPlugin(deps, deps.codexHome, staged.gitCommit, target, codexState === 'missing');
                if (failure?.kind === 'step' && !failure.restored && !failure.untouched) {
                    try {
                        const record = { marketplace: CODEX_MARKETPLACE, original: originalSource, source: CODEX_MARKETPLACE_SOURCE, configAfter: codexConfigFingerprint(deps.codexHome), at: deps.now().toISOString() };
                        fs.writeFileSync(path.join(deps.dir, CODEX_RESTORE_FILE), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
                        ownerOnly(path.join(deps.dir, CODEX_RESTORE_FILE));
                    }
                    catch (err) {
                        appendLog(deps.dir, `auto-update: could not write ${CODEX_RESTORE_FILE} (${err instanceof Error ? err.message : String(err)}); the marketplace will not be put back by itself`);
                    }
                }
                if (failure?.kind === 'readback')
                    return finish('failed', AUTO_UPDATE_REASONS.codexReadbackFailed);
                if (failure?.kind === 'step' && failure.untouched)
                    return finish('failed', AUTO_UPDATE_REASONS.codexRemoveFailed, failure.detail);
                if (failure)
                    return finish('failed', failure.restored ? AUTO_UPDATE_REASONS.codexInstallFailed : AUTO_UPDATE_REASONS.codexRestoreFailed, failure.detail);
            }
            else {
                const script = path.join(deps.packageRoot, 'scripts', 'upgrade-plugin.sh');
                const run = deps.exec('bash', [script], {
                    env: { ...deps.env, MEMESH_UPGRADE_PIN_COMMIT: staged.gitCommit, MEMESH_UPGRADE_EXPECT_VERSION: target },
                });
                if (run.status !== 0)
                    return finish('failed', AUTO_UPDATE_REASONS.installFailed, run.stderr);
                if (!claudeRegistryRecords(deps, staged.gitCommit, target))
                    return finish('failed', AUTO_UPDATE_REASONS.claudeReadbackFailed);
            }
            hermes = refreshHermes(deps, staged.tarball, target, staged.integrity);
            try {
                writeJustUpgradedMarker(deps.dir, deps.currentVersion, target, deps.now());
            }
            catch { }
            return finish('installed', waitedOut ? AUTO_UPDATE_REASONS.installedAfterWait : AUTO_UPDATE_REASONS.installed);
        }
        finally {
            staged.cleanup();
        }
    }
    catch (err) {
        return finish('failed', AUTO_UPDATE_REASONS.installFailed, err instanceof Error ? err.message : String(err));
    }
}
function removeRetiredFiles(dir) {
    for (const name of ['update-snooze.json', 'update-consent']) {
        try {
            fs.rmSync(path.join(dir, name), { recursive: true, force: true });
        }
        catch { }
    }
}
function defaultCanSelfUpdate(root) {
    const support = getInstallChannelSupport(getCurrentInstallChannel({ packageRoot: root }), root);
    return { ok: support.canSelfUpdate, label: support.label };
}
export async function dispatchAutoUpdate(pluginRoot, nowMs = Date.now(), options = {}) {
    const dir = getMemeshDirFromDbPath();
    let fd = -1;
    let claim = null;
    const say = (line) => {
        try {
            ensureOwnerDir(dir);
            fs.appendFileSync(path.join(dir, LOG_FILE), `[${new Date().toISOString()}] ${oneLine(line)}\n`, { mode: 0o600 });
            ownerOnly(path.join(dir, LOG_FILE));
        }
        catch {
            try {
                process.stderr.write(`[memesh] ${oneLine(line)}\n`);
            }
            catch { }
        }
    };
    try {
        ensureOwnerDir(dir);
        removeRetiredFiles(dir);
        const support = (options.canSelfUpdate ?? defaultCanSelfUpdate)(pluginRoot);
        if (!support.ok) {
            say(`auto-update: no runner started: ${support.label} cannot update itself`);
            return { state: 'unsupported' };
        }
        const claimPath = path.join(dir, DISPATCH_CLAIM);
        for (let attempt = 0;; attempt += 1) {
            try {
                fs.mkdirSync(claimPath);
                claim = claimPath;
                break;
            }
            catch (err) {
                if (err.code !== 'EEXIST')
                    throw err;
                let age = 0;
                let vanished = false;
                try {
                    age = Date.now() - fs.statSync(claimPath).mtimeMs;
                }
                catch {
                    vanished = true;
                }
                if (attempt === 0 && vanished)
                    continue;
                if (attempt === 0 && age > DISPATCH_CLAIM_STALE_MS) {
                    say(`auto-update: a dispatch claim ${Math.round(age / 1000)} seconds old was left behind; taking it over`);
                    fs.rmSync(claimPath, { recursive: true, force: true });
                    continue;
                }
                say('auto-update THROTTLED: another session is deciding whether to start the updater right now');
                return { state: 'throttled' };
            }
        }
        const attemptPath = path.join(dir, ATTEMPT_FILE);
        try {
            const last = Number(fs.readFileSync(attemptPath, 'utf8'));
            if (Number.isFinite(last) && last > nowMs) {
                say(`auto-update: the last attempt time is in the future (${new Date(last).toISOString()}); ignoring it`);
            }
            else if (Number.isFinite(last) && nowMs - last < ATTEMPT_INTERVAL_MS) {
                say(`auto-update THROTTLED: the last attempt was ${Math.round((nowMs - last) / 60000)} minute(s) ago, under the ${ATTEMPT_INTERVAL_MS / 3600000}-hour interval`);
                return { state: 'throttled' };
            }
        }
        catch { }
        const runnerPath = path.join(pluginRoot, 'scripts', 'hooks', 'auto-update-runner.mjs');
        if (!fs.existsSync(runnerPath)) {
            say(`auto-update FAILED: runner missing at ${runnerPath}`);
            return { state: 'failed' };
        }
        const logPath = path.join(dir, LOG_FILE);
        try {
            fd = fs.openSync(logPath, 'a', 0o600);
        }
        catch (err) {
            try {
                process.stderr.write(`[memesh] auto-update FAILED: durable log unavailable at ${logPath} (${err instanceof Error ? err.message : String(err)})\n`);
            }
            catch { }
            return { state: 'failed' };
        }
        const lockPath = path.join(dir, 'auto-update.lock');
        const child = (options.spawnImpl ?? spawn)(process.execPath, [runnerPath, lockPath], { detached: true, stdio: ['ignore', fd, fd], env: process.env, windowsHide: true });
        return await new Promise((resolve) => {
            let settled = false;
            const finishWith = (state, line) => {
                if (settled)
                    return;
                settled = true;
                if (fd >= 0) {
                    try {
                        fs.closeSync(fd);
                    }
                    catch { }
                    fd = -1;
                }
                say(line);
                resolve({ state });
            };
            child.once('spawn', () => {
                child.unref();
                try {
                    fs.writeFileSync(attemptPath, String(nowMs), { mode: 0o600 });
                    ownerOnly(attemptPath);
                }
                catch (err) {
                    say(`auto-update: could not record the attempt time (${err instanceof Error ? err.message : String(err)})`);
                }
                finishWith('dispatched', `auto-update DISPATCHED: worker_pid=${child.pid ?? 'unknown'} lock=${lockPath}`);
            });
            child.once('error', (err) => finishWith('failed', `auto-update FAILED: stage=dispatch error=${err.message}`));
        });
    }
    catch (err) {
        if (fd >= 0) {
            try {
                fs.closeSync(fd);
            }
            catch { }
        }
        say(`auto-update FAILED: stage=dispatch error=${err instanceof Error ? err.message : String(err)}`);
        return { state: 'failed' };
    }
    finally {
        if (claim !== null) {
            try {
                fs.rmSync(claim, { recursive: true, force: true });
            }
            catch (err) {
                say(`auto-update: could not remove the dispatch claim (${err instanceof Error ? err.message : String(err)}); it is taken over after a minute`);
            }
        }
    }
}
const INSTALL_ALREADY_RAN = new Set([
    AUTO_UPDATE_REASONS.installFailed,
    AUTO_UPDATE_REASONS.readbackFailed,
    AUTO_UPDATE_REASONS.codexReadbackFailed,
    AUTO_UPDATE_REASONS.claudeReadbackFailed,
    AUTO_UPDATE_REASONS.installNotUndone,
    AUTO_UPDATE_REASONS.codexInstallFailed,
    AUTO_UPDATE_REASONS.codexRestoreFailed,
]);
export function describeLockHolder(dir) {
    try {
        const [, pid, startedAt, label, startTag] = fs.readFileSync(path.join(dir, 'auto-update.lock'), 'utf8').split('\n');
        const started = Number(startedAt);
        if (!Number.isSafeInteger(Number(pid)) || !Number.isFinite(started))
            return null;
        return { label: label === 'manual' ? 'manual' : 'auto', pid: Number(pid), startedAt: new Date(started).toISOString(), running: sameProcessAlive(Number(pid), startTag || null, pidAlive) };
    }
    catch {
        return null;
    }
}
export function runManualUpdate(pluginRoot, dir = getMemeshDirFromDbPath(), options = {}) {
    const runnerPath = path.join(pluginRoot, 'scripts', 'hooks', 'auto-update-runner.mjs');
    const logPath = path.join(dir, LOG_FILE);
    if (!fs.existsSync(runnerPath)) {
        return { code: 1, lines: [`❌ The update runner is missing (${runnerPath}); reinstall MeMesh.`] };
    }
    ensureOwnerDir(dir);
    const before = readAutoUpdateState(dir)?.at ?? null;
    const offBeforeRun = currentPolicy().policy === 'off';
    const ran = spawnSync(process.execPath, [runnerPath, path.join(dir, 'auto-update.lock'), options.reinstall ? '--reinstall' : '--manual'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: process.env });
    const read = inspectAutoUpdateState(dir);
    const state = read.kind === 'ok' ? read.state : null;
    const fresh = state !== null && state.at !== before;
    const offNote = offBeforeRun ? ['ℹ️  Automatic updates are still off; this was an update you asked for by hand.'] : [];
    if (!fresh) {
        const tail = `${ran.stderr ?? ''}${ran.stdout ?? ''}`.trim().split('\n').slice(-3).join(' | ');
        if (ran.error)
            return { code: 1, lines: [`❌ No update was made: the runner could not start (${ran.error.message}).`, `   Log: ${logPath}`] };
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
        if (read.kind === 'unreadable')
            return { code: 1, lines: [`❌ The update ran, but its record cannot be read (${read.detail}); \`memesh doctor\` shows what is on the machine.`, `   Log: ${logPath}`] };
        return { code: 1, lines: [`❌ No update was made: the runner ended (exit ${ran.status ?? 'none'}) without recording a result${tail ? `: ${tail}` : ''}.`, `   Log: ${logPath}`] };
    }
    const fresh_ = state;
    const hermesFailed = (Array.isArray(fresh_.hermes) ? fresh_.hermes : []).filter((h) => h.outcome === 'failed');
    const hermesLines = hermesFailed.map((h) => `⚠️  Hermes provider at ${h.path} was not updated: ${h.reason}`);
    if (fresh_.outcome === 'installed') {
        const verb = options.reinstall ? `Reinstalled ${fresh_.to ?? '?'}` : `Updated ${fresh_.from ?? '?'} → ${fresh_.to ?? '?'}`;
        const lines = [`✅ ${verb} (source verified; database backup: ${fresh_.backup ?? 'none'}).`, '   It takes effect in the next session you start; sessions already running keep the old version until they restart.', ...hermesLines, ...offNote];
        return { code: hermesFailed.length > 0 ? 1 : 0, lines };
    }
    if (fresh_.reason === AUTO_UPDATE_REASONS.upToDate) {
        if (hermesFailed.length > 0)
            return { code: 1, lines: [`⚠️  MeMesh itself is on the newest version (${fresh_.from ?? '?'}), but the Hermes provider could not be brought to it.`, ...hermesLines, ...offNote] };
        return { code: 0, lines: [`✅ Already on the newest version for this install (${fresh_.from ?? '?'}).`, ...offNote] };
    }
    const backupLine = fresh_.backup ? ` Your database backup: ${fresh_.backup}.` : '';
    const installRan = INSTALL_ALREADY_RAN.has(fresh_.reason);
    const effect = installRan
        ? `   An install step had already run, so some files may be new. \`memesh doctor\` shows what is on the machine; \`memesh update --reinstall\` puts this version back through the same checks.${backupLine}`
        : fresh_.reason === AUTO_UPDATE_REASONS.dependencyPinFailed
            ? `   Nothing was changed: the install was undone and ${fresh_.from ?? 'the version that was running'} is still what runs. The next \`memesh update\` tries again.${backupLine}`
            : `   Nothing was installed.${backupLine}`;
    const still = !installRan && fresh_.from ? ` (still on ${fresh_.from})` : '';
    return { code: 1, lines: [`❌ Not updated${still}: ${fresh_.reason}`, ...(fresh_.detail ? [`   ${fresh_.detail}`] : []), effect, `   Log: ${logPath}`, ...offNote] };
}
export function startReinstall(pluginRoot, dir = getMemeshDirFromDbPath()) {
    const runnerPath = path.join(pluginRoot, 'scripts', 'hooks', 'auto-update-runner.mjs');
    if (!fs.existsSync(runnerPath))
        throw new Error(`The update runner is missing at ${runnerPath}; reinstall MeMesh.`);
    ensureOwnerDir(dir);
    const logPath = path.join(dir, LOG_FILE);
    const fd = fs.openSync(logPath, 'a', 0o600);
    try {
        const child = spawn(process.execPath, [runnerPath, path.join(dir, 'auto-update.lock'), '--reinstall'], { detached: true, stdio: ['ignore', fd, fd], env: process.env, windowsHide: true });
        child.unref();
    }
    finally {
        fs.closeSync(fd);
    }
    return { started: true, message: `A verified reinstall of this version was started in the background (source check, database backup, install). It takes a few minutes; \`memesh doctor\` shows the result, and the log is ${logPath}.` };
}
export function productionDeps(packageRoot, currentVersion) {
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
//# sourceMappingURL=auto-update.js.map