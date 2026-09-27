// Claude channel launch-flag check (#468).
//
// Not a hook (the `_` prefix): imported by session-start.js. `--dangerously-
// load-development-channels` is an upstream Claude Code opt-in the launching
// terminal command must carry — a dash in it silently autocorrecting to an em
// dash (`—`) leaves the memesh-channel MCP server running while every channel
// notification is dropped, with no other symptom (docs/platforms/agent-
// messaging.md). This walks the process ancestry to find the `claude`
// process that started this session and checks its own command line.
//
// Deliberately narrow: most Claude Code sessions never opt into channels at
// all, including on a machine where `hosts/claude.json` exists from a past
// `memesh agent setup claude` that is not in current use. Warning on every
// flag-less session would be noise for exactly that owner. This only warns
// when the command line shows some INTENT to load the channel — the flag
// word or the channel name appears — that the exact flag does not back up.
//
// Split into pure pieces plus one impure `ps` spawn so the decision logic is
// unit-testable with injected `ps` output, never a live process tree.

import { execFileSync } from 'child_process';

export const CHANNEL_FLAG = '--dangerously-load-development-channels';
/** The flag as it must appear: a preceding space, then the exact ASCII token. */
const EXACT_FLAG_TOKEN = ` ${CHANNEL_FLAG}`;
/** The bare flag word, without its leading dashes. */
const FLAG_WORD = 'dangerously-load-development-channels';
const MAX_ANCESTRY_LEVELS = 6;

/** One `ps -o ppid=,command=` line to `{ ppid, command }`, or `null` when it does not parse. */
export function parsePsLine(line) {
  const trimmed = String(line ?? '').replace(/\r?\n?$/, '');
  const m = /^\s*(\d+)\s+(.*)$/.exec(trimmed);
  if (!m) return null;
  return { ppid: Number(m[1]), command: m[2] };
}

/**
 * True when `command`'s own executable resolves to the `claude` CLI: either
 * invoked directly (`claude ...`, any directory) or through its npm shim,
 * where the OS-visible command is `node <path>/claude ...` — the SHIM's own
 * path, not `cli.js`, since npm's POSIX bin mechanism installs the package's
 * bin file under the COMMAND name, and a shebang exec preserves the invoked
 * path rather than substituting the realpath of the file it names.
 */
export function commandNamesClaudeLauncher(command) {
  const tokens = String(command ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const baseOf = (tok) => tok.split(/[\\/]/).pop() ?? tok;
  const first = baseOf(tokens[0]).toLowerCase();
  if (first === 'claude') return true;
  if ((first === 'node' || first === 'node.exe') && tokens[1]) {
    const stem = baseOf(tokens[1]).replace(/\.(m|c)?js$/i, '');
    return stem === 'claude';
  }
  return false;
}

/**
 * Walk up from `startPpid`, calling `runPs(pid)` for one `ps -o
 * ppid=,command=` line at a time, up to `maxLevels` hops. Returns the
 * launcher's full command line once found, or `null` — a missing process, an
 * unparsable line, or the walk running out of levels — without ever
 * throwing: `runPs` failing (no such process, `ps` itself missing) ends the
 * walk exactly like reaching the top of the tree.
 */
export function findClaudeLauncherCommand(startPpid, runPs, maxLevels = MAX_ANCESTRY_LEVELS) {
  let pid = startPpid;
  for (let i = 0; i < maxLevels && Number.isInteger(pid) && pid > 1; i++) {
    let raw;
    try {
      raw = runPs(pid);
    } catch {
      return null;
    }
    const parsed = parsePsLine(raw);
    if (!parsed) return null;
    if (commandNamesClaudeLauncher(parsed.command)) return parsed.command;
    pid = parsed.ppid;
  }
  return null;
}

/**
 * Does `command` contain the bare flag WORD somewhere that is not the exact
 * `--dangerously-load-development-channels` token — i.e. the two characters
 * immediately before it are not `--`? An em dash (`—dangerously-load-...`,
 * one character, not two ASCII hyphens) is the observed real-world case: a
 * terminal or input method autocorrecting a typed `--` into it. A correctly
 * double-hyphenated occurrence, wherever it sits, is not flagged by this
 * check alone.
 */
function hasMistypedFlagWord(command) {
  let idx = command.indexOf(FLAG_WORD);
  while (idx !== -1) {
    if (command.slice(Math.max(0, idx - 2), idx) !== '--') return true;
    idx = command.indexOf(FLAG_WORD, idx + FLAG_WORD.length);
  }
  return false;
}

/** Does `command` carry the flag exactly as Claude Code requires it? */
function hasExactFlag(command) {
  return command.includes(EXACT_FLAG_TOKEN);
}

/**
 * Does this command line show an INTENT to load the memesh-channel that the
 * exact flag does not back up? Two shapes, each independently sufficient:
 *   - the flag word appears but not as the exact double-hyphenated token
 *     (a mistyped dash, most commonly an autocorrected em dash), or
 *   - `server:memesh-channel` (the channel name) appears with no exact flag
 *     token anywhere on the line — the flag was dropped or badly mangled.
 * A command line mentioning NEITHER is not a channel launch attempt at all
 * (the common case — most Claude Code users never opt into channels), so it
 * is silent: warning there would fire on every ordinary session an owner who
 * has `hosts/claude.json` from a past `agent setup` never uses the flag on.
 */
function commandLooksLikeMistypedChannelFlag(command) {
  if (hasMistypedFlagWord(command)) return true;
  if (command.includes('server:memesh-channel') && !hasExactFlag(command)) return true;
  return false;
}

/** The exact SessionStart line shown when a launcher's flag looks mistyped. */
export function channelFlagWarningLine() {
  return 'MeMesh messages will not appear live because the '
    + `\`${CHANNEL_FLAG}\` flag looks mistyped (a dash may have been autocorrected into an em dash) — `
    + `restart Claude with the exact \`${CHANNEL_FLAG} server:memesh-channel\` flag.`;
}

/** The only impure call in this module. `-p` scopes `ps` to one pid. */
function runRealPs(pid) {
  return execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 2000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * One warning line for SessionStart's `systemMessage`, or `null`. Never
 * throws: any failure to inspect the process tree means silence, never a
 * false warning, so a platform where `ps` behaves differently just sees no
 * line rather than a wrong one. Also silent when the launcher's command line
 * shows no intent to load a channel at all — see
 * `commandLooksLikeMistypedChannelFlag`.
 */
export function findChannelFlagWarning(startPpid = process.ppid, runPs = runRealPs) {
  try {
    const launcher = findClaudeLauncherCommand(startPpid, runPs);
    if (!launcher) return null;
    return commandLooksLikeMistypedChannelFlag(launcher) ? channelFlagWarningLine() : null;
  } catch {
    return null;
  }
}
