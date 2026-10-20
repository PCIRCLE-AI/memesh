#!/usr/bin/env node

// The plugin marketplace installs a self-contained dist/ tree without
// node_modules. Bundle the CLI just like the MCP entry point so the documented
// `memesh` command and its diagnostic child work from that cache as well as
// from an npm installation.
import { builtinModules } from 'node:module';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(projectRoot, 'dist');
const executableEntryPoints = new Set(
  ['transports/cli/cli.js', 'transports/cli/doctor-message-probe.js']
    .map((entry) => path.join(distRoot, entry)),
);
const entryPoints = [
  ...executableEntryPoints,
  path.join(distRoot, 'host-adapters/codex-app-server.js'),
  path.join(distRoot, 'host-adapters/claude-channel.js'),
];

const result = await build({
  absWorkingDir: projectRoot,
  entryPoints,
  outdir: distRoot,
  outbase: distRoot,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.13',
  packages: 'bundle',
  // Plugin caches have no optional native ws addons. Keep ws's JavaScript
  // masking and Node's built-in UTF-8 validation instead of external imports.
  define: {
    'process.env.WS_NO_BUFFER_UTIL': '"1"',
    'process.env.WS_NO_UTF_8_VALIDATE': '"1"',
  },
  external: ['node:*'],
  sourcemap: true,
  sourcesContent: false,
  legalComments: 'none',
  metafile: true,
  banner: {
    // Commander is CommonJS and uses a small dynamic require for Node builtins.
    // Give the ESM bundle a real require function so that dependency can still
    // be fully bundled into a node_modules-free marketplace cache.
    js: "import { createRequire as __memeshCreateRequire } from 'node:module'; const require = __memeshCreateRequire(import.meta.url);",
  },
  write: false,
});

const builtinSpecifiers = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);
const externalImports = Object.values(result.metafile?.outputs ?? {})
  .flatMap((output) => output.imports)
  .filter((entry) => entry.external)
  .filter(({ path: specifier }) => !builtinSpecifiers.has(specifier));
if (externalImports.length > 0) {
  const specifiers = [...new Set(externalImports.map(({ path: specifier }) => specifier))].sort();
  throw new Error(`CLI bundle left non-builtin imports external: ${specifiers.join(', ')}`);
}

function replaceAtomically(destination, contents, mode) {
  const temporary = `${destination}.tmp-${process.pid}`;
  try {
    // The build runs serially; a process-specific temporary prevents a partial
    // file from being visible to a concurrently starting plugin host.
    fs.writeFileSync(temporary, contents, { mode: mode ?? 0o644 });
    if (mode !== undefined) fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

for (const entryPoint of entryPoints) {
  const javascript = result.outputFiles.find((file) => file.path === entryPoint);
  if (!javascript || (executableEntryPoints.has(entryPoint) && !javascript.text.startsWith('#!/usr/bin/env node\n'))) {
    throw new Error(`Missing bundle or executable shebang: ${entryPoint}`);
  }
  replaceAtomically(entryPoint, javascript.text.replace(/[ \t]+(?=\r?\n)/g, ''), executableEntryPoints.has(entryPoint) ? 0o755 : 0o644);
  const sourceMap = result.outputFiles.find((file) => file.path === `${entryPoint}.map`);
  if (sourceMap) replaceAtomically(`${entryPoint}.map`, sourceMap.contents);
}

// Preserve the licenses of dependencies bundled into these plugin entries.
const dependencyRoots = new Set(Object.keys(result.metafile.inputs).flatMap((input) => {
  const segments = path.resolve(projectRoot, input).split(path.sep);
  const index = segments.lastIndexOf('node_modules');
  if (index < 0) return [];
  return [segments.slice(0, index + (segments[index + 1].startsWith('@') ? 3 : 2)).join(path.sep)];
}));
const notices = [...dependencyRoots].sort().map((root) => {
  const info = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const files = fs.readdirSync(root).filter((name) => /^(?:licen[cs]e|notice|copying)(?:[._-].*)?$/i.test(name)).sort();
  if (!files.length) throw new Error(`Bundled package ${info.name}@${info.version} has no license file`);
  return `${info.name}@${info.version}\n${files.map((name) => fs.readFileSync(path.join(root, name), 'utf8').trimEnd()).join('\n\n')}`;
});
replaceAtomically(
  path.join(distRoot, 'transports/cli/THIRD_PARTY_NOTICES.txt'),
  `Third-party software bundled in the CLI, diagnostic client and checked host adapters\n\n${notices.join('\n\n')}\n`,
);
