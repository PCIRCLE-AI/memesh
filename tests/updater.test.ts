import { describe, expect, it } from 'vitest';
import {
  classifyBump,
  getInstalledGlobalVersion,
} from '../src/core/updater.js';

function makeExecFileSyncMock(handlers: {
  install?: (args: string[], options: Record<string, unknown>) => void;
  ls?: (args: string[], options: Record<string, unknown>) => string;
}) {
  return ((
    file: string,
    args: readonly string[] | undefined | null,
    options: Record<string, unknown> = {},
  ) => {
    expect(file).toBe('npm');
    expect(Array.isArray(args)).toBe(true);

    const command = args as string[];
    if (command[0] === 'install') {
      handlers.install?.(command, options);
      return '';
    }

    if (command[0] === 'ls') {
      // `command` is forwarded, not discarded. The mock used to call
      // `handlers.ls()` with no arguments, so nothing could see WHICH npm
      // command had been run: dropping `-g` from `npm ls` left every test
      // green while the updater read the LOCAL tree and reported the global
      // package as missing.
      return handlers.ls?.(command, options) ?? JSON.stringify({});
    }

    throw new Error(`Unexpected command: ${command.join(' ')}`);
  }) as typeof import('child_process').execFileSync;
}

describe('updater', () => {
  it('reads the installed global version from npm ls output — and asks GLOBALLY', () => {
    let lsArgs: string[] = [];
    const version = getInstalledGlobalVersion({
      execFileSyncImpl: makeExecFileSyncMock({
        ls: (args) => {
          lsArgs = args;
          return JSON.stringify({
            dependencies: {
              '@pcircle/memesh': { version: '4.0.2' },
            },
          });
        },
      }),
    });

    expect(version).toBe('4.0.2');
    // The half that was missing. `npm ls` without `-g` reads the CURRENT
    // project, so the updater would report a globally-installed memesh as
    // absent — and refuse to update it — with every assertion above still
    // green.
    expect(lsArgs, 'npm ls was asked about the local tree, not the global one').toContain('-g');
  });

  it('returns null when npm ls does not report a global install', () => {
    const version = getInstalledGlobalVersion({
      execFileSyncImpl: makeExecFileSyncMock({
        ls: () => JSON.stringify({ dependencies: {} }),
      }),
    });

    expect(version).toBeNull();
  });
});


describe('classifyBump', () => {
  it('returns the largest bump kind', () => {
    expect(classifyBump('1.0.0', '1.0.1')).toBe('patch');
    expect(classifyBump('1.0.0', '1.1.0')).toBe('minor');
    expect(classifyBump('1.0.0', '2.0.0')).toBe('major');
    expect(classifyBump('1.0.0', '1.1.5')).toBe('minor');
    expect(classifyBump('1.0.0', '2.5.7')).toBe('major');
  });
  it('returns null for same-or-older targets (never auto-downgrade)', () => {
    expect(classifyBump('1.0.0', '1.0.0')).toBeNull();
    expect(classifyBump('1.0.1', '1.0.0')).toBeNull();
    expect(classifyBump('2.0.0', '1.9.9')).toBeNull();
  });
  it('returns null for unparseable input', () => {
    expect(classifyBump('not-a-version', '1.0.0')).toBeNull();
    expect(classifyBump('1.0.0', '')).toBeNull();
  });
  it('strips prerelease and build tags', () => {
    expect(classifyBump('1.0.0', '1.0.1-rc.1')).toBe('patch');
    expect(classifyBump('1.0.0-beta', '1.0.0')).toBeNull(); // same numeric triple
  });
});
