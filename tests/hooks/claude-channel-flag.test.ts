import { describe, expect, it } from 'vitest';
import {
  CHANNEL_FLAG,
  channelFlagWarningLine,
  commandNamesClaudeLauncher,
  findChannelFlagWarning,
  findClaudeLauncherCommand,
  parsePsLine,
} from '../../scripts/hooks/_claude-channel.js';

// SessionStart warns once when the memesh-channel is configured but
// the launching `claude` process is missing the exact
// `--dangerously-load-development-channels` flag (a dash silently
// autocorrected to an em dash is the observed real-world cause). Unit-tested
// against INJECTED `ps` output, never a live process tree.
describe('Feature: the channel-flag ancestry check never warns falsely', () => {
  describe('parsePsLine', () => {
    it('parses a ppid and the rest of the line as the command', () => {
      expect(parsePsLine('  123 node /usr/local/bin/claude --foo bar')).toEqual({
        ppid: 123,
        command: 'node /usr/local/bin/claude --foo bar',
      });
    });

    it('returns null for a line with no leading pid', () => {
      expect(parsePsLine('not a ps line')).toBeNull();
      expect(parsePsLine('')).toBeNull();
    });
  });

  describe('commandNamesClaudeLauncher', () => {
    it('matches a direct `claude` invocation, any directory', () => {
      expect(commandNamesClaudeLauncher('claude --dangerously-load-development-channels server:memesh-channel')).toBe(true);
      expect(commandNamesClaudeLauncher('/opt/homebrew/bin/claude')).toBe(true);
    });

    it('matches the node-running-the-npm-shim shape', () => {
      expect(commandNamesClaudeLauncher('node /usr/local/bin/claude --dangerously-load-development-channels server:memesh-channel')).toBe(true);
    });

    it('does not match an unrelated node process, even one naming a .claude path', () => {
      expect(commandNamesClaudeLauncher('node /Users/x/.claude/plugins/cache/pcircle-memesh/memesh/4.10.5/scripts/hooks/session-start.js')).toBe(false);
      expect(commandNamesClaudeLauncher('node /usr/local/bin/some-other-cli')).toBe(false);
      expect(commandNamesClaudeLauncher('-zsh')).toBe(false);
      expect(commandNamesClaudeLauncher('')).toBe(false);
    });
  });

  describe('findClaudeLauncherCommand', () => {
    it('walks up the ancestry and returns the launcher command once found', () => {
      const lines = [
        '900 /bin/zsh',
        '1 node /usr/local/bin/claude --dangerously-load-development-channels server:memesh-channel',
      ];
      let calls = 0;
      const runPs = (_pid: number) => {
        const line = lines[calls];
        calls += 1;
        return line;
      };
      expect(findClaudeLauncherCommand(1000, runPs)).toBe(
        'node /usr/local/bin/claude --dangerously-load-development-channels server:memesh-channel',
      );
      expect(calls).toBe(2);
    });

    it('returns null when the walk runs out of levels without finding one', () => {
      const runPs = (pid: number) => `${pid - 1} /bin/some-wrapper`;
      expect(findClaudeLauncherCommand(1000, runPs, 3)).toBeNull();
    });

    it('returns null, never throws, when ps fails (a missing process)', () => {
      const runPs = () => { throw new Error('No such process'); };
      expect(findClaudeLauncherCommand(1000, runPs)).toBeNull();
    });

    it('returns null on an unparsable ps line', () => {
      const runPs = () => 'garbage, not a ps line';
      expect(findClaudeLauncherCommand(1000, runPs)).toBeNull();
    });
  });

  describe('findChannelFlagWarning', () => {
    // Narrow on purpose: an owner whose Mac has `hosts/claude.json` from a
    // past `agent setup` but never uses the channel flag must not be warned
    // at every session start. Only a command line that shows some INTENT to
    // load the channel — the flag word, or the channel name — without the
    // exact flag backing it up gets a line.
    it('warns nothing when the launcher carries the exact ASCII flag', () => {
      const runPs = () => '1 node /usr/local/bin/claude --dangerously-load-development-channels server:memesh-channel';
      expect(findChannelFlagWarning(1000, runPs)).toBeNull();
    });

    it('warns, with mistyped-flag wording, when a dash was autocorrected into an em dash', () => {
      const runPs = () => '1 node /usr/local/bin/claude —dangerously-load-development-channels server:memesh-channel';
      const line = findChannelFlagWarning(1000, runPs);
      expect(line).toBe(channelFlagWarningLine());
      expect(line).toContain('mistyped');
      expect(line).toContain(CHANNEL_FLAG);
    });

    it('warns when server:memesh-channel appears with no exact flag token anywhere', () => {
      const runPs = () => '1 node /usr/local/bin/claude server:memesh-channel';
      const line = findChannelFlagWarning(1000, runPs);
      expect(line).toBe(channelFlagWarningLine());
    });

    // Isolates the mistyped-dash branch from the server:memesh-channel
    // branch: no channel-name mention here at all, so this line only warns
    // if the flag-word check itself fires.
    it('warns on a mistyped flag word even with no channel-name mention on the line', () => {
      const runPs = () => '1 node /usr/local/bin/claude —dangerously-load-development-channels';
      const line = findChannelFlagWarning(1000, runPs);
      expect(line).toBe(channelFlagWarningLine());
    });

    it('warns nothing when the command line mentions neither the flag word nor the channel name', () => {
      const runPs = () => '1 node /usr/local/bin/claude --resume abc123';
      expect(findChannelFlagWarning(1000, runPs)).toBeNull();
    });

    it('warns nothing when the launching claude process cannot be found', () => {
      const runPs = () => { throw new Error('No such process'); };
      expect(findChannelFlagWarning(1000, runPs)).toBeNull();
    });

    it('never throws even when runPs throws something unusual', () => {
      const runPs = () => { throw 'not an Error object'; };
      expect(() => findChannelFlagWarning(1000, runPs)).not.toThrow();
      expect(findChannelFlagWarning(1000, runPs)).toBeNull();
    });
  });
});
