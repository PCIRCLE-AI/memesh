import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { binTargets, hookCommands, mcpEntry, mcpManifestPath } from './lib/executable-targets.mjs';
import { buildIsolatedRuntimeEnv } from './lib/isolated-env.mjs';
import { npmSync, parsePackResult } from './lib/npm-bin.mjs';

const repoRoot = process.cwd();

// OUTSIDE the repository, deliberately.
//
// This used to extract into `<repoRoot>/tmp/pack-smoke`, so when the import
// check below loaded the packaged `dist/index.js`, every bare specifier
// resolved by walking UP into the repo's own `node_modules` — devDependencies
// included. The gate therefore could not see a missing runtime dependency. It also printed
// "installs" for an install that never happened.
//
// In os.tmpdir() nothing resolves upward, so the install below is the only
// thing that can satisfy the import — which is what makes the check mean
// something.
const smokeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-pack-smoke-'));
const npmCacheDir = process.env.MEMESH_NPM_CACHE ?? path.join(os.tmpdir(), 'memesh-npm-cache');
// A release gate must fail boundedly when registry/cache resolution is
// unavailable. Without this timeout npm can sleep forever before any of the
// installed-artifact assertions run, which turns a network problem into a
// wedged pre-release review.
const consumerInstallTimeoutMs = 180_000;

const packJson = npmSync(['pack', '--json', '--pack-destination', smokeDir], {
  cwd: repoRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    npm_config_cache: npmCacheDir,
  },
});

const { filename } = parsePackResult(packJson);
const tarballPath = path.join(smokeDir, filename);
const extractDir = path.join(smokeDir, 'extract');

fs.mkdirSync(extractDir, { recursive: true });

// Use platform-aware tar extraction.
// Windows 10+ (required by Node 20+) ships tar.exe, but locate it
// explicitly via ComSpec fallback to handle PATH edge cases.
const tarCommand = process.platform === 'win32' ? 'tar.exe' : 'tar';
try {
  execFileSync(tarCommand, ['-xf', tarballPath, '-C', extractDir], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
} catch (err) {
  if (err.code === 'ENOENT') {
    console.error(
      `Error: '${tarCommand}' not found. ` +
      'Install tar or upgrade to Windows 10 1803+ (which bundles tar.exe).'
    );
    process.exit(1);
  }
  throw err;
}

const packageDir = path.join(extractDir, 'package');

for (const retired of ['dashboard', 'dist/cli/view-live.js']) {
  if (fs.existsSync(path.join(packageDir, retired))) throw new Error(`Retired web UI shipped: ${retired}`);
}

const requiredFiles = [
  // Core
  'package.json',
  'memesh-lock.json',
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
  '.claude-plugin/mcp.json',
  '.codex-plugin/mcp.json',
  'hooks/hooks.json',
  // Dist — core engine
  'dist/index.js',
  'dist/db.js',
  'dist/knowledge-graph.js',
  'dist/transports/cli/THIRD_PARTY_NOTICES.txt',
  'dist/core/operations.js',
  'dist/core/types.js',
  'dist/core/config.js',
  'dist/core/scoring.js',
  'dist/core/lesson-engine.js',
  'dist/core/serializer.js',
  'dist/core/patterns.js',
  'dist/core/product-improvements.js',
  // Dist — transports
  'dist/transports/schemas.js',
  'dist/mcp/server.js',
  'dist/mcp/server.js.map',
  'dist/mcp/THIRD_PARTY_NOTICES.txt',
  'dist/transports/mcp/handlers.js',
  'dist/transports/http/server.js',
  'dist/transports/cli/cli.js',
  // Conversation storage and native wake paths must ship with the entry.
  'dist/core/conversation-messages.js',
  'dist/core/conversation-message-migration.js',
  'dist/host-adapters/conversation-wake.js',
  'dist/transports/conversation-messaging.js',
  'dist/host-adapters/claude-channel.js',
  'dist/host-runtime/claude.js',
  'dist/host-runtime/conversation-channel.js',
  'dist/host-runtime/entry.js',
  'dist/core/export-signature.js',
  // Hook support: hooks cannot import from dist/, so these are the whole of
  // their dependency surface. Missing, every hook throws on first require.
  // The hooks themselves are not listed here — they are derived from
  // hooks/hooks.json below, so adding one cannot silently go unchecked.
  'scripts/hooks/_shared.js',
  'scripts/hooks/auto-update-runner.mjs',
  'scripts/hooks/_generated/core-paths.js',
  'scripts/hooks/_generated/fts-index.js',
  'scripts/hooks/_generated/entity-write.js',
  // Skills (2)
  'skills/memesh/SKILL.md',
  'skills/memesh-review/SKILL.md',
  // The public README links this exact lifecycle and support contract.
  'docs/platforms/agent-messaging.md',
  // The Hermes memory provider that `memesh hermes install` and the updater copy out of the package.
  'extensions/hermes-memesh/__init__.py',
  'extensions/hermes-memesh/plugin.yaml',
];

for (const relativePath of requiredFiles) {
  assert.ok(
    fs.existsSync(path.join(packageDir, relativePath)),
    `Missing packaged file: ${relativePath}`
  );
}

const bundledServer = fs.readFileSync(path.join(packageDir, 'dist/mcp/server.js'));
const bundledSourceMap = fs.readFileSync(path.join(packageDir, 'dist/mcp/server.js.map'));
const bundledNotice = fs.readFileSync(
  path.join(packageDir, 'dist/mcp/THIRD_PARTY_NOTICES.txt'),
  'utf8',
);
const declaredBundleDigest = bundledNotice.match(/^Bundle SHA-256: ([0-9a-f]{64})$/m)?.[1];
const declaredSourceMapDigest = bundledNotice.match(/^Source map SHA-256: ([0-9a-f]{64})$/m)?.[1];
assert.equal(
  declaredBundleDigest,
  createHash('sha256').update(bundledServer).digest('hex'),
  'third-party notice is not bound to the packaged MCP bundle',
);
assert.equal(
  declaredSourceMapDigest,
  createHash('sha256').update(bundledSourceMap).digest('hex'),
  'third-party notice is not bound to the packaged MCP source map',
);
assert.equal(
  Object.hasOwn(JSON.parse(bundledSourceMap.toString('utf8')), 'sourcesContent'),
  false,
  'packaged MCP source map embeds source bodies instead of following the repository map policy',
);

// Every hook the plugin manifest can invoke, and every command package.json
// declares, has to be in the tarball AND be runnable. Both lists are derived
// from their manifests (see scripts/lib/executable-targets.mjs) because both
// hand-written copies had drifted.
//
// Present-but-not-executable is the failure this checks for beyond existence:
// Claude Code exec()s hook commands directly, so a hook packed without its +x
// bit is a silent total dropout — the tarball looks complete and the hook
// never runs.
const declaredExecutables = [
  ...binTargets(packageDir).map((p) => ({ relativePath: p, kind: 'bin (package.json)' })),
  ...hookCommands(packageDir).map((p) => ({ relativePath: p, kind: 'hook (hooks/hooks.json)' })),
];

for (const { relativePath, kind } of declaredExecutables) {
  const full = path.join(packageDir, relativePath);
  assert.ok(fs.existsSync(full), `Missing packaged ${kind}: ${relativePath}`);

  if (process.platform !== 'win32') {
    assert.ok(
      fs.statSync(full).mode & 0o111,
      `Packaged ${kind} is not executable: ${relativePath} — it would be present but unrunnable`
    );
  }
}

// The Claude plugin must declare its MCP manifest on a path Claude Code does
// NOT auto-discover as a project config. A root `.mcp.json` is loaded twice —
// once by the plugin loader (where ${CLAUDE_PLUGIN_ROOT} resolves) and once as
// a project-scoped config for anyone who opens the directory (where it does
// not, and the server dies with `-32000 Connection closed`). Custom component
// paths SUPPLEMENT the defaults rather than replacing them, so declaring a
// custom path is only half the fix: the root file has to be gone.
const claudePlugin = JSON.parse(
  fs.readFileSync(path.join(packageDir, '.claude-plugin', 'plugin.json'), 'utf8')
);
assert.equal(
  claudePlugin.mcpServers,
  './.claude-plugin/mcp.json',
  'Claude plugin manifest must declare its MCP manifest on a non-auto-discovered path'
);
assert.ok(
  !fs.existsSync(path.join(packageDir, '.mcp.json')),
  'the tarball ships a root .mcp.json — Claude Code auto-discovers it as a project-scoped ' +
    'MCP config, where ${CLAUDE_PLUGIN_ROOT} is undefined and every memesh MCP tool fails to start'
);

// The script the MCP manifest starts, derived from the manifest rather than
// from a hand-written path. A `/plugin install` user reaches memesh ONLY
// through this entry; when it named a file that had been renamed away, every
// MCP tool died with `-32000 failed to reconnect` and no gate said a word.
const mcpManifest = mcpManifestPath(packageDir);
const mcpTarget = mcpEntry(packageDir);
assert.ok(
  fs.existsSync(path.join(packageDir, mcpTarget)),
  `${mcpManifest} starts ${mcpTarget}, which is not in the tarball — every MCP tool would fail to start`
);

const packagedJson = JSON.parse(
  fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')
);
assert.equal(packagedJson.name, '@pcircle/memesh');
assert.equal(packagedJson.version, JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version);

const codexPlugin = JSON.parse(fs.readFileSync(path.join(packageDir, '.codex-plugin', 'plugin.json'), 'utf8'));
assert.equal(codexPlugin.version, packagedJson.version);
assert.equal(
  codexPlugin.mcpServers,
  './.codex-plugin/mcp.json',
  'Codex plugin manifest must declare the bundled MCP manifest',
);
const codexMcpManifestPath = codexPlugin.mcpServers.slice(2);
const codexMcpManifest = JSON.parse(
  fs.readFileSync(path.join(packageDir, codexMcpManifestPath), 'utf8'),
);
assert.deepEqual(
  Object.keys(codexMcpManifest),
  ['mcpServers'],
  'Codex MCP manifest must use the loader mcpServers wrapper, not a direct server map',
);
const codexMcp = codexMcpManifest.mcpServers?.memesh;
// env_vars: Codex passes an MCP server only the variables it names (#482).
assert.deepEqual(codexMcp, {
  command: 'node',
  args: ['./dist/mcp/server.js'],
  cwd: '.',
  env_vars: ['MEMESH_DIR', 'MEMESH_DB_PATH', 'MEMESH_PROJECT_ROOT'],
});
assert.equal(
  codexMcp.args[0].replace(/^\.\//, ''),
  mcpTarget,
  'Codex and Claude plugin manifests must resolve to the same bundled MCP server',
);

// A plugin cache is the raw extracted package: no npm install runs inside it.
// Start exactly what the Codex manifests declare before creating the installed
// consumer below, so a server that only works by walking into node_modules
// cannot pass this gate.
assert.equal(
  fs.existsSync(path.join(packageDir, 'node_modules')),
  false,
  'raw extracted plugin cache unexpectedly contains node_modules',
);
const rawProtocolHome = path.join(smokeDir, 'raw-protocol-home');
const rawProtocolMemeshDir = path.join(rawProtocolHome, '.memesh');
fs.mkdirSync(rawProtocolMemeshDir, { recursive: true });
const rawProtocolDbPath = path.join(rawProtocolMemeshDir, 'knowledge-graph.db');
const rawOsEnvKeys = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR'];
const rawBaseEnv = Object.fromEntries(
  rawOsEnvKeys.flatMap((key) => (
    typeof process.env[key] === 'string' ? [[key, process.env[key]]] : []
  )),
);
assert.equal('NODE_PATH' in rawBaseEnv, false, 'raw plugin cache inherited NODE_PATH');
assert.equal('NODE_OPTIONS' in rawBaseEnv, false, 'raw plugin cache inherited NODE_OPTIONS');
assert.equal(
  Object.keys(rawBaseEnv).some((key) => /(?:KEY|TOKEN|SECRET|SOCKET)/i.test(key)),
  false,
  'raw plugin cache inherited a credential or agent-socket variable',
);
const clientModuleUrl = import.meta.resolve('@modelcontextprotocol/sdk/client/index.js');
const transportModuleUrl = import.meta.resolve('@modelcontextprotocol/sdk/client/stdio.js');
execFileSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `import assert from 'node:assert/strict';
import { Client } from ${JSON.stringify(clientModuleUrl)};
import { StdioClientTransport } from ${JSON.stringify(transportModuleUrl)};

const transport = new StdioClientTransport({
  command: ${JSON.stringify(codexMcp.command)},
  args: ${JSON.stringify(codexMcp.args)},
  cwd: ${JSON.stringify(path.resolve(packageDir, codexMcp.cwd))},
  env: { ...process.env, MEMESH_AUTO_CAPTURE: 'false' },
});
const client = new Client({ name: 'memesh-raw-plugin-cache-smoke', version: '1.0.0' });
try {
  await client.connect(transport);
  assert.deepEqual(
    client.getServerVersion(),
    { name: 'memesh', version: ${JSON.stringify(packagedJson.version)} },
    'raw plugin cache initialize returned the wrong server identity/version',
  );
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    ['briefing', 'export', 'forget', 'import', 'improvement', 'learn', 'message', 'recall', 'remember', 'task_state', 'user_patterns', 'work_package'],
    'raw plugin cache exposed an unexpected tool surface',
  );
} finally {
  await client.close();
}
`,
  ],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    env: buildIsolatedRuntimeEnv(rawBaseEnv, {
      runtimeHome: rawProtocolHome,
      memeshDir: rawProtocolMemeshDir,
      dbPath: rawProtocolDbPath,
    }),
  },
);

// Doctor must probe the raw plugin cache too, without borrowing the smoke
// runner's SDK or requiring npm install inside the extracted package.
const runRawDoctor = () => spawnSync(
  process.execPath,
  [path.join(packageDir, 'dist/transports/cli/cli.js'), 'doctor', '--json'],
  {
    cwd: packageDir,
    encoding: 'utf8',
    timeout: 30_000,
    env: buildIsolatedRuntimeEnv({
      ...rawBaseEnv,
      CLAUDE_PLUGIN_ROOT: packageDir,
      MEMESH_DOCTOR_PROBE_MESSAGE_CAPABILITY: '1',
    }, {
      runtimeHome: rawProtocolHome,
      memeshDir: rawProtocolMemeshDir,
      dbPath: rawProtocolDbPath,
    }),
  },
);
const rawDoctor = runRawDoctor();
const rawDoctorReport = JSON.parse(rawDoctor.stdout);
assert.equal(
  rawDoctorReport.checks.find((check) => check.id === 'message-capability')?.status,
  'pass',
  `raw plugin cache doctor message probe failed: ${rawDoctor.stdout}`,
);
assert.equal(rawDoctor.status, 0, rawDoctor.stderr);

// A real MCP startup failure must still fail the opt-in diagnostic.
const rawMcpPath = path.join(packageDir, mcpTarget);
const rawMcpBytes = fs.readFileSync(rawMcpPath);
try {
  fs.writeFileSync(rawMcpPath, "throw new Error('expected broken MCP fixture');\n");
  const brokenDoctor = runRawDoctor();
  const brokenReport = JSON.parse(brokenDoctor.stdout);
  assert.equal(brokenDoctor.status, 1);
  assert.equal(
    brokenReport.checks.find((check) => check.id === 'message-capability')?.status,
    'fail',
    'doctor hid a real installed MCP startup failure',
  );
} finally {
  fs.writeFileSync(rawMcpPath, rawMcpBytes);
}

// A running MCP server never re-reads its own package.json after startup, so
// a plugin-marketplace upgrade that replaces files on disk while this process
// is still alive must be self-detected some other way (issue #426 review): a
// prior version of this check computed a relative path from handlers.ts's own
// ORIGINAL source depth, which esbuild bundles into dist/mcp/server.js at a
// SHALLOWER depth — silently reading nothing (or a neighbour package.json) in
// exactly this raw-plugin-cache scenario. Only a real spawned bundle, mutated
// mid-session, can catch that class of bug; a source-level unit test cannot.
const staleNoticeHome = path.join(smokeDir, 'stale-notice-home');
const staleNoticeMemeshDir = path.join(staleNoticeHome, '.memesh');
fs.mkdirSync(staleNoticeMemeshDir, { recursive: true });
const staleNoticeDbPath = path.join(staleNoticeMemeshDir, 'knowledge-graph.db');
// A `-suffix` would be a PRERELEASE tag (isStrictlyOlder treats
// `4.10.4-x` as OLDER than `4.10.4`, correctly per semver) — bump the last
// numeric component instead, so this is unambiguously a newer release.
const versionParts = packagedJson.version.split('.');
versionParts[versionParts.length - 1] = String(Number(versionParts[versionParts.length - 1]) + 1);
const bumpedVersion = versionParts.join('.');
execFileSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Client } from ${JSON.stringify(clientModuleUrl)};
import { StdioClientTransport } from ${JSON.stringify(transportModuleUrl)};

const packageJsonPath = ${JSON.stringify(path.join(packageDir, 'package.json'))};
const transport = new StdioClientTransport({
  command: ${JSON.stringify(codexMcp.command)},
  args: ${JSON.stringify(codexMcp.args)},
  cwd: ${JSON.stringify(path.resolve(packageDir, codexMcp.cwd))},
  env: { ...process.env, MEMESH_AUTO_CAPTURE: 'false' },
});
const client = new Client({ name: 'memesh-stale-notice-smoke', version: '1.0.0' });
try {
  await client.connect(transport);
  const before = await client.callTool({ name: 'recall', arguments: { query: 'anything', cross_project: true } });
  assert.equal(before.content.length, 1, 'first call must carry no stale-process notice yet');

  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  pkg.version = ${JSON.stringify(bumpedVersion)};
  fs.writeFileSync(packageJsonPath, JSON.stringify(pkg));

  const after = await client.callTool({ name: 'recall', arguments: { query: 'anything', cross_project: true } });
  assert.equal(after.content.length, 2, 'second call must carry exactly one appended notice');
  const noticeText = after.content[1].text;
  assert.ok(noticeText.includes('This session started on'), 'must be the stale-process notice');
  assert.ok(noticeText.includes(${JSON.stringify(packagedJson.version)}), 'must name the version this process started on');
  assert.ok(noticeText.includes(${JSON.stringify(bumpedVersion)}), 'must name the version now on disk');
  assert.ok(noticeText.includes('Restart this session'), 'must tell the user how to pick up the change');

  const third = await client.callTool({ name: 'recall', arguments: { query: 'anything', cross_project: true } });
  assert.equal(third.content.length, 1, 'third call must not repeat the notice once this process already gave it');
} finally {
  await client.close();
}
`,
  ],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    env: buildIsolatedRuntimeEnv(rawBaseEnv, {
      runtimeHome: staleNoticeHome,
      memeshDir: staleNoticeMemeshDir,
      dbPath: staleNoticeDbPath,
    }),
  },
);

// Install the way a consumer does — production deps only, scripts ON so the
// native bindings actually build — into a project that has no relationship to
// this repo's node_modules. Without this the import below has nothing to
// resolve against, which is the point: it now proves the declared runtime
// dependencies are sufficient, rather than proving the dev tree exists.
const consumerDir = path.join(smokeDir, 'consumer');
fs.mkdirSync(consumerDir, { recursive: true });
npmSync(['init', '-y'], { cwd: consumerDir, stdio: 'ignore' });
npmSync(['install', '--omit=dev', tarballPath], {
  cwd: consumerDir,
  stdio: 'inherit',
  env: { ...process.env, npm_config_cache: npmCacheDir },
  timeout: consumerInstallTimeoutMs,
  killSignal: 'SIGTERM',
});

const installedRoot = path.join(consumerDir, 'node_modules', '@pcircle', 'memesh');
assert.ok(
  fs.existsSync(path.join(installedRoot, 'package.json')),
  'the packed tarball did not install — nothing was imported'
);

// Keep every path inside the smoke directory even though openDatabase receives
// an explicit file, so future startup reads cannot reach owner state.
const importHome = path.join(smokeDir, 'import-home');
const importMemeshDir = path.join(importHome, '.memesh');
fs.mkdirSync(importMemeshDir, { recursive: true });
const importDbPath = path.join(smokeDir, 'smoke.db');

execFileSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `import * as pkg from ${JSON.stringify(path.join(installedRoot, 'dist', 'index.js'))};
if (typeof pkg.openDatabase !== 'function') {
  throw new Error('Packaged module missing openDatabase export');
}
if (typeof pkg.KnowledgeGraph !== 'function') {
  throw new Error('Packaged module missing KnowledgeGraph export');
}
// Exercise the runtime path, not just the export shape: opening a database
// must create the FTS-backed schema from the installed package.
const db = pkg.openDatabase(${JSON.stringify(importDbPath)});
if (!db) throw new Error('openDatabase returned nothing');
const fts = db.prepare("SELECT name FROM sqlite_master WHERE name = 'entities_fts'").get();
if (!fts) throw new Error('packaged database did not create entities_fts');
pkg.closeDatabase();
`,
  ],
  {
    cwd: consumerDir,
    stdio: 'inherit',
    env: buildIsolatedRuntimeEnv(process.env, {
      runtimeHome: importHome,
      memeshDir: importMemeshDir,
      dbPath: importDbPath,
    }),
  }
);

// Exercise the actual MCP wire contract from the installed consumer tree.
// Importing handlers directly would miss the stdio initialize handshake,
// tool-list schema, and the server lifecycle that every host depends on.
const protocolHome = path.join(smokeDir, 'protocol-home');
const protocolMemeshDir = path.join(protocolHome, '.memesh');
fs.mkdirSync(protocolMemeshDir, { recursive: true });
const protocolDbPath = path.join(protocolMemeshDir, 'knowledge-graph.db');
const protocolServer = path.join(installedRoot, 'dist', 'mcp', 'server.js');
// The project this MCP session is bound to, as a host launched for one
// project sets it. remember and learn with no project need the binding;
// a default recall searches the bound project.
const protocolProjectRoot = path.join(smokeDir, 'protocol-project');
fs.mkdirSync(protocolProjectRoot, { recursive: true });
execFileSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// \`process.env\` here is already the isolated env built by
// buildIsolatedRuntimeEnv() at the outer execFileSync call below — HOME,
// MEMESH_DIR and MEMESH_DB_PATH are already test-owned, so this spread
// carries the isolation through rather than re-inheriting the ambient shell.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [${JSON.stringify(protocolServer)}],
  env: { ...process.env, MEMESH_AUTO_CAPTURE: 'false', MEMESH_PROJECT_ROOT: ${JSON.stringify(protocolProjectRoot)} },
});
// Controlled SDK declaration selects per-call threadId; this is not a native Codex host test.
const client = new Client({ name: 'codex-mcp-client', version: '1.0.0' });
try {
  await client.connect(transport);

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  assert.deepEqual(
    names,
    ['briefing', 'export', 'forget', 'import', 'improvement', 'learn', 'message', 'recall', 'remember', 'task_state', 'user_patterns', 'work_package'],
    'installed MCP server exposed an unexpected tool surface'
  );

  const remembered = await client.callTool({
    name: 'remember',
    arguments: {
      name: 'packaged-protocol-smoke',
      type: 'fact',
      observations: ['The installed MCP protocol path is alive.'],
      tags: ['smoke'],
    },
  });
  assert.notEqual(remembered.isError, true, 'remember returned an MCP tool error');

  const recalled = await client.callTool({
    name: 'recall',
    // remember filed it under the bound project, so the default recall finds it.
    arguments: { query: 'packaged-protocol-smoke', limit: 5 },
  });
  assert.notEqual(recalled.isError, true, 'recall returned an MCP tool error');
  assert.match(
    JSON.stringify(recalled),
    /packaged-protocol-smoke/,
    'recall did not return the memory written through MCP'
  );
  // The binding came from MEMESH_PROJECT_ROOT: the memory carries that project, and the recall searched it.
  const { getProjectName } = await import(${JSON.stringify(pathToFileURL(path.join(installedRoot, 'dist', 'core', 'paths.js')).href)});
  const boundProject = getProjectName(${JSON.stringify(protocolProjectRoot)});
  const recalledBody = JSON.parse(recalled.content[0].text);
  assert.equal(recalledBody.scope?.project, boundProject, 'the default recall did not search the bound project');
  assert.deepEqual(
    recalledBody.entities.find((entity) => entity.name === 'packaged-protocol-smoke')?.projects,
    [boundProject],
    'remember did not file the memory under the bound project'
  );

  const learned = await client.callTool({
    name: 'learn',
    arguments: {
      error: 'Packaged MCP learn contract failed',
      fix: 'Use the documented snake_case field',
      root_cause: 'The caller used a field name outside the strict MCP schema',
      prevention: 'Keep runtime schemas, exported schemas, and examples in parity',
      severity: 'major',
    },
  });
  assert.notEqual(learned.isError, true, 'learn rejected the documented root_cause field');
  const recalledLesson = await client.callTool({
    name: 'recall',
    arguments: { query: 'Packaged MCP learn contract failed', limit: 5 },
  });
  assert.notEqual(recalledLesson.isError, true, 'recall rejected the packaged learn readback');
  assert.match(
    JSON.stringify(recalledLesson),
    /caller used a field name outside the strict MCP schema/,
    'learn did not persist the documented root_cause value'
  );

  const camelCaseLearn = await client.callTool({
    name: 'learn',
    arguments: {
      error: 'This request must be rejected',
      fix: 'Do not silently drop unknown fields',
      rootCause: 'Wrong public field name',
    },
  });
  assert.equal(camelCaseLearn.isError, true, 'learn silently accepted the undocumented rootCause field');
  assert.match(
    JSON.stringify(camelCaseLearn.content),
    /rootCause|Unrecognized key/,
    'learn rejected rootCause without identifying the invalid request'
  );

  // Register only synthetic sessions in this protocol child's isolated messages.db.
  const { ConversationMessages } = await import(${JSON.stringify(pathToFileURL(path.join(installedRoot, 'dist', 'core', 'conversation-messages.js')).href)});
  const { hostname } = await import('node:os');
  const registrations = new ConversationMessages();
  try {
    for (const id of ['A', 'B', 'C']) {
      registrations.register({ id, host: 'codex', machine: hostname(), pid: process.pid, wake: {} });
    }
  } finally { registrations.close(); }

  const message = (args, session) => client.callTool({ name: 'message', arguments: args,
    ...(session ? { _meta: { threadId: session } } : {}) });
  const value = (result, label) => {
    assert.notEqual(result.isError, true, label + ': ' + JSON.stringify(result.content));
    return JSON.parse(result.content[0].text);
  };
  const rejected = (result, pattern, label) => {
    assert.equal(result.isError, true, label + ' was accepted');
    assert.match(JSON.stringify(result.content), pattern, label + ' returned the wrong error');
  };

  const roster = value(await message({ action: 'discover' }, 'A'), 'discover');
  assert.deepEqual(roster.conversations.map((row) => row.address), ['A', 'B', 'C']);
  assert.ok(roster.conversations.every((row) => row.host === 'codex' && row.online));

  const body = ['packaged-first-marker', 'packaged-middle-marker', 'packaged-last-marker'].join(String.fromCharCode(10));
  const sendArgs = { action: 'send', recipient: 'B', kind: 'task', body };
  rejected(await message(sendArgs), /conversation_identity_unavailable/, 'missing session');
  rejected(await message({ action: 'poll' }, 'A'), /action|Invalid|invalid/, 'legacy poll');
  for (const action of ['update', 'delete']) {
    rejected(await message({ action }, 'A'), /action|Invalid|invalid/, action);
  }
  rejected(await message({ ...sendArgs, sender: 'C' }, 'A'), /sender|Unrecognized/, 'forged sender');
  rejected(await message({ ...sendArgs, project: 'obsolete' }, 'A'), /project|Unrecognized/, 'unknown field');
  assert.deepEqual(value(await message({ action: 'status' }, 'A'), 'empty status').messages, []);

  const sent = value(await message(sendArgs, 'A'), 'send');
  assert.equal(sent.state, 'queued');
  assert.match(sent.message_id, /^[0-9a-f-]{36}$/i);
  const denied = await message({ action: 'read', message_id: sent.message_id }, 'C');
  rejected(denied, /not addressed to this conversation/i, 'cross-recipient read');
  const queued = value(await message({ action: 'status', message_id: sent.message_id }, 'A'), 'queued status');
  assert.equal(queued.messages.length, 1);
  assert.equal(queued.messages[0].body, body);
  assert.deepEqual(queued.messages[0].events.map((event) => event.event), ['queued']);

  const read = value(await message({ action: 'read', message_id: sent.message_id }, 'B'), 'read');
  assert.equal(read.message.body, body);
  assert.equal(read.message.sender, 'A');
  assert.equal(read.message.recipient, 'B');
  const readStatus = value(await message({ action: 'status', message_id: sent.message_id }, 'A'), 'read status');
  assert.deepEqual(readStatus.messages[0].events.map((event) => event.event), ['queued', 'delivered', 'read']);

  const replyBody = 'packaged-reply-marker';
  const reply = value(await message({ action: 'send', recipient: 'A', kind: 'result', body: replyBody,
    reply_to: sent.message_id }, 'B'), 'reply');
  assert.equal(reply.state, 'queued');
  const original = value(await message({ action: 'status', message_id: sent.message_id }, 'A'), 'replied status');
  assert.equal(original.messages[0].state, 'replied');
  assert.deepEqual(original.messages[0].events.map((event) => event.event), ['queued', 'delivered', 'read', 'replied']);
  const replyRead = value(await message({ action: 'read', message_id: reply.message_id }, 'A'), 'read reply');
  assert.equal(replyRead.message.body, replyBody);
  assert.equal(replyRead.message.reply_to, sent.message_id);

  const oversized = '密'.repeat(8000);
  rejected(await message({ ...sendArgs, body: oversized }, 'A'), /message_too_large/, 'oversized send');
  const audit = value(await message({ action: 'status' }, 'A'), 'oversized audit');
  const refused = audit.messages.filter((row) => row.state === 'rejected');
  assert.equal(refused.length, 1);
  assert.equal(refused[0].body, null);
  assert.equal(refused[0].body_bytes, Buffer.byteLength(oversized, 'utf8'));
  assert.deepEqual(refused[0].events.map((event) => event.event), ['rejected']);
  assert.ok(Buffer.byteLength(JSON.stringify(refused[0]), 'utf8') < 2000, 'oversized audit retained unbounded content');
  rejected(await message({ ...sendArgs, recipient: 'unknown-conversation' }, 'A'), /unknown_recipient/, 'unknown recipient');
  const unknownAudit = value(await message({ action: 'status' }, 'A'), 'unknown recipient audit').messages
    .find(row => row.recipient === 'unknown-conversation');
  assert.equal(unknownAudit.body, body);
  assert.equal(unknownAudit.state, 'rejected');
  assert.deepEqual(unknownAudit.events.map(event => event.event), ['rejected']);
  assert.deepEqual(value(await message({ action: 'status' }, 'C'), 'unrelated conversation status').messages, []);
} finally {
  await client.close();
}
`,
  ],
  {
    cwd: consumerDir,
    stdio: 'inherit',
    env: buildIsolatedRuntimeEnv(process.env, {
      runtimeHome: protocolHome,
      memeshDir: protocolMemeshDir,
      dbPath: protocolDbPath,
    }),
  }
);

const installedCliEntry = path.join(installedRoot,
  JSON.parse(fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8')).bin.memesh);

// Real installed public CLI, with synthetic registration only. No host wake.
{
  const nativeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-'));
  const nativeDir = path.join(nativeHome, '.memesh');
  const nativeDbPath = path.join(nativeDir, 'knowledge-graph.db');
  const nativeEnv = {
    ...buildIsolatedRuntimeEnv(process.env, {
      runtimeHome: nativeHome,
      memeshDir: nativeDir,
      dbPath: nativeDbPath,
    }),
    MEMESH_AUTO_CAPTURE: 'false',
  };
  const sessionA = '11a041b4-5c67-75b3-9505-4e33d7942b8e';
  const sessionB = '22a041b4-5c67-75b3-9505-4e33d7942b8e';
  const sessionC = '33a041b4-5c67-75b3-9505-4e33d7942b8e';
  const offlineSession = '44a041b4-5c67-75b3-9505-4e33d7942b8e';
  delete nativeEnv.CLAUDE_CODE_SESSION_ID;
  delete nativeEnv.CODEX_THREAD_ID;
  const messagesModule = pathToFileURL(path.join(installedRoot, 'dist/core/conversation-messages.js')).href;
  const call = (args, session, input) => spawnSync(process.execPath, [installedCliEntry, 'message', ...args], {
    cwd: consumerDir, env: { ...nativeEnv, ...(session ? { CODEX_THREAD_ID: session } : {}) },
    input, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  const value = result => {
    assert.equal(result.error, undefined, 'CLI launcher failed');
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const rejected = (result, pattern) => {
    assert.equal(result.error, undefined, 'rejection was a launcher failure');
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, pattern);
  };
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { ConversationMessages } from ${JSON.stringify(messagesModule)};
      import { hostname } from 'node:os';
      const s = new ConversationMessages();
      try {
        for (const id of ${JSON.stringify([sessionA, sessionB, sessionC, offlineSession])}) {
          s.register({id,host:'codex',machine:hostname(),pid:id===${JSON.stringify(offlineSession)}?2147483647:${process.pid},wake:{}});
        }
      } finally { s.close(); }
    `], {cwd:consumerDir,env:nativeEnv,timeout:10_000});
    const roster = value(call(['discover'])).conversations;
    assert.deepEqual(roster.map(row => row.address), [sessionA, sessionB, sessionC, offlineSession]);
    assert.equal(roster.find(row => row.address === offlineSession).online, false);
    const body = 'CLI-HEAD\n' + '全文-middle-'.repeat(160) + '\nCLI-TAIL';
    const args = ['send','--recipient',sessionB,'--kind','task','--payload-stdin'];
    rejected(call(args, undefined, body), /without a host session identity/);
    rejected(call([...args,'--sender','forged'],sessionA,body), /unknown option/);
    const status = () => value(call(['status','--json'])).messages;
    assert.deepEqual(status(), []);
    const sent = value(call(args,sessionA,body));
    assert.equal(sent.state,'queued');
    const original = () => status().find(row => row.id === sent.message_id);
    assert.equal(original().body,body);
    assert.equal(original().body_bytes,Buffer.byteLength(body));
    assert.equal(original().sender,sessionA);
    assert.equal(original().recipient,sessionB);
    assert.deepEqual(original().events.map(e=>e.event),['queued']);
    const denied = call(['read','--message-id',sent.message_id],sessionC);
    rejected(denied,/not addressed to this conversation/);
    assert.equal((denied.stdout+denied.stderr).includes(body),false);
    assert.equal(value(call(['read','--message-id',sent.message_id],sessionB)).message.body,body);
    assert.deepEqual(original().events.map(e=>e.event),['queued','delivered','read']);
    rejected(call(['send','--recipient',sessionC,'--kind','result','--reply-to',sent.message_id,'--payload-stdin'],sessionB,'wrong reply'),/Reply must address/);
    assert.equal(status().length,1,'invalid reply left a partial message');
    const reply = value(call(['send','--recipient',sessionA,'--kind','result','--reply-to',sent.message_id,'--payload-stdin'],sessionB,'CLI full reply'));
    const replyRead = value(call(['read','--message-id',reply.message_id],sessionA)).message;
    assert.equal(replyRead.body,'CLI full reply');
    assert.equal(replyRead.reply_to,sent.message_id);
    assert.equal(original().state,'replied');
    const offline = value(call(['send','--recipient',offlineSession,'--kind','question','--payload-stdin'],sessionA,'offline body'));
    assert.equal(offline.state,'queued');
    assert.deepEqual(status().find(row=>row.id===offline.message_id).events.map(e=>e.event),['queued']);
    rejected(call(['send','--recipient','unknown-conversation','--kind','task','--payload-stdin'],sessionA,'unknown body'),/unknown_recipient/);
    const oversized = '密'.repeat(8000);
    rejected(call(args,sessionA,oversized),/message_too_large/);
    const refused = status().filter(row=>row.state==='rejected');
    assert.equal(refused.length,2);
    const large = refused.find(row=>row.body===null);
    assert.equal(large.body_bytes,Buffer.byteLength(oversized));
    assert.ok(Buffer.byteLength(JSON.stringify(large))<2000);
    assert.ok(refused.every(row=>row.events.length===1&&row.events[0].event==='rejected'));
    assert.equal(refused.find(row=>row.recipient==='unknown-conversation').body,'unknown body');
    for (const action of ['update','delete','poll','fetch','intake','storage']) rejected(call([action],sessionA),/unknown command/);
    assert.equal(status().length,5,'unsupported public action changed messages');

    // Installed clock seeds only this separate private fixture. The real CLI
    // open below must retain 13-day data, notify once, and remove 15-day data.
    const timeDir = path.join(nativeHome,'time');
    fs.mkdirSync(timeDir,{mode:0o700});
    const timeEnv = {...nativeEnv,MEMESH_DIR:timeDir,MEMESH_DB_PATH:path.join(timeDir,'graph.db')};
    const fixture = JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',`
      import { ConversationMessages } from ${JSON.stringify(messagesModule)};
      import { hostname } from 'node:os';
      const file=${JSON.stringify(path.join(timeDir,'messages.db'))},now=Date.now(),day=86400000;
      const make=(age,body)=>{
        const s=new ConversationMessages({file,clock:()=>now-age*day});
        try {
          for(const id of ['time-A','time-B'])s.register({id,host:'codex',machine:hostname(),pid:process.pid,wake:{}});
          return s.send('time-A',{recipient:'time-B',kind:'task',body}).message.id;
        } finally {s.close();}
      };
      // Newer first: fixture construction cannot expire or notify older rows.
      const retained=make(13,'thirteen day full body'),expired=make(15,'fifteen day body');
      process.stdout.write(JSON.stringify({retained,expired}));
    `],{cwd:consumerDir,env:timeEnv,encoding:'utf8',timeout:10_000}));
    const timeStatus=()=>JSON.parse(execFileSync(process.execPath,[installedCliEntry,'message','status','--json'],{cwd:consumerDir,env:timeEnv,encoding:'utf8',timeout:10_000})).messages;
    const first=timeStatus();
    assert.equal(first.some(row=>row.id===fixture.expired),false);
    assert.equal(first.find(row=>row.id===fixture.retained).body,'thirteen day full body');
    assert.equal(first.filter(row=>row.sender==='memesh'&&row.reply_to===fixture.retained).length,1);
    assert.equal(first.find(row=>row.id===fixture.retained).events.filter(e=>e.event==='undelivered_notified').length,1);
    assert.deepEqual(timeStatus(),first,'maintenance repeated notice');
    execFileSync(process.execPath,['--input-type=module','-e',`
      import assert from 'node:assert/strict';import { DatabaseSync } from 'node:sqlite';
      const db=new DatabaseSync(${JSON.stringify(path.join(timeDir,'messages.db'))},{readOnly:true});
      try {assert.equal(db.prepare('SELECT count(*) AS n FROM events WHERE message_id=?').get(${JSON.stringify(fixture.expired)}).n,0);}finally{db.close();}
    `],{cwd:consumerDir,env:timeEnv,timeout:10_000});
  } finally {
    fs.rmSync(nativeHome, { recursive: true, force: true });
  }
}

fs.rmSync(smokeDir, { recursive: true, force: true });

// Say something on success. A check that prints nothing when it passes is
// indistinguishable from one that did not run — the exact failure mode this
// repo has spent several releases removing from its own code.
console.log('✅ Packaged artifact smoke passed: installed CLI/MCP four-action messaging, complete bodies, recipient isolation, reply/audit and 14-day retention. Synthetic registration only; native wake is not verified.');
