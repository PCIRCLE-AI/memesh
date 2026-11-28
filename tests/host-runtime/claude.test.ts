import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const start = vi.hoisted(() => vi.fn());
vi.mock('../../src/host-runtime/conversation-channel.js', () => ({ startConversationChannel: start }));
const originalArgv = process.argv;
const originalExit = process.exitCode;

beforeEach(() => {
  vi.resetModules();
  start.mockReset();
  start.mockResolvedValue({ close: async () => undefined });
  process.argv = [process.execPath, fileURLToPath(new URL('../../src/host-runtime/claude.ts', import.meta.url))];
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExit;
  vi.restoreAllMocks();
});

it('routes the realpath entry only to the conversation Channel despite a nonexistent legacy config', async () => {
  process.argv.push('--config', '/nonexistent-retired-config.json');
  await import('../../src/host-runtime/claude.js');
  expect(start).toHaveBeenCalledTimes(1);
  expect(Object.keys(start.mock.calls[0][0])).toEqual(['onError']);
  expect(process.exitCode).toBe(0);
});

it('keeps the shared one-line startup error instead of falling back to a router', async () => {
  start.mockRejectedValue(new Error('Claude Channel requires the actual host session'));
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  await import('../../src/host-runtime/claude.js');
  expect(start).toHaveBeenCalledTimes(1);
  expect(process.exitCode).toBe(1);
  expect(stderr).toHaveBeenCalledWith('memesh-host-claude: Claude Channel requires the actual host session\n');
});

it('reports asynchronous Channel failure without exposing error contents or claiming delivery', async () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  await import('../../src/host-runtime/claude.js');
  start.mock.calls[0][0].onError(new Error('private synthetic diagnostic'));
  expect(process.exitCode).toBe(1);
  expect(stderr).toHaveBeenCalledWith('memesh-host-claude: conversation Channel failed; messages remain pending.\n');
  expect(stderr.mock.calls.flat().join('')).not.toContain('private synthetic diagnostic');
});

it('does not start a Channel when another module imports the entry', async () => {
  process.argv = [process.execPath, '/nonexistent-other-entry.js'];
  await import('../../src/host-runtime/claude.js');
  expect(start).not.toHaveBeenCalled();
});
