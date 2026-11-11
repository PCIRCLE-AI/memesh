/**
 * "Is this agent on this machine?", answered one way for every caller, and the
 * same way for every agent: its configuration directory exists, or its command is
 * on PATH.
 *
 * `memesh setup` and `memesh doctor` used to disagree about Codex: setup looked
 * for the `codex` command on PATH, doctor for Codex's configuration directory.
 * A machine with only the directory, or only the command, got two different
 * answers from the two commands. Claude Code had the same half-rule: a freshly
 * installed Claude Code has no `~/.claude` until it first runs, so judging it by
 * the directory alone called a machine with Claude Code "Codex-only". Both agents
 * are now asked through `claudeCodePresent` / `codexPresent`.
 */
import fs from 'fs';
import path from 'path';
import { pluginHostConfigRoot } from './install-channel.js';

/**
 * True when `tool` resolves to an executable on the current PATH. Windows
 * executables carry a PATHEXT extension (`npm.cmd`, not `npm`), so each
 * extension is tried there.
 */
export function isOnPath(tool: string): boolean {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        const candidate = path.join(dir, tool + ext);
        fs.accessSync(candidate, fs.constants.X_OK);
        // A directory is "executable" too (X_OK means searchable there), but a
        // folder named `claude` is not the command — a shell's `command -v` skips it.
        if (fs.statSync(candidate).isFile()) return true;
      } catch { /* not in this dir — keep looking */ }
    }
  }
  return false;
}

/**
 * Claude Code is present when its config directory exists or its command is on PATH.
 * `configDir` is where Claude Code keeps its configuration; the default is the
 * environment's answer (CLAUDE_CONFIG_DIR, else ~/.claude).
 */
export function claudeCodePresent(
  existsSyncImpl: (p: string) => boolean = fs.existsSync,
  onPath: (tool: string) => boolean = isOnPath,
  configDir: string = pluginHostConfigRoot('claude-code'),
): boolean {
  return existsSyncImpl(configDir) || onPath('claude');
}

/** Codex is present when its config directory exists or its command is on PATH. */
export function codexPresent(
  existsSyncImpl: (p: string) => boolean = fs.existsSync,
  onPath: (tool: string) => boolean = isOnPath,
): boolean {
  return existsSyncImpl(pluginHostConfigRoot('codex')) || onPath('codex');
}

/** Gemini CLI has no configuration directory memesh looks at: it is present when its command is on PATH. */
export function geminiPresent(onPath: (tool: string) => boolean = isOnPath): boolean {
  return onPath('gemini');
}
