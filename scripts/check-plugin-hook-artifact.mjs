#!/usr/bin/env node
/** Verify plugin hooks and host entrypoints before a cache/artifact swap. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmSync, envWithNpmCache } from './lib/npm-bin.mjs';

export const CLAUDE_PLUGIN_ROOT_PREFIX = '${CLAUDE_PLUGIN_ROOT}/';

function isSubpath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function hookTargetsFromManifest(manifest) {
  const targets = [];
  for (const [event, entries] of Object.entries(manifest?.hooks ?? {})) {
    if (!Array.isArray(entries)) throw new Error(`${event} is not an array in hooks/hooks.json`);
    for (const entry of entries) {
      for (const hook of entry?.hooks ?? []) {
        if (hook?.type !== 'command') continue;
        if (typeof hook.command !== 'string' || !hook.command.startsWith(CLAUDE_PLUGIN_ROOT_PREFIX)) {
          throw new Error(`${event} command must start with ${CLAUDE_PLUGIN_ROOT_PREFIX}`);
        }
        const relative = hook.command.slice(CLAUDE_PLUGIN_ROOT_PREFIX.length);
        if (!relative || /\s/.test(relative) || path.posix.normalize(relative) !== relative || relative.startsWith('../')) {
          throw new Error(`${event} command is not a single safe plugin-relative path: ${hook.command}`);
        }
        targets.push({ event, relative });
      }
    }
  }
  if (targets.length === 0) throw new Error('hooks/hooks.json declares no command hooks');
  return targets;
}

export function readHookManifest(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8'));
}

export function validateHookTargets(root, manifest = readHookManifest(root)) {
  const rootPath = path.resolve(root);
  const targets = hookTargetsFromManifest(manifest);
  const missing = [];
  for (const target of targets) {
    const resolved = path.resolve(rootPath, target.relative);
    try {
      if (isContainedRegularFile(rootPath, resolved)) continue;
    } catch {
      // Report the same bounded finding for missing and unreadable targets.
    }
    missing.push({ ...target, resolved });
  }
  return { targets, missing, ok: missing.length === 0 };
}

/**
 * True only for a regular file whose every path component lives inside root.
 * `lstat` rejects a symlink as the last component; `realpathSync` on both
 * sides rejects a symlinked directory ABOVE it — `scripts/hooks -> /elsewhere`
 * passed the lstat-only check and would have let a staged cache execute
 * ambient bytes. Throws on a missing path, like the fs calls it wraps.
 */
function isContainedRegularFile(rootPath, resolved) {
  if (!isSubpath(rootPath, resolved) || !fs.lstatSync(resolved).isFile()) return false;
  return isSubpath(fs.realpathSync(rootPath), fs.realpathSync(resolved));
}

function safeRelativePath(value, label) {
  if (typeof value !== 'string' || !value.startsWith('./')) {
    throw new Error(`${label} must be a ./ relative path`);
  }
  const relative = value.slice(2);
  if (!relative || path.posix.normalize(relative) !== relative || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(`${label} is not a safe plugin-relative path: ${value}`);
  }
  return relative;
}

function regularFile(root, relative, label) {
  const rootPath = path.resolve(root);
  const resolved = path.resolve(rootPath, relative);
  if (!isSubpath(rootPath, resolved)) throw new Error(`${label} escapes plugin root: ${relative}`);
  try {
    if (isContainedRegularFile(rootPath, resolved)) return relative;
  } catch {
    // Fall through to one bounded diagnostic.
  }
  throw new Error(`${label} is missing or not a regular file: ${relative}`);
}

export function validatePluginEntrypoints(root) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const targets = [];
  for (const [relativeManifest, expectedPrefix] of [
    ['.claude-plugin/plugin.json', '${CLAUDE_PLUGIN_ROOT}/'],
    ['.codex-plugin/plugin.json', './'],
  ]) {
    regularFile(root, relativeManifest, relativeManifest);
    const plugin = JSON.parse(fs.readFileSync(path.join(root, relativeManifest), 'utf8'));
    if (plugin.name !== 'memesh') throw new Error(`${relativeManifest} has unexpected plugin name`);
    if (plugin.version !== packageJson.version) throw new Error(`${relativeManifest} version does not match package.json`);
    const mcpManifest = safeRelativePath(plugin.mcpServers, `${relativeManifest} mcpServers`);
    regularFile(root, mcpManifest, `${relativeManifest} mcpServers`);
    targets.push({ kind: 'manifest', relative: relativeManifest });
    targets.push({ kind: 'manifest', relative: mcpManifest });
    const manifest = JSON.parse(fs.readFileSync(path.join(root, mcpManifest), 'utf8'));
    const entry = manifest.mcpServers?.memesh;
    if (!entry || entry.command !== 'node' || !Array.isArray(entry.args) || typeof entry.args[0] !== 'string') {
      throw new Error(`${mcpManifest} has no valid mcpServers.memesh node entry`);
    }
    const rawTarget = entry.args[0];
    if (!rawTarget.startsWith(expectedPrefix)) {
      throw new Error(`${mcpManifest} entry must start with ${expectedPrefix}`);
    }
    const target = rawTarget.slice(expectedPrefix.length);
    if (path.posix.normalize(target) !== target || target.startsWith('../') || path.isAbsolute(target)) {
      throw new Error(`${mcpManifest} entry is not a safe plugin-relative path: ${rawTarget}`);
    }
    regularFile(root, target, `${mcpManifest} entrypoint`);
    targets.push({ kind: 'entrypoint', relative: target });
  }
  return { targets };
}

export function validateArtifactPaths(targets, files) {
  const shipped = new Set(files.map((file) => typeof file === 'string' ? file : file.path));
  const missing = targets.filter((target) => !shipped.has(target.relative));
  return { missing, ok: missing.length === 0 };
}

function packFiles(root) {
  const npmCache = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-pack-cache-'));
  try {
    const stdout = npmSync(['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
      env: envWithNpmCache(npmCache),
    });
    let report;
    try { report = JSON.parse(String(stdout)); } catch { throw new Error('npm pack --dry-run did not return valid JSON'); }
    const entry = Array.isArray(report) ? report[0] : report;
    if (!entry || !Array.isArray(entry.files)) throw new Error('npm pack --dry-run returned no file list');
    return entry.files;
  } catch (error) {
    if (error instanceof Error && /npm pack --dry-run (?:did not return|returned no)/.test(error.message)) throw error;
    const record = error && typeof error === 'object' ? /** @type {Record<string, unknown>} */ (error) : {};
    const status = typeof record.status === 'number' ? record.status : 'unknown';
    const stderr = typeof record.stderr === 'string' ? record.stderr.trim() : '';
    throw new Error(
      `npm pack --dry-run failed (exit ${status}): ${stderr || (error instanceof Error ? error.message : String(error))}`,
      { cause: error },
    );
  } finally {
    fs.rmSync(npmCache, { recursive: true, force: true });
  }
}

export function checkPluginHookArtifact(root, { checkPack = true } = {}) {
  const source = validateHookTargets(root);
  const plugin = validatePluginEntrypoints(root);
  const allTargets = [...source.targets, ...plugin.targets];
  if (!checkPack) return { ...source, plugin, artifact: null };
  return { ...source, plugin, artifact: validateArtifactPaths(allTargets, packFiles(root)) };
}

function main(argv) {
  const rootIndex = argv.indexOf('--root');
  if (rootIndex !== -1 && (!argv[rootIndex + 1] || argv[rootIndex + 1].startsWith('--'))) {
    console.error('plugin hook integrity: --root requires a directory argument');
    process.exit(2);
  }
  const root = path.resolve(rootIndex === -1 ? process.cwd() : argv[rootIndex + 1]);
  const checkPack = !argv.includes('--skip-pack');
  try {
    const result = checkPluginHookArtifact(root, { checkPack });
    if (!result.ok) {
      for (const item of result.missing) console.error(`Missing hook target: ${item.event} -> ${item.resolved}`);
      process.exit(1);
    }
    if (result.artifact && !result.artifact.ok) {
      for (const item of result.artifact.missing) console.error(`Hook target omitted from npm artifact: ${item.event} -> ${item.relative}`);
      process.exit(1);
    }
    console.log(`plugin artifact integrity: PASS (${result.targets.length} hook targets, ${result.plugin.targets.length} plugin/MCP targets${checkPack ? ', npm artifact checked' : ''})`);
  } catch (error) {
    console.error(`plugin hook integrity: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

/**
 * Run `main` only when this file is the entrypoint. Both sides go through
 * realpath: Node resolves symlinks in `import.meta.url` but not in argv[1],
 * so `node /var/folders/.../check-plugin-hook-artifact.mjs` (macOS tmp is a
 * symlink) compared unequal, skipped `main`, and exited 0 with no output — a
 * silent PASS from a checker that had checked nothing. Pinned by the tarball
 * test in tests/plugin-hook-artifact.test.ts, which asserts on the output.
 */
function isEntrypoint(argv1) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(argv1));
  } catch {
    return false;
  }
}

if (isEntrypoint(process.argv[1])) main(process.argv.slice(2));
