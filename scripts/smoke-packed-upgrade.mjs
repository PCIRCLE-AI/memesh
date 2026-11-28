import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { npmSync, parsePackResult } from './lib/npm-bin.mjs';
import { buildCredentialFreeBaseEnv, withAccountHomePreload } from './lib/isolated-env.mjs';
import { assertEveryPathProven, fetchPackument, selectUpgradePaths } from './lib/upgrade-matrix.mjs';

// This is deliberately a narrow upgrade proof, not a second copy of
// smoke-packed-artifact.mjs. That script validates a fresh consumer install;
// this one proves that a real npm-global install of a published version keeps
// its local data when npm replaces it with the exact packed candidate.
//
// Which versions it starts from is derived, not written down here: see
// `scripts/lib/upgrade-matrix.mjs` for why a hand-written pin goes on passing
// for a path nobody upgrades along.
const packageName = '@pcircle/memesh';
const repoRoot = process.cwd();
const npmTimeoutMs = 180_000;
const processTimeoutMs = 45_000;
const upgradeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-packed-upgrade-'));

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readFileSnapshot(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    return {
      bytes: fs.readFileSync(descriptor),
      mode: fs.fstatSync(descriptor).mode & 0o777,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function run(binary, args, options = {}) {
  return execFileSync(binary, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: processTimeoutMs,
    killSignal: 'SIGTERM',
    ...options,
  });
}

function installedBin(prefix, name) {
  const binDir = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
  return path.join(binDir, process.platform === 'win32' ? `${name}.cmd` : name);
}

function installedEntry(packageRoot, relativePath) {
  const entry = path.join(packageRoot, relativePath);
  assert.ok(fs.existsSync(entry), `installed package entry is missing: ${relativePath}`);
  // Invoke installed JavaScript through this Node runtime instead of executing
  // npm's Windows .cmd shim. The shim is still asserted above, while this is
  // portable and ensures the process always loads the global package tree.
  return entry;
}

function isolatedNpmEnv({ home, memeshDir, prefix, cache, userconfig }) {
  // HOME alone is insufficient: an exported MEMESH_DB_PATH would otherwise
  // route this acceptance test back to a maintainer's real database.
  const env = {
    ...buildCredentialFreeBaseEnv(process.env),
    HOME: home,
    USERPROFILE: home,
    MEMESH_DIR: memeshDir,
    MEMESH_AUTO_CAPTURE: 'false',
    npm_config_prefix: prefix,
    npm_config_cache: cache,
    npm_config_userconfig: userconfig,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
  delete env.MEMESH_DB_PATH;
  return withAccountHomePreload(env);
}

function globalPackageRoot(prefix, env) {
  return String(npmSync(['root', '--global', '--prefix', prefix], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
    timeout: processTimeoutMs,
    killSignal: 'SIGTERM',
  })).trim();
}

function readInstalledPackage(prefix, env) {
  const packageRoot = path.join(globalPackageRoot(prefix, env), '@pcircle', 'memesh');
  const packageJson = path.join(packageRoot, 'package.json');
  assert.ok(fs.existsSync(packageJson), `npm global install did not create ${packageJson}`);
  return { packageRoot, packageJson: JSON.parse(fs.readFileSync(packageJson, 'utf8')) };
}

function npmGlobalInstall(specifier, prefix, env, mustFail = false) {
  let failure;
  try {
    npmSync(['install', '--global', '--ignore-scripts', '--prefix', prefix, '--cache', env.npm_config_cache, '--userconfig', env.npm_config_userconfig, specifier], {
      cwd: repoRoot,
      stdio: 'inherit',
      env,
      timeout: npmTimeoutMs,
      killSignal: 'SIGTERM',
    });
  } catch (error) {
    failure = error;
  }

  if (mustFail) {
    assert.ok(failure, `invalid candidate unexpectedly installed: ${specifier}`);
    assert.equal(failure.signal, null, 'invalid candidate npm install timed out instead of rejecting it');
    assert.notEqual(failure.status, 0, 'invalid candidate npm install did not return a failing exit status');
    return;
  }
  if (failure) throw failure;
}

async function runCandidateAutoUpdate({ candidateTarball, candidateVersion, env, rowRoot, baseline, fromVersion }) {
  const stage = path.join(rowRoot, 'candidate-stage');
  npmSync(['install', '--prefix', stage, '--ignore-scripts', '--omit=dev', '--cache', env.npm_config_cache,
    '--userconfig', env.npm_config_userconfig, candidateTarball], {
    cwd: repoRoot,
    stdio: 'inherit',
    env,
    timeout: npmTimeoutMs,
    killSignal: 'SIGTERM',
  });
  const candidateRoot = path.join(stage, 'node_modules', '@pcircle', 'memesh');
  const runner = path.join(candidateRoot, 'scripts', 'hooks', 'auto-update-runner.mjs');
  assert.ok(fs.existsSync(runner), 'packed candidate is missing its auto-update runner');
  const { runLocked } = await import(pathToFileURL(runner));
  const { runAutoUpdate, readAutoUpdateState, AUTO_UPDATE_REASONS } = await import(
    pathToFileURL(path.join(candidateRoot, 'dist', 'core', 'auto-update.js')));
  const { npmInvocation } = await import(pathToFileURL(path.join(candidateRoot, 'dist', 'core', 'npm-launch.js')));
  const npmLaunch = npmInvocation([]);
  assert.ok(npmLaunch, 'the packed updater could not locate npm');
  const npmCli = npmLaunch.args[0] ?? process.env.npm_execpath;
  assert.ok(npmCli && path.isAbsolute(npmCli) && fs.existsSync(npmCli),
    'the release gate needs an absolute npm CLI path');

  // The candidate is unpublished. Tags/provenance/main membership are explicit
  // fixtures, not registry acceptance. The packed automatic engine, lock, tar,
  // npm-global install, pinned ci, rollback and data readback all run for real.
  const fixtureCommit = '1'.repeat(40);
  const signer = `https://github.com/PCIRCLE-AI/memesh/.github/workflows/publish-npm.yml@refs/tags/v${candidateVersion}`;
  const bytes = fs.readFileSync(candidateTarball);
  const integrity = `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`;
  const statement = {
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{ name: `pkg:npm/%40pcircle/memesh@${candidateVersion}`, digest: { sha512: crypto.createHash('sha512').update(bytes).digest('hex') } }],
    predicate: { buildDefinition: {
      externalParameters: { workflow: { ref: `refs/tags/v${candidateVersion}`, repository: 'https://github.com/PCIRCLE-AI/memesh', path: '.github/workflows/publish-npm.yml' } },
      resolvedDependencies: [{ digest: { gitCommit: fixtureCommit } }],
    } },
  };
  const auditFixture = JSON.stringify({ invalid: [], missing: [], verified: [{
    name: packageName, version: candidateVersion,
    attestationBundles: [{ predicateType: statement.predicateType, bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') } } }],
  }] });
  const fixtureEnv = { ...env, MEMESH_AUTO_UPDATE: 'major', MEMESH_UPGRADE_FORCE_FAILURE: '1' };
  const calls = [];
  const forcedPins = [];
  const configPath = path.join(env.MEMESH_DIR, 'config.json');
  const originalConfig = readFileSnapshot(configPath);
  const npm = (args, opts, forcePin = false) => {
    const child = spawnSync(process.execPath, [npmCli, ...args], {
      cwd: opts?.cwd ?? repoRoot,
      env: forcePin ? { ...fixtureEnv, npm_config_cache: path.join(rowRoot, 'empty-cache'), npm_config_offline: 'true' } : fixtureEnv,
      encoding: 'utf8', timeout: opts?.timeoutMs ?? npmTimeoutMs, killSignal: 'SIGTERM',
    });
    const result = { status: child.status, stdout: child.stdout ?? '', stderr: child.stderr ?? '', startupError: child.error?.message };
    if (forcePin) forcedPins.push(result);
    return result;
  };
  const deps = {
    env: fixtureEnv, accountHome: env.HOME, dir: env.MEMESH_DIR, configDir: env.MEMESH_DIR,
    dbPath: path.join(env.MEMESH_DIR, 'knowledge-graph.db'), packageRoot: candidateRoot,
    currentVersion: fromVersion, channel: 'npm-global', pluginHost: null, codexHome: null,
    tmpRoot: rowRoot, now: () => new Date(),
    sleep: async () => { throw new Error('unexpected live host in isolated upgrade fixture'); },
    signerOf: () => signer, readTags: () => ({ latest: candidateVersion }),
    readInstalledVersion: () => JSON.parse(fs.readFileSync(path.join(baseline.packageRoot, 'package.json'), 'utf8')).version,
    exec: (cmd, argv, opts) => {
      calls.push({ cmd, args: argv });
      if (cmd === npmLaunch.command && npmLaunch.args.every((arg, i) => argv[i] === arg)) {
        const args = argv.slice(npmLaunch.args.length);
        if (args[0] === 'install' && !args.includes('-g')) {
          fs.writeFileSync(path.join(opts.cwd, 'package-lock.json'), JSON.stringify({ packages: { [`node_modules/${packageName}`]: { integrity } } }));
          return { status: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'pack') {
          fs.copyFileSync(candidateTarball, path.join(opts.cwd, path.basename(candidateTarball)));
          return { status: 0, stdout: path.basename(candidateTarball), stderr: '' };
        }
        if (args[0] === 'audit') return { status: 0, stdout: auditFixture, stderr: '' };
        return npm(args, opts, args[0] === 'ci' && opts?.cwd === baseline.packageRoot && fixtureEnv.MEMESH_UPGRADE_FORCE_FAILURE === '1');
      }
      if (cmd === process.execPath && argv[0] === '-e' && argv[2]?.startsWith('https://api.github.com/repos/PCIRCLE-AI/memesh/compare/')) {
        return { status: 0, stdout: `200\n${JSON.stringify({ status: 'ahead', merge_base_commit: { sha: fixtureCommit } })}`, stderr: '' };
      }
      assert.equal(cmd, 'tar', 'unexpected command in upgrade fixture');
      const child = spawnSync(cmd, argv, { cwd: opts?.cwd, env: fixtureEnv, encoding: 'utf8', timeout: processTimeoutMs });
      return { status: child.status, stdout: child.stdout ?? '', stderr: child.stderr ?? '', startupError: child.error?.message };
    },
  };
  const lockPath = path.join(rowRoot, 'auto-update.lock');
  const attempt = async () => {
    let result;
    const code = await runLocked(lockPath, async context => (result = await runAutoUpdate({ ...deps, ...context })), 'auto');
    assert.equal(fs.existsSync(lockPath), false, 'automatic attempt left its lock behind');
    return { result, code };
  };
  const off = await attempt();
  assert.equal(off.result.outcome, 'skipped');
  assert.equal(off.result.reason, AUTO_UPDATE_REASONS.policyOff);
  assert.equal(calls.length, 0, 'explicit off reached registry or install steps');
  assert.deepEqual(readFileSnapshot(configPath), originalConfig);

  // Only the test owner changes policy. Assert the engine preserves this exact
  // permitted configuration before restoring off for the diagnostic readback.
  fs.writeFileSync(configPath, JSON.stringify({ ...JSON.parse(originalConfig.bytes), autoUpdate: 'major' }, null, 2));
  const permittedConfig = readFileSnapshot(configPath);
  try {
    const failed = await attempt();
    assert.equal(failed.code, 1);
    assert.equal(failed.result.reason, AUTO_UPDATE_REASONS.dependencyPinFailed, JSON.stringify(readAutoUpdateState(deps.dir)));
    assert.equal(forcedPins.length, 1);
    assert.ok(forcedPins[0].status !== null && forcedPins[0].status !== 0, 'forced npm ci did not fail with an exit status');
    assert.equal(deps.readInstalledVersion(), fromVersion, 'failed pinned install did not restore the baseline');
    assert.equal(run(process.execPath, [path.join(baseline.packageRoot, 'dist/transports/cli/cli.js'), '--version'], { cwd: baseline.packageRoot, env }).trim(), fromVersion);
    runMcp(path.join(baseline.packageRoot, 'dist/mcp/server.js'), baseline.packageRoot, env, 'verify', ['remember', 'recall']);
    assert.deepEqual(readFileSnapshot(configPath), permittedConfig);
    fixtureEnv.MEMESH_UPGRADE_FORCE_FAILURE = '0';
    const success = await attempt();
    assert.equal(success.code, 0);
    assert.equal(success.result.outcome, 'installed', JSON.stringify(readAutoUpdateState(deps.dir)));
    assert.equal(deps.readInstalledVersion(), candidateVersion);
    assert.deepEqual(readFileSnapshot(configPath), permittedConfig);
  } finally {
    fs.writeFileSync(configPath, originalConfig.bytes);
  }
  console.log('automatic transaction: off skip, real pinned-install failure/rollback, then real install/readback; source fixtures only, real registry provenance/native dispatch not exercised');
}

/**
 * Speak MCP to an installed server.
 *
 * `requiredTools` is per call rather than one shared list: the seed runs
 * against a published version that predates the candidate, and asserting the
 * candidate's tool surface there would make an old row red for tools its
 * release never claimed to have. The seed needs `remember`; the readback needs
 * the tools this candidate ships.
 */
function runMcp(serverPath, packageRoot, env, mode, requiredTools) {
  const source = `
    import assert from 'node:assert/strict';
    import { Client } from '@modelcontextprotocol/sdk/client/index.js';
    import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

    const serverPath = ${JSON.stringify(serverPath)};
    const mode = ${JSON.stringify(mode)};
    const requiredTools = ${JSON.stringify(requiredTools)};
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      env: process.env,
    });
    const client = new Client({ name: 'memesh-packed-upgrade', version: '1.0.0' });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      for (const required of requiredTools) {
        assert.ok(names.includes(required), 'installed MCP tool surface is missing ' + required);
      }

      if (mode === 'seed') {
        const saved = await client.callTool({
          name: 'remember',
          arguments: {
            name: 'packed-upgrade-existing-memory',
            type: 'fact',
            observations: ['This marker was written by the installed baseline MCP server before upgrade.'],
            // Published baselines require a project when the client reports no workspace root.
            tags: ['packed-upgrade', 'project:packed-upgrade'],
          },
        });
        assert.notEqual(saved.isError, true, 'baseline MCP remember failed: ' + JSON.stringify(saved));
      } else {
        const recalled = await client.callTool({
          name: 'recall',
          arguments: { query: 'packed-upgrade-existing-memory', limit: 5, cross_project: true },
        });
        assert.notEqual(recalled.isError, true, 'candidate MCP recall failed');
        assert.match(JSON.stringify(recalled), /packed-upgrade-existing-memory/,
          'candidate MCP could not read the baseline memory');
      }
    } finally {
      await client.close();
    }
  `;
  run(process.execPath, ['--input-type=module', '-e', source], {
    cwd: packageRoot,
    env,
  });
}

/**
 * One row of the matrix: install `fromVersion` from the registry, write a
 * memory through it, upgrade it to the packed candidate, and require the
 * memory, the binaries and the version readback to survive — then force the
 * upgrade's child-process boundary to fail and require it to say so.
 */
async function proveUpgradePath({ fromVersion, candidateVersion, candidateTarball, publishedLatest, cache, userconfig }) {
  const rowRoot = path.join(upgradeRoot, `from-${fromVersion}`);
  const home = path.join(rowRoot, 'home');
  const memeshDir = path.join(rowRoot, 'memesh-data');
  const prefix = path.join(rowRoot, 'npm-prefix');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(memeshDir, { recursive: true });
  const env = isolatedNpmEnv({ home, memeshDir, prefix, cache, userconfig });

  npmGlobalInstall(`${packageName}@${fromVersion}`, prefix, env);
  let installed = readInstalledPackage(prefix, env);
  assert.equal(installed.packageJson.version, fromVersion,
    `the isolated baseline is not the public v${fromVersion} package`);
  const oldCli = installedBin(prefix, 'memesh');
  const oldMcp = installedBin(prefix, 'memesh-mcp');
  assert.ok(fs.existsSync(oldCli), `v${fromVersion} npm-global CLI is missing`);
  assert.equal(installed.packageJson.bin?.['memesh-mcp'], 'dist/mcp/server.js',
    `public v${fromVersion} package does not declare the expected MCP binary`);
  assert.ok(fs.existsSync(oldMcp), `public v${fromVersion} tarball did not install the memesh-mcp binary`);
  const oldCliEntry = installedEntry(installed.packageRoot, 'dist/transports/cli/cli.js');
  const oldMcpEntry = installedEntry(installed.packageRoot, 'dist/mcp/server.js');
  assert.equal(run(process.execPath, [oldCliEntry, '--version'], { cwd: installed.packageRoot, env }).trim(), fromVersion);
  if (process.platform === 'win32' && fromVersion === publishedLatest) {
    const directNpm = spawnSync('npm', ['--version'], { env, encoding: 'utf8', timeout: processTimeoutMs });
    console.log(`Windows direct npm launch: ${directNpm.error?.code ?? `exit ${directNpm.status}`}`);
    const baseline = spawnSync(process.execPath, [oldCliEntry, 'update'], {
      cwd: installed.packageRoot, env, encoding: 'utf8', timeout: processTimeoutMs,
    });
    assert.ifError(baseline.error);
    const diagnostic = (baseline.stderr || baseline.stdout).trim();
    assert.ok(baseline.status === 0 || baseline.status === 1, `published update CLI exited ${baseline.status}: ${diagnostic}`);
    assert.equal(readInstalledPackage(prefix, env).packageJson.version, fromVersion,
      'registry latest changed during the published CLI baseline');
    console.log(`published Windows update observation: version=${fromVersion} exit=${baseline.status} ${diagnostic}`);
  }
  runMcp(oldMcpEntry, installed.packageRoot, env, 'seed', ['remember', 'recall']);
  const retiredConfigMarker = crypto.randomBytes(32).toString('hex');
  const configPath = path.join(memeshDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    llm: { provider: 'openai', apiKey: retiredConfigMarker },
    llmFallbacks: [{ provider: 'anthropic', apiKey: retiredConfigMarker }],
    embedder: { provider: 'openai', credentials: { apiKey: retiredConfigMarker } },
    language: 'zh-TW',
    transcriptMining: true,
    autoCapture: false,
    sessionLimit: 17,
    autoUpdate: 'off',
    setupCompleted: true,
    futureSetting: { keep: true },
  }, null, 2), { mode: 0o640 });
  if (process.platform !== 'win32') fs.chmodSync(configPath, 0o640);
  const configBeforeUpgrade = readFileSnapshot(configPath);
  const configDigestBeforeUpgrade = crypto.createHash('sha256').update(configBeforeUpgrade.bytes).digest('hex');
  const configModeBeforeUpgrade = configBeforeUpgrade.mode;
  console.log(`baseline: version=${installed.packageJson.version} package=${installed.packageRoot}`);

  await runCandidateAutoUpdate({ candidateTarball, candidateVersion, env, rowRoot, baseline: installed, fromVersion });
  installed = readInstalledPackage(prefix, env);
  assert.equal(installed.packageJson.version, candidateVersion,
    `npm did not replace the isolated global install with v${candidateVersion}`);
  const candidateCli = installedBin(prefix, 'memesh');
  const candidateMcp = installedBin(prefix, 'memesh-mcp');
  assert.ok(fs.existsSync(candidateCli), 'candidate npm-global CLI is missing');
  assert.ok(fs.existsSync(candidateMcp), 'candidate npm-global MCP binary is missing');
  const candidateCliEntry = installedEntry(installed.packageRoot, 'dist/transports/cli/cli.js');
  const candidateMcpEntry = installedEntry(installed.packageRoot, 'dist/mcp/server.js');
  assert.equal(run(process.execPath, [candidateCliEntry, '--version'], { cwd: installed.packageRoot, env }).trim(), candidateVersion);
  assert.match(run(process.execPath, [candidateCliEntry, '--help'], { cwd: installed.packageRoot, env }), /remember/,
    'candidate CLI help is not readable');
  const doctorOutput = run(process.execPath, [candidateCliEntry, 'doctor', '--json'], { cwd: installed.packageRoot, env });
  assert.equal(
    doctorOutput.includes(retiredConfigMarker),
    false,
    'candidate doctor exposed a retired config value',
  );
  const doctor = JSON.parse(doctorOutput);
  assert.ok(Array.isArray(doctor.checks), 'candidate doctor output is not readable JSON diagnostics');
  const configCheck = doctor.checks.find((check) => check.id === 'config');
  assert.deepEqual(
    {
      status: configCheck?.status,
      code: configCheck?.code,
      fixId: configCheck?.fixId,
      count: configCheck?.params?.count,
      keys: configCheck?.params?.keys,
    },
    {
      status: 'warn',
      code: 'config-parse.retired-settings',
      fixId: 'config-retired-settings',
      count: 5,
      keys: 'llm, llmFallbacks, embedder, language, transcriptMining',
    },
    'candidate doctor did not diagnose every retired top-level config key',
  );
  const preservedConfig = readFileSnapshot(configPath);
  const preservedConfigBytes = preservedConfig.bytes;
  const preservedConfigMode = preservedConfig.mode;
  assert.equal(crypto.createHash('sha256').update(preservedConfigBytes).digest('hex'), configDigestBeforeUpgrade,
    'candidate diagnostics changed the legacy config instead of remaining read-only');
  assert.equal(preservedConfigMode, configModeBeforeUpgrade,
    'candidate diagnostics changed the legacy config mode');
  const preservedConfigText = preservedConfigBytes.toString('utf8');
  assert.equal(preservedConfigText.includes(retiredConfigMarker), true,
    'the read-only diagnostic unexpectedly removed retired config state');
  const preservedConfigJson = JSON.parse(preservedConfigText);
  assert.deepEqual({
    autoCapture: preservedConfigJson.autoCapture,
    sessionLimit: preservedConfigJson.sessionLimit,
    autoUpdate: preservedConfigJson.autoUpdate,
    setupCompleted: preservedConfigJson.setupCompleted,
    futureSetting: preservedConfigJson.futureSetting,
  }, {
    autoCapture: false,
    sessionLimit: 17,
    autoUpdate: 'off',
    setupCompleted: true,
    futureSetting: { keep: true },
  }, 'candidate diagnostics did not preserve active and unknown extension settings');

  for (const requiredFile of [
    'package.json',
    '.claude-plugin/mcp.json',
    'dist/transports/cli/cli.js',
    'dist/mcp/server.js',
    'dist/core/doctor.js',
    'dist/core/install-channel.js',
  ]) {
    assert.ok(fs.existsSync(path.join(installed.packageRoot, requiredFile)),
      `candidate package is missing ${requiredFile}`);
  }
  const recalledByCli = JSON.parse(run(process.execPath, [candidateCliEntry, 'recall', 'packed-upgrade-existing-memory', '--json'], {
    cwd: installed.packageRoot,
    env,
  }));
  assert.match(JSON.stringify(recalledByCli), /packed-upgrade-existing-memory/,
    `candidate CLI could not read the v${fromVersion} memory`);
  runMcp(candidateMcpEntry, installed.packageRoot, env, 'verify', ['remember', 'recall', 'briefing', 'task_state']);
  console.log(`upgrade: from=${fromVersion} version=${installed.packageJson.version} package=${installed.packageRoot} data=${memeshDir}`);

  // The corrupt real tarball must also be refused without replacing the now
  // usable candidate. Automatic pin-failure rollback was checked above.
  const invalidCandidate = path.join(rowRoot, `invalid-memesh-v${candidateVersion}-candidate.tgz`);
  fs.copyFileSync(candidateTarball, invalidCandidate);
  fs.truncateSync(invalidCandidate, 64);
  npmGlobalInstall(invalidCandidate, prefix, env, true);
  installed = readInstalledPackage(prefix, env);
  assert.equal(installed.packageJson.version, candidateVersion,
    `failed upgrade changed the existing v${candidateVersion} package`);
  const afterFailure = JSON.parse(run(process.execPath, [candidateCliEntry, 'recall', 'packed-upgrade-existing-memory', '--json'], {
    cwd: installed.packageRoot,
    env,
  }));
  assert.match(JSON.stringify(afterFailure), /packed-upgrade-existing-memory/,
    'failed upgrade made pre-existing data unreadable');
  console.log(`failure-path: from=${fromVersion} corrupt artifact refused; candidate CLI and pre-existing data remain readable`);
}

try {
  const candidatePackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const candidateVersion = candidatePackage.version;
  const cache = path.join(upgradeRoot, 'npm-cache');
  const userconfig = path.join(upgradeRoot, 'npmrc');
  // One registry answers both questions. The versions used to be derived from
  // `npm config get registry` while every install was pinned to
  // registry.npmjs.org, so on a machine behind a mirror the matrix could name
  // versions the installs could not fetch — or worse, agree by accident.
  const registry = 'https://registry.npmjs.org/';
  fs.writeFileSync(userconfig, [
    `registry=${registry}`,
    'audit=false',
    'fund=false',
    'update-notifier=false',
    '',
  ].join('\n'));
  const packument = await fetchPackument(packageName, registry);
  const upgradePaths = selectUpgradePaths(packument, candidateVersion);
  const publishedLatest = packument['dist-tags']?.latest;
  console.log(`matrix: candidate=${candidateVersion} registry=${registry} from=${upgradePaths.join(', ')}`);

  const packEnv = isolatedNpmEnv({
    home: path.join(upgradeRoot, 'pack-home'),
    memeshDir: path.join(upgradeRoot, 'pack-data'),
    prefix: path.join(upgradeRoot, 'pack-prefix'),
    cache,
    userconfig,
  });
  const packJson = npmSync(['pack', '--json', '--pack-destination', upgradeRoot], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: packEnv,
    timeout: processTimeoutMs,
    killSignal: 'SIGTERM',
  });
  const { filename } = parsePackResult(packJson);
  const candidateTarball = path.join(upgradeRoot, filename);
  assert.ok(fs.existsSync(candidateTarball), `npm pack did not create ${candidateTarball}`);
  console.log(`candidate: version=${candidateVersion} tarball=${filename} sha256=${sha256(candidateTarball)}`);

  const proven = [];
  for (const fromVersion of upgradePaths) {
    console.log(`--- upgrade path: ${fromVersion} -> ${candidateVersion}`);
    await proveUpgradePath({ fromVersion, candidateVersion, candidateTarball, publishedLatest, cache, userconfig });
    proven.push(fromVersion);
  }
  assertEveryPathProven(upgradePaths, proven);

  console.log(`✅ Packaged upgrade smoke passed — ${proven.length} upgrade path(s) proved: `
    + proven.map((from) => `${from} -> ${candidateVersion}`).join(', '));
  console.log('Boundary: transaction fixtures; real registry provenance and native dispatch remain unverified.');
} finally {
  removeThrowawayRoot(upgradeRoot);
}

/**
 * Delete the throwaway root without letting a detached child fail the gate.
 *
 * Every install this smoke exercises runs the real CLI, and the real CLI
 * starts a detached, unref'd `memesh status` to refresh the update-check
 * cache (src/core/update-entrypoint.ts) — deliberately fire-and-forget, so a
 * slow npm lookup never blocks a command. Nothing waits for it, and it writes
 * into the same MEMESH_DIR this function is deleting. `rmSync` enumerates the
 * directory, removes what it saw, calls rmdir — and the child has created a
 * file in between: `ENOTEMPTY`. On Windows a file the child still holds open
 * gives `EPERM` instead; same cause, different errno.
 *
 * The proof is already printed by then ("✅ Packaged upgrade smoke passed"),
 * so a lost cleanup race was turning a PASSING gate red, and a gate that goes
 * red for a reason unrelated to the change is how a team learns to ignore
 * gates. A leaked temp directory on a CI runner is harmless; nothing here
 * asserts anything about cleanup.
 *
 * Widening the retry window is NOT the fix and has been disconfirmed twice in
 * this repository (5/100 ms → 10/200 ms, failed identically): a retry budget
 * only helps when the holder is slow, never when it is still running. This
 * mirrors `removeTempDir` in tests/helpers/temp-dir.ts, which the ten test
 * files with the same constraint already use. Every other error still throws.
 */
function removeThrowawayRoot(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (err) {
    if (err?.code !== 'ENOTEMPTY' && err?.code !== 'EBUSY' && err?.code !== 'EPERM') throw err;
    console.log(`cleanup: left ${dir} behind (${err.code}) — a detached update-check child was still writing`);
  }
}
