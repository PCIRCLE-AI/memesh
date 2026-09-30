// =============================================================================
// Is this process running in the directory it was installed in?
// =============================================================================
//
// A host that starts the MCP server with the plugin root as its working
// directory (Codex resolves the manifest's `"cwd": "."` against the plugin
// root, and runs the server from that same root) makes "the current
// directory's project" MeMesh's install directory, not the user's workspace.
// Anything that defaults a project from `process.cwd()` would then file
// memories under the plugin directory's project (#527).
//
// The test is identity with the RUNNING server's own package root (the
// directory holding the package.json of the server file being run), or with
// the plugin root the host announced. It is deliberately not "any directory
// named @pcircle/memesh": under Claude Code the server runs from the plugin
// cache while the cwd is the workspace, and that workspace may itself be a
// MeMesh checkout, which must keep working. Symlinks are resolved first. A read
// failure means "not the same directory" — this only ever REFUSES a defaulted
// project, and "no" is exactly the behaviour before this file.

import fs from 'fs';

function realOrNull(p: string | undefined): string | null {
  if (!p) return null;
  try { return fs.realpathSync(p); } catch { return null; }
}

export function cwdIsMemeshOwnRoot(
  cwd: string,
  packageRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const here = realOrNull(cwd);
  if (here === null) return false;
  return [packageRoot, env.CLAUDE_PLUGIN_ROOT, env.PLUGIN_ROOT].some((root) => realOrNull(root) === here);
}
