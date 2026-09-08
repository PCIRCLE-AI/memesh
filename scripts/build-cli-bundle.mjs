#!/usr/bin/env node

// The plugin marketplace installs a self-contained dist/ tree without
// node_modules. Bundle the CLI just like the MCP entry point so the documented
// `memesh` command works from that cache as well as from an npm installation.
import { builtinModules } from 'node:module';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entryPoint = path.join(projectRoot, 'dist/transports/cli/cli.js');

const result = await build({
  absWorkingDir: projectRoot,
  entryPoints: [entryPoint],
  outfile: entryPoint,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.13',
  packages: 'bundle',
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

const javascript = result.outputFiles.find((file) => file.path === entryPoint);
if (!javascript || !javascript.text.startsWith('#!/usr/bin/env node\n')) {
  throw new Error('CLI bundle lost its executable shebang');
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

replaceAtomically(entryPoint, javascript.text.replace(/[ \t]+(?=\r?\n)/g, ''), 0o755);
const sourceMap = result.outputFiles.find((file) => file.path === `${entryPoint}.map`);
if (sourceMap) replaceAtomically(`${entryPoint}.map`, sourceMap.contents);
