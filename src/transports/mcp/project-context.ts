import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProjectName } from '../../core/paths.js';

/**
 * The project an MCP call belongs to when it names none.
 *
 * Two sources can bind a call: the launch root (`MEMESH_PROJECT_ROOT`, set by
 * whoever started the host for one project) and the client's workspace roots
 * (`roots/list`). The server's own working directory is never one: a plugin
 * starts this server in the plugin directory, so it names no user project.
 */
export type McpProjectResolution =
  | { project: string }
  // `unbound`: nothing names a project at all — distinct from a launch root
  // or a client root that was given but cannot be resolved.
  | { error: 'workspace_unavailable' | 'workspace_ambiguous'; reason: string; unbound?: true };

function existingDirectory(candidate: string): string | null {
  try {
    const real = fs.realpathSync(candidate);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function rootDirectory(uri: string): string | null {
  // `file:` and `file://` name no directory; URL parsing would turn them into the filesystem root.
  if (/^file:(\/\/)?$/i.test(uri)) return null;
  try {
    const parsed = new URL(uri);
    return parsed.protocol === 'file:' ? existingDirectory(fileURLToPath(parsed)) : null;
  } catch {
    return null;
  }
}

/**
 * `rootUris` is `[]` when the client has no workspace roots, and `null` when it
 * advertises roots but did not return them (the request failed or timed out).
 * A root that cannot be checked binds nothing: without it, agreement with the
 * other roots and with the launch root cannot be established.
 */
export function resolveMcpProject(
  launchRoot: string | undefined,
  rootUris: readonly string[] | null,
): McpProjectResolution {
  if (rootUris === null) {
    return {
      error: 'workspace_unavailable',
      reason: 'The client advertises workspace roots but did not return them.',
    };
  }
  const fromRoots = new Set<string>();
  for (const uri of rootUris) {
    const directory = rootDirectory(uri);
    if (!directory) {
      return {
        error: 'workspace_unavailable',
        reason: `A workspace root from the client is not an existing local directory: ${JSON.stringify(uri)}.`,
      };
    }
    fromRoots.add(getProjectName(directory));
  }

  if (launchRoot !== undefined) {
    const directory = path.isAbsolute(launchRoot) ? existingDirectory(launchRoot) : null;
    if (!directory) {
      return {
        error: 'workspace_unavailable',
        reason: `MEMESH_PROJECT_ROOT is not an existing absolute directory: ${JSON.stringify(launchRoot)}.`,
      };
    }
    const project = getProjectName(directory);
    if ([...fromRoots].some(other => other !== project)) {
      return {
        error: 'workspace_ambiguous',
        reason: 'MEMESH_PROJECT_ROOT and the client\'s workspace root name different projects.',
      };
    }
    return { project };
  }

  if (fromRoots.size === 1) return { project: [...fromRoots][0] };
  if (fromRoots.size > 1) {
    return {
      error: 'workspace_ambiguous',
      reason: 'The client\'s workspace roots name more than one project.',
    };
  }
  return {
    error: 'workspace_unavailable',
    reason: 'No project is bound to this MCP session (no workspace root and no MEMESH_PROJECT_ROOT).',
    unbound: true,
  };
}
