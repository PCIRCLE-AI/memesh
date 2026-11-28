// =============================================================================
// setup — one command from "installed" to "wired and verified", per host
// =============================================================================
//
// THE GAP THIS CLOSES (measured in the install audit, 2026-08-16)
// ───────────────────────────────────────────────────────────────
// There was no single verified install path. `memesh doctor` scopes every
// check to the COPY being invoked (its packageRoot), so it can answer "is
// this npm install healthy?" but structurally cannot answer "is this
// MACHINE wired?" — a plugin-only user has no copy that can see the plugin,
// and a both-paths user gets a doctor report that contradicts
// install-hooks' own bail message. `memesh setup --check` answers the
// machine-level question: it reads the HOSTS' own state — Claude Code's
// plugin registry and settings.json, Codex's and Gemini's MCP registries —
// not this package's files. `memesh setup` additionally offers to do the
// wiring, using each host CLI's own `mcp add` (the hosts own their config
// files; memesh never writes them directly).
//
// HOW EACH HOST IS PROBED — deliberately not uniform
// ──────────────────────────────────────────────────
// - Claude Code: the plugin registry (installed_plugins.json) and the
//   `_memesh` hook markers in settings.json are FILES with stable shapes
//   that install-hooks already owns; MCP registration is probed with
//   `claude mcp get memesh` (exit code) because user-scope entries live in
//   ~/.claude.json alongside unrelated state.
// - Codex: `codex mcp get memesh` (exit code). A substring check on
//   config.toml was rejected in review: TOML allows a quoted
//   [mcp_servers."memesh"] form and an `enabled = false` field, and
//   CODEX_HOME can relocate the whole directory — the CLI resolves all of
//   that itself.
// - Gemini: the settings file (~/.gemini/settings.json, key
//   mcpServers.memesh). Verified against a real machine — and verified the
//   hard way that `gemini mcp get` DOES NOT EXIST (add/remove/list/
//   enable/disable only), which is why Gemini cannot be probed like the
//   other two.
//
// All commands here are FIXED STRINGS — nothing user-supplied is ever
// interpolated into a command line.

import fs from 'fs';
import path from 'path';
import { detectPluginRuntime, settingsHaveMemeshHooks } from './install-hooks.js';
import { pluginHostConfigRoot } from './install-channel.js';
import { claudeCodePresent, codexPresent, folderHere, geminiPresent } from './host-presence.js';

export type HostId = 'claude-code' | 'codex' | 'gemini';

export interface RunResult {
  /** null when the process was killed by a signal or could not be spawned. */
  status: number | null;
  stderr: string;
}

/**
 * The seams tests inject. Defaults live in the CLI (they spawn real
 * processes); core stays pure enough to unit-test every branch.
 */
export interface SetupSeams {
  home: () => string;
  isOnPath: (bin: string) => boolean;
  run: (cmd: string, args: string[]) => RunResult;
  /** Test override for Claude Code's plugin registry path. */
  installedPluginsPath?: string;
  /** Claude Code's relocated config directory (CLAUDE_CONFIG_DIR), if any. Default: the environment. */
  claudeConfigDir?: () => string | undefined;
}

export interface WireAction {
  /** 'run' spawns cmd+args; 'install-hooks' calls installHooks() in-process. */
  kind: 'run' | 'install-hooks';
  /** One plain sentence, shown before asking to proceed. */
  label: string;
  cmd?: string;
  args?: string[];
}

export interface HostStatus {
  host: HostId;
  title: string;
  /** Is this host on the machine at all? Absent hosts are informational. */
  present: boolean;
  /** What presence was decided from — a real path or binary name. */
  presenceDetail: string;
  /** true / false / null = present but could not be determined. */
  wired: boolean | null;
  /**
   * What could not be checked, in plain language (set exactly when `wired` is null): Codex's
   * config directory without the codex command, a probe that failed to run, or Claude Code's
   * MCP registration without the claude command. Not a failure with an action to take: a
   * question a person has to answer.
   */
  unchecked?: string;
  /**
   * True when the host is present and NOTHING about its wiring could be checked (a subset of
   * `unchecked`; Claude Code's hooks are still verified when only its MCP registration is not).
   * Such a host is not "wired", and does not count as confirmed.
   */
  unprobed?: boolean;
  /** What wiredness was decided from, in plain language. */
  wiredDetail: string;
  /** What `memesh setup` would do about it. Empty = nothing to do. */
  actions: WireAction[];
}

function inspectClaudeCode(seams: SetupSeams): HostStatus {
  // Where `memesh install-hooks` writes: CLAUDE_CONFIG_DIR when Claude Code is
  // relocated, else ~/.claude. Looking anywhere else reports Claude Code as
  // missing while the hooks sit in the directory it really uses.
  const relocated = seams.claudeConfigDir ? seams.claudeConfigDir() : process.env.CLAUDE_CONFIG_DIR;
  const claudeDir = relocated ? path.resolve(relocated) : path.join(seams.home(), '.claude');
  // The same definition of "Claude Code is here" as `memesh doctor` (host-presence.ts): its directory exists or
  // its command is on PATH (a freshly installed Claude Code has no directory until it first runs).
  const present = claudeCodePresent(fs.existsSync, seams.isOnPath, claudeDir);
  const status: HostStatus = {
    host: 'claude-code',
    title: 'Claude Code',
    present,
    presenceDetail: folderHere(fs.existsSync, claudeDir) ? claudeDir : present ? 'claude on PATH' : `claude on PATH, or ${claudeDir}`,
    wired: null,
    wiredDetail: '',
    actions: [],
  };
  if (!present) {
    status.wiredDetail = 'not on this machine — nothing to wire';
    return status;
  }

  // The registry path derives from the SEAM's home, not from
  // detectPluginRuntime's internal default — the default reads the real
  // machine, and a test's fixture home would be silently ignored on any
  // developer machine that has the plugin installed (this exact
  // host-state-dependence was flagged in the design review; the unit test
  // for this file caught it on first run).
  const plugin = detectPluginRuntime(
    seams.installedPluginsPath ?? path.join(claudeDir, 'plugins', 'installed_plugins.json'),
  );
  if (plugin) {
    // The plugin runtime loads hooks, MCP and skills itself. Anything more
    // would double-wire — installHooks' own guard refuses for this reason.
    status.wired = true;
    status.wiredDetail = `plugin v${plugin.version} manages hooks, MCP and skills (installed_plugins.json)`;
    return status;
  }

  const settingsPath = path.join(claudeDir, 'settings.json');
  const hooksWired = settingsHaveMemeshHooks(settingsPath);

  // MCP: user-scope entries live in ~/.claude.json among unrelated state,
  // so ask the claude CLI itself. Scope matters — `claude mcp add` defaults
  // to LOCAL (current directory only), which is why the action below says
  // `-s user`.
  let mcpWired: boolean | null = null;
  let mcpDetail: string;
  if (seams.isOnPath('claude')) {
    const probe = seams.run('claude', ['mcp', 'get', 'memesh']);
    mcpWired = probe.status === 0;
    mcpDetail = mcpWired ? 'claude mcp get memesh → registered' : 'claude mcp get memesh → not registered';
  } else {
    mcpDetail = 'claude CLI not on PATH — cannot probe MCP registration';
    if (hooksWired) status.unchecked = mcpDetail;
  }

  // Unwired hooks are a definite NO. Wired hooks with an unprobeable MCP
  // (no claude CLI on PATH) are UNKNOWN, not a failure — there is nothing
  // to prescribe, and reporting false would fail a healthy plugin-less
  // hooks-only machine forever.
  status.wired = hooksWired ? mcpWired : false;
  status.wiredDetail = `${hooksWired ? 'hooks wired (settings.json)' : 'hooks NOT wired (no _memesh marker in settings.json)'}; ${mcpDetail}`;

  if (!hooksWired) {
    status.actions.push({
      kind: 'install-hooks',
      label: `Wire the session hooks into ${path.join(claudeDir, 'settings.json')} (backs the file up first)`,
    });
  }
  if (mcpWired === false) {
    status.actions.push({
      kind: 'run',
      label: 'Register the MCP server with Claude Code (user scope, all folders)',
      cmd: 'claude',
      args: ['mcp', 'add', '-s', 'user', 'memesh', 'memesh-mcp'],
    });
  }
  return status;
}

function inspectCodex(seams: SetupSeams): HostStatus {
  // The same definition of "Codex is here" as `memesh doctor` (host-presence.ts): the command is on PATH or
  // Codex's config directory exists.
  const onPath = seams.isOnPath('codex');
  const codexDir = pluginHostConfigRoot('codex');
  const present = codexPresent(fs.existsSync, seams.isOnPath);
  const status: HostStatus = {
    host: 'codex',
    title: 'Codex CLI',
    present,
    presenceDetail: onPath ? 'codex on PATH' : present ? codexDir : `codex on PATH, or ${codexDir}`,
    wired: null,
    wiredDetail: present ? '' : 'not on this machine — nothing to wire',
    actions: [],
  };
  if (!present) return status;
  if (!onPath) {
    status.wiredDetail = 'Codex\'s config directory exists but the codex command is not on PATH — cannot probe MCP registration';
    status.unchecked = 'the codex command is not on PATH — cannot probe MCP registration';
    status.unprobed = true;
    return status;
  }

  const probe = seams.run('codex', ['mcp', 'get', 'memesh']);
  if (probe.status === null) {
    status.wiredDetail = 'codex mcp get failed to run — could not determine';
    status.unchecked = 'codex mcp get failed to run — could not determine';
    status.unprobed = true;
  } else {
    status.wired = probe.status === 0;
    status.wiredDetail = status.wired ? 'codex mcp get memesh → registered' : 'codex mcp get memesh → not registered';
    if (!status.wired) {
      status.actions.push({
        kind: 'run',
        label: 'Register the MCP server with Codex CLI',
        cmd: 'codex',
        args: ['mcp', 'add', 'memesh', '--', 'memesh-mcp'],
      });
    }
  }
  return status;
}

function inspectGemini(seams: SetupSeams): HostStatus {
  const present = geminiPresent(seams.isOnPath);
  const status: HostStatus = {
    host: 'gemini',
    title: 'Gemini CLI',
    present,
    presenceDetail: 'gemini on PATH',
    wired: null,
    wiredDetail: present ? '' : 'not on this machine — nothing to wire',
    actions: [],
  };
  if (!present) return status;

  const settingsPath = path.join(seams.home(), '.gemini', 'settings.json');
  let wired = false;
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    wired = Boolean(parsed.mcpServers && Object.prototype.hasOwnProperty.call(parsed.mcpServers, 'memesh'));
  } catch { /* no settings file yet — not wired */ }

  status.wired = wired;
  status.wiredDetail = wired
    ? 'mcpServers.memesh present in ~/.gemini/settings.json'
    : 'no mcpServers.memesh in ~/.gemini/settings.json';
  if (!wired) {
    status.actions.push({
      kind: 'run',
      label: 'Register the MCP server with Gemini CLI (user scope, all folders)',
      cmd: 'gemini',
      args: ['mcp', 'add', '-s', 'user', 'memesh', 'memesh-mcp'],
    });
  }
  return status;
}

/** Machine-level wiring status for every known host, in a stable order. */
export function inspectHosts(seams: SetupSeams): HostStatus[] {
  return [inspectClaudeCode(seams), inspectCodex(seams), inspectGemini(seams)];
}

const CHECK_AGAIN = 'To check it, put the command on PATH and run `memesh setup --check` again.';

/**
 * How `setup` ends, and the exit code that goes with it — ONE rule for `--check`, a plain `setup`
 * and `setup --yes` after it has wired:
 *
 *  - no host on the machine, or no host that could be confirmed wired            → exit 1, says why
 *  - a present host that can be checked and is not wired (or has an action left) → exit 1
 *  - everything that can be checked is wired                                      → exit 0
 *
 * "Could not look" is never turned into "all good": a host that was not checked (Codex's folder
 * without the codex command, Claude Code's MCP registration without the claude command) is named in
 * the closing sentence together with how to check it, but it does not fail a machine whose other
 * parts are wired. Hooks verified plus MCP unprobeable counts as confirmed; nothing verified does not.
 */
export function setupVerdict(statuses: HostStatus[]): { exitCode: 0 | 1; closing: string | null } {
  const present = statuses.filter((s) => s.present);
  if (present.length === 0) {
    const looked = statuses.map((s) => `  - ${s.title}: ${s.presenceDetail}`).join('\n');
    return {
      exitCode: 1,
      closing: `No supported agent host was found on this machine, so memesh changed nothing and connected to nothing. Looked for:\n${looked}\n\nInstall Claude Code or Codex (or Gemini CLI), then run \`memesh setup\` again.`,
    };
  }
  // The lines above say what is wrong and the plan says what to do about it. (Every host that has an action to take is `wired === false`.)
  if (present.some((s) => s.wired === false)) return { exitCode: 1, closing: null };

  const unchecked = present.filter((s) => s.unchecked !== undefined);
  if (unchecked.length === 0) return { exitCode: 0, closing: 'Everything present is wired. Nothing to do.' };
  const what = unchecked.map((s) => `${s.title} (${s.unchecked})`).join(' and ');
  if (present.every((s) => s.unprobed)) {
    return { exitCode: 1, closing: `Nothing to wire automatically — see the lines above. Nothing could be confirmed wired. Not checked: ${what}. ${CHECK_AGAIN}` };
  }
  return { exitCode: 0, closing: `Everything that could be checked is wired. Not checked: ${what}. ${CHECK_AGAIN}` };
}
