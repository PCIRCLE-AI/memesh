/**
 * Two branches of the journey that a real machine will not produce on demand:
 * the step process cannot be started at all, and the throwaway folder survives
 * its removal. Both are driven by standing in the one call each depends on
 * (spawn, rmSync); everything else is the real code.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Hook = ((...args: unknown[]) => unknown) | undefined;
const hooks = globalThis as unknown as { __journeySpawn?: Hook; __journeyKeepScratch?: boolean };

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return { ...real, spawn: (...args: unknown[]) => (hooks.__journeySpawn ? hooks.__journeySpawn(...args) : (real.spawn as (...a: unknown[]) => unknown)(...args)) };
});
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const rmSync = (...args: unknown[]) => (hooks.__journeyKeepScratch ? undefined : (real.rmSync as (...a: unknown[]) => unknown)(...args));
  return { ...real, rmSync, default: { ...real, rmSync } };
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as journey from '../../src/core/doctor-journey.js';

const PACKAGE_ROOT = path.resolve('.');
let privateTmp: string;
let savedTmp: Record<string, string | undefined>;

beforeEach(() => {
  privateTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-journey-test-'));
  savedTmp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = privateTmp;
});
afterEach(() => {
  hooks.__journeySpawn = undefined;
  hooks.__journeyKeepScratch = false;
  for (const [key, value] of Object.entries(savedTmp)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(privateTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('the seams', () => {
  it('a step that cannot be started is reported as such, with a reason and a fix', async () => {
    hooks.__journeySpawn = () => {
      const child = Object.assign(new EventEmitter(), { pid: undefined, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true });
      setImmediate(() => child.emit('error', new Error('spawn EACCES')));
      return child;
    };
    const result = await journey.runInstallJourney({ packageRoot: PACKAGE_ROOT });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe('remember');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].result).toBe('could not start');
    expect(result.steps[0].reason).toBe('Node could not start the installed command: spawn EACCES');
    expect(result.steps[0].fix).toContain('Reinstall');
    expect(result.cleaned).toBe(true);
  });

  it('a throwaway folder that is still there after removal is said to be, with its path', async () => {
    hooks.__journeyKeepScratch = true;
    const result = await journey.runInstallJourney({ packageRoot: PACKAGE_ROOT });
    hooks.__journeyKeepScratch = false;
    try {
      expect(result.ok, JSON.stringify(result.steps)).toBe(true);
      expect(result.cleaned).toBe(false);
      expect(result.cleanupError).toBe('folder still present after removal');
      expect(fs.existsSync(result.scratchDir)).toBe(true);
      const text = journey.formatJourney(result).join('\n');
      expect(text).toContain(`${result.scratchDir} could not be removed (folder still present after removal)`);
    } finally {
      fs.rmSync(result.scratchDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('the budget runs on its own clock', () => {
  /** A step that ignores being killed: it never exits, and nothing ever closes its output. */
  const unkillable = (pid: number, kill: () => boolean) => Object.assign(new EventEmitter(), {
    pid, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill, unref: () => undefined,
  });

  it('a kill that does not end the step does not hold the verdict past the budget', async () => {
    hooks.__journeySpawn = () => unkillable(2_147_000_000, () => true);
    const started = Date.now();
    const result = await journey.runInstallJourney({ packageRoot: PACKAGE_ROOT }, { timeoutMs: 1_200 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.timedOut).toBe(true);
    expect(result.failedStep).toBe('remember');
    expect(result.steps[0].result).toBe('timed out');
    expect(result.steps[0].reason).toContain('1.2 s budget');
    expect(result.cleaned).toBe(true);
  }, 30_000);

  it('a step that could not be stopped is reported with its process, not as stopped', async () => {
    // Where taskkill is what stops a step (Windows), a failing taskkill is the real situation; elsewhere the platform is stood in.
    const real = process.platform;
    if (real !== 'win32') Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      hooks.__journeySpawn = () => unkillable(2_147_000_001, () => false);
      const result = await journey.runInstallJourney({ packageRoot: PACKAGE_ROOT }, { timeoutMs: 1_200 });
      expect(result.timedOut).toBe(true);
      expect(result.steps[0].reason).toContain('could not be stopped');
      expect(result.steps[0].reason).toContain('2147000001');
      expect(result.steps[0].reason).not.toContain('and was stopped');
    } finally {
      Object.defineProperty(process, 'platform', { value: real });
    }
  }, 30_000);
});
